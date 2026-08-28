import {
  Block as FlashBlock,
  FlshFile,
  IfStatement,
  ForStatement,
  ForEachStatement,
  WhileStatement,
  TryStatement,
  StateAssignment,
  StoreWriteStatement,
  FocusStatement,
  JumpFocusStatement,
  TernaryAssignmentStatement,
  AnonymousFunctionExpression,
  AnonymousFunctionAssignmentStatement,
  ScaleLocalAssignmentStatement,
  ScaleStateAssignmentStatement,
  reconstructTernaryText,
  parse as parseThrFile,
  parseFlshFile,
  ThrFile,
  parseEmbeddedExpression,
  parseEmbeddedStatements,
  findGlobalPathAccesses,
  findAnonymousFunctionExpressions,
  findAnimationOnFinishCalls,
} from 'flash-parser';
import { CompileError, ThrScriptAst } from './dsl-parser/dsl-ast.js';
import { adaptFlshFile, adaptScriptSection, adaptTemplateSection } from './dsl-parser/dsl-parser.js';
import { buildDependencyGraph } from './analysis/dependency-graph.js';
import { buildScriptBindings, ScriptBindings } from './analysis/scope-resolution.js';
import { checkDuplicateBindingNames, checkDuplicateElementIds, checkEachItemAliasCollisions, checkElementIdCollisions, checkReservedIdentifierPrefix, checkReservedGlobalFunctionNames } from './analysis/binding-collisions.js';
import { checkDerivedTypes } from './analysis/derived-type-check.js';
import { checkBindTargets, collectBindTargets } from './analysis/bind-targets.js';
import { checkAndGroupKeyBindings, checkComponentKeyBindings, collectKeyBindingAttributes } from './analysis/key-bindings.js';
import { checkAtMostOneDefaultFocus, checkNestedFocusableConflicts, collectFocusableElements } from './analysis/focusable-elements.js';
import { checkReservedFocusStateNames, collectUsedFocusStateNames, synthesizeFocusStateFields } from './analysis/focus-state.js';
import { checkDuplicateClassMemberNames, checkOverrideCoherence } from './analysis/class-analysis.js';
import { buildClassShape, ClassShape } from './analysis/class-shape.js';
import { GlobalBindingsContext, ThemeShape } from './analysis/global-bindings.js';
import { analyzeTemplateBindings, collectElementIds, TemplateAttributeBinding } from './codegen/template-bindings.js';
import { analyzeTemplateBlocks, ConditionalBlock } from './analysis/conditional-blocks.js';
import { EachBlock } from './codegen/each-block-emitter.js';
import { emitXml } from './codegen/xml-emitter.js';
import { emitBrs } from './codegen/brs-emitter.js';
import {
  isTaskManagerOnAlertChangedStatement,
  isTaskManagerOnResultStatement,
  isTaskManagerOnRequestSentStatement,
  isTaskManagerOnResponseReceivedStatement,
  isTimerCallStatement,
} from './analysis/identifier-rewrite.js';
import { compileClass, CompiledClass } from './codegen/class-emitter.js';
import { validateGeneratedBrs, GeneratedBrsValidationError } from './validate-generated-brs.js';
import { parseRequestConfig } from './analysis/request-config.js';
import { parseAnimationConfig, collectEffectiveTargetIds, ParsedAnimationStep } from './analysis/animation-config.js';
import { resolveBlockTransitions, stepHasRepeat } from './analysis/transitions.js';
import { resolveOutletTransitions } from './analysis/router-transitions.js';
import { resolveAnimateBindings } from './analysis/animate-bindings.js';
import { checkFieldStateDefaultLiterals } from './analysis/field-state-literals.js';
import { requestInterfaceFields, requestDeclaresBuildRequest, PREPARE_REQUEST_FUNCTION_NAME } from './codegen/request-emitter.js';
import { UNMOUNT_FUNCTION_NAME, usesRuntimeHelperCall, ROUTE_READY_FIELD_NAME } from './codegen/naming.js';
import { emitAnimationXml, ScaledInterpolatorRef, RefreshableInterpolatorRef } from './codegen/animation-emitter.js';
import { GLOBAL_FIELD_NAMES } from './codegen/global-fields.js';

const NO_DESTROY_MODE_TARGET_IDS: ReadonlySet<string> = new Set();

const ROUTER_ROOT_NAME = ['router'] as const;
const TASK_MANAGER_ROOT_NAME = ['taskManager'] as const;

export interface CompiledThrFile {
  componentName: string;
  xml: string;
  brs: string;
  /** True if this component uses the store at all (`read`/`watch`/`store(...)` write) — decides whether `app-compiler.ts` needs to wire the built-in runtime Store component into the app's globals. */
  usesStore: boolean;
  /** True if this component has at least one `focusable`-bearing element OR calls `focus(...)`/`jumpFocus(...)` anywhere (a component can redirect focus elsewhere without registering any focusable content of its own) — decides whether `app-compiler.ts` needs to wire the built-in runtime `FlashTheaterFocusManager` into the app's globals, mirroring `usesStore` exactly. */
  usesFocusSystem: boolean;
  /** True if this component reads or calls `router.*` anywhere — a function body (including nested inside `if`/`else`, or inside a `state`/`store(...)`/`focus(...)` statement's own right-hand side), a `derived` expression, a dynamic template attribute, or an `{#if}`/`{#if:destroy}`/`{#each}` block's own condition/collection/key expression. Unlike `store`/`focus`, `router` has no dedicated flash-parser statement/keyword of its own (`router.navigate(...)`/`router.back()`/etc. are ordinary BrightScript dot-chain calls, resolved by `analysis/global-bindings.ts`'s `resolveRouterPath` — see GRAMMAR.md's "Router" section), so this can't reuse `scriptUsesFocus`'s `instanceof FocusStatement` walk; it re-parses each raw text surface instead (cheap — `parseEmbeddedExpression`/`parseEmbeddedStatements` are memoized by exact text). Decides whether `app-compiler.ts` wires `FlashTheaterRouter`/`FlashTheaterRouterOutlet` into the app's globals, mirroring `usesStore`/`usesFocusSystem`. */
  usesRouter: boolean;
  /** True if this component reads or calls `taskManager.*` anywhere — same detection shape as `usesRouter` (no dedicated flash-parser grammar of its own; a raw-text re-scan via `findGlobalPathAccesses` across every expression surface), gated by `app-compiler.ts` to decide whether to wire the built-in runtime `FlashTheaterTaskManager` into the app's globals. See GRAMMAR.md's "Task manager" section. */
  usesTaskManager: boolean;
  /** True if this component's own compiled `.brs` calls `ft_equals(` (an `==`/`!=` DSL comparison lowered somewhere) — decided directly from the emitted output, not a separate pre-scan (unlike `usesRouter`), since `brs` is already fully computed by the time this is checked. `app-compiler.ts` uses this (together with whether any transitively-imported `.flsh` class needs it) to decide whether to add a `<script uri="...">` pointing at `runtime-assets/SafeCompare/FlashTheaterSafeCompare.brs` to this component's own XML. */
  usesComparisonHelper: boolean;
  /** True if this component's own compiled `.brs` calls `ft_not(` (a `!` DSL safe-NOT lowered somewhere) — same detection/wiring shape as `usesComparisonHelper`, just pointing `app-compiler.ts` at `runtime-assets/SafeNot/FlashTheaterSafeNot.brs` instead of SafeCompare's asset. */
  usesSafeNotHelper: boolean;
  /** True if this component's own compiled `.brs` calls `ft_createStream(` (a declared `stream` — see GRAMMAR.md's "stream" section) — same detection/wiring shape as `usesComparisonHelper`, just pointing `app-compiler.ts` at `runtime-assets/Stream/FlashTheaterStream.brs` instead of SafeCompare's asset. */
  usesStreamHelper: boolean;
  /** True when this component declares `request Http { ... }` — computed structurally off `script.request?.requestKind`, not a text scan (unlike `usesStreamHelper`), since it's driven by exactly one AST node, not an arbitrary call pattern. Decides whether `app-compiler.ts` needs to wire `runtime-assets/Http/FlashTheaterHttp.brs` into this component's own `<script>` list. See GRAMMAR.md's "Requests" section. */
  usesHttpRequestHelper: boolean;
  /** True if this component's own compiled `.brs` calls `ft_scale(` (a `scale`-flagged field/state/derived/watch/read declaration, or a `scale`-prefixed function-body assignment — see GRAMMAR.md's "scale" section) — same detection/wiring shape as `usesComparisonHelper`/`usesStreamHelper`, pointing `app-compiler.ts` at `runtime-assets/Scale/FlashTheaterScale.brs`. */
  usesScaleHelper: boolean;
  /** True if this component's own compiled `.brs` calls `ft_relationalGuard(` (a `<`/`>`/`<=`/`>=` DSL relational comparison lowered somewhere) — same detection/wiring shape as `usesComparisonHelper`, just pointing `app-compiler.ts` at `runtime-assets/SafeRelational/FlashTheaterSafeRelational.brs` (its own dedicated asset, not folded into SafeCompare's) instead. */
  usesRelationalHelper: boolean;
  /**
   * True if this component's own compiled `.brs` references `m.global.ft_env`/`ft_globalAA.global.ft_env`
   * (an `env.*` DSL access) — decided directly from the already-emitted output, same as
   * `usesComparisonHelper`, NOT a pre-emission raw-text scan like `usesRouter`/`usesTaskManager`: `env`
   * has no init-time registration, no unmount hook, and no codegen-ordering dependency, so this is
   * always safe to compute after the fact. See GRAMMAR.md's "Environments" section.
   */
  usesEnv: boolean;
}

const NO_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };

/**
 * Optional knobs for {@link compileThrSource}, beyond the two args every caller always supplies
 * (`source`, `componentName`) — same "required positional params + one bundled options object"
 * shape as `codegen/xml-emitter.ts`'s own `EmitXmlOptions`, so a future runtime-asset feature (a
 * 7th Pattern-B helper uri, say) adds one more named field here instead of a new positional
 * parameter.
 */
