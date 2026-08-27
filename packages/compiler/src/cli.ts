import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import {
  compileApp,
  AppFileInput,
  CompiledAppOutput,
  CompiledClassOutput,
  CompiledThemeOutput,
  FLASH_THEATER_STORE_COMPONENT_NAME,
  FLASH_THEATER_THEME_COMPONENT_NAME,
  FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME,
  FLASH_THEATER_ROUTER_COMPONENT_NAME,
  FLASH_THEATER_ROUTER_OUTLET_COMPONENT_NAME,
  FLASH_THEATER_TASK_MANAGER_COMPONENT_NAME,
  FLASH_THEATER_SAFE_COMPARE_DIR_NAME,
  FLASH_THEATER_SAFE_COMPARE_FILE_BASE_NAME,
  FLASH_THEATER_SAFE_NOT_DIR_NAME,
  FLASH_THEATER_SAFE_NOT_FILE_BASE_NAME,
  FLASH_THEATER_STREAM_DIR_NAME,
  FLASH_THEATER_STREAM_FILE_BASE_NAME,
  FLASH_THEATER_HTTP_DIR_NAME,
  FLASH_THEATER_HTTP_FILE_BASE_NAME,
  FLASH_THEATER_SCALE_DIR_NAME,
  FLASH_THEATER_SCALE_FILE_BASE_NAME,
  FLASH_THEATER_SAFE_RELATIONAL_DIR_NAME,
  FLASH_THEATER_SAFE_RELATIONAL_FILE_BASE_NAME,
} from './app-compiler.js';
import { CompileError } from './dsl-parser/dsl-ast.js';
import {
  FlashTheaterConfig,
  FlashTheaterEnvironmentConfig,
  loadFlashTheaterConfig,
  loadFlashTheaterEnvironmentConfig,
  mergeEnvironmentConfigs,
  resolveEnvironmentVariables,
} from './config.js';
import { resolveProjectLayout, walkSrcTree } from './project-layout.js';
import { applyManifestOverrides } from './manifest.js';
import { writeAppZip } from './packaging.js';

export const GENERATED_MARKER = 'flash-theater:generated';

/**
 * Entry point for both `flash-theater compile [...]` and `flash-theater zip [...]`, split out of
 * bin/flash-theater.ts so it's testable without spawning a process. Returns an exit code
 * (0 = success, 1 = failure) instead of calling `process.exit`. Dispatches to `runCompileCommand`/
 * `runZipCommand` — see each for its own flags and behavior.
 */
export function runCli(argv: string[]): number {
  const command = argv[0];

  if (command === 'compile') {
    return runCompileCommand(argv.slice(1));
  }

  if (command === 'zip') {
    return runZipCommand(argv.slice(1));
  }

  console.error('Usage: flash-theater compile [--check] [--src-dir <dir>] [--out-dir <dir>] [--env <name>]');
  console.error('       flash-theater zip [--out-dir <dir>] [--env <name>] [--app-name <name>]');
  return 1;
}

/** `flash-theater.config.json` — sibling to `src/`/`out/`/`dist/`; absent entirely is fine, both `compile` and `zip` treat that as `config: null` and fall back to their own defaults. */
function loadConfig(appRoot: string): FlashTheaterConfig | null {
  const configPath = join(appRoot, 'flash-theater.config.json');
  return existsSync(configPath) ? loadFlashTheaterConfig(configPath) : null;
}

