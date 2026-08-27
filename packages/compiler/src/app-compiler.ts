/**
 * Whole-app compile entry point — the cross-file counterpart to
 * `compile.ts`'s single-file `compileThrSource`. Theme-variant validation
 * is inherently cross-file (a component can't be validated against
 * `theme.x` without knowing the whole theme shape), so it can't live inside
 * the existing pure, single-file pipeline — see
 * findings/compiler-pipeline-and-build.md's "no `fs` inside `compile.ts`" rule,
 * which this file honors too: it takes file *contents* as plain data
 * (already read by the caller — `cli.ts`), not paths to read itself.
 *
 * The store has no cross-file validation at all anymore — it's a built-in
 * runtime primitive (never user-authored in the DSL, see GRAMMAR.md's
 * "Global store" section), so there's no `<store>` file to discover, bucket,
 * or validate the cardinality of. This file's only remaining store-related
 * job is tallying whether *any* component uses it (`appUsesStore`), so
 * `cli.ts` knows whether to copy the fixed runtime Store component into the
 * app's output and wire it into `FlashTheaterGlobals.brs`.
 *
 * Fail-fast: the theme itself is validated (and compiled) before any
 * component is compiled — widening the existing single-file "stop at first
 * structural error" policy to app scope, not a new policy.
 */
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { FlshFile, parse as parseThrFile, parseFlshFile, ThrFile } from 'flash-parser';
import { CompileError, ThrClassAst } from './dsl-parser/dsl-ast.js';
import { adaptFlshFile, adaptThemeTemplateSection, adaptThemeVariantSection } from './dsl-parser/dsl-parser.js';
import { buildThemeShape, GlobalBindingsContext, ThemeShape } from './analysis/global-bindings.js';
import { buildClassShape, ClassShape } from './analysis/class-shape.js';
import { checkDuplicateClassMemberNames, checkOverrideCoherence } from './analysis/class-analysis.js';
import { compileClass } from './codegen/class-emitter.js';
import { compileThrSource } from './compile.js';
import { compileTheme } from './codegen/theme-emitter.js';
import { GLOBAL_FIELD_NAMES } from './codegen/global-fields.js';
import { brsStringLiteral } from './codegen/naming.js';
import { FlashTheaterConfig } from './config.js';

/** Fixed name of the built-in runtime Store component — never chosen per-app, since it's copied verbatim from `runtime-assets/Store` (see `cli.ts`), not compiled from user DSL. */
export const FLASH_THEATER_STORE_COMPONENT_NAME = 'FlashTheaterStore';

/** Fixed name of the built-in runtime focus-manager component — never chosen per-app, copied verbatim from `runtime-assets/FocusManager` (see `cli.ts`), same treatment as `FLASH_THEATER_STORE_COMPONENT_NAME`. */
export const FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME = 'FlashTheaterFocusManager';

/** Fixed name of the built-in runtime router (global singleton) component — never chosen per-app, copied verbatim from `runtime-assets/Router` (see `cli.ts`), same treatment as `FLASH_THEATER_STORE_COMPONENT_NAME`. Wired into `FlashTheaterGlobals.brs`, unlike `FLASH_THEATER_ROUTER_OUTLET_COMPONENT_NAME` below (an ordinary per-use component, never a global). */
export const FLASH_THEATER_ROUTER_COMPONENT_NAME = 'FlashTheaterRouter';

/** Fixed name of the built-in runtime router-outlet component — copied verbatim from `runtime-assets/RouterOutlet` (see `cli.ts`) whenever `usesRouter` is true, exactly like the router singleton itself. Unlike the router (a single `m.global.ft_router` instance), this is an ORDINARY component a `.thr` template instantiates directly (`<FlashTheaterRouterOutlet id="..."/>`, any number of times, nested arbitrarily) — never itself a global, so it has no entry in `emitFlashTheaterGlobalsBrs`. */
export const FLASH_THEATER_ROUTER_OUTLET_COMPONENT_NAME = 'FlashTheaterRouterOutlet';

/** Fixed name of the built-in runtime task-manager (global singleton) component — never chosen per-app, copied verbatim from `runtime-assets/TaskManager` (see `cli.ts`), same treatment as `FLASH_THEATER_ROUTER_COMPONENT_NAME`. */
export const FLASH_THEATER_TASK_MANAGER_COMPONENT_NAME = 'FlashTheaterTaskManager';

/**
 * Fixed directory/file names of the built-in `ft_equals(...)` runtime helper
 * — copied verbatim from `runtime-assets/SafeCompare` (see `cli.ts`'s
 * `copyRuntimeBrsAsset`) whenever `usesComparisonHelper` is true. Unlike
 * Store/Theme/FocusManager/Router (each a singleton SceneGraph node reached
 * via `m.global.*`), this is plain `.brs` with no `.xml` at all — a
 * component/class that needs it gets a `<script uri="...">` pointing at this
 * one shared, fixed location instead, reusing the exact same
 * `<script uri>`-dedup mechanism a `.flsh` `import` already uses (see
 * `compileFlshClasses`'s own `transitiveBrsPaths`).
 */
export const FLASH_THEATER_SAFE_COMPARE_DIR_NAME = 'SafeCompare';
export const FLASH_THEATER_SAFE_COMPARE_FILE_BASE_NAME = 'FlashTheaterSafeCompare';

/**
 * Fixed directory/file names of the built-in `ft_not(...)` runtime helper — copied verbatim from
 * `runtime-assets/SafeNot` (see `cli.ts`'s `copyRuntimeBrsAsset`) whenever `usesSafeNotHelper` is
 * true. Same "plain `.brs`, no `.xml`, one shared `<script uri="...">`" treatment as
 * `FLASH_THEATER_SAFE_COMPARE_DIR_NAME` — a dedicated asset rather than folded into SafeCompare's
 * own file, so a component using only `!` (never `==`/`!=`) never pulls in the equality helper.
 */
export const FLASH_THEATER_SAFE_NOT_DIR_NAME = 'SafeNot';
export const FLASH_THEATER_SAFE_NOT_FILE_BASE_NAME = 'FlashTheaterSafeNot';