export interface CompileThrOptions {
  /**
   * The app's `theme` shape and whether the store is used anywhere, if either. Defaults to
   * "neither". This validation is inherently cross-file, so it can only be supplied by a caller
   * that has already scanned the whole app (`app-compiler.ts`'s `compileApp`); `compileThrSource`
   * itself stays pure and filesystem-free (see findings/compiler-pipeline-and-build.md's "no `fs` inside
   * `compile.ts`" rule), taking that context as plain data instead of discovering it itself.
   */
  globalBindings?: GlobalBindingsContext;
  /**
   * Same cross-file story as `globalBindings`, for `import` — resolving a `.thr` file's `import
   * <Class> from "..."` to a real `.flsh` file (and collecting that class's own transitive
   * imports) is inherently cross-file too, so `app-compiler.ts` resolves it and passes the final,
   * deduped, already-relative-to-this-component `<script uri="...">` list straight through to
   * `emitXml`. A bare `import`ed class *name* still resolves fine inside a function body without
   * this (see `analysis/scope-resolution.ts`'s `importedClassNames` bucket, built from
   * `script.imports` alone) — this option only affects the generated XML's `<script>` tags.
   * Defaults to none.
   */
  extraScriptUris?: readonly string[];
  /**
   * Opts into `validate-generated-brs.ts`'s post-codegen check — parsing the generated `.brs` as
   * real BrightScript and throwing `GeneratedBrsValidationError` if it doesn't parse cleanly.
   * Defaults to `false`: re-parsing every generated file is pure overhead on a production compile
   * once codegen is trusted; meant for tests/CI, see that module's own doc comment.
   */
  validateOutput?: boolean;
  /**
   * The same cross-file story as `extraScriptUris`, just for a single fixed asset instead of a
   * per-`import` list: `app-compiler.ts` is the only caller that can compute a real
   * filesystem-relative `<script uri="...">` string pointing at
   * `runtime-assets/SafeCompare/FlashTheaterSafeCompare.brs` (`compileThrSource` stays pure and
   * filesystem-free, per findings/compiler-pipeline-and-build.md's "no `fs` inside `compile.ts`" rule),
   * so it's passed in unconditionally — `compileThrSource` decides for itself, AFTER computing
   * `brs`, whether to actually splice it into the component's own `<script>` list (only when `brs`
   * itself calls `ft_equals(`; seeing the uri passed in is not by itself a reason to include it —
   * most components never emit a comparison at all). Defaults to `null`.
   */
  safeCompareScriptUri?: string | null;
  /**
   * Same story as `safeCompareScriptUri`, pointing at
   * `runtime-assets/Stream/FlashTheaterStream.brs` — spliced in only when this component actually
   * needs it (`usesStreamHelper`, computed below). Defaults to `null`.
   */
  streamHelperScriptUri?: string | null;
  /**
   * Same story as `safeCompareScriptUri`, pointing at `runtime-assets/Http/FlashTheaterHttp.brs` —
   * spliced in only when this component actually needs it (`usesHttpRequestHelper`, computed
   * below). Defaults to `null`.
   */
  httpRequestHelperScriptUri?: string | null;
  /**
   * Same story as `safeCompareScriptUri`, pointing at `runtime-assets/Scale/FlashTheaterScale.brs`
   * — spliced in only when this component actually needs it (`usesScaleHelper`, computed below).
   * Defaults to `null`.
   */
  scaleHelperScriptUri?: string | null;
  /**
   * Same story as `safeCompareScriptUri`, pointing at
   * `runtime-assets/SafeNot/FlashTheaterSafeNot.brs` — spliced in only when this component
   * actually needs it (`usesSafeNotHelper`, computed below). Defaults to `null`.
   */
  safeNotScriptUri?: string | null;
  /**
   * Same story as `safeCompareScriptUri`, pointing at
   * `runtime-assets/SafeRelational/FlashTheaterSafeRelational.brs` (its own dedicated asset, not
   * folded into SafeCompare's) — spliced in only when this component actually needs it
   * (`usesRelationalHelper`, computed below). Defaults to `null`.
   */
  relationalHelperScriptUri?: string | null;
  /**
   * The whole app's `.flsh` class member table, keyed by class name (`app-compiler.ts`'s
   * `compileFlshClasses` builds it once, app-wide, after class-import topological compilation
   * finishes — a genuine class-name collision across two unrelated `.flsh` files is excluded from
   * the map entirely there, never arbitrarily resolved to one of them) —
   * `analysis/derived-type-check.ts`'s `checkDerivedTypes` uses it to resolve a `derived`
   * expression's `ClassName(...).methodName(...)` call to that method's own declared return type.
   * Defaults to `undefined` when this file is compiled standalone (a unit test with no app-wide
   * class context) — class-method calls in a `derived` expression simply fall back to "unknown"
   * (unchecked) in that case, the same as a call to an unresolvable name.
   */
  classShapesByName?: ReadonlyMap<string, ClassShape>;
}

/**
 * Orchestrates the full pipeline for a single .thr file: flash-parser's
 * single `parse()` call (the `<script>`/template split, the DSL grammar,
 * and the template markup, all in one lossless CST) → adapt into
 * `ThrScriptAst`/`ThrTemplateAst` → dependency graph → codegen. Throws
 * `CompileError` (see dsl-parser/dsl-ast.ts) on the first diagnostic —
 * the compiler does not accumulate multiple diagnostics at once, see
 * GRAMMAR.md.
 *
 * See {@link CompileThrOptions} for the optional knobs beyond `source`/`componentName` — each
 * field there is independently documented (same convention as `EmitXmlOptions`).
 */