/**
 * Logic for `flash-theater compile [--check] [--src-dir <dir>] [--out-dir <dir>] [--env <name>]`.
 *
 * Convention-based, not pattern-based — unlike the old `compile <pattern>` shape, this always
 * compiles the WHOLE project: it discovers everything under the app's `src/` (defaulting to a
 * `src`/`out` sibling pair of the current working directory, overridable via
 * `flash-theater.config.json`'s `srcDir`/`outDir`, or these CLI flags — see `project-layout.ts`).
 * `out/` is wiped and rebuilt from scratch on every non-`--check` run — see `findings/build-layout.md`
 * for why (it lets a stale file from a since-deleted/renamed source disappear automatically, and
 * removes the need for the old marker-based overwrite-protection this file used to have).
 *
 * `--env <name>` (or, equivalently, a `FLASH_THEATER_ENV` environment variable — checked as a
 * fallback specifically so it flows through `npm run build:roku`'s `compile && zip` script chain
 * with zero `package.json` changes) selects an environment: `environments/<name>.config.json`
 * (required to exist) is loaded, and `environments/<name>.local.config.json` (optional — a
 * developer's own git-ignored local override, see `config.ts`'s `mergeEnvironmentConfigs`) is
 * layered on top if present. Neither flag/var set ⇒ byte-for-byte the same behavior as before this
 * feature existed: `out/`, `dist/<app>.zip`, no manifest patch, no `ft_env`. An active environment
 * writes to `out-<env>/` instead of `out/` (see `project-layout.ts`) and patches `src/manifest`'s
 * `manifestOverrides` into `out-<env>/manifest` instead of copying it verbatim. See GRAMMAR.md's
 * "Environments" section and findings/environments.md.
 *
 * Routes the whole discovered file list through `compileApp` (a single whole-app compile, not
 * independent per-file compiles) — theme validation is inherently cross-file, so it can't be done
 * any other way. An app with no `<theme-template>` file degrades to exactly the same output as
 * compiling each file independently. The store needs no such cross-file step (it's schemaless),
 * but `compileApp`'s tally of whether any component uses it (`usesStore`) still decides whether
 * `copyRuntimeAsset` runs. The theme's compiled output (`compiledApp.themeOutput`) is written the
 * same way the store is — its own dedicated `writeThemeOutput` call, not the generic per-input
 * `writeCompiledOutput` loop — since its name/location are fixed
 * (`FLASH_THEATER_THEME_COMPONENT_NAME`), not derived from whatever the app author named or placed
 * their `<theme-template>` file.
 */
