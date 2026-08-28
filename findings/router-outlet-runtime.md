# Router outlet runtime behavior (`FlashTheaterRouter`/`FlashTheaterRouterOutlet`)

Runtime design rationale for what the router/outlet actually do once wired up: history-stack
bookkeeping, nested route matching, reactivity, `params` equality, subtree teardown, and back-key
fallthrough. See `packages/compiler/GRAMMAR.md`'s "Router" section for the grammar itself, and
[router.md](router.md) for the namespace/codegen-mechanics core (module responsibilities table,
`router.navigate(...)`'s argument-shape repacking, nested `router.*`/`theme.*` access in call
arguments) — this file is the *why* behind what `FlashTheaterRouter.brs`/
`FlashTheaterRouterOutlet.brs` do once a route change actually happens.

## A phantom first history entry made the very first "back" press blank the whole app

`navigate()`'s history push ran unconditionally on every call except an explicit `skipInHistory:
true`. On the very first `navigate()` call an app ever makes, `m.top.activatedRoute` is still
`init()`'s own uninitialized sentinel (`_emptyRoute()`, `path = ""`) — so that call pushed a
snapshot of it onto history regardless. A single "back" press on the very first screen then popped
that phantom entry and re-activated `path = ""`, which no route ever matches — every mounted outlet
tore down to nothing, with no further history to pop: the entire app went blank and stayed that way.

**Fix:** guard the history push with `m.top.activatedRoute.path <> ""` — a real app route can never
legitimately have an empty path, so this excludes only the sentinel, never genuine history. See
`runtime-assets/Router`'s own doc comment on `navigate()`.

Not behavior-tested (this package has no BrightScript execution harness) — only regression-guarded:
`packages/compiler/test/runtime-assets.test.ts` confirms the guard text itself is still present. The
actual effect was verified live: cold-boot, press "back" once on the very first screen, confirm a
clean app exit instead of a blank, dead screen. A route tree with a genuine multi-hop history chain
(e.g. `SplashScreen` → `Shell`/Home → `Schedule`) legitimately needs one "back" press per real stop
before it exits — that's expected, not a regression of this fix.

## Nested route matching

flash-theater has no generic renderer, so `FlashTheaterRouterOutlet` does
`CreateObject`/`AppendChild`/`RemoveChild` by hand. The *matching* logic (which of possibly-many
nested outlets owns which route, whether a given outlet's own match changed) works as follows:

- **Any number of outlets may be mounted at once, nested arbitrarily** — each captures its own
  `m._parentPath` (the router's own `renderedPath`, read once at construction) and its own candidate
  route list (the whole route tree for a ROOT outlet — detected via `activatedRoute.routeConfig =
  invalid` — or `routeConfig.children` for a NESTED one) and never re-reads either: if the enclosing
  route ever changed, this whole component would already have been torn down and recreated by the
  enclosing outlet.
- **`renderedPath`/`activatedRoute.routeConfig` are a single shared, sequentially-mutated
  bookkeeping channel** — written by whichever outlet is currently deciding its match, read once by
  whatever nested outlet is constructed synchronously moments later (inside the same `CreateObject`
  call). Safe only because SceneGraph script execution is single-threaded and construction is a
  synchronous, depth-first, one-outlet-at-a-time cascade — confirmed by tracing the actual call
  order, not assumed.
- **An outlet only rebuilds when its own match changes** — the entire mechanism behind "a parent
  route renders persistent chrome, child routes swap inside it for free"
  (`apps/sample-app/src/components/Shell.thr`): an ancestor outlet whose own matched route entry
  (compared by `.path` segment string, never AA reference) is unchanged never rebuilds, regardless
  of how many times a deeper sibling segment changes.
- **Only the "leaf" outlet for the current navigation cares about `params` changes** (`isLeaf =
  thisOutletsOwnFullPath = router's target path`) — otherwise every mounted outlet would rebuild
  on any params change anywhere in the app, defeating persistent chrome.

## Reactivity trigger is a plain integer field, deliberately NOT the `activatedRoute` AA itself