export function compileThrSource(source: string, componentName: string, options: CompileThrOptions = {}): CompiledThrFile {
  const {
    globalBindings = NO_GLOBAL_BINDINGS,
    extraScriptUris = [],
    validateOutput = false,
    safeCompareScriptUri = null,
    streamHelperScriptUri = null,
    httpRequestHelperScriptUri = null,
    scaleHelperScriptUri = null,
    safeNotScriptUri = null,
    relationalHelperScriptUri = null,
    classShapesByName,
  } = options;

  const parseResult = parseThrFile(source);

  if (parseResult.diagnostics.length > 0) {
    const first = parseResult.diagnostics[0];
    throw new CompileError({ code: first.code, message: first.message, span: { line: first.line } });
  }

  const file = new ThrFile(parseResult.root);
  const rawScript = adaptScriptSection(file.script);
  const template = adaptTemplateSection(file.template!);

  checkFieldStateDefaultLiterals(rawScript);

  if (file.script.requests.length > 1) {
    throw new CompileError({
      code: 'request/multiple-request-declarations',
      message: `A component may declare at most one request {} — found ${file.script.requests.length}.`,
    });
  }

  const requestConfig = rawScript.request ? parseRequestConfig(rawScript.request, `request ${rawScript.request.requestKind} {} declaration`) : null;
  if (requestConfig && template.extends !== 'Task') {
    throw new CompileError({
      code: 'request/declaration-requires-task-extends',
      message: `request Http {} requires <component extends="Task"> — found extends="${template.extends ?? 'Group'}".`,
    });
  }

  // Must run before buildScriptBindings: `isFocused`/`isInFocusChain` become real, ordinary fields
  // whenever this component reads them, so every stage below (scope resolution, the derived
  // dependency graph, the XML <field> list, the change-cascade) sees them as declared fields and
  // needs no special-casing at all. A component that reads neither gets nothing synthesized — see
  // analysis/focus-state.ts.
  checkReservedFocusStateNames(rawScript);
  const usedFocusStateNames = collectUsedFocusStateNames(rawScript, template.root);
  const script = synthesizeFocusStateFields(rawScript, usedFocusStateNames);

  const scriptBindings = buildScriptBindings(script);
  checkDuplicateBindingNames(scriptBindings);
  checkDerivedTypes(script, classShapesByName);

  const { conditional: conditionalBlocks, each: eachBlocks } = analyzeTemplateBlocks(template.root);

  const elementIds = collectElementIds(template.root, conditionalBlocks.syntheticParentIds);
  checkDuplicateElementIds(elementIds);
  checkElementIdCollisions(elementIds, scriptBindings);
  checkReservedIdentifierPrefix(script, scriptBindings, elementIds, eachBlocks.blocks.map((b) => b.itemAlias));
  checkReservedGlobalFunctionNames(script, scriptBindings);
  checkEachItemAliasCollisions(eachBlocks, scriptBindings, elementIds);
  const bindTargets = checkBindTargets(collectBindTargets(template.root), scriptBindings, eachBlocks);
  const keyBindings = checkAndGroupKeyBindings(collectKeyBindingAttributes(template.root), eachBlocks);
  const componentKeyBindings = checkComponentKeyBindings(template.onKeyAttributes);
  const focusableElements = collectFocusableElements(template.root);
  checkNestedFocusableConflicts(template.root);
  checkAtMostOneDefaultFocus(focusableElements);

  const elementIdSetForAnimations = new Set(elementIds);
  const animationConfigs = script.animations.map((a) => parseAnimationConfig(a, elementIdSetForAnimations, `animation ${a.name} {} declaration`));
  const animationConfigsByName = new Map(animationConfigs.map((c) => [c.name, c]));
  const resolvedBlockTransitions = resolveBlockTransitions(template.root, conditionalBlocks, animationConfigsByName);
  const resolvedOutletTransitions = resolveOutletTransitions(template.root, animationConfigsByName);
  const animateBindings = resolveAnimateBindings(template.root);

  // Every declared `animation` name with at least one `.onFinish(...)` registration anywhere in the
  // script — see `scriptAnimationOnFinishNames`'s own doc comment. Threaded into `emitBrs` so
  // `codegen/conditional-block-emitter.ts`'s shared per-name state-change handler knows which names
  // need the callback-invoking tail, in addition to (or instead of) any Layer 2 exit-transition
  // consumer. Checked here, rather than in `identifier-rewrite.ts`'s onFinish splice, because it needs
  // the animation's own parsed step tree (`animationConfigsByName`), which that module never receives.
  const animationOnFinishNames = scriptAnimationOnFinishNames(script, scriptBindings);
  for (const name of animationOnFinishNames) {
    const config = animationConfigsByName.get(name)!;
    if (stepHasRepeat(config.step)) {
      throw new CompileError({
        code: 'animation/repeat-not-supported-with-onfinish',
        message: `The animation "${name}" declares "repeat: true" somewhere in its own step tree — an animation must actually finish (report state="stopped") for its ".onFinish(...)" callback to ever run, and a repeating animation never does on its own. Remove "repeat: true" from "${name}", or remove its ".onFinish(...)" registration.`,
      });
    }
  }

  const graph = buildDependencyGraph(script, scriptBindings, globalBindings);
  const bindings = analyzeTemplateBindings(template, scriptBindings, graph, globalBindings, conditionalBlocks, eachBlocks);

  // `prepareRequest` is compiler-synthesized, never a `script.functions` entry the DSL author
  // wrote — appended here rather than folded into the ordinary public-function scan below. It only
  // exists when `buildRequest` is declared (see request-emitter.ts's `emitRequestGeneratedFunctions`
  // doc comment for why); `<function name="...">` is required for `task.callFunc("prepareRequest",
  // ...)` to find it at all — an undeclared interface function is not just a naming gotcha the way
  // observeFieldScoped's string target is, callFunc simply cannot reach it.
  const requestHasBuildRequest = requestConfig?.requestKind === 'Http' && requestDeclaresBuildRequest(script);
  // ft_unmount is unconditional on EVERY component, unlike prepareRequest above — see naming.ts's
  // UNMOUNT_FUNCTION_NAME doc comment for why leaf-gating this hook would be unsound, not just leaner.
  const interfaceFunctions = [...script.functions.filter((f) => f.visibility === 'public').map((f) => f.name), ...(requestHasBuildRequest ? [PREPARE_REQUEST_FUNCTION_NAME] : []), UNMOUNT_FUNCTION_NAME];

  // Computed once, up front, so the SAME `scaledInterpolatorRefs`/per-block refresh-ref lists (and
  // the ids assigned while building them) reach both `emitBrs` (the runtime `ft_scale(...)`
  // overrides, and — via the enriched `blockTransitions` below — the `fieldToInterp` refresh lines
  // `conditional-block-emitter.ts` emits at each create/hide call site) and `emitXml`'s
  // `extraChildrenXml` below (the actual `id="..."` attributes on the interpolator nodes) — see
  // `codegen/animation-emitter.ts`'s `emitAnimationXml` doc comment for why calling it twice with
  // the same config is safe (deterministic ids) rather than fragile to keep in sync.
  const scaledInterpolatorRefs: ScaledInterpolatorRef[] = [];

  // Every id, anywhere in `step`'s own tree, that resolves inside a `{#if:destroy}` block — the set
  // an interpolator's own `fieldToInterp` refresh treatment is gated on (see
  // `codegen/animation-emitter.ts`'s `RefreshableInterpolatorRef` doc comment). Shared by both
  // Layer 1 declarations and Layer 2 transitions below — a transition's own target is normally just
  // `t.targetElementId`, but a `transition:myCustomAnim` reusing a DECLARED animation's own step
  // tree can carry its own, independently-declared target(s), so this is computed the same
  // general way for both rather than assumed to be a single id.
  function destroyModeTargetIdsFor(step: ParsedAnimationStep): ReadonlySet<string> {
    const ids = [...collectEffectiveTargetIds(step, null)].filter((id) => conditionalBlocks.nearestDestroyAncestorById.has(id));
    return ids.length > 0 ? new Set(ids) : NO_DESTROY_MODE_TARGET_IDS;
  }

  // A `{#if:destroy}` block's own `in:`/`out:` interpolators need a `fieldToInterp` refresh before
  // every `.control = "start"` — see `ResolvedBlockTransition.isDestroyMode`'s own doc comment for
  // why (Roku caches the fieldToInterp target resolution on first use; a `{#if:destroy}` block's
  // target node is destroyed and recreated on every cycle, so that cached resolution goes stale).
  // `{#if}` (toggle mode) never destroys its target, so it needs no such refresh — the target-id set
  // stays empty there, and `emitAnimationXml` is called exactly like any other (no refreshRefs
  // collected). Each block gets its OWN `inRefreshRefs`/`outRefreshRefs` array (not one shared list)
  // so `conditional-block-emitter.ts` can look up exactly the refs belonging to ITS OWN block's
  // create/hide call sites, without having to filter a flat cross-component list itself.
  const blockTransitions = new Map(
    [...resolvedBlockTransitions.entries()].map(([blockId, t]) => {
      const inRefreshRefs: RefreshableInterpolatorRef[] = [];
      const outRefreshRefs: RefreshableInterpolatorRef[] = [];
      const inDestroyModeTargetIds = t.isDestroyMode && t.inConfig ? destroyModeTargetIdsFor(t.inConfig.step) : NO_DESTROY_MODE_TARGET_IDS;
      const outDestroyModeTargetIds = t.isDestroyMode && t.outConfig ? destroyModeTargetIdsFor(t.outConfig.step) : NO_DESTROY_MODE_TARGET_IDS;
      if (t.inConfig) emitAnimationXml(t.inConfig, 2, scaledInterpolatorRefs, inDestroyModeTargetIds, inRefreshRefs);
      if (t.outConfig) emitAnimationXml(t.outConfig, 2, scaledInterpolatorRefs, outDestroyModeTargetIds, outRefreshRefs);
      return [blockId, { ...t, inRefreshRefs, outRefreshRefs }];
    }),
  );

  // Layer 1 `animation {}` declarations get the exact same treatment as a destroy-mode transition
  // above, except keyed by ANIMATION NAME rather than block id — a Layer 1 `.start()` has no fixed
  // codegen call site the way a transition's create/hide sub does (it's an ordinary statement,
  // callable from anywhere in the script), so `identifier-rewrite.ts`'s `rewriteAnimationControlCalls`
  // looks this map up (via `scriptBindings.animationFieldRefreshByName`, spread in below) and injects
  // the refresh lines at EVERY `.start()` call site for a name with a non-empty entry — see that
  // function's own doc comment. An animation with no destroy-mode target at all gets no entry here,
  // the ordinary case, completely unaffected by this.
  const layer1RefreshRefsByName = new Map<string, readonly RefreshableInterpolatorRef[]>();
  const layer1DestroyModeTargetIdsByName = new Map(animationConfigs.map((c) => [c.name, destroyModeTargetIdsFor(c.step)] as const));
  for (const config of animationConfigs) {
    const destroyModeTargetIds = layer1DestroyModeTargetIdsByName.get(config.name)!;
    if (destroyModeTargetIds.size === 0) continue;
    const refreshRefs: RefreshableInterpolatorRef[] = [];
    emitAnimationXml(config, 2, scaledInterpolatorRefs, destroyModeTargetIds, refreshRefs);
    layer1RefreshRefsByName.set(config.name, refreshRefs);
  }
  // `scriptBindings` was already built (needed by several earlier analysis steps above, none of
  // which care about animation-refresh data) before the template/conditional-block analysis this
  // map depends on existed — so it's threaded into `emitBrs` as an augmented copy, not the original,
  // the one field on `ScriptBindings` built outside `analysis/scope-resolution.ts` (see that
  // interface's own doc comment on `animationFieldRefreshByName`).
  const scriptBindingsForBrs = { ...scriptBindings, animationFieldRefreshByName: layer1RefreshRefsByName };

  const animationXmlLines = [
    ...animationConfigs.flatMap((c) => emitAnimationXml(c, 2, scaledInterpolatorRefs, layer1DestroyModeTargetIdsByName.get(c.name))),
    ...[...blockTransitions.values()].flatMap((t) => [
      ...(t.inConfig ? emitAnimationXml(t.inConfig, 2, scaledInterpolatorRefs, t.isDestroyMode ? destroyModeTargetIdsFor(t.inConfig.step) : NO_DESTROY_MODE_TARGET_IDS) : []),
      ...(t.outConfig ? emitAnimationXml(t.outConfig, 2, scaledInterpolatorRefs, t.isDestroyMode ? destroyModeTargetIdsFor(t.outConfig.step) : NO_DESTROY_MODE_TARGET_IDS) : []),
    ]),
    ...[...animateBindings.values()].flatMap((a) => emitAnimationXml(a.config, 2, scaledInterpolatorRefs)),
    // A router-outlet transition's own target is always the outlet itself (never destroyed/recreated
    // by this feature — see analysis/router-transitions.ts), so no destroy-mode target set is needed.
    ...[...resolvedOutletTransitions.values()].flatMap((t) => [t.navigateOut, t.navigateIn, t.backOut, t.backIn].flatMap((c) => (c ? emitAnimationXml(c, 2, scaledInterpolatorRefs) : []))),
  ];

  const brs = emitBrs(
    script,
    template,
    graph,
    bindings,
    scriptBindingsForBrs,
    componentName,
    bindTargets,
    globalBindings,
    conditionalBlocks,
    eachBlocks,
    keyBindings,
    focusableElements,
    componentKeyBindings,
    usedFocusStateNames.length > 0,
    scriptUsesTaskManagerAlertCallback(script),
    scriptUsesTaskManagerResultCallback(script),
    scriptUsesTaskManagerRequestSentCallback(script),
    scriptUsesTaskManagerResponseReceivedCallback(script),
    requestConfig,
    blockTransitions,
    animateBindings,
    scaledInterpolatorRefs,
    scriptUsesTimer(script),
    animationOnFinishNames,
    resolvedOutletTransitions,
    usesTaskManagerRunAnywhere(script, bindings.all, conditionalBlocks.blocks, eachBlocks.blocks),
  );
  if (validateOutput) {
    const result = validateGeneratedBrs(brs);
    if (!result.valid) throw new GeneratedBrsValidationError(componentName, result);
  }

  const usesComparisonHelper = usesRuntimeHelperCall(brs, 'ft_equals');
  const usesSafeNotHelper = usesRuntimeHelperCall(brs, 'ft_not');
  const usesStreamHelper = usesRuntimeHelperCall(brs, 'ft_createStream');
  const usesHttpRequestHelper = requestConfig?.requestKind === 'Http';
  const usesScaleHelper = usesRuntimeHelperCall(brs, 'ft_scale');
  const usesRelationalHelper = usesRuntimeHelperCall(brs, 'ft_relationalGuard');
  const usesEnv = brs.includes(GLOBAL_FIELD_NAMES.env);
  if (usesScaleHelper && !globalBindings.designResolutionConfigured) {
    throw new CompileError({
      code: 'dsl/scale-requires-config',
      message: `Component "${componentName}" uses "scale" but no flash-theater.config.json with a valid "designResolution" ("hd"/"fhd") was found — scale's meaning depends on knowing which resolution your sizes were authored for.`,
    });
  }
  const scriptUris = Array.from(
    new Set([
      ...extraScriptUris,
      ...(usesComparisonHelper && safeCompareScriptUri ? [safeCompareScriptUri] : []),
      ...(usesSafeNotHelper && safeNotScriptUri ? [safeNotScriptUri] : []),
      ...(usesStreamHelper && streamHelperScriptUri ? [streamHelperScriptUri] : []),
      ...(usesHttpRequestHelper && httpRequestHelperScriptUri ? [httpRequestHelperScriptUri] : []),
      ...(usesScaleHelper && scaleHelperScriptUri ? [scaleHelperScriptUri] : []),
      ...(usesRelationalHelper && relationalHelperScriptUri ? [relationalHelperScriptUri] : []),
    ]),
  );

  return {
    componentName,
    xml: emitXml(script, template, bindings.sourcesNeedingCascade, componentName, {
      extends: template.extends ?? undefined,
      extraScriptUris: scriptUris,
      conditionalBlocks,
      eachBlocks,
      interfaceFunctions,
      // ft_routeReady is unconditional on EVERY component, same "leaf-gating would be unsound"
      // reasoning as UNMOUNT_FUNCTION_NAME above — a component's own template can't statically know
      // whether it'll end up mounted under a loadingComponent-gated <FlashTheaterRouterOutlet>. See
      // naming.ts's ROUTE_READY_FIELD_NAME doc comment.
      //
      // Default is `false`, not `true` — FlashTheaterRouterOutlet.brs's own _mountRouteImmediate
      // reads this field, right after calling setup(), to tell "setup() already called
      // router.markReady() synchronously" apart from "never called it, still at its untouched
      // default". A `true` default made those two cases indistinguishable (both would read `true`
      // after setup() returns), which is exactly what caused a live bug: a synchronous
      // router.markReady() call always got silently lost, because the field already read `true`
      // before the gate had even started observing it. See findings/router-transitions.md.
      extraInterfaceFields: [...requestInterfaceFields(requestConfig !== null), { id: ROUTE_READY_FIELD_NAME, type: 'boolean', value: 'false' }],
      extraChildrenXml: animationXmlLines,
    }),
    brs,
    usesStore: scriptUsesStore(script),
    // Reading isFocused/isInFocusChain needs the focus manager wired into the app's globals just
    // as much as declaring a focusable element does — the component subscribes to it at init().
    usesFocusSystem: focusableElements.length > 0 || scriptUsesFocus(script) || usedFocusStateNames.length > 0,
    usesRouter: usesRouterAnywhere(script, bindings.all, conditionalBlocks.blocks, eachBlocks.blocks),
    // A `request {}` component's generated ft_runRequest()/init() reaches m.global.ft_taskManager
    // implicitly (result/error observation, interceptors — see the approved plan), invisibly to
    // usesTaskManagerAnywhere's own raw-text scan, exactly like usesFocusSystem's bare focus() gap.
    usesTaskManager: usesTaskManagerAnywhere(script, bindings.all, conditionalBlocks.blocks, eachBlocks.blocks) || requestConfig !== null,
    usesComparisonHelper,
    usesSafeNotHelper,
    usesStreamHelper,
    usesHttpRequestHelper,
    usesScaleHelper,
    usesRelationalHelper,
    usesEnv,
  };
}

