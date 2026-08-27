# `store`/`state`/`focus(...)` entirely unreachable from a `.flsh` class body

**Type:** Gap
**Area:** classes
**Status:** Open

## Problem

A `.flsh` class has no reactive lifecycle at all — `store`, `state`, and `focus(...)` are rejected
inside a class body (`class/state-store-not-supported`), and `taskManager.onAlertChanged`/`onResult`/
`onRequestSent`/`onResponseReceived` are similarly unreachable (needs real SceneGraph node identity,
which a class instance's `m` doesn't have — see `findings/class-pipeline-global-singleton-access.md`).
A class instance is plain-object data + methods, not a node.

## Impact

Business logic that wants to react to global store changes or manage its own focus can't live in a
`.flsh` class — it has to live in a `.thr` component instead, even if the logic itself has nothing to
do with template rendering. This pushes some non-UI logic into components purely to get reactive
lifecycle access.

## Where

- `findings/class-pipeline.md` / `findings/class-pipeline-global-singleton-access.md` — the node-
  identity root cause (a class instance's `m` is the instance AA, never a SceneGraph node).
- `GRAMMAR.md` classes section — the `class/state-store-not-supported` diagnostic.

## Suggested fix

This is a fundamental architecture gap, not a small addition — `store`/`state`/`focus` reactivity is
built entirely on SceneGraph node fields/observers (`ObserveFieldScoped`, etc.), which a class
instance doesn't have. A real fix would mean either (a) giving class instances an optional backing
node for reactive purposes (significant redesign), or (b) a documented pattern for a class exposing
plain methods that a `.thr` component calls into after itself reading/watching the store — option (b)
is already possible today and is likely the pragmatic answer rather than chasing (a).

## Related

- `findings/class-pipeline-global-singleton-access.md`
- `findings/reactivity-state.md`
- [timers-not-usable-in-derived-template-or-class-body.md](timers-not-usable-in-derived-template-or-class-body.md)
  — timers share this file's `taskManager`-callback-family root cause, not the `store`/`state`/
  `focus(...)` restriction, which is unique to this file
