# A missing `source/Main.brs` compiles and zips silently

**Type:** Bug
**Area:** build-layout
**Status:** Open

## Problem

The compiler never validates that `source/Main.brs` (the one hand-written bootstrap file every app
still needs — see GRAMMAR.md's "Not yet implemented" history and `findings/build-layout.md`) actually
exists before compiling and zipping an app. If it's missing, `npm run build:roku` completes cleanly
and produces a zip with no entry point.

## Impact

Confirmed to have already shipped **5 demo apps broken this way** before being caught by hand
(per `findings/build-layout.md`). The failure mode is silent at build time — the first signal is a
sideloaded app that does nothing, which is a slow, manual thing to diagnose.

## Where

- `findings/build-layout.md` — documents the confirmed silent-failure precedent.
- `packages/compiler/src/compile.ts` / `packages/compiler/src/index.ts` (`compileApp`) — the
  whole-app compile entry point where a pre-flight file-existence check would live.
- `packages/compiler/src/packaging.ts` — the zip-packaging step, the last point before a broken
  artifact ships.

## Suggested fix

Add a pre-flight check in `compileApp` (or immediately before `packaging.ts` zips) that verifies
`<srcDir>/Main.brs` exists, and fail the build loudly (non-zero exit, clear message naming the
expected path) if it doesn't. Should be a cheap `fs.existsSync` check — no new architecture needed,
just a missing guard. Add a compiler test asserting the build fails when this file is absent.

## Related

- `findings/build-layout.md`
- `findings/dev-environment.md` (sideload flow that currently surfaces this failure late)