export interface CompiledFlshFile {
  compiled: CompiledClass;
  /** This class's own member table (own ∪ inherited from `baseShape`) — the caller (`app-compiler.ts`) threads this back in as `baseShape` for whichever class(es) `extends` this one, in topological order. */
  shape: ClassShape;
}

/**
 * Orchestrates the full pipeline for a single `.flsh` file: flash-parser's
 * `parseFlshFile()` (bare `import`/`class`, no `<script>` wrapper, no
 * template) → adapt into `ThrClassAst` → member/override validation →
 * BRS-only codegen (`codegen/class-emitter.ts` — no XML, no `<interface>`,
 * a class has nothing SceneGraph-shaped about it). Throws `CompileError` on
 * the first diagnostic, same "first error wins" policy as
 * `compileThrSource`.
 *
 * `baseShape` is this class's resolved base class's own `ClassShape` (from
 * a prior `compileFlshSource` call in the same app-compile pass) — `null`
 * for a non-extending class. Resolving *which* file a `class X extends Y`'s
 * `Y` refers to is inherently cross-file (an `import Y from "..."`
 * statement elsewhere), so — exactly like `compileThrSource`'s
 * `globalBindings` — that resolution happens in `app-compiler.ts`, never
 * here; this function stays pure and filesystem-free.
 *
 * `validateOutput` — see `compileThrSource`'s own doc comment; same opt-in
 * post-codegen check, applied to the generated class `.brs`.
 *
 * `themeShape` — the app's theme shape (or `null` if the app has no `<theme-template>`), so a class
 * body's `theme.*` reads resolve the same way `app-compiler.ts` threads it through for `.thr`
 * components. Exactly like `baseShape`, this is inherently cross-file (theme presence is app-wide,
 * resolved once in `app-compiler.ts`), so this function stays pure and filesystem-free otherwise.
 */
export function compileFlshSource(source: string, baseShape: ClassShape | null, validateOutput = false, themeShape: ThemeShape | null = null): CompiledFlshFile {
  const parseResult = parseFlshFile(source);

  if (parseResult.diagnostics.length > 0) {
    const first = parseResult.diagnostics[0];
    throw new CompileError({ code: first.code, message: first.message, span: { line: first.line } });
  }

  const file = new FlshFile(parseResult.root);
  const classAst = adaptFlshFile(file);

  checkDuplicateClassMemberNames(classAst, baseShape);
  checkOverrideCoherence(classAst, baseShape);

  const shape = buildClassShape(classAst, baseShape);
  const compiled = compileClass(classAst, shape, baseShape, themeShape);

  if (validateOutput) {
    const result = validateGeneratedBrs(compiled.brs);
    if (!result.valid) throw new GeneratedBrsValidationError(compiled.className, result);
  }

  return { compiled, shape };
}

/** True if `script` reads (`read`/`watch`) or writes (`store(...)`, anywhere in a function body — including nested inside `if`/`else`) the store at all. */
function scriptUsesStore(script: ThrScriptAst): boolean {
  if (script.reads.length > 0 || script.watches.length > 0) return true;
  return script.functions.some((f) => blockHasStoreWrite(f.block));
}

function blockHasStoreWrite(block: FlashBlock): boolean {
  return block.statements.some((s) => {
    if (s instanceof StoreWriteStatement) return true;
    if (s instanceof IfStatement) return ifHasStoreWrite(s);
    if (s instanceof ForStatement || s instanceof ForEachStatement || s instanceof WhileStatement) return blockHasStoreWrite(s.body);
    if (s instanceof TryStatement) return blockHasStoreWrite(s.tryBlock) || blockHasStoreWrite(s.catchClause.body);
    if (s instanceof StateAssignment) return s.rhs instanceof AnonymousFunctionExpression && blockHasStoreWrite(s.rhs.block);
    if (s instanceof AnonymousFunctionAssignmentStatement) return blockHasStoreWrite(s.value.block);
    // A Tier-2 anonymous function nested in this statement's own expression text (a `focus(...)`
    // argument, a ternary branch, or an opaque call-argument in a `StatementRegion`) has its own
    // separately-parsed body, invisible to any plain text scan — see
    // `anyNestedAnonymousFunctionSatisfies`'s own doc comment.
    if (s instanceof FocusStatement) return anyNestedAnonymousFunctionSatisfies(s.expression, 'expression', blockHasStoreWrite);
    if (s instanceof JumpFocusStatement) {
      return (
        anyNestedAnonymousFunctionSatisfies(s.directionExpression, 'expression', blockHasStoreWrite) ||
        anyNestedAnonymousFunctionSatisfies(s.countExpression, 'expression', blockHasStoreWrite) ||
        anyNestedAnonymousFunctionSatisfies(s.pressExpression, 'expression', blockHasStoreWrite)
      );
    }
    if (s instanceof TernaryAssignmentStatement) return anyNestedAnonymousFunctionSatisfies(reconstructTernaryText(s.rhs), 'expression', blockHasStoreWrite);
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) return s.rhs instanceof AnonymousFunctionExpression && blockHasStoreWrite(s.rhs.block);
    return anyNestedAnonymousFunctionSatisfies(s.text, 'statement', blockHasStoreWrite);
  });
}

function ifHasStoreWrite(stmt: IfStatement): boolean {
  if (stmt.thenBlock && blockHasStoreWrite(stmt.thenBlock)) return true;
  const clause = stmt.elseClause;
  if (!clause) return false;
  if (clause.block && blockHasStoreWrite(clause.block)) return true;
  if (clause.elseIf) return ifHasStoreWrite(clause.elseIf);
  return false;
}

