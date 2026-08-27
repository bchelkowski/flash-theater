/**
 * Loads `flash-theater.config.json` — the repo's first compiler-level config file (see
 * GRAMMAR.md's "scale" section and findings/reactivity-state.md). Holds two kinds of setting:
 * `designResolution` (the resolution tier `scale` computes its runtime factor from) and the
 * project-layout trio `srcDir`/`outDir`/`exclude` (see findings/build-layout.md) that tells the
 * CLI where an app's hand-written project files live and where to write everything it generates.
 *
 * Kept out of `compile.ts`/`app-compiler.ts` — neither touches `fs` (see
 * findings/compiler-pipeline-and-build.md's "no `fs` inside `compile.ts`" rule) — this is the one place
 * in the compiler that reads a config file directly, called only from `cli.ts`.
 */
import { readFileSync } from 'node:fs';
import { CompileError } from './dsl-parser/dsl-ast.js';

export type DesignResolution = 'hd' | 'fhd';

export interface FlashTheaterConfig {
  designResolution: DesignResolution;
  /** Project source directory, relative to the app root (sibling of this config file) — defaults to `'src'`. See `project-layout.ts`. */
  srcDir?: string;
  /** Fully generated/copied output directory, relative to the app root — defaults to `'out'`. Wiped and rebuilt on every `compile`. See `project-layout.ts`. */
  outDir?: string;
  /** Glob patterns (relative to `srcDir`) for files/directories to skip entirely — neither compiled nor copied. See `project-layout.ts`'s `isExcluded`. */
  exclude?: string[];
}

const VALID_DESIGN_RESOLUTIONS: ReadonlySet<string> = new Set(['hd', 'fhd']);

