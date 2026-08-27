# No way to remove a subscriber from a stream

**Type:** Bug
**Area:** streams
**Status:** Open

## Problem

`ft_createStream()`'s runtime keeps a plain `.subscribers` array that `.subscribe(...)` appends to.
There is no corresponding removal API — nothing prunes a dead callback before the stream's own owner
is garbage-collected. The same gap exists for `taskManager.onAlertChanged`'s subscriber list.

## Impact

A stream instance that lives for the app's whole lifetime (e.g. a class-declared stream field on a
long-lived singleton-style object) accumulates one dead subscriber entry per transient subscriber
that comes and goes during that lifetime — a real, if slow, memory leak *within* that instance's own
lifetime, independent of whether the instance itself is ever collected.

## Where

- `findings/streams.md` — documents the gap and the same caveat for `taskManager.onAlertChanged`.
- `packages/compiler/runtime-assets/` — wherever `ft_createStream`'s `.subscribers` array and
  `.subscribe`/`.emit` are implemented (see `findings/streams.md` for the exact runtime asset path).

## Suggested fix

`.subscribe(...)` currently returns nothing usable by the caller. Smallest viable fix: have
`.subscribe(...)` return a lightweight handle/id, and add a `.unsubscribe(id)` method to the stream
runtime that splices the matching entry out of `.subscribers`. This is a runtime-asset change plus a
small grammar/codegen addition to expose `.unsubscribe(...)` as a callable member — no DSL grammar
change needed if it's just another method call on the stream value, same shape as `.emit`/`.subscribe`
already are.

## Related

- `findings/streams.md`
- `findings/task-manager-alerting.md` (shares the same missing-unsubscribe shape for
  `onAlertChanged`)