/** True if `script` calls `focus(...)`/`jumpFocus(...)` anywhere in a function body (including nested inside `if`/`else`) — mirrors `scriptUsesStore`. A component that only ever *redirects* focus this way, with no `focusable` element of its own, still needs the runtime `FlashTheaterFocusManager` wired into the app's globals. */
function scriptUsesFocus(script: ThrScriptAst): boolean {
  return script.functions.some((f) => blockHasFocusCall(f.block));
}

function blockHasFocusCall(block: FlashBlock): boolean {
  return block.statements.some((s) => {
    if (s instanceof FocusStatement) return true;
    // `jumpFocus(...)` directly calls into `FlashTheaterFocusManager` too (see `printJumpFocusStatement`),
    // so a component using it needs the same runtime wiring `focus(...)` triggers — no nested scan
    // needed, unlike the other statement kinds below, since this statement itself IS the usage.
    if (s instanceof JumpFocusStatement) return true;
    if (s instanceof IfStatement) return ifHasFocusCall(s);
    if (s instanceof ForStatement || s instanceof ForEachStatement || s instanceof WhileStatement) return blockHasFocusCall(s.body);
    if (s instanceof TryStatement) return blockHasFocusCall(s.tryBlock) || blockHasFocusCall(s.catchClause.body);
    if (s instanceof StateAssignment) return s.rhs instanceof AnonymousFunctionExpression && blockHasFocusCall(s.rhs.block);
    if (s instanceof AnonymousFunctionAssignmentStatement) return blockHasFocusCall(s.value.block);
    // See `blockHasStoreWrite`'s identical shape and `anyNestedAnonymousFunctionSatisfies`'s own doc comment.
    if (s instanceof StoreWriteStatement) return anyNestedAnonymousFunctionSatisfies(s.expression, 'expression', blockHasFocusCall);
    if (s instanceof TernaryAssignmentStatement) return anyNestedAnonymousFunctionSatisfies(reconstructTernaryText(s.rhs), 'expression', blockHasFocusCall);
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) return s.rhs instanceof AnonymousFunctionExpression && blockHasFocusCall(s.rhs.block);
    return anyNestedAnonymousFunctionSatisfies(s.text, 'statement', blockHasFocusCall);
  });
}

function ifHasFocusCall(stmt: IfStatement): boolean {
  if (stmt.thenBlock && blockHasFocusCall(stmt.thenBlock)) return true;
  const clause = stmt.elseClause;
  if (!clause) return false;
  if (clause.block && blockHasFocusCall(clause.block)) return true;
  if (clause.elseIf) return ifHasFocusCall(clause.elseIf);
  return false;
}

/**
 * True if `router.*` (a data read like `router.path`, or an action call like
 * `router.navigate(...)`) appears ANYWHERE in this component — a function
 * body (including nested `if`/`else`, and inside a `state`/`store(...)`/
 * `focus(...)` statement's own right-hand side), a `derived` expression, a
 * dynamic template attribute (`bindingExpressions`, already flattened by
 * `analyzeTemplateBindings` — includes every ordinary dynamic attribute plus
 * the synthetic toggle-mode `visible` binding), or an `{#if}`/`{#if:destroy}`/
 * `{#each}` block's own condition/collection/key expression (NOT covered by
 * `bindingExpressions`, since a block's condition isn't a
 * `TemplateAttributeBinding` — see `TemplateBindings.affectedBySourceBlocks`'s
 * own doc comment in `codegen/template-bindings.ts`).
 *
 * Unlike `scriptUsesFocus`, this can't walk a dedicated AST statement kind —
 * `router` has no flash-parser grammar of its own (see GRAMMAR.md's "Router"
 * section: `router.navigate(...)`/`router.back()`/etc. are ordinary
 * BrightScript dot-chain calls, resolved by `analysis/global-bindings.ts`'s
 * `resolveRouterPath`, the same generic mechanism `theme.a.b` already uses)
 * — so every raw text surface is independently re-parsed and scanned via
 * `findGlobalPathAccesses`. Cheap in practice: `parseEmbeddedExpression`/
 * `parseEmbeddedStatements` are memoized by exact text (see
 * `analysis/expression-region.ts`'s own doc comment), and this same text
 * gets parsed again anyway during the real rewrite pass moments later.
 */
function usesRouterAnywhere(
  script: ThrScriptAst,
  bindingExpressions: readonly TemplateAttributeBinding[],
  conditionalBlocks: readonly ConditionalBlock[],
  eachBlocks: readonly EachBlock[],
): boolean {
  if (script.derived.some((d) => textHasRouterAccess(d.expression, 'expression'))) return true;
  if (script.functions.some((f) => blockHasRouterAccess(f.block))) return true;
  if (bindingExpressions.some((b) => textHasRouterAccess(b.expression, 'expression'))) return true;
  if (conditionalBlocks.some((b) => textHasRouterAccess(b.expression, 'expression'))) return true;
  if (eachBlocks.some((b) => textHasRouterAccess(b.collectionExpression, 'expression') || textHasRouterAccess(b.keyExpression, 'expression'))) return true;
  return false;
}

function textHasRouterAccess(text: string, mode: 'expression' | 'statement'): boolean {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  // A real parse error here is surfaced properly, later, by the normal rewrite pipeline — this
  // scan is best-effort detection only, so it just treats an unparseable fragment as "no access".
  if (parsed.result.diagnostics.length > 0) return false;
  return findGlobalPathAccesses(parsed, ROUTER_ROOT_NAME, text).length > 0;
}

/**
 * True if `text` (an opaque `ExpressionRegion`/`StatementRegion`'s own raw text) contains a
 * Tier-2 anonymous function whose own body satisfies `blockPredicate` — shared by
 * `blockHasStoreWrite`/`blockHasFocusCall`/`blockHasRouterAccess`'s generic fallback branches.
 * A nested anon function's own DSL-parsed body (a `store(...)`/`focus(...)`/`router.*` usage
 * inside it, or a further-nested anon function) is invisible to a plain BrightScript-tree scan of
 * the *outer* text: each `StatementRegion`/`ExpressionRegion` inside the anon function's own
 * `Block` gets its own, separately-parsed `.embedded` tree (`attachBrightScriptParse`,
 * memoized-by-text but structurally independent), never a descendant of the outer text's parse.
 */
function anyNestedAnonymousFunctionSatisfies(text: string, mode: 'expression' | 'statement', blockPredicate: (block: FlashBlock) => boolean): boolean {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return false;
  return findAnonymousFunctionExpressions(parsed, text).some((access) => blockPredicate(new AnonymousFunctionExpression(access.node).block));
}

function blockHasRouterAccess(block: FlashBlock): boolean {
  return block.statements.some((s) => {
    if (s instanceof IfStatement) return ifHasRouterAccess(s);
    if (s instanceof ForStatement) {
      if (textHasRouterAccess(s.startExpr.text, 'expression')) return true;
      if (textHasRouterAccess(s.endExpr.text, 'expression')) return true;
      if (s.stepExpr && textHasRouterAccess(s.stepExpr.text, 'expression')) return true;
      return blockHasRouterAccess(s.body);
    }
    if (s instanceof ForEachStatement) return textHasRouterAccess(s.collectionExpr.text, 'expression') || blockHasRouterAccess(s.body);
    if (s instanceof WhileStatement) return textHasRouterAccess(s.condition.text, 'expression') || blockHasRouterAccess(s.body);
    if (s instanceof TryStatement) return blockHasRouterAccess(s.tryBlock) || blockHasRouterAccess(s.catchClause.body);
    // `reconstructTernaryText` degrades to `.expression`'s own text unchanged for a ternary-free
    // RHS, so one call covers both shapes for `StateAssignment` (whose `.expression` getter throws
    // once the RHS is ternary-bearing — see flash-parser's ast.ts). An anonymous-function RHS has
    // no text of its own to scan; recurse into its body instead.
    if (s instanceof StateAssignment) {
      return s.rhs instanceof AnonymousFunctionExpression ? blockHasRouterAccess(s.rhs.block) : textHasRouterAccess(reconstructTernaryText(s.rhs), 'expression');
    }
    if (s instanceof StoreWriteStatement) return textHasRouterAccess(s.expression, 'expression');
    if (s instanceof FocusStatement) return textHasRouterAccess(s.expression, 'expression');
    if (s instanceof JumpFocusStatement) {
      return (
        textHasRouterAccess(s.directionExpression, 'expression') ||
        textHasRouterAccess(s.countExpression, 'expression') ||
        textHasRouterAccess(s.pressExpression, 'expression')
      );
    }
    if (s instanceof TernaryAssignmentStatement) return textHasRouterAccess(reconstructTernaryText(s.rhs), 'expression');
    if (s instanceof AnonymousFunctionAssignmentStatement) return blockHasRouterAccess(s.value.block);
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) {
      return s.rhs instanceof AnonymousFunctionExpression ? blockHasRouterAccess(s.rhs.block) : textHasRouterAccess(reconstructTernaryText(s.rhs), 'expression');
    }
    // See `anyNestedAnonymousFunctionSatisfies`'s own doc comment: a Tier-2 anonymous function
    // nested in this opaque statement's own text needs its own body scanned explicitly too.
    return textHasRouterAccess(s.text, 'statement') || anyNestedAnonymousFunctionSatisfies(s.text, 'statement', blockHasRouterAccess);
  });
}

function ifHasRouterAccess(stmt: IfStatement): boolean {
  if (textHasRouterAccess(stmt.condition.text, 'expression')) return true;
  if (stmt.thenBlock && blockHasRouterAccess(stmt.thenBlock)) return true;
  if (stmt.thenStatement && textHasRouterAccess(stmt.thenStatement.text, 'statement')) return true;
  const clause = stmt.elseClause;
  if (!clause) return false;
  if (clause.block && blockHasRouterAccess(clause.block)) return true;
  if (clause.statement && textHasRouterAccess(clause.statement.text, 'statement')) return true;
  if (clause.elseIf) return ifHasRouterAccess(clause.elseIf);
  return false;
}