function runCompileCommand(argv: string[]): number {
  const { checkOnly, srcDirOverride, outDirOverride, envOverride } = parseCompileArgs(argv);

  try {
    const appRoot = process.cwd();

    // Holds both this app's design-resolution setting for `scale` (see GRAMMAR.md's "scale"
    // section) and its optional `srcDir`/`outDir`/`exclude` project-layout overrides (see
    // `project-layout.ts`) — unless the app actually uses `scale` anywhere, in which case
    // `compileApp`/`compileThrSource` reject a missing config with `dsl/scale-requires-config`.
    const config = loadConfig(appRoot);

    // `--env`, falling back to FLASH_THEATER_ENV so it flows through `npm run build:roku`'s
    // `compile && zip` chain untouched — see this function's own doc comment.
    const envName = envOverride ?? process.env.FLASH_THEATER_ENV ?? null;

    let environmentConfig: FlashTheaterEnvironmentConfig | null = null;
    if (envName) {
      const envConfigPath = join(appRoot, 'environments', `${envName}.config.json`);
      if (!existsSync(envConfigPath)) {
        console.error(`No such environment: ${envConfigPath}`);
        return 1;
      }
      const baseEnvConfig = loadFlashTheaterEnvironmentConfig(envConfigPath);

      const localEnvConfigPath = join(appRoot, 'environments', `${envName}.local.config.json`);
      const localEnvConfig = existsSync(localEnvConfigPath) ? loadFlashTheaterEnvironmentConfig(localEnvConfigPath) : null;

      environmentConfig = mergeEnvironmentConfigs(baseEnvConfig, localEnvConfig);
    }

    const resolvedEnvVariables = environmentConfig ? resolveEnvironmentVariables(environmentConfig.variables, process.env) : null;

    const { srcRoot, outRoot, exclude, include } = resolveProjectLayout(appRoot, config, { srcDir: srcDirOverride, outDir: outDirOverride }, environmentConfig, envName);

    if (!existsSync(srcRoot)) {
      console.error(`No such src directory: ${srcRoot}`);
      return 1;
    }

    const { compileTargets, passthroughFiles } = walkSrcTree(srcRoot, exclude, include);

    if (compileTargets.length === 0 && passthroughFiles.length === 0) {
      console.error(`Nothing found under ${srcRoot}`);
      return 1;
    }

    const inputs: AppFileInput[] = compileTargets.map((p) => ({
      path: p,
      source: readFileSync(p, 'utf8'),
      componentName: basename(p, extname(p)),
      kind: extname(p) === '.flsh' ? 'flsh' : 'thr',
    }));
    const compiledApp = compileApp(inputs, srcRoot, outRoot, config, resolvedEnvVariables);

    if (checkOnly) {
      for (const output of compiledApp.outputs) console.log(`OK  ${output.path}`);
      if (compiledApp.themeOutput) console.log(`OK  ${compiledApp.themeOutput.sourcePath}`);
      for (const classOutput of compiledApp.classOutputs) console.log(`OK  ${classOutput.path}`);
      return 0;
    }

    // `out/` is 100% derived — wipe it clean before regenerating rather than writing in place, so
    // renaming/deleting a source file can never leave a stale compiled/copied leftover behind.
    rmSync(outRoot, { recursive: true, force: true });

    for (const file of passthroughFiles) {
      // Patch (rather than verbatim-copy) exactly the app-root src/manifest — not any nested file
      // that happens to be named "manifest" — when the active environment declares manifestOverrides.
      if (envName && environmentConfig?.manifestOverrides && dirname(file) === srcRoot && basename(file) === 'manifest') {
        const patched = applyManifestOverrides(readFileSync(file, 'utf8'), environmentConfig.manifestOverrides);
        mkdirSync(outRoot, { recursive: true });
        writeFileSync(join(outRoot, 'manifest'), patched);
        continue;
      }
      copyPassthroughFile(srcRoot, outRoot, file);
    }
    for (const output of compiledApp.outputs) writeCompiledOutput(srcRoot, outRoot, output);
    for (const classOutput of compiledApp.classOutputs) writeCompiledClassOutput(srcRoot, outRoot, classOutput);

    const componentsBaseDir = join(outRoot, 'components');
    const sourceDir = join(outRoot, 'source');

    if (compiledApp.usesStore) {
      copyRuntimeAsset(componentsBaseDir, 'Store', 'Store', FLASH_THEATER_STORE_COMPONENT_NAME);
    }

    if (compiledApp.usesFocusSystem) {
      copyRuntimeAsset(componentsBaseDir, 'FocusManager', 'FlashTheaterFocusManager', FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME);
    }

    if (compiledApp.usesRouter) {
      copyRuntimeAsset(componentsBaseDir, 'Router', 'FlashTheaterRouter', FLASH_THEATER_ROUTER_COMPONENT_NAME);
      copyRuntimeAsset(componentsBaseDir, 'RouterOutlet', 'FlashTheaterRouterOutlet', FLASH_THEATER_ROUTER_OUTLET_COMPONENT_NAME);
    }

    if (compiledApp.usesTaskManager) {
      copyRuntimeAsset(componentsBaseDir, 'TaskManager', 'FlashTheaterTaskManager', FLASH_THEATER_TASK_MANAGER_COMPONENT_NAME);
    }

    if (compiledApp.usesComparisonHelper) {
      copyRuntimeBrsAsset(componentsBaseDir, FLASH_THEATER_SAFE_COMPARE_DIR_NAME, FLASH_THEATER_SAFE_COMPARE_FILE_BASE_NAME, FLASH_THEATER_SAFE_COMPARE_DIR_NAME);
    }

    if (compiledApp.usesSafeNotHelper) {
      copyRuntimeBrsAsset(componentsBaseDir, FLASH_THEATER_SAFE_NOT_DIR_NAME, FLASH_THEATER_SAFE_NOT_FILE_BASE_NAME, FLASH_THEATER_SAFE_NOT_DIR_NAME);
    }

    if (compiledApp.usesStreamHelper) {
      copyRuntimeBrsAsset(componentsBaseDir, FLASH_THEATER_STREAM_DIR_NAME, FLASH_THEATER_STREAM_FILE_BASE_NAME, FLASH_THEATER_STREAM_DIR_NAME);
    }

    if (compiledApp.usesHttpRequestHelper) {
      copyRuntimeBrsAsset(componentsBaseDir, FLASH_THEATER_HTTP_DIR_NAME, FLASH_THEATER_HTTP_FILE_BASE_NAME, FLASH_THEATER_HTTP_DIR_NAME);
    }

    if (compiledApp.usesScaleHelper) {
      copyRuntimeBrsAsset(componentsBaseDir, FLASH_THEATER_SCALE_DIR_NAME, FLASH_THEATER_SCALE_FILE_BASE_NAME, FLASH_THEATER_SCALE_DIR_NAME);
    }

    if (compiledApp.usesRelationalHelper) {
      copyRuntimeBrsAsset(componentsBaseDir, FLASH_THEATER_SAFE_RELATIONAL_DIR_NAME, FLASH_THEATER_SAFE_RELATIONAL_FILE_BASE_NAME, FLASH_THEATER_SAFE_RELATIONAL_DIR_NAME);
    }

    if (compiledApp.themeOutput) {
      writeThemeOutput(compiledApp.themeOutput, componentsBaseDir);
    }

    if (compiledApp.globalsBrs) {
      writeGlobalsBrs(compiledApp.globalsBrs, sourceDir);
    }

    return 0;
  } catch (err) {
    reportError(err);
    return 1;
  }
}

