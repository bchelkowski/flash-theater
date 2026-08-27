# `runningCount`/`queuedCount`/`alertLevel` aren't `watch`-able

**Type:** Gap
**Area:** task-manager
**Status:** Open

## Problem

`taskManager`'s `runningCount`/`queuedCount`/`alertLevel` are plain non-reactive snapshots — reading
them gets you the value at that instant, but there's no `watch`-style subscription the way the global
`store` supports `watch` for reactive updates. Only `onAlertChanged` gives a callback-style hook, and
only for the alert level specifically, not the raw counts.

## Impact

A UI wanting to live-display "3 tasks running, 5 queued" has to poll (e.g. via a timer) rather than
reactively bind a template attribute to the count, which is inconsistent with how every other
reactive value in the framework works (`field`/`derived`/`store` all support `watch`/binding).

## Where

- `findings/task-manager-core.md` — the non-reactive-snapshot nature of these three values.
- `findings/task-manager-alerting.md` — the existing `onAlertChanged` callback, the closest analog.

## Suggested fix

Route `runningCount`/`queuedCount` through the same global-store mechanism the rest of the reactive
system already uses (e.g. the manager writes these into a well-known `store` key on every change),
which would make them `watch`-able for free without inventing new reactive plumbing specific to
`taskManager`. Check whether `alertLevel`'s existing `onAlertChanged` callback already updates
something store-shaped internally — if so, this may be a small extension rather than new machinery.

## Related

- `findings/task-manager-core.md`
- `findings/task-manager-alerting.md`
- `findings/reactivity-state.md`