/**
 * True if `taskManager.*` (a data read like `taskManager.runningCount`, or an action call like
 * `taskManager.run(...)`) appears ANYWHERE in this component — mechanical mirror of
 * `usesRouterAnywhere`/`textHasRouterAccess`/`blockHasRouterAccess`/`ifHasRouterAccess` (same four
 * expression surfaces, same reasoning for why a raw-text re-scan is needed instead of walking a
 * dedicated AST statement kind — `taskManager` has no flash-parser grammar of its own either). See
 * GRAMMAR.md's "Task manager" section.
 */
function usesTaskManagerAnywhere(
  script: ThrScriptAst,
  bindingExpressions: readonly TemplateAttributeBinding[],
  conditionalBlocks: readonly ConditionalBlock[],
  eachBlocks: readonly EachBlock[],
): boolean {
  if (script.derived.some((d) => textHasTaskManagerAccess(d.expression, 'expression'))) return true;
  if (script.functions.some((f) => blockHasTaskManagerAccess(f.block))) return true;
  if (bindingExpressions.some((b) => textHasTaskManagerAccess(b.expression, 'expression'))) return true;
  if (conditionalBlocks.some((b) => textHasTaskManagerAccess(b.expression, 'expression'))) return true;
  if (eachBlocks.some((b) => textHasTaskManagerAccess(b.collectionExpression, 'expression') || textHasTaskManagerAccess(b.keyExpression, 'expression'))) return true;
  return false;
}

function textHasTaskManagerAccess(text: string, mode: 'expression' | 'statement'): boolean {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  // A real parse error here is surfaced properly, later, by the normal rewrite pipeline — this
  // scan is best-effort detection only, so it just treats an unparseable fragment as "no access".
  if (parsed.result.diagnostics.length > 0) return false;
  return findGlobalPathAccesses(parsed, TASK_MANAGER_ROOT_NAME, text).length > 0;
}

function blockHasTaskManagerAccess(block: FlashBlock): boolean {
  return block.statements.some((s) => {
    if (s instanceof IfStatement) return ifHasTaskManagerAccess(s);
    if (s instanceof ForStatement) {
      if (textHasTaskManagerAccess(s.startExpr.text, 'expression')) return true;
      if (textHasTaskManagerAccess(s.endExpr.text, 'expression')) return true;
      if (s.stepExpr && textHasTaskManagerAccess(s.stepExpr.text, 'expression')) return true;
      return blockHasTaskManagerAccess(s.body);
    }
    if (s instanceof ForEachStatement) return textHasTaskManagerAccess(s.collectionExpr.text, 'expression') || blockHasTaskManagerAccess(s.body);
    if (s instanceof WhileStatement) return textHasTaskManagerAccess(s.condition.text, 'expression') || blockHasTaskManagerAccess(s.body);
    if (s instanceof TryStatement) return blockHasTaskManagerAccess(s.tryBlock) || blockHasTaskManagerAccess(s.catchClause.body);
    if (s instanceof StateAssignment) {
      return s.rhs instanceof AnonymousFunctionExpression ? blockHasTaskManagerAccess(s.rhs.block) : textHasTaskManagerAccess(reconstructTernaryText(s.rhs), 'expression');
    }
    if (s instanceof StoreWriteStatement) return textHasTaskManagerAccess(s.expression, 'expression');
    if (s instanceof FocusStatement) return textHasTaskManagerAccess(s.expression, 'expression');
    if (s instanceof JumpFocusStatement) {
      return (
        textHasTaskManagerAccess(s.directionExpression, 'expression') ||
        textHasTaskManagerAccess(s.countExpression, 'expression') ||
        textHasTaskManagerAccess(s.pressExpression, 'expression')
      );
    }
    if (s instanceof TernaryAssignmentStatement) return textHasTaskManagerAccess(reconstructTernaryText(s.rhs), 'expression');
    if (s instanceof AnonymousFunctionAssignmentStatement) return blockHasTaskManagerAccess(s.value.block);
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) {
      return s.rhs instanceof AnonymousFunctionExpression ? blockHasTaskManagerAccess(s.rhs.block) : textHasTaskManagerAccess(reconstructTernaryText(s.rhs), 'expression');
    }
    return textHasTaskManagerAccess(s.text, 'statement') || anyNestedAnonymousFunctionSatisfies(s.text, 'statement', blockHasTaskManagerAccess);
  });
}

function ifHasTaskManagerAccess(stmt: IfStatement): boolean {
  if (textHasTaskManagerAccess(stmt.condition.text, 'expression')) return true;
  if (stmt.thenBlock && blockHasTaskManagerAccess(stmt.thenBlock)) return true;
  if (stmt.thenStatement && textHasTaskManagerAccess(stmt.thenStatement.text, 'statement')) return true;
  const clause = stmt.elseClause;
  if (!clause) return false;
  if (clause.block && blockHasTaskManagerAccess(clause.block)) return true;
  if (clause.statement && textHasTaskManagerAccess(clause.statement.text, 'statement')) return true;
  if (clause.elseIf) return ifHasTaskManagerAccess(clause.elseIf);
  return false;
}

/**
 * True if `script` calls `taskManager.run(...)` anywhere — a narrower sibling of
 * `usesTaskManagerAnywhere` (which is true for ANY `taskManager.*` access, including a bare
 * `runningCount` read or an `onAlertChanged` registration that never calls `run` at all). Scans the
 * same four surfaces `usesTaskManagerAnywhere` does (derived, function bodies, template bindings,
 * `{#if}`/`{#each}` expressions) since `run(...)` has no restricted position of its own, unlike
 * `onAlertChanged`/`onResult`/timer calls. Decides whether THIS component's own generated
 * `ft_unmount()` needs the `cancelOwnedBy(m.top)` auto-cancel line at all (see
 * `codegen/brs-emitter.ts`'s `emitUnmountFunction`) — a component that never itself starts a task has
 * nothing of its own for the global manager to ever have registered under its `m.top`.
 */
function usesTaskManagerRunAnywhere(
  script: ThrScriptAst,
  bindingExpressions: readonly TemplateAttributeBinding[],
  conditionalBlocks: readonly ConditionalBlock[],
  eachBlocks: readonly EachBlock[],
): boolean {
  if (script.derived.some((d) => textHasTaskManagerRunCall(d.expression, 'expression'))) return true;
  if (script.functions.some((f) => blockHasTaskManagerRunCall(f.block))) return true;
  if (bindingExpressions.some((b) => textHasTaskManagerRunCall(b.expression, 'expression'))) return true;
  if (conditionalBlocks.some((b) => textHasTaskManagerRunCall(b.expression, 'expression'))) return true;
  if (eachBlocks.some((b) => textHasTaskManagerRunCall(b.collectionExpression, 'expression') || textHasTaskManagerRunCall(b.keyExpression, 'expression'))) return true;
  return false;
}

function textHasTaskManagerRunCall(text: string, mode: 'expression' | 'statement'): boolean {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return false;
  return findGlobalPathAccesses(parsed, TASK_MANAGER_ROOT_NAME, text).some((access) => access.isCallTarget && access.segments.length === 1 && access.segments[0] === 'run');
}

function blockHasTaskManagerRunCall(block: FlashBlock): boolean {
  return block.statements.some((s) => {
    if (s instanceof IfStatement) return ifHasTaskManagerRunCall(s);
    if (s instanceof ForStatement) {
      if (textHasTaskManagerRunCall(s.startExpr.text, 'expression')) return true;
      if (textHasTaskManagerRunCall(s.endExpr.text, 'expression')) return true;
      if (s.stepExpr && textHasTaskManagerRunCall(s.stepExpr.text, 'expression')) return true;
      return blockHasTaskManagerRunCall(s.body);
    }
    if (s instanceof ForEachStatement) return textHasTaskManagerRunCall(s.collectionExpr.text, 'expression') || blockHasTaskManagerRunCall(s.body);
    if (s instanceof WhileStatement) return textHasTaskManagerRunCall(s.condition.text, 'expression') || blockHasTaskManagerRunCall(s.body);
    if (s instanceof TryStatement) return blockHasTaskManagerRunCall(s.tryBlock) || blockHasTaskManagerRunCall(s.catchClause.body);
    if (s instanceof StateAssignment) {
      return s.rhs instanceof AnonymousFunctionExpression ? blockHasTaskManagerRunCall(s.rhs.block) : textHasTaskManagerRunCall(reconstructTernaryText(s.rhs), 'expression');
    }
    if (s instanceof StoreWriteStatement) return textHasTaskManagerRunCall(s.expression, 'expression');
    if (s instanceof FocusStatement) return textHasTaskManagerRunCall(s.expression, 'expression');
    if (s instanceof JumpFocusStatement) {
      return (
        textHasTaskManagerRunCall(s.directionExpression, 'expression') ||
        textHasTaskManagerRunCall(s.countExpression, 'expression') ||
        textHasTaskManagerRunCall(s.pressExpression, 'expression')
      );
    }
    if (s instanceof TernaryAssignmentStatement) return textHasTaskManagerRunCall(reconstructTernaryText(s.rhs), 'expression');
    if (s instanceof AnonymousFunctionAssignmentStatement) return blockHasTaskManagerRunCall(s.value.block);
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) {
      return s.rhs instanceof AnonymousFunctionExpression ? blockHasTaskManagerRunCall(s.rhs.block) : textHasTaskManagerRunCall(reconstructTernaryText(s.rhs), 'expression');
    }
    return textHasTaskManagerRunCall(s.text, 'statement') || anyNestedAnonymousFunctionSatisfies(s.text, 'statement', blockHasTaskManagerRunCall);
  });
}