/**
 * Fixed directory/file names of the built-in `ft_relationalGuard(...)` runtime helper — copied
 * verbatim from `runtime-assets/SafeRelational` (see `cli.ts`'s `copyRuntimeBrsAsset`) whenever
 * `usesRelationalHelper` is true. Same "plain `.brs`, no `.xml`, one shared `<script uri="...">`"
 * treatment as `FLASH_THEATER_SAFE_COMPARE_DIR_NAME` — a dedicated asset rather than folded into
 * SafeCompare's own file, so a component using only `<`/`>`/`<=`/`>=` (never `==`/`!=`) never pulls
 * in the equality helper, and vice versa.
 */
export const FLASH_THEATER_SAFE_RELATIONAL_DIR_NAME = 'SafeRelational';
export const FLASH_THEATER_SAFE_RELATIONAL_FILE_BASE_NAME = 'FlashTheaterSafeRelational';

/**
 * Fixed directory/file names of the built-in `ft_createStream(...)` runtime
 * helper backing the DSL's `stream` primitive — copied verbatim from
 * `runtime-assets/Stream` (see `cli.ts`'s `copyRuntimeBrsAsset`) whenever
 * `usesStreamHelper` is true. Same "plain `.brs`, no `.xml`, one shared
 * `<script uri="...">`" treatment as `FLASH_THEATER_SAFE_COMPARE_DIR_NAME`.
 */
export const FLASH_THEATER_STREAM_DIR_NAME = 'Stream';
export const FLASH_THEATER_STREAM_FILE_BASE_NAME = 'FlashTheaterStream';

/**
 * Fixed directory/file names of the built-in `ft_httpFetch(...)` runtime helper backing the DSL's
 * `request Http { ... }` declaration — copied verbatim from `runtime-assets/Http` (see `cli.ts`'s
 * `copyRuntimeBrsAsset`) whenever `usesHttpRequestHelper` is true. Same "plain `.brs`, no `.xml`,
 * one shared `<script uri="...">`" treatment as `FLASH_THEATER_STREAM_DIR_NAME` — `.flsh` classes
 * can never declare `request {}` (it's a `.thr`-only, script-level declaration), so unlike
 * `usesStreamHelper`/`usesComparisonHelper` there is no `anyClassUsesHttpRequestHelper` tally to
 * fold in here.
 */
export const FLASH_THEATER_HTTP_DIR_NAME = 'Http';
export const FLASH_THEATER_HTTP_FILE_BASE_NAME = 'FlashTheaterHttp';

/**
 * Fixed directory/file names of the built-in `ft_scale(...)` runtime helper backing the DSL's
 * `scale` modifier — copied verbatim from `runtime-assets/Scale` (see `cli.ts`'s
 * `copyRuntimeBrsAsset`) whenever `usesScaleHelper` is true. Same "plain `.brs`, no `.xml`, one
 * shared `<script uri="...">`" treatment as `FLASH_THEATER_STREAM_DIR_NAME`/
 * `FLASH_THEATER_HTTP_DIR_NAME`. Unlike those two, `scale` ALSO needs one global field
 * (`ft_scaleFactor`, wired into `globalsBrs` by `emitFlashTheaterGlobalsBrs` below) — the once-
 * computed runtime scale factor every `ft_scale(...)` call site reads.
 */
export const FLASH_THEATER_SCALE_DIR_NAME = 'Scale';
export const FLASH_THEATER_SCALE_FILE_BASE_NAME = 'FlashTheaterScale';

/** `flash-theater.config.json`'s `designResolution` tier, converted to the pixel width `ft_scaleFactor` divides the actual device display width by — `hd` (1280x720) or `fhd` (1920x1080), matching Roku's own `ui_resolutions` manifest vocabulary. See `config.ts`. */
export const DESIGN_RESOLUTION_WIDTHS: Readonly<Record<'hd' | 'fhd', number>> = { hd: 1280, fhd: 1920 };

/**
 * Fixed name of the compiled theme component — never derived from whatever
 * the app author happens to name their `<theme-template>` `.thr` file (or
 * where they put it). An app has at most one theme-template (enforced
 * below), so there's exactly as much reason to fix its compiled name as
 * there is for the store's: `cli.ts` detects the theme-template file
 * structurally (by its root tag, via `ThrFile.kind`), never by filename, so
 * requiring a specific filename to get a specific compiled name would be an
 * arbitrary extra rule on the app author for no benefit — see
 * findings/reactivity-theme-parsing.md.
 */
export const FLASH_THEATER_THEME_COMPONENT_NAME = 'FlashTheaterTheme';

export interface AppFileInput {
  /** Original `.thr`/`.flsh` path — carried through so a caller (cli.ts) knows where to write the corresponding compiled output, and so error messages can point at the right file. */
  path: string;
  source: string;
  /** Ignored for a `.flsh` input (a class's compiled name always comes from its own `class Name` declaration, not the file path) — kept required for `.thr` backward compatibility. */
  componentName: string;
  /** `'thr'` (the default, for backward compatibility with every existing caller/test) or `'flsh'` — decides which grammar this file is parsed with. `cli.ts` computes this from the real file extension. */
  kind?: 'thr' | 'flsh';
}

export interface CompiledClassOutput {
  /** Original `.flsh` source path. */
  path: string;
  className: string;
  brs: string;
}

export interface CompiledAppOutput {
  path: string;
  componentName: string;
  xml: string;
  brs: string;
}

/**
 * The app's single compiled theme component. Deliberately **not** part of
 * `CompiledApp.outputs` — like the store, its compiled name/location is
 * fixed (`FLASH_THEATER_THEME_COMPONENT_NAME`), not derived from an input
 * file's own name/path, so `cli.ts` writes it through its own dedicated
 * path rather than the generic per-input `outputs` loop. `sourcePath` is
 * kept only for informational logging (`cli.ts`'s `--check`/`compiled`
 * messages) — it plays no role in deciding where the compiled output goes.
 */
export interface CompiledThemeOutput {
  sourcePath: string;
  xml: string;
  brs: string;
}