function parseCompileArgs(argv: string[]): { checkOnly: boolean; srcDirOverride: string | null; outDirOverride: string | null; envOverride: string | null } {
  let checkOnly = false;
  let srcDirOverride: string | null = null;
  let outDirOverride: string | null = null;
  let envOverride: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      checkOnly = true;
      continue;
    }
    if (arg === '--src-dir') {
      srcDirOverride = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === '--out-dir') {
      outDirOverride = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === '--env') {
      envOverride = argv[i + 1] ?? null;
      i++;
      continue;
    }
  }

  return { checkOnly, srcDirOverride, outDirOverride, envOverride };
}

/**
 * Logic for `flash-theater zip [--out-dir <dir>] [--env <name>] [--app-name <name>]` — zips an
 * already-compiled `outRoot` into `dist/` (see `packaging.ts`'s `writeAppZip`). No `--src-dir`: unlike
 * `compile`, zipping never reads `srcRoot`, and `resolveProjectLayout`'s `outRoot` doesn't depend on
 * `srcDir` either, so there's nothing for that flag to affect here.
 *
 * Deliberately does not load/validate `environments/<name>.config.json` the way `compile` does —
 * `resolveProjectLayout`'s `outRoot` only depends on `outDir` (config/`--out-dir`) and the env
 * *name* for its `-<env>` suffix, never on that file's contents, so `zip --env <name>` only requires
 * that `out-<name>/` was already produced by a prior `compile --env <name>`, not that the environment
 * config file still exists.
 */
function runZipCommand(argv: string[]): number {
  const { outDirOverride, envOverride, appNameOverride } = parseZipArgs(argv);

  try {
    const appRoot = process.cwd();
    const config = loadConfig(appRoot);
    const envName = envOverride ?? process.env.FLASH_THEATER_ENV ?? null;

    const { outRoot } = resolveProjectLayout(appRoot, config, { outDir: outDirOverride }, null, envName);

    if (!existsSync(outRoot)) {
      console.error(`No such output directory: ${outRoot} — run "flash-theater compile" first.`);
      return 1;
    }

    const { zipPath } = writeAppZip({ appRoot, outRoot, envName, appName: appNameOverride });
    console.log(`Wrote ${zipPath}`);
    return 0;
  } catch (err) {
    reportError(err);
    return 1;
  }
}