function ifHasTaskManagerRunCall(stmt: IfStatement): boolean {
  if (textHasTaskManagerRunCall(stmt.condition.text, 'expression')) return true;
  if (stmt.thenBlock && blockHasTaskManagerRunCall(stmt.thenBlock)) return true;
  if (stmt.thenStatement && textHasTaskManagerRunCall(stmt.thenStatement.text, 'statement')) return true;
  const clause = stmt.elseClause;
  if (!clause) return false;
  if (clause.block && blockHasTaskManagerRunCall(clause.block)) return true;
  if (clause.statement && textHasTaskManagerRunCall(clause.statement.text, 'statement')) return true;
  if (clause.elseIf) return ifHasTaskManagerRunCall(clause.elseIf);
  return false;
}

/**
 * True if `script` calls `taskManager.onAlertChanged(...)` anywhere in a function body — narrower
 * than `usesTaskManagerAnywhere` (only scans function bodies, not `derived`/template bindings/
 * `{#if}`/`{#each}` expressions) because `onAlertChanged` is restricted to statement position only
 * (`checkTaskManagerOnAlertChangedIsStandaloneStatement` in `identifier-rewrite.ts` rejects any
 * expression-mode use outright), so it can never legally appear in those other three surfaces.
 * Decides whether `emitBrs` needs to append the generated `on_taskManagerAlertChange` trampoline sub
 * to THIS component's own `.brs` — purely local to this file, no whole-app wiring needed (unlike
 * `usesTaskManager`): the singleton itself is already copied/wired whenever `usesTaskManagerAnywhere`
 * is true, which `onAlertChanged` usage already satisfies on its own.
 */
function scriptUsesTaskManagerAlertCallback(script: ThrScriptAst): boolean {
  return script.functions.some((f) => blockHasTaskManagerOnAlertChangedCall(f.block));
}

function blockHasTaskManagerOnAlertChangedCall(block: FlashBlock): boolean {
  return block.statements.some((s) => {
    if (s instanceof IfStatement) return ifHasTaskManagerOnAlertChangedCall(s);
    if (s instanceof ForStatement || s instanceof ForEachStatement || s instanceof WhileStatement) return blockHasTaskManagerOnAlertChangedCall(s.body);
    if (s instanceof TryStatement) return blockHasTaskManagerOnAlertChangedCall(s.tryBlock) || blockHasTaskManagerOnAlertChangedCall(s.catchClause.body);
    if (s instanceof StateAssignment) return s.rhs instanceof AnonymousFunctionExpression && blockHasTaskManagerOnAlertChangedCall(s.rhs.block);
    if (s instanceof AnonymousFunctionAssignmentStatement) return blockHasTaskManagerOnAlertChangedCall(s.value.block);
    // onAlertChanged can never legally appear inside any of these three statement kinds' own RHS
    // expression — it's restricted to standalone-statement position (see
    // checkTaskManagerOnAlertChangedIsStandaloneStatement), and none of these has a nested Block of
    // its own to recurse into either — so there is nothing left to check.
    if (s instanceof StoreWriteStatement || s instanceof FocusStatement || s instanceof JumpFocusStatement || s instanceof TernaryAssignmentStatement) return false;
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) return s.rhs instanceof AnonymousFunctionExpression && blockHasTaskManagerOnAlertChangedCall(s.rhs.block);
    return isTaskManagerOnAlertChangedStatement(s.text) || anyNestedAnonymousFunctionSatisfies(s.text, 'statement', blockHasTaskManagerOnAlertChangedCall);
  });
}

function ifHasTaskManagerOnAlertChangedCall(stmt: IfStatement): boolean {
  if (stmt.thenBlock && blockHasTaskManagerOnAlertChangedCall(stmt.thenBlock)) return true;
  if (stmt.thenStatement && isTaskManagerOnAlertChangedStatement(stmt.thenStatement.text)) return true;
  const clause = stmt.elseClause;
  if (!clause) return false;
  if (clause.block && blockHasTaskManagerOnAlertChangedCall(clause.block)) return true;
  if (clause.statement && isTaskManagerOnAlertChangedStatement(clause.statement.text)) return true;
  if (clause.elseIf) return ifHasTaskManagerOnAlertChangedCall(clause.elseIf);
  return false;
}

/**
 * True if `script` calls `taskManager.onResult(...)` anywhere in a function body — mirrors
 * `scriptUsesTaskManagerAlertCallback`'s exact shape (`onResult` is restricted to statement
 * position too, via `checkTaskManagerOnResultNotInReactiveExpression`). Decides whether `emitBrs`
 * needs to append the two generated trampoline subs (`codegen/brs-emitter.ts`'s
 * `emitTaskManagerResultTrampolines`) to this component's own `.brs`.
 */
function scriptUsesTaskManagerResultCallback(script: ThrScriptAst): boolean {
  return script.functions.some((f) => blockHasTaskManagerOnResultCall(f.block));
}

function blockHasTaskManagerOnResultCall(block: FlashBlock): boolean {
  return block.statements.some((s) => {
    if (s instanceof IfStatement) return ifHasTaskManagerOnResultCall(s);
    if (s instanceof ForStatement || s instanceof ForEachStatement || s instanceof WhileStatement) return blockHasTaskManagerOnResultCall(s.body);
    if (s instanceof TryStatement) return blockHasTaskManagerOnResultCall(s.tryBlock) || blockHasTaskManagerOnResultCall(s.catchClause.body);
    if (s instanceof StateAssignment) return s.rhs instanceof AnonymousFunctionExpression && blockHasTaskManagerOnResultCall(s.rhs.block);
    if (s instanceof AnonymousFunctionAssignmentStatement) return blockHasTaskManagerOnResultCall(s.value.block);
    // onResult can never legally appear inside any of these three statement kinds' own RHS
    // expression — restricted to standalone-statement position, same as onAlertChanged — and none
    // has a nested Block of its own to recurse into either.
    if (s instanceof StoreWriteStatement || s instanceof FocusStatement || s instanceof JumpFocusStatement || s instanceof TernaryAssignmentStatement) return false;
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) return s.rhs instanceof AnonymousFunctionExpression && blockHasTaskManagerOnResultCall(s.rhs.block);
    return isTaskManagerOnResultStatement(s.text) || anyNestedAnonymousFunctionSatisfies(s.text, 'statement', blockHasTaskManagerOnResultCall);
  });
}

function ifHasTaskManagerOnResultCall(stmt: IfStatement): boolean {
  if (stmt.thenBlock && blockHasTaskManagerOnResultCall(stmt.thenBlock)) return true;
  if (stmt.thenStatement && isTaskManagerOnResultStatement(stmt.thenStatement.text)) return true;
  const clause = stmt.elseClause;
  if (!clause) return false;
  if (clause.block && blockHasTaskManagerOnResultCall(clause.block)) return true;
  if (clause.statement && isTaskManagerOnResultStatement(clause.statement.text)) return true;
  if (clause.elseIf) return ifHasTaskManagerOnResultCall(clause.elseIf);
  return false;
}

/**
 * Every declared `animation` name with at least one `<name>.onFinish(callback)` registration
 * anywhere in `script`'s function bodies — same statement-position-only scope as
 * `scriptUsesTaskManagerResultCallback` (`.onFinish()` is restricted to a standalone statement, never
 * a `derived`/template expression, via `identifier-rewrite.ts`'s
 * `checkAnimationOnFinishCallIsStandaloneStatement`), but COLLECTING names rather than returning a
 * single boolean — `codegen/conditional-block-emitter.ts`'s shared per-name state-change handler
 * needs to know WHICH names to attach the callback-invoking tail to, not just whether any exist.
 * Filtered against `bindings.animationNames` the same "trust the shape, don't try to type-check it"
 * way `identifier-rewrite.ts`'s own onFinish rewrite does — an unrelated `x.onFinish()` call on some
 * other object is left out.
 */
function scriptAnimationOnFinishNames(script: ThrScriptAst, bindings: ScriptBindings): ReadonlySet<string> {
  const names = new Set<string>();
  for (const f of script.functions) collectAnimationOnFinishNames(f.block, bindings, names);
  return names;
}

function collectAnimationOnFinishNames(block: FlashBlock, bindings: ScriptBindings, names: Set<string>): void {
  for (const s of block.statements) {
    if (s instanceof IfStatement) {
      collectAnimationOnFinishNamesInIf(s, bindings, names);
      continue;
    }
    if (s instanceof ForStatement || s instanceof ForEachStatement || s instanceof WhileStatement) {
      collectAnimationOnFinishNames(s.body, bindings, names);
      continue;
    }
    if (s instanceof TryStatement) {
      collectAnimationOnFinishNames(s.tryBlock, bindings, names);
      collectAnimationOnFinishNames(s.catchClause.body, bindings, names);
      continue;
    }
    if (s instanceof StateAssignment) {
      if (s.rhs instanceof AnonymousFunctionExpression) collectAnimationOnFinishNames(s.rhs.block, bindings, names);
      continue;
    }
    if (s instanceof AnonymousFunctionAssignmentStatement) {
      collectAnimationOnFinishNames(s.value.block, bindings, names);
      continue;
    }
    // `.onFinish()` can never legally appear inside any of these three statement kinds' own RHS
    // expression — restricted to standalone-statement position, same as onResult/Timer — and none
    // has a nested Block of its own to recurse into either.
    if (s instanceof StoreWriteStatement || s instanceof FocusStatement || s instanceof JumpFocusStatement || s instanceof TernaryAssignmentStatement) continue;
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) {
      if (s.rhs instanceof AnonymousFunctionExpression) collectAnimationOnFinishNames(s.rhs.block, bindings, names);
      continue;
    }
    collectAnimationOnFinishNamesInText(s.text, 'statement', bindings, names);
  }
}