/** Reads and validates `flash-theater.config.json` at `path`. Throws `CompileError` (`config/malformed-json`/`config/invalid-design-resolution`/`config/invalid-src-dir`/`config/invalid-out-dir`/`config/invalid-exclude`) on anything wrong — never returns a partially-valid config. */
export function loadFlashTheaterConfig(path: string): FlashTheaterConfig {
  const raw = readFileSync(path, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CompileError({
      code: 'config/malformed-json',
      message: `${path}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const obj = parsed as Record<string, unknown> | null;

  const designResolution = obj?.designResolution;
  if (typeof designResolution !== 'string' || !VALID_DESIGN_RESOLUTIONS.has(designResolution)) {
    throw new CompileError({
      code: 'config/invalid-design-resolution',
      message: `${path}: "designResolution" must be exactly "hd" or "fhd" — got ${JSON.stringify(designResolution)}.`,
    });
  }

  const srcDirRaw = obj?.srcDir;
  if (srcDirRaw !== undefined && typeof srcDirRaw !== 'string') {
    throw new CompileError({ code: 'config/invalid-src-dir', message: `${path}: "srcDir" must be a string — got ${JSON.stringify(srcDirRaw)}.` });
  }

  const outDirRaw = obj?.outDir;
  if (outDirRaw !== undefined && typeof outDirRaw !== 'string') {
    throw new CompileError({ code: 'config/invalid-out-dir', message: `${path}: "outDir" must be a string — got ${JSON.stringify(outDirRaw)}.` });
  }

  const excludeRaw = obj?.exclude;
  if (excludeRaw !== undefined && (!Array.isArray(excludeRaw) || excludeRaw.some((e) => typeof e !== 'string'))) {
    throw new CompileError({ code: 'config/invalid-exclude', message: `${path}: "exclude" must be an array of strings — got ${JSON.stringify(excludeRaw)}.` });
  }

  const config: FlashTheaterConfig = { designResolution: designResolution as DesignResolution };
  if (srcDirRaw !== undefined) config.srcDir = srcDirRaw;
  if (outDirRaw !== undefined) config.outDir = outDirRaw;
  if (excludeRaw !== undefined) config.exclude = excludeRaw as string[];
  return config;
}

/**
 * One declared environment variable's value source — exactly one of the two, never both/neither.
 * `fromEnv` reads a bash/CI environment variable at build time (for secrets/URLs that shouldn't be
 * committed); `value` is a plain literal baked in as-is. See `resolveEnvironmentVariables`.
 */
export interface EnvVariableSource {
  fromEnv?: string;
  value?: string;
}

/**
 * `environments/<name>.config.json` (and, identically shaped, `environments/<name>.local.config.json`
 * — see `mergeEnvironmentConfigs`) — an opt-in *patch* on top of the app's base
 * `flash-theater.config.json`, selected via `--env <name>`/`FLASH_THEATER_ENV`. Deliberately excludes
 * `designResolution`/`srcDir`/`outDir`: those stay app-wide, base-config-only settings, never
 * per-environment. See GRAMMAR.md's "Environments" section and findings/environments.md.
 */
export interface FlashTheaterEnvironmentConfig {
  /** Baked into the generated `ft_env` global AA, readable from DSL code as `env.<name>`. */
  variables?: Record<string, EnvVariableSource>;
  /** Key/value pairs upserted into the base `src/manifest`'s `key=value` lines when this environment is active — see `manifest.ts`'s `applyManifestOverrides`. */
  manifestOverrides?: Record<string, string>;
  /** Glob patterns (same syntax as the base config's `exclude`) added on top of it for this environment only. */
  exclude?: string[];
  /** Glob patterns exempted from `exclude` (base's and this environment's) for this environment only — see `project-layout.ts`'s `isExcludedNotIncluded`. */
  include?: string[];
}

const VALID_ENVIRONMENT_CONFIG_KEYS: ReadonlySet<string> = new Set(['variables', 'manifestOverrides', 'exclude', 'include']);

/**
 * Reads and validates `environments/<name>.config.json` (or `.local.config.json`) at `path`.
 * Throws `CompileError` (`environment-config/malformed-json`/`environment-config/unknown-key`/
 * `environment-config/invalid-variables`/`environment-config/invalid-variable-source`/
 * `environment-config/invalid-manifest-overrides`/`environment-config/invalid-exclude`/
 * `environment-config/invalid-include`) on anything wrong — never returns a partially-valid config.
 * Unlike `loadFlashTheaterConfig`, unrecognized top-level keys are rejected rather than silently
 * ignored — the most likely mistake here is assuming `designResolution`/`srcDir`/`outDir` are
 * overridable per-environment (they are not, see `FlashTheaterEnvironmentConfig`'s own doc comment).
 */
export function loadFlashTheaterEnvironmentConfig(path: string): FlashTheaterEnvironmentConfig {
  const raw = readFileSync(path, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CompileError({
      code: 'environment-config/malformed-json',
      message: `${path}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!VALID_ENVIRONMENT_CONFIG_KEYS.has(key)) {
      throw new CompileError({
        code: 'environment-config/unknown-key',
        message: `${path}: unrecognized key "${key}" — an environment config only supports "variables", "manifestOverrides", "exclude", "include" (not "designResolution"/"srcDir"/"outDir", which stay base-config-only).`,
      });
    }
  }

  const variablesRaw = obj.variables;
  if (variablesRaw !== undefined) {
    if (typeof variablesRaw !== 'object' || variablesRaw === null || Array.isArray(variablesRaw)) {
      throw new CompileError({ code: 'environment-config/invalid-variables', message: `${path}: "variables" must be an object — got ${JSON.stringify(variablesRaw)}.` });
    }
    for (const [name, source] of Object.entries(variablesRaw as Record<string, unknown>)) {
      validateVariableSource(path, name, source);
    }
  }

  const manifestOverridesRaw = obj.manifestOverrides;
  if (manifestOverridesRaw !== undefined) {
    if (typeof manifestOverridesRaw !== 'object' || manifestOverridesRaw === null || Array.isArray(manifestOverridesRaw)) {
      throw new CompileError({ code: 'environment-config/invalid-manifest-overrides', message: `${path}: "manifestOverrides" must be an object — got ${JSON.stringify(manifestOverridesRaw)}.` });
    }
    for (const [key, value] of Object.entries(manifestOverridesRaw as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new CompileError({ code: 'environment-config/invalid-manifest-overrides', message: `${path}: "manifestOverrides.${key}" must be a string — got ${JSON.stringify(value)}.` });
      }
    }
  }

  const excludeRaw = obj.exclude;
  if (excludeRaw !== undefined && (!Array.isArray(excludeRaw) || excludeRaw.some((e) => typeof e !== 'string'))) {
    throw new CompileError({ code: 'environment-config/invalid-exclude', message: `${path}: "exclude" must be an array of strings — got ${JSON.stringify(excludeRaw)}.` });
  }

  const includeRaw = obj.include;
  if (includeRaw !== undefined && (!Array.isArray(includeRaw) || includeRaw.some((e) => typeof e !== 'string'))) {
    throw new CompileError({ code: 'environment-config/invalid-include', message: `${path}: "include" must be an array of strings — got ${JSON.stringify(includeRaw)}.` });
  }

  const config: FlashTheaterEnvironmentConfig = {};
  if (variablesRaw !== undefined) config.variables = variablesRaw as Record<string, EnvVariableSource>;
  if (manifestOverridesRaw !== undefined) config.manifestOverrides = manifestOverridesRaw as Record<string, string>;
  if (excludeRaw !== undefined) config.exclude = excludeRaw as string[];
  if (includeRaw !== undefined) config.include = includeRaw as string[];
  return config;
}

function validateVariableSource(path: string, name: string, source: unknown): void {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new CompileError({ code: 'environment-config/invalid-variable-source', message: `${path}: "variables.${name}" must be an object with exactly one of "fromEnv"/"value" — got ${JSON.stringify(source)}.` });
  }
  const { fromEnv, value } = source as Record<string, unknown>;
  const hasFromEnv = fromEnv !== undefined;
  const hasValue = value !== undefined;
  if (hasFromEnv === hasValue) {
    throw new CompileError({
      code: 'environment-config/invalid-variable-source',
      message: `${path}: "variables.${name}" must declare exactly one of "fromEnv" or "value" — got ${JSON.stringify(source)}.`,
    });
  }
  if (hasFromEnv && typeof fromEnv !== 'string') {
    throw new CompileError({ code: 'environment-config/invalid-variable-source', message: `${path}: "variables.${name}.fromEnv" must be a string — got ${JSON.stringify(fromEnv)}.` });
  }
  if (hasValue && typeof value !== 'string') {
    throw new CompileError({ code: 'environment-config/invalid-variable-source', message: `${path}: "variables.${name}.value" must be a string — got ${JSON.stringify(value)}.` });
  }
}

