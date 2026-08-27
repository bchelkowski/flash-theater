/**
 * Zips an already-compiled app's `outRoot` (see `project-layout.ts`) into a `dist/` artifact ready
 * to sideload onto a Roku device — `cli.ts`'s `zip` command is the only caller. `outRoot` already
 * mirrors the exact Roku package shape (manifest, source/, components/, images/) with no .thr/.flsh
 * left in it (see findings/build-layout.md), so the whole directory is zipped as-is, no filtering
 * needed. Assumes `outRoot` already exists — the caller (`cli.ts`) is responsible for that check,
 * the same way it already checks `srcRoot` exists before compiling.
 */
import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readManifestVersion } from './manifest.js';

export interface WriteAppZipOptions {
  /** App root — where `flash-theater.config.json`/`package.json` live. */
  appRoot: string;
  /** Already-resolved directory to zip (`out/` or `out-<env>/` — see `project-layout.ts`'s `resolveProjectLayout`). */
  outRoot: string;
  /** Active environment name, or `null` for a plain build — only used to name the zip, not to re-derive `outRoot`. */
  envName: string | null;
  /** `--app-name` override — takes priority over `package.json`'s `"name"` and the `appRoot` directory's own basename. */
  appName?: string | null;
}

export interface WriteAppZipResult {
  zipPath: string;
}

/**
 * No active environment: `dist/<appName>.zip`. Active environment: `dist/<appName>-<env>-<major>.<minor>.<build>.zip`,
 * version read from `outRoot`'s own (already environment-patched) manifest — so different
 * environments' builds never clobber each other or the plain build. See `findings/environments.md`.
 */
export function writeAppZip(options: WriteAppZipOptions): WriteAppZipResult {
  const { appRoot, outRoot, envName } = options;

  const appName = resolveAppName(appRoot, options.appName ?? null);
  const distDir = join(appRoot, 'dist');
  mkdirSync(distDir, { recursive: true });

  let outPath: string;
  if (envName) {
    const manifestText = readFileSync(join(outRoot, 'manifest'), 'utf8');
    const version = readManifestVersion(manifestText);
    outPath = join(distDir, `${appName}-${envName}-${version.major}.${version.minor}.${version.build}.zip`);
  } else {
    outPath = join(distDir, `${appName}.zip`);
  }

  const zip = new AdmZip();
  zip.addLocalFolder(outRoot, '');
  zip.writeZip(outPath);

  return { zipPath: outPath };
}

/** `--app-name` override, else `package.json`'s `"name"` field at `appRoot`, else the `appRoot` directory's own basename — matches what every `apps/*` `zip.mjs` used to hardcode as its own `APP_NAME` constant. */
function resolveAppName(appRoot: string, appNameOverride: string | null): string {
  if (appNameOverride) return appNameOverride;

  const packageJsonPath = join(appRoot, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.length > 0) return parsed.name;
    } catch {
      // Malformed package.json — fall through to the directory-basename fallback below rather than failing the zip.
    }
  }

  return basename(appRoot);
}
