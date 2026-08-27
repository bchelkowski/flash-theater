/**
 * Resolves the TypeScript-style `src/` (hand-written project files) vs `out/` (fully generated,
 * safe to delete/gitignore) split every app follows — see findings/build-layout.md. `cli.ts` is
 * the only caller; kept separate from it (rather than inlined) because it's pure path/string logic
 * with no filesystem writes of its own, only `readdirSync`/`statSync` reads.
 */
import { readdirSync } from 'node:fs';
import { extname, join, relative, resolve as resolvePath } from 'node:path';
import { FlashTheaterConfig, FlashTheaterEnvironmentConfig } from './config.js';

export interface ProjectLayout {
  /** 100% hand-written project files (manifest, images/, source/Main.brs, components/**\/*.thr, .flsh, and any hand-written .xml/.brs with no .thr source). Never written to by the compiler. */
  srcRoot: string;
  /** 100% generated/copied output — wiped and rebuilt on every `compile`. Physically becomes the Roku package root once zipped. Suffixed `-<env>` when an environment is active (`out-staging/`), so different environments' builds never clobber each other. */
  outRoot: string;
  /** Glob patterns (relative to `srcRoot`, posix-style) — a matching file or directory is skipped entirely, neither compiled nor copied. The base config's own `exclude` plus (when an environment is active) that environment's `exclude`. */
  exclude: readonly string[];
  /** Glob patterns (relative to `srcRoot`, posix-style) exempted from `exclude` — only ever non-empty when an environment is active and declares its own `include`. See `isExcludedNotIncluded`. */
  include: readonly string[];
}

/**
 * `appRoot` is the app's own directory (where `flash-theater.config.json`/`package.json` live).
 * `overrides` are `--src-dir`/`--out-dir` CLI flags — take priority over the config file, which
 * takes priority over the `src`/`out` defaults. `envConfig`/`envName` are the active environment's
 * already-merged config (base + local override, see `config.ts`'s `mergeEnvironmentConfigs`) and its
 * name — both `null` when no `--env`/`FLASH_THEATER_ENV` is active, in which case this function's
 * output is byte-identical to before the `environments` feature existed.
 */
export function resolveProjectLayout(
  appRoot: string,
  config: FlashTheaterConfig | null,
  overrides: { srcDir?: string | null; outDir?: string | null } = {},
  envConfig: FlashTheaterEnvironmentConfig | null = null,
  envName: string | null = null,
): ProjectLayout {
  const srcDir = overrides.srcDir ?? config?.srcDir ?? 'src';
  const outDir = overrides.outDir ?? config?.outDir ?? 'out';
  // `resolvePath` (not `join`) so an absolute override — e.g. a test's own tmp dir — replaces
  // appRoot entirely instead of being nested under it; a relative one resolves against appRoot as normal.
  return {
    srcRoot: resolvePath(appRoot, srcDir),
    outRoot: resolvePath(appRoot, envName ? `${outDir}-${envName}` : outDir),
    exclude: [...(config?.exclude ?? []), ...(envConfig?.exclude ?? [])],
    include: envConfig?.include ?? [],
  };
}

export interface SrcTree {
  /** `.thr`/`.flsh` files to compile, as absolute paths. */
  compileTargets: string[];
  /** Every other file under `srcRoot` (manifest, images, hand-written `.brs`/`.xml`, ...), as absolute paths — copied verbatim to the mirrored path under `outRoot`. */
  passthroughFiles: string[];
}

/**
 * Recursively walks `srcRoot`, splitting discovered files into compile targets and pass-through
 * files, skipping anything `exclude` matches unless `include` exempts it (a matched-and-not-exempted
 * directory is not descended into at all — but see the `include`-non-empty branch below).
 */
export function walkSrcTree(srcRoot: string, exclude: readonly string[], include: readonly string[] = []): SrcTree {
  const compileTargets: string[] = [];
  const passthroughFiles: string[] = [];
  // When no `include` patterns are active (every build with no environment, or an environment that
  // doesn't declare `include`), keep the original fast path exactly: an excluded directory is never
  // descended into. Once `include` is non-empty, a file exempting an otherwise-excluded subtree could
  // be arbitrarily deep inside it, so every directory must be descended into and exclusion decided
  // per-file instead — see findings/environments.md for the perf tradeoff this accepts.
  const mustDescendExcludedDirs = include.length > 0;

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = toPosixPath(relative(srcRoot, full));
      const excluded = isExcludedNotIncluded(rel, exclude, include);

      if (entry.isDirectory()) {
        if (excluded && !mustDescendExcludedDirs) continue;
        walk(full);
      } else {
        if (excluded) continue;
        if (extname(full) === '.thr' || extname(full) === '.flsh') {
          compileTargets.push(full);
        } else {
          passthroughFiles.push(full);
        }
      }
    }
  }

  walk(srcRoot);
  return { compileTargets, passthroughFiles };
}

/** `isExcluded(relativePosixPath, exclude)` unless `include` explicitly exempts it — see `ProjectLayout.include`. */
function isExcludedNotIncluded(relativePosixPath: string, exclude: readonly string[], include: readonly string[]): boolean {
  return isExcluded(relativePosixPath, exclude) && !isExcluded(relativePosixPath, include);
}

/** Whether `relativePosixPath` matches any of `patterns` — each pattern supports `**` (any number of path segments), `*` (anything but `/`), and `?` (one character but `/`), tsconfig-`exclude`-style. Not a general glob engine; only what an app's own `exclude` list realistically needs (see findings/build-layout.md). */
export function isExcluded(relativePosixPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePosixPath));
}

function toPosixPath(p: string): string {
  return p.split('\\').join('/');
}

function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // `dir/**` must match `dir` itself too (not just its descendants) — a directory entry is
      // checked against `exclude` before the walker recurses into it (see `walkSrcTree`), so
      // without this a whole excluded subtree would still be descended into, just with every file
      // inside it individually filtered out one by one instead of the directory being skipped outright.
      if (re.endsWith('/')) {
        re = `${re.slice(0, -1)}(/.*)?`;
      } else {
        re += '.*';
      }
      i += 2;
      if (pattern[i] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}