export interface CompiledApp {
  /** One entry per plain, user-authored component — never the theme (see `themeOutput`) or the store (see `usesStore`), neither of which is user-authored output. */
  outputs: CompiledAppOutput[];
  /** The app's compiled theme component, or `null` if the app has no `<theme-template>` file. */
  themeOutput: CompiledThemeOutput | null;
  /** True if any component uses the store (`read`/`watch`/`store(...)` write) — `cli.ts` copies the fixed runtime Store component into the app's output and wires it into `globalsBrs` only when this is true. */
  usesStore: boolean;
  /** True if any component has at least one `focusable`-bearing element — `cli.ts` copies the fixed runtime `FlashTheaterFocusManager` component into the app's output and wires it into `globalsBrs` only when this is true, mirroring `usesStore` exactly. */
  usesFocusSystem: boolean;
  /** True if any component reads or calls `router.*` anywhere — `cli.ts` copies both the fixed runtime `FlashTheaterRouter` singleton AND `FlashTheaterRouterOutlet` into the app's output, and wires `FlashTheaterRouter` into `globalsBrs`, only when this is true, mirroring `usesStore`/`usesFocusSystem`. */
  usesRouter: boolean;
  /** True if any component reads or calls `taskManager.*` anywhere — `cli.ts` copies the fixed runtime `FlashTheaterTaskManager` component into the app's output and wires it into `globalsBrs` only when this is true, mirroring `usesStore`/`usesFocusSystem`/`usesRouter`. */
  usesTaskManager: boolean;
  /** True if any component's own compiled `.brs`, or any `.flsh` class's own compiled `.brs`, calls `ft_equals(` (an `==`/`!=` DSL comparison lowered somewhere) — `cli.ts` copies the fixed `runtime-assets/SafeCompare/FlashTheaterSafeCompare.brs` helper into the app's output only when this is true. Unlike `usesStore`/`usesFocusSystem`/`usesRouter`/`usesTaskManager`, this never wires anything into `globalsBrs` — every component/class that needs it gets its own `<script uri="...">` instead (see `FLASH_THEATER_SAFE_COMPARE_DIR_NAME`'s own doc comment). */
  usesComparisonHelper: boolean;
  /** True if any component's own compiled `.brs`, or any `.flsh` class's own compiled `.brs`, calls `ft_not(` (a `!` DSL safe-NOT lowered somewhere) — `cli.ts` copies the fixed `runtime-assets/SafeNot/FlashTheaterSafeNot.brs` helper into the app's output only when this is true. Same wiring shape as `usesComparisonHelper` — never touches `globalsBrs`, every component/class that needs it gets its own `<script uri="...">` instead. */
  usesSafeNotHelper: boolean;
  /** True if any component's own compiled `.brs`, or any `.flsh` class's own compiled `.brs`, calls `ft_createStream(` (a declared `stream` — see GRAMMAR.md's "stream" section) — `cli.ts` copies the fixed `runtime-assets/Stream/FlashTheaterStream.brs` helper into the app's output only when this is true. Same wiring shape as `usesComparisonHelper` — never touches `globalsBrs`, every component/class that needs it gets its own `<script uri="...">` instead. */
  usesStreamHelper: boolean;
  /** True if any component's own compiled `.brs` calls `ft_httpFetch(` (a declared `request Http { ... }` — see GRAMMAR.md's "Requests" section) — `cli.ts` copies the fixed `runtime-assets/Http/FlashTheaterHttp.brs` helper into the app's output only when this is true. Same wiring shape as `usesStreamHelper`/`usesComparisonHelper` — never touches `globalsBrs`. */
  usesHttpRequestHelper: boolean;
  /** True if any component's own compiled `.brs`, or any `.flsh` class's own compiled `.brs`, calls `ft_scale(` (a `scale`-flagged declaration/statement — see GRAMMAR.md's "scale" section) — `cli.ts` copies the fixed `runtime-assets/Scale/FlashTheaterScale.brs` helper into the app's output only when this is true. Unlike `usesComparisonHelper`/`usesStreamHelper`, this ALSO wires one global field (`ft_scaleFactor`) into `globalsBrs`, mirroring `usesStore`/`usesFocusSystem`/`usesRouter`/`usesTaskManager` in that one respect. */
  usesScaleHelper: boolean;
  /** True if any component's own compiled `.brs`, or any `.flsh` class's own compiled `.brs`, calls `ft_relationalGuard(` (a `<`/`>`/`<=`/`>=` DSL relational comparison lowered somewhere) — `cli.ts` copies the fixed `runtime-assets/SafeRelational/FlashTheaterSafeRelational.brs` helper into the app's output only when this is true. Same wiring shape as `usesComparisonHelper` — never touches `globalsBrs`, every component/class that needs it gets its own `<script uri="...">` instead. */
  usesRelationalHelper: boolean;
  /** True if any component, or any `.flsh` class, reads `env.*` anywhere — decides whether `globalsBrs` wires the active environment's `environmentVariables` into `ft_env`, mirroring `usesStore`/`usesFocusSystem`/`usesRouter`/`usesTaskManager`. Unlike those, there's no separate runtime asset to copy — `env` is a plain literal AA baked directly into `globalsBrs`, not a SceneGraph node. */
  usesEnv: boolean;
  /** The `FlashTheaterSetupGlobals(globalNode)` bootstrap sub's `.brs` content — `null` when the app uses none of the store/theme/focus/router/task-manager/scale/env singletons (nothing to wire up). */
  globalsBrs: string | null;
  /** One entry per `.flsh` class input, in the order they were topologically compiled (a base class always before anything that `extends`/`import`s it). Written in-place next to its own `.flsh` source (see cli.ts) — unlike the theme/store, a class is user-named and there can be arbitrarily many. */
  classOutputs: CompiledClassOutput[];
}

interface Bucketed {
  readonly input: AppFileInput;
  readonly file: ThrFile;
}

/** One parsed-and-adapted `.flsh` input, keyed by its own resolved (absolute) path — the map key every `import` resolves against. */
interface FlshBucketed {
  readonly input: AppFileInput;
  readonly classAst: ThrClassAst;
  readonly resolvedPath: string;
}

/** Anything with `className`/`path` — both the compiler's own `ImportDecl` and flash-parser's raw `ImportDeclaration` satisfy this structurally, so the same resolver works for a `.flsh` file's own imports and a `.thr` component's. */
interface ImportLike {
  readonly className: string;
  readonly path: string;
}

/**
 * `srcRoot`/`outRoot` are the app's split project-layout roots (see `project-layout.ts`):
 * `srcRoot` is what a bare (non-`./`) `.flsh` import resolves against (it's a source-to-source
 * reference — see `resolveImportTargetPath`); `outRoot` is what every `<script uri="pkg:/...">`
 * is computed relative to (it's the directory that physically becomes the Roku package once
 * zipped — see `toScriptUri`). Both default to `'.'` so pure unit tests that use neither feature
 * can omit them entirely.
 */