/**
 * Resolves every declared variable to its final string value — `{value}` passes through literally,
 * `{fromEnv}` looks the named key up in `processEnv`, throwing `environment-config/missing-env-var`
 * if it's absent/undefined. Never returns a partial result. Kept separate from the loader (and takes
 * `processEnv` as a parameter rather than reading the real `process.env` itself) so it's unit-testable
 * without mutating global state — this is the first place in `packages/compiler/src` that reads
 * `process.env` at all, and only `cli.ts` ever passes it the real thing.
 */
export function resolveEnvironmentVariables(variables: Record<string, EnvVariableSource> | undefined, processEnv: NodeJS.ProcessEnv): Map<string, string> {
  const resolved = new Map<string, string>();
  if (!variables) return resolved;

  for (const [name, source] of Object.entries(variables)) {
    if (source.fromEnv !== undefined) {
      const value = processEnv[source.fromEnv];
      if (value === undefined) {
        throw new CompileError({
          code: 'environment-config/missing-env-var',
          message: `Environment variable "${name}" is declared as { "fromEnv": "${source.fromEnv}" }, but "${source.fromEnv}" is not set in the build environment.`,
        });
      }
      resolved.set(name, value);
    } else {
      resolved.set(name, source.value as string);
    }
  }

  return resolved;
}

/**
 * Layers `local` (from `environments/<name>.local.config.json`, if present) onto `base` (from
 * `environments/<name>.config.json`): `variables`/`manifestOverrides` are shallow-merged key-by-key
 * with `local` winning on conflicts (a `local` entry fully replaces `base`'s entry for that key —
 * not deep-merged — and `local` may introduce keys `base` never declared, e.g. a developer's own
 * sandbox-only secret); `exclude`/`include` are concatenated (`base`'s patterns first, then
 * `local`'s). `local === null` returns `base` unchanged (the common case — most developers never
 * create a local override file). See findings/environments.md for why local wins outright rather
 * than being deep-merged.
 */
export function mergeEnvironmentConfigs(base: FlashTheaterEnvironmentConfig, local: FlashTheaterEnvironmentConfig | null): FlashTheaterEnvironmentConfig {
  if (!local) return base;

  const merged: FlashTheaterEnvironmentConfig = {};

  if (base.variables || local.variables) {
    merged.variables = { ...base.variables, ...local.variables };
  }
  if (base.manifestOverrides || local.manifestOverrides) {
    merged.manifestOverrides = { ...base.manifestOverrides, ...local.manifestOverrides };
  }
  if (base.exclude || local.exclude) {
    merged.exclude = [...(base.exclude ?? []), ...(local.exclude ?? [])];
  }
  if (base.include || local.include) {
    merged.include = [...(base.include ?? []), ...(local.include ?? [])];
  }

  return merged;
}