`FlashTheaterRouterOutlet` observes `changeToken` (`type="integer"`, `alwaysNotify="true"`, bumped
once, last, at the end of `navigate()`), never `activatedRoute` directly. A monotonically-increasing
integer's field-change notification is unambiguous, unlike reassigning a complex AA value (which
this codebase has not verified either way for BrightScript's own field-change-detection semantics).

## `params` equality — `FormatJson()`, never a hand-rolled deep-equality walk

An outlet's own "did params change" check compares `FormatJson(target.params)` against a remembered
JSON string, not the AA values directly — BrightScript `=`/`<>` on `roAssociativeArray`/`roArray` is
not reliably defined for nested complex values (mirrors `findings/focus-system.md`'s `roSGNode`
equality finding), and `params` may itself hold nested arrays/AAs. This is also why
`FlashTheaterRouter.brs`'s `navigate()` deliberately does **not** guard against navigating to an
"identical" route — a redundant `navigate()` call is harmless (one redundant history entry at
worst).

## Destroying a router-swapped subtree needed a new focus-manager capability

`{#if:destroy}`/`{#each}` teardown always knows exactly which static ids it's removing, so
`unregister(node)` (one call per known id) sufficed for a PLAIN element there — but not for a nested
CUSTOM component's own focusable content (a completely different, compile-time-unknown `.thr` file's
own template, invisible to the enclosing component's own scan; see
`findings/focus-router-free-and-nested-gaps.md`'s "opaque nested custom component" gap, closed later
by reusing this same capability from `{#if:destroy}`'s own destroy sub too). A router-swapped
subtree has the identical problem at a coarser grain: an arbitrary, dynamically-`CreateObject`'d
component tree with compile-time-unknown contents — no way to enumerate individual ids at all, not
even the top-level one. **Fix**: `unregisterSubtree(root, recoveryOwner)` walks the whole registry
once, deleting any entry whose `owner` `IsSameNode()`s `root` or is a descendant of it. Must run
before `RemoveChild`, same requirement `unregister()` already has (`GetParent()` needs the
still-attached tree). `recoveryOwner` (this outlet's own call passes `invalid`) exists for
`{#if:destroy}`'s own later use — see the linked finding for why the caller needs it, not this one.

**Two teardown timings coexist**, selected per-outlet by whether a `navigate-out:`/`back-out:`
animation is configured for the current direction (see [router-transitions.md](router-transitions.md)):
unanimated (the shape above) unregisters + `ft_unmount` + `RemoveChild` all synchronously, in
`_mountRoute`'s own call stack; animated defers `ft_unmount`/`RemoveChild` until the exit animation
reports `state="stopped"`, while `unregisterSubtree` still runs at the ORIGINAL synchronous point
(exit-start, before the animation even begins) — the same split Layer 2's own
`{#if}`/`{#if:destroy}` transitions already established (`focus-system.md`'s "candidate scoring has
no `visible` check" reasoning applies identically here). An outlet with no transitions configured at
all is byte-for-byte the original synchronous path — nothing above is retrofitted onto it.

## Back-key fallthrough — Scene-only, and needed relaxing an existing early-return

Emitted only on the app's one `Scene`-extending component (`isSceneRoot = template?.extends ===
'Scene'`) — Roku bubbles every unhandled key up to the Scene regardless of where focus sits, so one
copy suffices; placed last, after every explicit `on:key` dispatch and the LRUD fallthrough, so an
author's own `on:key[back]` handler anywhere in the tree always wins. Guarded at runtime
(`m.global.hasField("ft_router")`) since router usage isn't known at per-component codegen time — a
router-less Scene gets a harmless dead branch. `emitOnKeyEventFunction`'s existing early-return (no
function emitted when a component has zero `on:key`/focusable content) needed `!isSceneRoot` added
to it — otherwise a Scene root with no explicit key handling and no focusable content of its own
(the common "root Scene just hosts a router outlet" case) never got an `onKeyEvent` at all.
