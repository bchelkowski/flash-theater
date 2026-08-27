#!/usr/bin/env node
// Same default-to-"dev" reasoning as with-env.mjs, plus: an environment build's zip is named
// dist/environments-demo-<env>-<version>.zip (the version comes from the final, patched manifest —
// see GRAMMAR.md's Environments "Output naming"), so (unlike every other app's fixed
// dist/<app>.zip) the exact filename can't be hardcoded here without going stale on every manifest
// version bump. This just globs dist/ for the active environment's zip instead.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const envName = process.env.FLASH_THEATER_ENV || 'dev';
const distDir = join(import.meta.dirname, '..', 'dist');
const prefix = `environments-demo-${envName}-`;

const match = readdirSync(distDir).find((f) => f.startsWith(prefix) && f.endsWith('.zip'));

if (!match) {
  console.error(`No dist/${prefix}*.zip found — run "npm run build:roku" (optionally with FLASH_THEATER_ENV=${envName}) first.`);
  process.exit(1);
}

const result = spawnSync('kopytko-roku', ['installer', 'install', '--zip', join('dist', match)], {
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status === null ? 1 : result.status);