function collectAnimationOnFinishNamesInIf(stmt: IfStatement, bindings: ScriptBindings, names: Set<string>): void {
  if (stmt.thenBlock) collectAnimationOnFinishNames(stmt.thenBlock, bindings, names);
  if (stmt.thenStatement) collectAnimationOnFinishNamesInText(stmt.thenStatement.text, 'statement', bindings, names);
  const clause = stmt.elseClause;
  if (!clause) return;
  if (clause.block) collectAnimationOnFinishNames(clause.block, bindings, names);
  if (clause.statement) collectAnimationOnFinishNamesInText(clause.statement.text, 'statement', bindings, names);
  if (clause.elseIf) collectAnimationOnFinishNamesInIf(clause.elseIf, bindings, names);
}

function collectAnimationOnFinishNamesInText(text: string, mode: 'expression' | 'statement', bindings: ScriptBindings, names: Set<string>): void {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return;
  for (const match of findAnimationOnFinishCalls(parsed, text)) {
    if (bindings.animationNames.has(match.animationName)) names.add(match.animationName);
  }
  for (const access of findAnonymousFunctionExpressions(parsed, text)) {
    collectAnimationOnFinishNames(new AnonymousFunctionExpression(access.node).block, bindings, names);
  }
}

/**
 * True if `script` calls `taskManager.onRequestSent(...)` anywhere in a function body — mirrors
 * `scriptUsesTaskManagerAlertCallback`'s exact shape (`onRequestSent` is restricted to statement
 * position too, via `checkTaskManagerOnRequestSentNotInReactiveExpression`). Decides whether
 * `emitBrs` needs to append the generated `on_taskManagerRequestSent` trampoline sub (see
 * `codegen/brs-emitter.ts`'s `emitTaskManagerRequestSentTrampoline`) to this component's own `.brs`.
 */
function scriptUsesTaskManagerRequestSentCallback(script: ThrScriptAst): boolean {
  return script.functions.some((f) => blockHasTaskManagerOnRequestSentCall(f.block));
}

function blockHasTaskManagerOnRequestSentCall(block: FlashBlock): boolean {
  return block.statements.some((s) => {
    if (s instanceof IfStatement) return ifHasTaskManagerOnRequestSentCall(s);
    if (s instanceof ForStatement || s instanceof ForEachStatement || s instanceof WhileStatement) return blockHasTaskManagerOnRequestSentCall(s.body);
    if (s instanceof TryStatement) return blockHasTaskManagerOnRequestSentCall(s.tryBlock) || blockHasTaskManagerOnRequestSentCall(s.catchClause.body);
    if (s instanceof StateAssignment) return s.rhs instanceof AnonymousFunctionExpression && blockHasTaskManagerOnRequestSentCall(s.rhs.block);
    if (s instanceof AnonymousFunctionAssignmentStatement) return blockHasTaskManagerOnRequestSentCall(s.value.block);
    // onRequestSent can never legally appear inside any of these three statement kinds' own RHS
    // expression — restricted to standalone-statement position, same as onAlertChanged — and none
    // has a nested Block of its own to recurse into either.
    if (s instanceof StoreWriteStatement || s instanceof FocusStatement || s instanceof JumpFocusStatement || s instanceof TernaryAssignmentStatement) return false;
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) return s.rhs instanceof AnonymousFunctionExpression && blockHasTaskManagerOnRequestSentCall(s.rhs.block);
    return isTaskManagerOnRequestSentStatement(s.text) || anyNestedAnonymousFunctionSatisfies(s.text, 'statement', blockHasTaskManagerOnRequestSentCall);
  });
}

function ifHasTaskManagerOnRequestSentCall(stmt: IfStatement): boolean {
  if (stmt.thenBlock && blockHasTaskManagerOnRequestSentCall(stmt.thenBlock)) return true;
  if (stmt.thenStatement && isTaskManagerOnRequestSentStatement(stmt.thenStatement.text)) return true;
  const clause = stmt.elseClause;
  if (!clause) return false;
  if (clause.block && blockHasTaskManagerOnRequestSentCall(clause.block)) return true;
  if (clause.statement && isTaskManagerOnRequestSentStatement(clause.statement.text)) return true;
  if (clause.elseIf) return ifHasTaskManagerOnRequestSentCall(clause.elseIf);
  return false;
}

/** See `scriptUsesTaskManagerRequestSentCallback`'s own doc comment — identical shape, the response-side hook. */
function scriptUsesTaskManagerResponseReceivedCallback(script: ThrScriptAst): boolean {
  return script.functions.some((f) => blockHasTaskManagerOnResponseReceivedCall(f.block));
}

function blockHasTaskManagerOnResponseReceivedCall(block: FlashBlock): boolean {
  return block.statements.some((s) => {
    if (s instanceof IfStatement) return ifHasTaskManagerOnResponseReceivedCall(s);
    if (s instanceof ForStatement || s instanceof ForEachStatement || s instanceof WhileStatement) return blockHasTaskManagerOnResponseReceivedCall(s.body);
    if (s instanceof TryStatement) return blockHasTaskManagerOnResponseReceivedCall(s.tryBlock) || blockHasTaskManagerOnResponseReceivedCall(s.catchClause.body);
    if (s instanceof StateAssignment) return s.rhs instanceof AnonymousFunctionExpression && blockHasTaskManagerOnResponseReceivedCall(s.rhs.block);
    if (s instanceof AnonymousFunctionAssignmentStatement) return blockHasTaskManagerOnResponseReceivedCall(s.value.block);
    if (s instanceof StoreWriteStatement || s instanceof FocusStatement || s instanceof JumpFocusStatement || s instanceof TernaryAssignmentStatement) return false;
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) return s.rhs instanceof AnonymousFunctionExpression && blockHasTaskManagerOnResponseReceivedCall(s.rhs.block);
    return isTaskManagerOnResponseReceivedStatement(s.text) || anyNestedAnonymousFunctionSatisfies(s.text, 'statement', blockHasTaskManagerOnResponseReceivedCall);
  });
}

function ifHasTaskManagerOnResponseReceivedCall(stmt: IfStatement): boolean {
  if (stmt.thenBlock && blockHasTaskManagerOnResponseReceivedCall(stmt.thenBlock)) return true;
  if (stmt.thenStatement && isTaskManagerOnResponseReceivedStatement(stmt.thenStatement.text)) return true;
  const clause = stmt.elseClause;
  if (!clause) return false;
  if (clause.block && blockHasTaskManagerOnResponseReceivedCall(clause.block)) return true;
  if (clause.statement && isTaskManagerOnResponseReceivedStatement(clause.statement.text)) return true;
  if (clause.elseIf) return ifHasTaskManagerOnResponseReceivedCall(clause.elseIf);
  return false;
}

/**
 * True if `script` calls `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` anywhere in a
 * function body — narrower than `usesTaskManagerAnywhere` (only scans function bodies, not
 * `derived`/template bindings/`{#if}`/`{#each}` expressions) because all four are restricted to
 * ordinary function-body statement position (see `codegen/statement-printer.ts`'s
 * `checkTimerStartCallPosition`/`lowerTimerStartCallsInText`'s own `mode === 'expression'` rejection,
 * and `analysis/identifier-rewrite.ts`'s equivalent `rewriteTimerClearCalls` guard) — they can never
 * legally appear in those other three surfaces. Decides whether `emitBrs` needs the shared registry/
 * trampoline/unmount-force-stop machinery at all (see `codegen/naming.ts`'s
 * `timerCallbacksFieldAccess` and `codegen/brs-emitter.ts`'s `emitTimerFireTrampoline`/
 * `emitUnmountFunction`) — purely local to this component's own generated `.brs`, unlike
 * `usesTaskManager`, since Timer needs no shared `runtime-assets/` asset or app-wide `m.global`
 * wiring (a Timer node is a native Roku SceneGraph type, not a custom component this compiler
 * defines its own XML for).
 */
function scriptUsesTimer(script: ThrScriptAst): boolean {
  return script.functions.some((f) => blockHasTimerCall(f.block));
}

function blockHasTimerCall(block: FlashBlock): boolean {
  return block.statements.some((s) => {
    if (s instanceof IfStatement) return ifHasTimerCall(s);
    if (s instanceof ForStatement || s instanceof ForEachStatement || s instanceof WhileStatement) return blockHasTimerCall(s.body);
    if (s instanceof TryStatement) return blockHasTimerCall(s.tryBlock) || blockHasTimerCall(s.catchClause.body);
    if (s instanceof StateAssignment) return s.rhs instanceof AnonymousFunctionExpression && blockHasTimerCall(s.rhs.block);
    if (s instanceof AnonymousFunctionAssignmentStatement) return blockHasTimerCall(s.value.block);
    // All four timer functions can never legally appear inside any of these three statement kinds'
    // own RHS expression — restricted to ordinary statement/plain-assignment position, same as
    // onAlertChanged/onResult — and none has a nested Block of its own to recurse into either.
    if (s instanceof StoreWriteStatement || s instanceof FocusStatement || s instanceof JumpFocusStatement || s instanceof TernaryAssignmentStatement) return false;
    if (s instanceof ScaleLocalAssignmentStatement || s instanceof ScaleStateAssignmentStatement) return s.rhs instanceof AnonymousFunctionExpression && blockHasTimerCall(s.rhs.block);
    return isTimerCallStatement(s.text) || anyNestedAnonymousFunctionSatisfies(s.text, 'statement', blockHasTimerCall);
  });
}

function ifHasTimerCall(stmt: IfStatement): boolean {
  if (stmt.thenBlock && blockHasTimerCall(stmt.thenBlock)) return true;
  if (stmt.thenStatement && isTimerCallStatement(stmt.thenStatement.text)) return true;
  const clause = stmt.elseClause;
  if (!clause) return false;
  if (clause.block && blockHasTimerCall(clause.block)) return true;
  if (clause.statement && isTimerCallStatement(clause.statement.text)) return true;
  if (clause.elseIf) return ifHasTimerCall(clause.elseIf);
  return false;
}
