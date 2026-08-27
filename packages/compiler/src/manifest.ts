/**
 * Pure string helpers for patching a Roku `manifest` file (`key=value` lines, `#`-comments, blank
 * lines) with an environment's `manifestOverrides` — see `config.ts`'s `FlashTheaterEnvironmentConfig`
 * and `cli.ts`'s passthrough-copy loop, the only caller. No `fs` access here — `cli.ts` reads/writes,
 * this module only transforms already-read text, same tier as `project-layout.ts`.
 */
import { CompileError } from './dsl-parser/dsl-ast.js';

const REQUIRED_VERSION_KEYS = ['major_version', 'minor_version', 'build_version'] as const;

/**
 * Upserts each `overrides` key into `manifestText`'s `key=value` lines — an existing `key=` line is
 * replaced in place (preserving its position), a key with no existing line is appended at the end.
 * Every other line (comments, blanks, unrelated keys) is preserved verbatim, in its original order.
 */
export function applyManifestOverrides(manifestText: string, overrides: Record<string, string>): string {
  const remaining = new Map(Object.entries(overrides));
  const lines = manifestText.split('\n');

  const patchedLines = lines.map((line) => {
    const key = manifestLineKey(line);
    if (key !== null && remaining.has(key)) {
      const value = remaining.get(key) as string;
      remaining.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });

  if (remaining.size === 0) return patchedLines.join('\n');

  // Append any override whose key didn't already exist in the manifest — after the last non-blank
  // line, so we don't insert new keys before a trailing blank line the source file happened to end with.
  let insertAt = patchedLines.length;
  while (insertAt > 0 && patchedLines[insertAt - 1].trim() === '') insertAt--;

  const appended = [...remaining.entries()].map(([key, value]) => `${key}=${value}`);
  patchedLines.splice(insertAt, 0, ...appended);
  return patchedLines.join('\n');
}

/** `key` of a `key=value` manifest line, or `null` for a comment (`#...`) or blank line. */
function manifestLineKey(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const eq = line.indexOf('=');
  if (eq === -1) return null;
  return line.slice(0, eq).trim();
}

/**
 * Reads `major_version`/`minor_version`/`build_version` out of (already-patched) manifest text — used
 * only to name a versioned, per-environment zip file (`dist/<app>-<env>-<major>.<minor>.<build>.zip`,
 * see `zip.mjs`). Throws `manifest/missing-version-key` if any of the three is absent — an incomplete
 * manifest is a real build-configuration error here, not something to silently default.
 */
export function readManifestVersion(manifestText: string): { major: string; minor: string; build: string } {
  const values = new Map<string, string>();
  for (const line of manifestText.split('\n')) {
    const key = manifestLineKey(line);
    if (key !== null && REQUIRED_VERSION_KEYS.includes(key as (typeof REQUIRED_VERSION_KEYS)[number])) {
      values.set(key, line.slice(line.indexOf('=') + 1).trim());
    }
  }

  const missing = REQUIRED_VERSION_KEYS.filter((key) => !values.has(key));
  if (missing.length > 0) {
    throw new CompileError({
      code: 'manifest/missing-version-key',
      message: `manifest is missing required version key(s): ${missing.join(', ')} — needed to name a versioned per-environment build.`,
    });
  }

  return { major: values.get('major_version') as string, minor: values.get('minor_version') as string, build: values.get('build_version') as string };
}