export function compileApp(
  files: readonly AppFileInput[],
  srcRoot: string = '.',
  outRoot: string = '.',
  config: FlashTheaterConfig | null = null,
  environmentVariables: ReadonlyMap<string, string> | null = null,
): CompiledApp {
  const components: Bucketed[] = [];
  const themeTemplates: Bucketed[] = [];
  const themeVariants: Bucketed[] = [];

  for (const input of files) {
    if (input.kind === 'flsh') continue;

    const parseResult = parseThrFile(input.source);
    if (parseResult.diagnostics.length > 0) {
      const first = parseResult.diagnostics[0];
      throw new CompileError({ code: first.code, message: `${input.path}: ${first.message}`, span: { line: first.line } });
    }

    const file = new ThrFile(parseResult.root);
    const bucketed: Bucketed = { input, file };
    switch (file.kind) {
      case 'component':
        components.push(bucketed);
        break;
      case 'theme-template':
        themeTemplates.push(bucketed);
        break;
      case 'theme-variant':
        themeVariants.push(bucketed);
        break;
    }
  }

  if (themeTemplates.length > 1) {
    throw new CompileError({
      code: 'theme/multiple-templates',
      message: `Found ${themeTemplates.length} <theme-template> files (${themeTemplates.map((t) => t.input.path).join(', ')}) — an app may have at most one.`,
    });
  }

  const outputs: CompiledAppOutput[] = [];

  let themeShape: ThemeShape | null = null;
  let themeOutput: CompiledThemeOutput | null = null;
  if (themeTemplates.length === 1) {
    const { input, file } = themeTemplates[0];
    const templateAst = adaptThemeTemplateSection(file.themeTemplate);
    const variantAsts = themeVariants.map(({ file: variantFile }) => adaptThemeVariantSection(variantFile.themeVariant));
    themeShape = withPathContext(input.path, () => buildThemeShape(templateAst, variantAsts));

    const compiled = compileTheme(themeShape, FLASH_THEATER_THEME_COMPONENT_NAME);
    themeOutput = { sourcePath: input.path, xml: compiled.xml, brs: compiled.brs };
  }

  const designResolutionWidth = config ? DESIGN_RESOLUTION_WIDTHS[config.designResolution] : null;
  const globalBindings: GlobalBindingsContext = {
    theme: themeShape,
    designResolutionConfigured: config !== null,
    envVariableNames: environmentVariables ? new Set(environmentVariables.keys()) : undefined,
  };

  const safeCompareAbsolutePath = resolvePath(outRoot, 'components', 'FlashTheater', FLASH_THEATER_SAFE_COMPARE_DIR_NAME, `${FLASH_THEATER_SAFE_COMPARE_FILE_BASE_NAME}.brs`);
  const safeNotAbsolutePath = resolvePath(outRoot, 'components', 'FlashTheater', FLASH_THEATER_SAFE_NOT_DIR_NAME, `${FLASH_THEATER_SAFE_NOT_FILE_BASE_NAME}.brs`);
  const streamHelperAbsolutePath = resolvePath(outRoot, 'components', 'FlashTheater', FLASH_THEATER_STREAM_DIR_NAME, `${FLASH_THEATER_STREAM_FILE_BASE_NAME}.brs`);
  const httpRequestHelperAbsolutePath = resolvePath(outRoot, 'components', 'FlashTheater', FLASH_THEATER_HTTP_DIR_NAME, `${FLASH_THEATER_HTTP_FILE_BASE_NAME}.brs`);
  const scaleHelperAbsolutePath = resolvePath(outRoot, 'components', 'FlashTheater', FLASH_THEATER_SCALE_DIR_NAME, `${FLASH_THEATER_SCALE_FILE_BASE_NAME}.brs`);
  const relationalHelperAbsolutePath = resolvePath(outRoot, 'components', 'FlashTheater', FLASH_THEATER_SAFE_RELATIONAL_DIR_NAME, `${FLASH_THEATER_SAFE_RELATIONAL_FILE_BASE_NAME}.brs`);

  const {
    classOutputs,
    classShapesByName,
    resolveComponentScriptUris,
    anyClassUsesComparisonHelper,
    anyClassUsesSafeNotHelper,
    anyClassUsesStreamHelper,
    anyClassUsesRouter,
    anyClassUsesTaskManager,
    anyClassUsesScaleHelper,
    anyClassUsesRelationalHelper,
    anyClassUsesEnv,
  } = compileFlshClasses(files.filter((f) => f.kind === 'flsh'), srcRoot, outRoot, safeCompareAbsolutePath, safeNotAbsolutePath, streamHelperAbsolutePath, scaleHelperAbsolutePath, relationalHelperAbsolutePath, themeShape);

  let usesStore = false;
  let usesFocusSystem = false;
  // A class that reaches `router.*`/`taskManager.*` via `GetGlobalAA().global` (see
  // analysis/class-identifier-rewrite.ts) needs the same runtime singleton wired into `globalsBrs`
  // as a `.thr` component that uses it directly — required, not optional: a component that never
  // calls `router.*`/`taskManager.*` itself but imports a class that does would otherwise never get
  // it, and the generated code would crash at runtime reading `invalid.callFunc(...)`.
  let usesRouter = anyClassUsesRouter;
  let usesTaskManager = anyClassUsesTaskManager;
  let usesComparisonHelper = anyClassUsesComparisonHelper;
  let usesSafeNotHelper = anyClassUsesSafeNotHelper;
  let usesStreamHelper = anyClassUsesStreamHelper;
  let usesHttpRequestHelper = false;
  // Same "required, not optional" reasoning as usesRouter/usesTaskManager above — a component that
  // never uses `scale` itself but imports a class that does would otherwise never get
  // ft_scaleFactor wired into globalsBrs, and every ft_scale(...) call in that class would read an
  // invalid field.
  let usesScaleHelper = anyClassUsesScaleHelper;
  let usesRelationalHelper = anyClassUsesRelationalHelper;
  // Same "required, not optional" reasoning as usesRouter/usesTaskManager above — a component that
  // never reads env.* itself but imports a class that does would otherwise never get ft_env wired
  // into globalsBrs, and that class's own env.* reads would crash reading invalid.<name>.
  let usesEnv = anyClassUsesEnv;
  for (const { input, file } of components) {
    const extraScriptUris = withPathContext(input.path, () => resolveComponentScriptUris(input.path, file.script.imports));
    const safeCompareScriptUri = toScriptUri(outRoot, safeCompareAbsolutePath);
    const safeNotScriptUri = toScriptUri(outRoot, safeNotAbsolutePath);
    const streamHelperScriptUri = toScriptUri(outRoot, streamHelperAbsolutePath);
    const httpRequestHelperScriptUri = toScriptUri(outRoot, httpRequestHelperAbsolutePath);
    const scaleHelperScriptUri = toScriptUri(outRoot, scaleHelperAbsolutePath);
    const relationalHelperScriptUri = toScriptUri(outRoot, relationalHelperAbsolutePath);
    const compiled = withPathContext(input.path, () =>
      compileThrSource(input.source, input.componentName, {
        globalBindings,
        extraScriptUris,
        safeCompareScriptUri,
        streamHelperScriptUri,
        httpRequestHelperScriptUri,
        scaleHelperScriptUri,
        safeNotScriptUri,
        relationalHelperScriptUri,
        classShapesByName,
      }),
    );
    outputs.push({ path: input.path, componentName: input.componentName, xml: compiled.xml, brs: compiled.brs });
    if (compiled.usesStore) usesStore = true;
    if (compiled.usesFocusSystem) usesFocusSystem = true;
    if (compiled.usesRouter) usesRouter = true;
    if (compiled.usesTaskManager) usesTaskManager = true;
    if (compiled.usesComparisonHelper) usesComparisonHelper = true;
    if (compiled.usesSafeNotHelper) usesSafeNotHelper = true;
    if (compiled.usesStreamHelper) usesStreamHelper = true;
    if (compiled.usesHttpRequestHelper) usesHttpRequestHelper = true;
    if (compiled.usesScaleHelper) usesScaleHelper = true;
    if (compiled.usesRelationalHelper) usesRelationalHelper = true;
    if (compiled.usesEnv) usesEnv = true;
  }

  const globalsBrs =
    usesStore || themeOutput || usesFocusSystem || usesRouter || usesTaskManager || usesScaleHelper || usesEnv
      ? emitFlashTheaterGlobalsBrs(
          usesStore ? FLASH_THEATER_STORE_COMPONENT_NAME : null,
          themeOutput ? FLASH_THEATER_THEME_COMPONENT_NAME : null,
          usesFocusSystem ? FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME : null,
          usesRouter ? FLASH_THEATER_ROUTER_COMPONENT_NAME : null,
          usesTaskManager ? FLASH_THEATER_TASK_MANAGER_COMPONENT_NAME : null,
          usesScaleHelper ? designResolutionWidth : null,
          usesEnv ? environmentVariables : null,
        )
      : null;

  return {
    outputs,
    themeOutput,
    usesStore,
    usesFocusSystem,
    usesRouter,
    usesTaskManager,
    usesComparisonHelper,
    usesSafeNotHelper,
    usesStreamHelper,
    usesHttpRequestHelper,
    usesScaleHelper,
    usesRelationalHelper,
    usesEnv,
    globalsBrs,
    classOutputs,
  };
}

