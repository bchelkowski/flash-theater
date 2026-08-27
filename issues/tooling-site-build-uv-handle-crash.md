# `site/`'s `npm run build` crashes on exit with `UV_HANDLE_CLOSING`

**Type:** Bug
**Area:** tooling
**Status:** Open

## Problem

Running `npm run build` inside `site/` (the Astro docs site) crashes on process exit with a
`UV_HANDLE_CLOSING` error. `findings/dev-environment.md` calls this "harmless" — the build output
itself is correct — but the crash is still an open rough edge that makes CI/scripted use of this
command noisy (non-zero-looking failure output even though the build succeeded).

## Impact

Low severity — doesn't affect the built site's correctness — but anyone scripting the docs-site build
(CI, a pre-deploy check) has to specifically know to ignore this exit noise, which is exactly the
kind of thing that causes a real failure to get ignored too.

## Where

- `findings/dev-environment.md` — where this is currently documented as a known/accepted rough edge.
- `site/` — Astro 5 + Tailwind v4 + React islands; likely a Node-version/native-binding interaction
  during Astro's own build teardown (Vite/esbuild child process handles), not flash-theater's own
  code.

## Suggested fix

Bisect whether this is a known upstream Astro/Vite issue for the pinned versions in `site/package.json`
(check their issue trackers before assuming it's fixable here) — if it's a known upstream bug, the fix
may just be a version bump; if not, narrow down which native handle isn't closed (likely a dev-server
preview process spawned during the build) and close it explicitly at the end of the build script.

## Related

- `findings/dev-environment.md`
