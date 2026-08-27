# No retry, cancellation, or timeout on an in-flight request

**Type:** Gap
**Area:** requests
**Status:** Open

## Problem

`request Http {}` has no built-in retry logic, no way to cancel an in-flight call, and no
request-level timeout. A hung transfer blocks only its own Task thread (doesn't take down the app),
but nothing in the framework surfaces or recovers from it automatically.

## Impact

Any app wanting resilience against flaky networks (retry with backoff) or wanting to abandon a
request the user navigated away from has to build that logic manually around the generated request
call — no declarative `retry:`/`timeout:` config option exists to opt into.

## Where

- `findings/requests-runtime.md` — transport mechanics, hook-invocation safety.
- `packages/compiler/runtime-assets/Http/FlashTheaterHttp.brs` — where per-call timeout/retry/cancel
  state would need to live.

## Suggested fix

Three independent, separately-shippable pieces: (1) `timeout:` — set on the underlying
`roUrlTransfer`'s own timeout if the platform exposes one, force-fail the request past that point;
(2) `cancel()` — expose a handle from the request call (mirroring the `taskManager.cancel(id)` shape)
that calls the transfer object's own abort method; (3) `retry:` — wrap the existing call in a
count-and-backoff loop at the generated-code level, re-using `taskManager`'s own retry-adjacent
patterns if any exist there. Timeout is likely the highest-value, lowest-effort of the three to ship
first.

## Related

- `findings/requests-runtime.md`
- `findings/task-manager-core.md` (for the `cancel(id)` shape to mirror)