/**
 * Parses, resolves, topologically sorts, and compiles every `.flsh` class
 * input, then returns both the compiled outputs and a resolver a `.thr`
 * component can use to turn its own `import` list into a deduped list of
 * `<script uri="...">` values relative to that component's own directory.
 *
 * Import resolution is inherently cross-file (same reasoning as theme
 * validation above) — `class Name` never carries its own file location, so
 * `extends`'s base and any instantiated class must be found via an explicit
 * `import <Name> from "<path>"`, resolved one of three ways (see
 * `resolveImportTargetPath`): filesystem-absolute as-is, `./`/`../`-prefixed
 * relative to the *importing* file's own directory, or (anything else)
 * relative to `srcRoot` — then matched by resolved path against every
 * discovered `.flsh` input. Compiling in topological order (Kahn's
 * algorithm via DFS, cycle-detected) guarantees a class's own imports
 * (their `ClassShape` for `extends`, their transitive script-URI list for
 * multi-`<script>` wiring) are already known before that class is compiled.
 */
function compileFlshClasses(
  flshInputs: readonly AppFileInput[],
  srcRoot: string,
  outRoot: string,
  safeCompareAbsolutePath: string,
  safeNotAbsolutePath: string,
  streamHelperAbsolutePath: string,
  scaleHelperAbsolutePath: string,
  relationalHelperAbsolutePath: string,
  themeShape: ThemeShape | null,
): {
  classOutputs: CompiledClassOutput[];
  /** Every compiled `.flsh` class's own member table, keyed by class name (a genuine name collision across two unrelated `.flsh` files is excluded from this map entirely — see its own construction site below) — built once, app-wide, after class-import topological compilation finishes. Returned (not just used internally for `extends`/`override` resolution) so `compileApp` can thread it into every `.thr` component's own `compileThrSource(...)` call — `analysis/derived-type-check.ts` uses it to resolve a `derived` expression's `ClassName(...).methodName(...)` call to that method's declared return type. */
  classShapesByName: ReadonlyMap<string, ClassShape>;
  resolveComponentScriptUris: (componentPath: string, imports: readonly ImportLike[]) => string[];
  /** True if any `.flsh` class's own compiled `.brs` calls `ft_equals(` — folded into `compileApp`'s app-wide `usesComparisonHelper` tally alongside every `.thr` component's own usage, since a class can exist (and be compiled) without ever being imported by a component that itself also uses `==`/`!=`. */
  anyClassUsesComparisonHelper: boolean;
  /** True if any `.flsh` class's own compiled `.brs` calls `ft_not(` — folded into `compileApp`'s app-wide `usesSafeNotHelper` tally the same way `anyClassUsesComparisonHelper` is, and for the same reason. */
  anyClassUsesSafeNotHelper: boolean;
  /** True if any `.flsh` class declares/constructs a `stream` — folded into `compileApp`'s app-wide `usesStreamHelper` tally the same way `anyClassUsesComparisonHelper` is, and for the same reason. */
  anyClassUsesStreamHelper: boolean;
  /** True if any `.flsh` class reads/calls `router.*`/`taskManager.*` (via `GetGlobalAA().global`) — folded into `compileApp`'s app-wide `usesRouter`/`usesTaskManager` tally the same way `anyClassUsesComparisonHelper` is, and for the same reason (a class can be compiled without any importing component itself also using the same singleton). */
  anyClassUsesRouter: boolean;
  anyClassUsesTaskManager: boolean;
  /** True if any `.flsh` class uses `scale` (a `scale <local> = <expr>` assignment) — folded into `compileApp`'s app-wide `usesScaleHelper` tally the same way `anyClassUsesComparisonHelper` is, and for the same reason. */
  anyClassUsesScaleHelper: boolean;
  /** True if any `.flsh` class's own compiled `.brs` calls `ft_relationalGuard(` — folded into `compileApp`'s app-wide `usesRelationalHelper` tally the same way `anyClassUsesComparisonHelper` is, and for the same reason. */
  anyClassUsesRelationalHelper: boolean;
  /** True if any `.flsh` class reads `env.*` (via `GetGlobalAA().global`) — folded into `compileApp`'s app-wide `usesEnv` tally the same way `anyClassUsesRouter` is, and for the same reason. */
  anyClassUsesEnv: boolean;
} {
  const flshByPath = new Map<string, FlshBucketed>();

  for (const input of flshInputs) {
    const parseResult = parseFlshFile(input.source);
    if (parseResult.diagnostics.length > 0) {
      const first = parseResult.diagnostics[0];
      throw new CompileError({ code: first.code, message: `${input.path}: ${first.message}`, span: { line: first.line } });
    }

    const classAst = adaptFlshFile(new FlshFile(parseResult.root));
    const expectedBase = basename(input.path, extname(input.path));
    if (expectedBase !== classAst.name) {
      throw new CompileError({
        code: 'class/name-file-mismatch',
        message: `${input.path}: file is named "${expectedBase}${extname(input.path)}" but declares "class ${classAst.name}" — a .flsh file's base name must match its class name.`,
      });
    }

    const resolvedPath = resolvePath(input.path);
    flshByPath.set(resolvedPath, { input, classAst, resolvedPath });
  }

  function resolveFlshImport(fromPath: string, imp: ImportLike): FlshBucketed {
    const targetPath = resolveImportTargetPath(fromPath, imp.path, srcRoot);
    const bucketed = flshByPath.get(targetPath);
    if (!bucketed) {
      throw new CompileError({
        code: 'import/file-not-found',
        message: `${fromPath}: import "${imp.className}" from "${imp.path}" — no .flsh file found at "${targetPath}".`,
      });
    }
    if (bucketed.classAst.name !== imp.className) {
      throw new CompileError({
        code: 'import/class-name-mismatch',
        message: `${fromPath}: import "${imp.className}" from "${imp.path}" resolves to a file declaring "class ${bucketed.classAst.name}", not "${imp.className}".`,
      });
    }
    return bucketed;
  }

  const order = topoSortFlshFiles(flshByPath, resolveFlshImport);

  const classShapes = new Map<string, ClassShape>();
  /** Every `.brs` this class's own compiled output needs alongside it — its own file plus everything transitively required by its own imports, all as resolved absolute paths (deduped). Converted to a component-relative `<script uri="...">` string only at the point a `.thr` component actually needs one — the same absolute set is reused verbatim by every importer, regardless of that importer's own directory. Includes `safeCompareAbsolutePath` whenever this class (or anything it transitively imports) calls `ft_equals(` — folded in right alongside `ownBrsPath` below, so `resolveComponentScriptUris` needs no dedicated comparison-helper logic of its own: it already turns whatever ends up in this set into `<script uri="...">` strings. */
  const transitiveBrsPaths = new Map<string, string[]>();
  const classOutputs: CompiledClassOutput[] = [];
  let anyClassUsesComparisonHelper = false;
  let anyClassUsesSafeNotHelper = false;
  let anyClassUsesStreamHelper = false;
  let anyClassUsesRouter = false;
  let anyClassUsesTaskManager = false;
  let anyClassUsesScaleHelper = false;
  let anyClassUsesRelationalHelper = false;
  let anyClassUsesEnv = false;

  for (const resolvedPath of order) {
    const { input, classAst } = flshByPath.get(resolvedPath)!;

    let baseShape: ClassShape | null = null;
    if (classAst.baseName) {
      const baseImport = classAst.imports.find((i) => i.className === classAst.baseName);
      if (!baseImport) {
        throw new CompileError({
          code: 'class/unresolved-base',
          message: `${input.path}: class "${classAst.name}" extends "${classAst.baseName}", but there is no matching "import ${classAst.baseName} from ..." in this file.`,
        });
      }
      baseShape = classShapes.get(resolveFlshImport(input.path, baseImport).resolvedPath)!;
    }

    withPathContext(input.path, () => {
      checkDuplicateClassMemberNames(classAst, baseShape);
      checkOverrideCoherence(classAst, baseShape);
    });

    const shape = buildClassShape(classAst, baseShape);
    classShapes.set(resolvedPath, shape);

    const compiled = withPathContext(input.path, () => compileClass(classAst, shape, baseShape, themeShape));
    classOutputs.push({ path: input.path, className: classAst.name, brs: compiled.brs });
    if (compiled.usesComparisonHelper) anyClassUsesComparisonHelper = true;
    if (compiled.usesSafeNotHelper) anyClassUsesSafeNotHelper = true;
    if (compiled.usesStreamHelper) anyClassUsesStreamHelper = true;
    if (compiled.usesRouter) anyClassUsesRouter = true;
    if (compiled.usesTaskManager) anyClassUsesTaskManager = true;
    if (compiled.usesScaleHelper) anyClassUsesScaleHelper = true;
    if (compiled.usesRelationalHelper) anyClassUsesRelationalHelper = true;
    if (compiled.usesEnv) anyClassUsesEnv = true;

    // `input.path` is srcRoot-based, but the compiled .brs physically lands under outRoot, mirrored
    // at the same relative directory (see cli.ts's own pass-through/compiled-output mirroring) — so
    // the absolute path used to build this class's <script uri="..."> must be mirrored the same way,
    // not simply "next to the .flsh source", or the URI would point at a file that was never written.
    const ownBrsPath = resolvePath(join(outRoot, relative(srcRoot, dirname(input.path)), `${classAst.name}.brs`));
    const importedTransitives = classAst.imports.flatMap((imp) => transitiveBrsPaths.get(resolveFlshImport(input.path, imp).resolvedPath) ?? []);
    const ownTransitives = [ownBrsPath, ...importedTransitives];
    if (compiled.usesComparisonHelper) ownTransitives.push(safeCompareAbsolutePath);
    if (compiled.usesSafeNotHelper) ownTransitives.push(safeNotAbsolutePath);
    if (compiled.usesStreamHelper) ownTransitives.push(streamHelperAbsolutePath);
    if (compiled.usesScaleHelper) ownTransitives.push(scaleHelperAbsolutePath);
    if (compiled.usesRelationalHelper) ownTransitives.push(relationalHelperAbsolutePath);
    transitiveBrsPaths.set(resolvedPath, Array.from(new Set(ownTransitives)));
  }

  function resolveComponentScriptUris(componentPath: string, imports: readonly ImportLike[]): string[] {
    const absolutePaths = new Set<string>();
    for (const imp of imports) {
      const target = resolveFlshImport(componentPath, imp);
      for (const abs of transitiveBrsPaths.get(target.resolvedPath) ?? []) absolutePaths.add(abs);
    }
    return Array.from(absolutePaths).map((abs) => toScriptUri(outRoot, abs));
  }

  // A name-keyed view of `classShapes` (which is keyed by resolved file PATH, needed internally
  // above for `baseShape`/import resolution) — built once here, app-wide, rather than by each
  // `derived`-type-check consumer separately re-deriving it per `.thr` component (which would be
  // O(components × classes) instead of O(classes), and risk each consumer inventing its own
  // collision policy). This DSL never enforces globally-unique `.flsh` class names (only that a
  // file's own basename matches its declared class name, and that an import's target actually
  // declares the expected name) — a genuine name COLLISION here is excluded from the map entirely
  // (never arbitrarily picks a "last one wins" winner), so a lookup miss safely falls back to
  // `analysis/derived-type-check.ts`'s `unknown` (unchecked) rather than silently resolving a
  // `ClassName(...).method()` call against the wrong class.
  const classShapesByName = new Map<string, ClassShape>();
  const ambiguousClassNames = new Set<string>();
  for (const shape of classShapes.values()) {
    if (classShapesByName.delete(shape.className) || ambiguousClassNames.has(shape.className)) {
      ambiguousClassNames.add(shape.className);
    } else {
      classShapesByName.set(shape.className, shape);
    }
  }

  return {
    classOutputs,
    classShapesByName,
    resolveComponentScriptUris,
    anyClassUsesComparisonHelper,
    anyClassUsesSafeNotHelper,
    anyClassUsesStreamHelper,
    anyClassUsesRouter,
    anyClassUsesTaskManager,
    anyClassUsesScaleHelper,
    anyClassUsesRelationalHelper,
    anyClassUsesEnv,
  };
}

