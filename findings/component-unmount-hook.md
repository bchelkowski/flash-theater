# Component-unmount hook (`ft_unmount`)

A general, compiler-manufactured "this component is about to be removed" hook — introduced for
[Timer statements](timer-statements.md) but not specific to it. Every compiled `.thr` component
declares `ft_unmount` (an interface function + a `.brs` sub), called right before the component is
actually detached: once by `FlashTheaterRouterOutlet`'s own `_teardownCurrentChild()` on the
outgoing screen, and once per nested id by `{#if:destroy}`'s own generated destroy sub
(`codegen/conditional-block-emitter.ts`) on every id it's about to null.

Roku SceneGraph gives no component a native destroy/unmount callback at all — this hook is entirely
compiler-manufactured, called explicitly at the two removal call sites this compiler fully controls.

## Why every component gets one, unconditionally — not just Timer-using ones

This compiler has **no cross-component template-tag registry** — `codegen/xml-emitter.ts`/
`codegen/conditional-block-emitter.ts` treat every template tag as an untyped string
(`CreateObject("roSGNode", tagName)`); nothing tracks "this tag is actually a `.thr`-compiled custom
component" the way `.flsh`'s `import` graph tracks class references. That means no single component
can know whether any of its own nested children, at any depth, need this hook.

The cascade must therefore be **unconditional and self-propagating**: every component's own
`ft_unmount` calls `ft_unmount` on its own direct children, who call it on theirs, and so on.
Leaf-gating this (emitting it only for components that themselves use a timer, the way every OTHER
trampoline in `codegen/brs-emitter.ts` — `usesTaskManagerAlertCallback`, etc. — genuinely is gated)
is not just leaner, it's **unsound**: an intermediate component that doesn't use Timer itself would
never declare `ft_unmount`, silently breaking the cascade to a Timer-using descendant two levels
down, with no compile error. `codegen/brs-emitter.ts`'s `emitUnmountFunction` is pushed into every
component's `sections` unconditionally; `compile.ts`'s `interfaceFunctions` list gets
`UNMOUNT_FUNCTION_NAME` unconditionally too. A leaf component with nothing to clean up and no
nested-component ids to cascade to just gets `sub ft_unmount()\nend sub` — cheap, harmless, always
valid.

## Naming: `ft_unmount`, not `__ft_unmount`