function parseZipArgs(argv: string[]): { outDirOverride: string | null; envOverride: string | null; appNameOverride: string | null } {
  let outDirOverride: string | null = null;
  let envOverride: string | null = null;
  let appNameOverride: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out-dir') {
      outDirOverride = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === '--env') {
      envOverride = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === '--app-name') {
      appNameOverride = argv[i + 1] ?? null;
      i++;
      continue;
    }
  }

  return { outDirOverride, envOverride, appNameOverride };
}

/** Copies one hand-written `src/` file (manifest, an image, `source/Main.brs`, a hand-written component with no `.thr` source like `apps/focus-demo`'s `MainScene.xml`/`.brs`, ...) verbatim to its mirrored path under `out/` — no marker, since it isn't generated, just relocated. */
function copyPassthroughFile(srcRoot: string, outRoot: string, srcPath: string): void {
  const targetPath = join(outRoot, relative(srcRoot, srcPath));
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(srcPath, targetPath);
}

/** Mirrors `output.path`'s directory (srcRoot-based) into the matching directory under `outRoot`, so a component nested under `src/components/Foo/` compiles to `out/components/Foo/`. */
function mirroredOutputDir(srcRoot: string, outRoot: string, inputPath: string): string {
  return join(outRoot, relative(srcRoot, dirname(inputPath)));
}