/** Kahn's-algorithm-style topological sort of the `.flsh` import graph via DFS, so every class is compiled only after everything it `import`s — cycle-detected the same way a real cycle would be caught (a node revisited while still on the current DFS stack). */
function topoSortFlshFiles(flshByPath: ReadonlyMap<string, FlshBucketed>, resolveFlshImport: (fromPath: string, imp: ImportLike) => FlshBucketed): string[] {
  const order: string[] = [];
  const onStack = new Set<string>();
  const done = new Set<string>();

  function visit(resolvedPath: string, stackNames: readonly string[]): void {
    if (done.has(resolvedPath)) return;
    const { input, classAst } = flshByPath.get(resolvedPath)!;

    if (onStack.has(resolvedPath)) {
      throw new CompileError({
        code: 'class/import-cycle',
        message: `Cyclic .flsh import/extends graph: ${[...stackNames, classAst.name].join(' -> ')}.`,
      });
    }

    onStack.add(resolvedPath);
    for (const imp of classAst.imports) {
      const target = resolveFlshImport(input.path, imp);
      visit(target.resolvedPath, [...stackNames, classAst.name]);
    }
    onStack.delete(resolvedPath);

    done.add(resolvedPath);
    order.push(resolvedPath);
  }

  for (const resolvedPath of flshByPath.keys()) visit(resolvedPath, []);
  return order;
}

