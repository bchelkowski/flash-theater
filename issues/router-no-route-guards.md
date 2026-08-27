# No middleware/route guards (`canActivate`, redirects)

**Type:** Gap
**Area:** router
**Status:** Open

## Problem

There's no concept of an async guard chain in the router — no way to declare "before entering this
route, run a check and possibly redirect or block navigation." Every route's `component:` mounts
unconditionally once matched.

## Impact

Anything resembling auth-gating, feature flags, or "confirm before leaving this screen" has to be
hand-rolled inside the target component's own `setup()` (e.g. check a condition, call
`router.navigate()` again to redirect) rather than declared at the route level — works, but scatters
the logic across every guarded component instead of centralizing it.

## Where

- `GRAMMAR.md` router section — no guard/middleware grammar exists.
- `findings/router.md` — router namespace/codegen core.
- `findings/router-setup-lifecycle.md` — where a hand-rolled guard-in-`setup()` workaround would live
  today.

## Suggested fix

A route-level `guard: <function>` config option (declared alongside `component:`/`default-focus`)
that the router's own navigate/match logic calls before mounting — if it returns false or a redirect
path, the router redirects instead of mounting. Needs to integrate with the router's existing
async-ish `markReady()`/`loadingTimeout` gate (`findings/router-transitions.md`) since a guard check
may itself be asynchronous (e.g. checking a stored auth token via `read`).

## Related

- `findings/router.md`
- `findings/router-transitions.md`