function writeCompiledOutput(srcRoot: string, outRoot: string, output: CompiledAppOutput): void {
  const dir = mirroredOutputDir(srcRoot, outRoot, output.path);
  const xmlPath = join(dir, `${output.componentName}.xml`);
  const brsPath = join(dir, `${output.componentName}.brs`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(xmlPath, withXmlMarker(output.xml, output.componentName));
  writeFileSync(brsPath, withBrsMarker(output.brs, output.componentName));

  console.log(`compiled  ${output.path}  ->  ${xmlPath}, ${brsPath}`);
}

/**
 * Writes a compiled `.flsh` class's `.brs` mirrored under `outRoot` next to where its own `.thr`
 * siblings land — no `.xml` (a class has no SceneGraph shape at all) — unlike the theme/store,
 * which land in the fixed `FlashTheater/` subfolder (see `writeThemeOutput`/`copyRuntimeAsset`): a
 * class is user-named and there can be arbitrarily many, so mirroring its own `src/` location is
 * what makes `import X from "./Foo/X.flsh"` read naturally next to where the user put it, and
 * avoids forcing every class in an app into one shared, collision-prone folder.
 */
function writeCompiledClassOutput(srcRoot: string, outRoot: string, output: CompiledClassOutput): void {
  const dir = mirroredOutputDir(srcRoot, outRoot, output.path);
  const brsPath = join(dir, `${output.className}.brs`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(brsPath, withBrsMarker(output.brs, output.className));

  console.log(`compiled  ${output.path}  ->  ${brsPath}`);
}

/**
 * Writes the app's compiled theme component into a `FlashTheater/` subfolder of
 * `componentsBaseDir` (an `outRoot`-based path — see `runCli`), under its fixed
 * `FLASH_THEATER_THEME_COMPONENT_NAME` — never next to the `<theme-template>` `.thr` source the
 * way an ordinary component's output is (see `writeCompiledOutput`), and never under the source
 * file's own name, mirroring `copyRuntimeAsset`'s fixed location for the store. This is what makes
 * the theme's source filename/location a free choice for the app author: `compileApp` already
 * finds the `<theme-template>` file structurally (by its root tag), not by name.
 */
function writeThemeOutput(theme: CompiledThemeOutput, componentsBaseDir: string): void {
  const targetDir = join(componentsBaseDir, 'FlashTheater', FLASH_THEATER_THEME_COMPONENT_NAME);
  mkdirSync(targetDir, { recursive: true });

  const xmlPath = join(targetDir, `${FLASH_THEATER_THEME_COMPONENT_NAME}.xml`);
  const brsPath = join(targetDir, `${FLASH_THEATER_THEME_COMPONENT_NAME}.brs`);

  // withXmlMarker/withBrsMarker append ".thr" to their second argument to describe the source —
  // pass the theme's *actual* source basename (not FLASH_THEATER_THEME_COMPONENT_NAME) so the
  // marker comment stays truthful even though the compiled filename and the source filename can
  // now legitimately differ (see writeThemeOutput's own doc comment above).
  const sourceBaseName = basename(theme.sourcePath, extname(theme.sourcePath));
  writeFileSync(xmlPath, withXmlMarker(theme.xml, sourceBaseName));
  writeFileSync(brsPath, withBrsMarker(theme.brs, sourceBaseName));

  console.log(`compiled  ${theme.sourcePath}  ->  ${xmlPath}, ${brsPath}`);
}

/**
 * Writes the `FlashTheaterSetupGlobals(globalNode)` bootstrap sub into a `FlashTheater/` subfolder
 * of `outRoot`'s own `source/` (the app author adds one hand-written call to it, right before
 * `CreateScene`, in `src/source/Main.brs`) — grouped alongside the copied runtime Store component
 * (see `copyRuntimeAsset`) so every piece of compiler-owned, never-hand-written output lives under
 * one `FlashTheater/` folder rather than scattered loose among the app's own files.
 */
function writeGlobalsBrs(globalsBrs: string, outSourceDir: string): void {
  const targetDir = join(outSourceDir, 'FlashTheater');
  const targetPath = join(targetDir, 'FlashTheaterGlobals.brs');

  mkdirSync(targetDir, { recursive: true });
  const marked = `' ${GENERATED_MARKER} — do not edit by hand, generated from the app's theme-template file and/or its components' store usage\n${globalsBrs}`;
  writeFileSync(targetPath, marked);

  console.log(`generated  ${targetPath}`);
}

/**
 * Locates `packages/compiler/runtime-assets/<assetDirName>` relative to this
 * module's own location rather than `process.cwd()`, so it works regardless
 * of where the CLI is invoked from. The relative depth differs between how
 * this file is actually run: one `..` when `tsx` runs `src/cli.ts` directly
 * (this repo's own tests, and dev/watch mode), two when running the compiled
 * `dist/src/cli.js` (the published CLI) — `dist/` sits beside
 * `runtime-assets/` at the package root, one level further out than `src/`.
 * Trying both and taking whichever actually exists avoids hardcoding one
 * depth and breaking the other context. `primaryFileName` (e.g. `Store.xml`)
 * is only used to confirm a candidate directory is really the asset dir, not
 * some unrelated empty folder.
 */
function resolveRuntimeAssetDir(assetDirName: string, primaryFileName: string): string {
  const candidates = [join(__dirname, '..', 'runtime-assets', assetDirName), join(__dirname, '..', '..', 'runtime-assets', assetDirName)];
  const found = candidates.find((c) => existsSync(join(c, primaryFileName)));
  if (!found) throw new Error(`internal: could not locate runtime-assets/${assetDirName} relative to ${__dirname} (tried: ${candidates.join(', ')})`);
  return found;
}

/**
 * Copies a fixed, hand-authored runtime component
 * (`packages/compiler/runtime-assets/<assetDirName>/{<fileBaseName>.xml,.brs}`)
 * into the app's own component output — zero manual wiring for the app
 * author, unlike the one hand-written `Main.brs` bootstrap line
 * `writeGlobalsBrs` still requires. `componentsBaseDir` is an `outRoot`-based
 * `components/` path (see `runCli`) — the same convention every other
 * compiled component's output already follows. Written under a
 * `FlashTheater/` subfolder (not directly in `componentsBaseDir`) so every
 * piece of compiler-owned output — never hand-authored, unlike an app's own
 * components — lives in one place; see `writeGlobalsBrs`'s matching
 * `source/FlashTheater/` convention. Shared by every fixed runtime asset
 * (Store, FocusManager, and any future one) — they differ only in
 * directory/file names.
 */
function copyRuntimeAsset(componentsBaseDir: string, assetDirName: string, fileBaseName: string, componentDirName: string): void {
  const assetDir = resolveRuntimeAssetDir(assetDirName, `${fileBaseName}.xml`);
  const targetDir = join(componentsBaseDir, 'FlashTheater', componentDirName);
  mkdirSync(targetDir, { recursive: true });

  const xmlPath = join(targetDir, `${fileBaseName}.xml`);
  const brsPath = join(targetDir, `${fileBaseName}.brs`);

  const xmlSource = readFileSync(join(assetDir, `${fileBaseName}.xml`), 'utf8');
  const brsSource = readFileSync(join(assetDir, `${fileBaseName}.brs`), 'utf8');
  const [xmlDeclarationLine, ...xmlRest] = xmlSource.split('\n');
  const xmlMarker = `<!-- ${GENERATED_MARKER} — do not edit by hand, copied from packages/compiler/runtime-assets/${assetDirName} -->`;

  writeFileSync(xmlPath, [xmlDeclarationLine, xmlMarker, ...xmlRest].join('\n'));
  writeFileSync(brsPath, `' ${GENERATED_MARKER} — do not edit by hand, copied from packages/compiler/runtime-assets/${assetDirName}\n${brsSource}`);

  console.log(`copied  runtime-assets/${assetDirName}  ->  ${xmlPath}, ${brsPath}`);
}

/**
 * `.brs`-only counterpart to `copyRuntimeAsset`, for a fixed runtime asset
 * with no `.xml` at all — currently just `runtime-assets/SafeCompare`
 * (`ft_equals(...)`, a plain function library, never itself a SceneGraph
 * node/component the way Store/FocusManager/Router are). Written under the
 * same `componentsBaseDir/FlashTheater/<componentDirName>/` convention as
 * `copyRuntimeAsset`, so a component's own `<script uri="...">` (computed by
 * `app-compiler.ts`'s `toScriptUri` against this same `outRoot`-based path)
 * resolves correctly regardless of that component's own directory depth.
 */
function copyRuntimeBrsAsset(componentsBaseDir: string, assetDirName: string, fileBaseName: string, componentDirName: string): void {
  const assetDir = resolveRuntimeAssetDir(assetDirName, `${fileBaseName}.brs`);
  const targetDir = join(componentsBaseDir, 'FlashTheater', componentDirName);
  mkdirSync(targetDir, { recursive: true });

  const brsPath = join(targetDir, `${fileBaseName}.brs`);
  const brsSource = readFileSync(join(assetDir, `${fileBaseName}.brs`), 'utf8');
  writeFileSync(brsPath, `' ${GENERATED_MARKER} — do not edit by hand, copied from packages/compiler/runtime-assets/${assetDirName}\n${brsSource}`);

  console.log(`copied  runtime-assets/${assetDirName}  ->  ${brsPath}`);
}

export function withXmlMarker(xml: string, componentName: string): string {
  const [declarationLine, ...rest] = xml.split('\n');
  const marker = `<!-- ${GENERATED_MARKER} — do not edit by hand, source: ${componentName}.thr -->`;
  return [declarationLine, marker, ...rest].join('\n');
}

export function withBrsMarker(brs: string, componentName: string): string {
  return `' ${GENERATED_MARKER} — do not edit by hand, source: ${componentName}.thr\n${brs}`;
}

function reportError(err: unknown): void {
  if (err instanceof CompileError) {
    const loc = err.diagnostic.span ? `:${err.diagnostic.span.line + 1}` : '';
    console.error(`ERROR${loc}  [${err.diagnostic.code}]  ${err.diagnostic.message}`);
  } else {
    console.error(`ERROR  ${err instanceof Error ? err.message : String(err)}`);
  }
}