/**
 * Resolves an `import <Name> from "<importPath>"` path one of three ways,
 * decided purely by `importPath`'s own shape:
 *
 * 1. Filesystem-absolute (`isAbsolute`, e.g. `/abs/path.flsh` or
 *    `C:\abs\path.flsh`) — used as-is (normalized).
 * 2. `./`- or `../`-prefixed — relative to the *importing* file's own
 *    directory, the only form this ever supported originally.
 * 3. Anything else (e.g. `components/Classes/LabeledCounter.flsh`) —
 *    relative to `srcRoot` instead, so an app author doesn't have to count
 *    `../` segments back out of a deeply nested component just to reach a
 *    shared class near the app's root. `srcRoot` is `compileApp`'s own
 *    caller-supplied second argument (`cli.ts` passes the project's `src/`
 *    directory — see `project-layout.ts`); it's meaningless without a real
 *    filesystem behind it, so pure unit tests that never exercise this path
 *    can safely ignore it (`compileApp`'s default, `'.'`, is never consulted
 *    unless a fixture actually uses a bare path). This is deliberately
 *    `srcRoot`, not `outRoot` — a bare import is a reference between two
 *    source files, resolved before either is compiled.
 */
function resolveImportTargetPath(fromPath: string, importPath: string, srcRoot: string): string {
  if (isAbsolute(importPath)) return resolvePath(importPath);
  if (importPath.startsWith('./') || importPath.startsWith('../')) return resolvePath(dirname(fromPath), importPath);
  return resolvePath(srcRoot, importPath);
}