`codegen/naming.ts`'s own house style reserves `ft_` (never a leading underscore) for
compiler-synthesized names. Naming it this way gets free protection from
`analysis/binding-collisions.ts`'s existing `checkReservedIdentifierPrefix` (`dsl/reserved-
identifier-prefix`), which already rejects any DSL-authored name starting with `ft_` — a `.thr`
author can never accidentally declare their own `ft_unmount` and shadow the hook, with zero new
enforcement code.

## Reachability: only id-bearing template elements

`{#if:destroy}`'s cascade walks `block.nestedIds` (`analysis/conditional-blocks.ts`) — every id
anywhere in the block's own subtree. A nested custom component with **no author-given `id`** is an
uncached throwaway local (`ft_n<N>` in `conditional-block-emitter.ts`'s `emitSubtreeConstruction`)
never reachable by this cascade. This mirrors the pre-existing `focusable`/`bind:` rule (both already
require an `id` on their target element) — not a new restriction shape, the same one applied to a
new feature. **A component that itself uses Timer, placed as a template child, needs an `id` for the
unmount cascade to reach it.**

## The two call sites

**`FlashTheaterRouterOutlet.brs`'s `_teardownCurrentChild()`** — already ran one cross-cutting
cleanup pass (`unregisterSubtree`) immediately before `RemoveChild`; the hook slots into the same
place:
```brs
if m.global.HasField("ft_focus") then m.global.ft_focus.callFunc("unregisterSubtree", m.currentChild)
m.currentChild.callFunc("ft_unmount")
m.top.RemoveChild(m.currentChild)
```
`callFunc` on a fixed name a node may or may not declare is already live-confirmed-safe in this exact
runtime-asset family — `findings/router-setup-lifecycle.md` documents `m.currentChild.callFunc("setup")`
being called unconditionally on every mounted screen, safe even when undeclared. The outlet itself
also declares `ft_unmount` (hand-authored, not compiler-generated) and forwards the cascade to
whichever screen it currently has mounted — it can itself be nested inside an ancestor's
`{#if:destroy}` subtree.

**`{#if:destroy}`'s own destroy sub** (`emitConditionalDestroySub`) — a third guarded pass over
`block.nestedIds`, alongside the existing `unobserveLines`/`unregisterLines`, immediately before
`removeChild`. Runs at actual `removeChild` time, not earlier (unlike focus-unregister's
animation-start timing requirement) — a component mid-exit-animation is still legitimately alive, so
its timers should keep running through the animation.

## `{#each}` item removal — covered

`codegen/each-block-emitter.ts` has its own, separate item-removal call sites (three of them: the
top-level reconcile sub's own removal loop, a nested `{#if:destroy}` block's removal inside an
each-item body, and `emitInlineEachDiff`'s own removal loop for a nested `{#each}`) — each gets the
identical guarded cascade `{#if:destroy}` already has, via a shared `collectEachItemElementIds`/
`emitEachItemUnmountCascadeLines` pair mirroring `collectEachItemFocusableIds`'s own exact shape (and
its "stop at a nested `{#each}`'s own boundary" rule — that nested each's own removal pass owns
cascading to its own items).

One shape difference from `{#if:destroy}`, worth knowing before reading the generated code: an
`{#each}` item's own stored node (`m["$$<blockId>_nodes"][key]`) is always a **synthetic wrapper
`Group`** — even a single-element item body gets wrapped — never the item's own visible root element
directly. So the cascade is two-part: an unconditional `.callFunc("ft_unmount")` directly on that
wrapper (a harmless no-op on the native `Group` type, cheap insurance) plus the same guarded
`<wrapper>.findNode(<uniqueId>).callFunc("ft_unmount")` cascade `{#if:destroy}` uses for every OTHER
id in the item's own body — which is what actually reaches the item's real root element (and any
custom component nested deeper inside it), since `findNode` searches a node's descendants, never
matches the calling node itself. Same "needs an `id` to be reachable at all" restriction as
`{#if:destroy}`'s own cascade.

`taskManager.run(...)` (for an ordinary `.thr` component) now opts into this same hook too — see
`findings/task-manager-core.md`'s "No automatic cleanup..." section for the fix. It doesn't cascade
through `{#if:destroy}`/`{#each}`'s own nested-id walk the way a Timer node does, though: rather than
a per-component registry `ft_unmount` iterates locally (the Timer shape), the task manager itself
tracks each task's owning component node and exposes one `cancelOwnedBy(owner)` call — so the fix
needed no new per-component storage at all, just one new gated line in `emitUnmountFunction` calling
into the existing global singleton. A `.flsh` class-body `run(...)` call still has this exact gap
(GRAMMAR.md's Task manager "Known limitations") — classes have no node of their own for `ft_unmount`
to mean anything, the same boundary `onAlertChanged`/`onResult`/`onRequestSent`/`onResponseReceived`
already draw.

## How a feature opts in

Plain boolean gating (`usesTimer`), the same shape every other trampoline in `brs-emitter.ts` already
uses — not a registration/plugin system. `emitUnmountFunction(cascadeIds, usesTimer,
usesTaskManagerRun)` branches at TypeScript-emitter level (compile-time, not a runtime `if`), so a
component that doesn't use the relevant feature gets zero extra lines. `usesTaskManagerRun`
(`compile.ts`'s `usesTaskManagerRunAnywhere`) is the second real (not hypothetical) example of this
shape — narrower than the general `usesTaskManagerAnywhere` output-metadata flag, since only a
component that itself calls `run(...)` could ever have anything registered under its own `m.top` for
`cancelOwnedBy` to find.

## Live-device verification — Roku Ultra, firmware 15.3.4

**Confirmed**, driving `apps/sample-app` and `apps/async-demo` via ECP (keypress/queryAppUi) with a
temporary `print` marker inside each timer callback, read live over the debug console
(`ConsoleStream`, port 8085). `apps/async-demo` has since been split into router-mounted chapter
apps (`apps/task-manager-demo`, `apps/timers-demo` — see `findings/demo-app-conventions.md`); every
component named below now lives in one of those instead, migrated as-is in spirit but no longer a
plain `{#if:destroy}`-toggled child of a router-less `MainScene` the way it was when this pass ran.
The evidence itself is still accurate for the shape it tested — kept as historical record, not
re-verified against the new router-mounted shape (see each successor app's own `*-demo-app.md`
findings file for what is and isn't re-confirmed there).

- `TaskDemoScreen` (router-mounted, `FlashTheaterRouterOutlet`'s own `_teardownCurrentChild()` call
  site): `setInterval` ticked every ~500ms while the screen was visible (5 ticks / 2.5s), then
  **zero** ticks in the 3.5s after pressing the physical Back key to navigate away — `ft_unmount`'s
  force-stop loop genuinely ran and took effect, not just compiled.
- `PriorityQueueDemo` and `AlertingDemo` (plain children of `MainScene`'s own `{#if:destroy}` blocks,
  the `emitConditionalDestroySub` call site): same result — ticking at the expected ~300ms cadence
  while visible (7 and 6 ticks / 2s respectively), **zero** ticks in the 3s after switching to a
  different demo.
- The new `TimerDemoScreen` demo itself: 6 ticks / 3s while visible, zero in the following 4s after
  switching away.

This closes risk 1 below (`callFunc` timing completing before removal) for the one-level-deep
cascade shape all four of these exercise (`MainScene`/`FlashTheaterRouterOutlet` calling `ft_unmount`
directly on the Timer-owning child) — if it hadn't completed synchronously before detachment, or
hadn't run at all, ticking would have continued. It also indirectly confirms risk 2 and risk 4: every
one of these runs cascades `ft_unmount` onward to plain `Rectangle`/`Label` children (an undeclared
interface function on those) and exercises the always-present empty `ft_unmount` sub on every OTHER
component in both apps (`Shell`, `HomeScreen`, `ScheduleScreen`, ...) — no crash, no
`BrightScript Debugger>` suspension, normal navigation continued working throughout every test.

**A second pass** (`apps/async-demo`'s `NestedAndListTimerDemo`/`MiddleWrapper`/`TimerLeafWidget` —
new components, added specifically to close the two gaps below) confirms the two items the first
pass left open:

- **Genuinely multi-level-deep cascade — confirmed.** `TimerLeafWidget` sits nested inside
  `MiddleWrapper`, itself behind `NestedAndListTimerDemo`'s own `{#if:destroy}` — a real two-component-
  boundary chain (`{#if:destroy}` destroy sub → `middle.callFunc("ft_unmount")` → `MiddleWrapper`'s
  own generated `ft_unmount()` → `leaf.callFunc("ft_unmount")`). The leaf's `setInterval` auto-starts
  on mount (`startDemo()` forwarding, same convention as every other demo in this app) and ticked
  6 times in 2s while visible; tearing down `MiddleWrapper` (one button press) produced **zero**
  further ticks in the following 3.5s. This closes the "still open" risk 1 item below — the recursive
  cascade genuinely propagates through a real second hop, not just compiles to code that theoretically
  would.
- **`{#each}` item removal — confirmed.** A `TimerLeafWidget` rendered as a `{#each}` list item
  (`listWidget_w2`), started via its own on:key[OK] handler, ticked 6 times in 2s; removing it from
  the list (shrinking the backing array, triggering `each-block-emitter.ts`'s own reconcile removal
  loop) produced **zero** further ticks in the following 3.5s.

**A third pass** (`apps/async-demo`'s `FocusedTeardownDemo`/`TickReadout` and
`apps/animation-demo`'s `DestroyCustomDemo` extended with `cardTicker`/`badgeTicker`, both also
`TickReadout`) closes the two items the first two passes left open — see
`packages/compiler/test/codegen/conditional-block-emitter.test.ts`'s own "component-unmount-hook.md
gap 1"/"gap 2" `describe` blocks for the compile-time-level contract these pin down alongside the
live evidence below.

- **Ordering with focus-recovery — confirmed, and the two destroy-mode shapes behave
  differently by design.** For a **non-transitioning** block (`FocusedTeardownDemo`, one
  keypress removes a focusable widget that currently holds focus and is actively ticking):
  `unregister`/`recoverFocusFor` and the `ft_unmount` cascade all run in the SAME synchronous
  destroy sub. Confirmed live in one pass: the removed widget's own `TickReadout` was fully
  garbage-collected (no lingering node, let alone one still ticking) immediately after, focus
  landed on the sibling `fallback` target, and an ordinary LRUD round trip afterward still worked
  cleanly. For a **transitioning** (`out:`) block (`DestroyCustomDemo`'s `card`, `out:fade`
  duration 0.2s): `recoverFocusFor` fires at animation-**start**, well before the `ft_unmount`
  cascade, which only runs at animation-**stop**. Confirmed live: ~60ms into the 0.2s fade, focus
  had already moved to `trigger` while `card` was still visible and its nested `cardTicker` kept
  ticking; ticking only stopped once the fade actually completed (frozen thereafter, never
  resumed). This gap between "focus already moved on" and "the timer stops" is intentional (a
  component mid-exit-animation is still legitimately alive), now deliberately verified rather than
  assumed safe.
- **A focusable id hidden behind a separate `.thr` custom-component boundary gets NO
  unregister/recoverFocusFor lines at all** — not a new bug, the same already-documented "opaque
  nested custom component" gap in `findings/focus-router-free-and-nested-gaps.md`. Worth naming
  here as a fixture-design trap: the first attempt at the synchronous-case fixture nested
  `TimerLeafWidget` (itself focusable) directly inside the destroy block, which silently
  reproduced that pre-existing gap (no unregister call emitted at all) instead of exercising this
  hook's own ordering — fixed by making the destroyed, focused element a plain `Rectangle` visible
  to the enclosing component's own template analysis, with the Timer-owning component nested
  **inside** that (mirrors `DestroyCustomDemo`'s own `card`/`cardTicker` pair). Any future
  live-verification fixture for focus-adjacent teardown should put the focusable id at the
  outermost, template-visible level for the same reason.
- **`ft_unmount` reaching a node whose own children are already mid-teardown — confirmed safe.**
  `DestroyCustomDemo`'s `card` (`out:fade` 0.2s) contains its own nested destroy-mode
  `badgeTicker` (`out:fade` 0.5s, independently toggleable). Toggling `badgeTicker` off, then
  `card` off ~200ms later — well inside `badgeTicker`'s own still-in-flight 0.5s fade — makes
  `card`'s own (faster) destroy sub reach `badgeTicker` directly while `badgeTicker`'s own destroy
  sub hasn't run yet. Confirmed live: no crash, no `BrightScript Debugger>` suspension at the
  moment of the reach, `badgeTicker`'s ticking froze immediately (never resumed, checked 1.5s
  later), and the device stayed healthy well past `badgeTicker`'s own would-be independent
  completion mark (its own animation-stopped handler either never fires against the by-then-
  detached, already-nulled subtree, or fires harmlessly — either way, no observable failure).
  Ordinary demo-switching still worked cleanly afterward. The mechanism: `nestedIds` is a **flat**
  list — every id anywhere in a destroy-mode block's own subtree, regardless of any intermediate
  nested-block boundary — so the outer block's cascade line for `badgeTicker` is
  `if m.badgeTicker <> invalid then m.badgeTicker.callFunc("ft_unmount")` directly, not routed
  through the intermediate wrapper's own (no-op, since it's a plain `Group`) `ft_unmount`. The
  individually-guarded `if <ref> <> invalid then` shape is what makes this safe in both
  directions: it succeeds calling `ft_unmount` early on a still-valid, mid-independent-teardown
  ref, and it correctly no-ops later if the nested block's own destroy sub ever runs against a
  subtree the outer pass already nulled.

**Also confirmed live, unrelated to this hook but discovered while wiring the verification
fixtures above**: Roku's ECP `Info` keypress never reaches a `.thr` component's `onKeyEvent` as
`"info"` at all on this device/firmware — confirmed with focus placed directly on the same
component owning the `on:key[info]` handler (no cross-component bubbling involved), so it isn't a
bubbling issue. `Backspace` (ECP name matches the `onKeyEvent` string directly, unlike `Rev`/`Fwd`
→ `rewind`/`fastforward`) is confirmed working and used instead in both new fixtures. Likely the
same family as `focus-system.md`'s already-documented ECP-name-vs-`onKeyEvent`-string mismatches —
add to that file's "Platform facts" table if a future session needs `Info`/`Options` specifically.
