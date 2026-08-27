#!/usr/bin/env node
// Every chapter in this app reads `env.*` variables, so — unlike every other `apps/*-demo` app —
// there is no meaningful "plain" (no active environment) build here: `env.*` is a hard compile
// error with no active environment (`expression/env-requires-active-environment`, see
// packages/compiler/GRAMMAR.md's "Environments" section). Root `npm run build:roku` calls
// `npm run build:roku --workspace apps/environments-demo` with no `--env`/`FLASH_THEATER_ENV` of
// its own (same as every other app in that chain — the `--env` complexity is meant to stay INSIDE
// this app's own package.json, not leak into the root script), so this wrapper defaults
// `FLASH_THEATER_ENV` to "dev" whenever the caller hasn't already set one, then delegates straight
// to the real `flash-theater` CLI. An explicit `FLASH_THEATER_ENV=prod` (or any other declared
// environment) from the caller is left completely untouched — this only supplies a fallback, the
// exact same precedence `cli.ts` itself already gives `--env` over `FLASH_THEATER_ENV`. See
// findings/environments-demo-app.md for why this app needed its own wrapper where every other app
// just runs `flash-theater compile`/`flash-theater zip` directly.
import { spawnSync } from 'node:child_process';

// buildLabel (environments/dev.config.json / prod.config.json) is declared `{ "fromEnv":
// "ENVIRONMENTS_DEMO_BUILD_LABEL" }` specifically to demo that variant (see EnvVariableReadsDemo.thr's
// own top comment) — an unset fromEnv variable is a SEPARATE compile error
// (`environment-config/missing-env-var`) from the no-active-environment one above, and root
// `npm run build:roku` must succeed with zero extra setup, so this defaults it too.
const env = {
  ...process.env,
  FLASH_THEATER_ENV: process.env.FLASH_THEATER_ENV || 'dev',
  ENVIRONMENTS_DEMO_BUILD_LABEL: process.env.ENVIRONMENTS_DEMO_BUILD_LABEL || 'local-dev',
};
const args = process.argv.slice(2);

// shell: true so this resolves `flash-theater` (actually `flash-theater.cmd`/`flash-theater.ps1`
// on Windows) from node_modules/.bin the same way npm's own script runner would.
const result = spawnSync('flash-theater', args, { stdio: 'inherit', env, shell: true });

process.exit(result.status === null ? 1 : result.status);