/** A `<script uri="...">` value: `absoluteBrsPath` made relative to `outRoot` and printed as a `pkg:/`-rooted absolute path (normalized to forward slashes — SceneGraph XML URIs use `/` regardless of host OS, unlike `node:path`'s own separator). `outRoot` is the same directory Roku's own `pkg:/` scheme is rooted at once the app is packaged (every compiled/copied file — `source/`/`components`/`manifest` — lives directly under it, mirroring `srcRoot`'s own shape — see `project-layout.ts`), so this is a real absolute in-package path, not a path relative to whichever component happens to reference it — deliberately chosen over a `./`/`../`-relative URI so a shared runtime asset's `<script uri>` reads identically no matter how deeply nested the referencing component is. `absoluteBrsPath` must itself already be an `outRoot`-based path (see `ownBrsPath` in `compileFlshClasses`, and `safeCompareAbsolutePath`/etc. in `compileApp`) — never a `srcRoot`-based one, or the resulting URI would point at a file the compiler never actually wrote. */
function toScriptUri(outRoot: string, absoluteBrsPath: string): string {
  const rel = relative(outRoot, absoluteBrsPath).replace(/\\/g, '/');
  return `pkg:/${rel}`;
}

/** Re-throws a `CompileError` with its message prefixed by `path`, so a whole-app compile failure still points at the specific file responsible — same diagnostic code, richer message. */
function withPathContext<T>(path: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CompileError && !err.diagnostic.message.startsWith(`${path}: `)) {
      throw new CompileError({ code: err.diagnostic.code, message: `${path}: ${err.diagnostic.message}`, span: err.diagnostic.span });
    }
    throw err;
  }
}

/**
 * The marker-protected bootstrap sub an app author wires into their own
 * `Main.brs` with one hand-written line, right before `CreateScene`:
 * `FlashTheaterSetupGlobals(screen.getGlobalNode())`. Dynamically adds
 * `store`/`theme` as fields on the global node (there's no static
 * declaration for them — the global node's shape is app-specific), each
 * holding a freshly created instance of the relevant component.
 * `storeComponentName`/`themeComponentName`/`focusManagerComponentName`/
 * `routerComponentName`/`taskManagerComponentName` are each either `null`
 * (unused) or their respective fixed constant
 * (`FLASH_THEATER_STORE_COMPONENT_NAME`/`FLASH_THEATER_THEME_COMPONENT_NAME`/
 * `FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME`/`FLASH_THEATER_ROUTER_COMPONENT_NAME`/
 * `FLASH_THEATER_TASK_MANAGER_COMPONENT_NAME`) — none is ever an app-chosen
 * name: each is a copied runtime asset (`runtime-assets/Store`,
 * `runtime-assets/FocusManager`, `runtime-assets/Router`,
 * `runtime-assets/TaskManager`) or, for the theme, a fixed name independent
 * of the app's own `<theme-template>` filename (see `cli.ts`).
 *
 * `envVariables` is the active environment's already-resolved variable map (`null` when no
 * environment is active, or when one is active but no component/class ends up reading `env.*` —
 * see `compileApp`'s `usesEnv` guard) — baked as a literal AA under `ft_env`, not a `CreateObject(...)`
 * instance like the singletons above, since it's fixed data, not a node.
 *
 * The focus manager additionally needs the app's own Scene handed to it
 * (`setSceneRef`) — there's no reliable way for a plain `roSGNode` to
 * discover "the" Scene on its own, so this bootstrap sub can't do it either;
 * that one extra hand-written line lives in the app's own `Main.brs`, right
 * after `CreateScene`, same convention as the single hand-written
 * `FlashTheaterSetupGlobals(...)` call itself. Neither the router nor the
 * task manager needs such an extra line — unlike the focus manager, neither
 * depends on discovering the Scene.
 */
export function emitFlashTheaterGlobalsBrs(
  storeComponentName: string | null,
  themeComponentName: string | null,
  focusManagerComponentName: string | null = null,
  routerComponentName: string | null = null,
  taskManagerComponentName: string | null = null,
  designResolutionWidth: number | null = null,
  envVariables: ReadonlyMap<string, string> | null = null,
): string {
  const lines = ['sub FlashTheaterSetupGlobals(globalNode as object) as void'];
  if (storeComponentName) {
    lines.push(`  globalNode.addFields({ ${GLOBAL_FIELD_NAMES.store}: CreateObject("roSGNode", "${storeComponentName}") })`);
  }
  if (themeComponentName) {
    lines.push(`  globalNode.addFields({ ${GLOBAL_FIELD_NAMES.theme}: CreateObject("roSGNode", "${themeComponentName}") })`);
  }
  if (focusManagerComponentName) {
    lines.push(`  globalNode.addFields({ ${GLOBAL_FIELD_NAMES.focus}: CreateObject("roSGNode", "${focusManagerComponentName}") })`);
  }
  if (routerComponentName) {
    lines.push(`  globalNode.addFields({ ${GLOBAL_FIELD_NAMES.router}: CreateObject("roSGNode", "${routerComponentName}") })`);
  }
  if (taskManagerComponentName) {
    lines.push(`  globalNode.addFields({ ${GLOBAL_FIELD_NAMES.taskManager}: CreateObject("roSGNode", "${taskManagerComponentName}") })`);
  }
  // Computed exactly once, at app boot, before any component's init() runs — every ft_scale(...)
  // call site (codegen/brs-emitter.ts, codegen/class-emitter.ts) reads this same cached field
  // rather than ever recomputing GetDisplaySize() itself. BrightScript's `/` between two Integers
  // is true (float) division, so no `.0` suffix is needed on `designResolutionWidth`.
  if (designResolutionWidth !== null) {
    lines.push(`  globalNode.addFields({ ${GLOBAL_FIELD_NAMES.scaleFactor}: CreateObject("roDeviceInfo").GetDisplaySize().w / ${designResolutionWidth} })`);
  }
  // Baked as a plain literal AA, not a SceneGraph node — unlike Store/Theme/FocusManager/Router,
  // an environment's variables are fixed at compile time and never reassigned at runtime, so there's
  // no primitive to instantiate here, mirroring ft_scaleFactor's own literal-value treatment above.
  if (envVariables && envVariables.size > 0) {
    const entries = [...envVariables.entries()].map(([name, value]) => `${brsStringLiteral(name)}: ${brsStringLiteral(value)}`).join(', ');
    lines.push(`  globalNode.addFields({ ${GLOBAL_FIELD_NAMES.env}: { ${entries} } })`);
  }
  lines.push('end sub');
  return lines.join('\n') + '\n';
}
