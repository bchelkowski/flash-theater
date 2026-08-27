# Router / focus integration — navigation-memory redesign

Split out of [router-focus-integration.md](router-focus-integration.md) (that file covers the
foundational integration rules and the current directional-focus feature). This file covers
generalizing the route-focus-memory suppression mechanism from "back journeys only" to every
journey (`beginSuppressedNavigation`), and the full redesign investigation that followed — a
false-positive live test that nearly hid a second real bug, the `mostRecentlyFocusedWithin`
ancestry-based fix, and a self-inflicted rename crash caught only by live testing. See
`findings/focus-system.md` for the vacuum rule and LRUD registry this file assumes, and
[router-focus-integration-route-memory-bugs.md](router-focus-integration-route-memory-bugs.md) for
the route-keyed focus-memory design and early-arming bug this work builds on.

## The same mechanism, generalized from "back journeys only" to every journey — `beginSuppressedNavigation` (renamed from `beginSuppressedBackNavigation`)

**Confirmed live** (2026-08-19, real Roku Ultra, same device as above), found by the user
round-tripping `apps/sample-app`'s own `Shell.thr` demo: navigate Home → Schedule via HomeScreen's
own **content** button (`prompt`, `on:key[OK]="{goToSchedule()}"` — not the sidebar menu), then
press physical Back. Expected focus to land back on `prompt`; it landed on the sidebar's
`menuSchedule` instead.

**Root cause: the fix above only armed suppression for a back journey** (`if isBackJourney and
m.global.HasField("ft_focus") then ...` in `_mountRoute()`). `router.navigate()` had no equivalent
protection at all. `HomeScreen.thr`'s own `prompt` genuinely holds real SceneGraph focus when
pressed — it's routed CONTENT, not persistent chrome — so leaving it via `router.navigate()`
destroys the focused node exactly the same way a back journey does. With no suppression armed on
that forward leg, the compiler-emitted `applyPendingFocus()` follow-up (synchronous, right after
`router.navigate()` returns, well before Schedule even mounts) found nothing proposed and fell
straight into `recoverFocusFor()` — which correctly has no candidate of Home's own left (it's being
torn down) and falls through to `mostRecentlyFocusedElsewhere()`, landing focus on the sidebar
**immediately, permanently** (real, non-vacant `SetFocus`). Every previously-tested navigation in
this codebase (including the scenario the fix above was built and verified against) went through
the sidebar MENU, which the vacuum rule never actually removes focus from in the first place — so
this content-initiated forward leg, and the compounding effect it has on a LATER back-navigation's
own otherwise-correct restoration, was never exercised before.

**Why this defeats the back-navigation restoration too, not just the forward reveal**: once the
sidebar holds real, non-vacant focus (from the unprotected forward leg), the LATER back-navigation's
own `resolveRouteFocusTarget()` still correctly resolves `prompt` from Home's captured memory and
proposes it — but `applyPendingFocus()`'s own vacuum-rule check (`if not isExplicit and
currentlyFocused() <> invalid then return`) silently discards it, since the sidebar already holds
focus non-vacantly. The back-navigation side of the mechanism was never broken; it was fed a
polluted starting state by the forward leg.

**Live-reproduced the exact mechanism, step by step**, via `Shell.thr`'s own `focusStateReadout`
(`describeFocus(isFocused, isInFocusChain)` — "MENU"/"CONTENT"/"elsewhere") and `queryAppUi`:
pressing OK on `prompt` flipped the readout to `MENU` **immediately**, mid-animation, before
Schedule ever mounted — confirming `recoverFocusFor()` fired synchronously on the forward leg, not
lazily once the destination existed. (On a fresh app boot, with nothing yet recorded in
`mostRecentlyFocusedElsewhere()`, this same premature recovery instead fell all the way through to
`m.sceneRef.SetFocus(true)` — which `recoverFocusFor()` itself still marks as `m.focusedNode =
invalid`, i.e. still "vacant" to this file's own bookkeeping — so the bug was invisible on a first,
never-touched-the-sidebar-yet session; only became visible once the sidebar had genuinely held focus
at least once, which is every realistic real-world session.)

**The fix**: drop the `isBackJourney` condition entirely — `_mountRoute()` now calls
`beginSuppressedNavigation(fullPath + "?" + paramsJson)` (renamed from `beginSuppressedBackNavigation`
for the same reason; both the field and the function no longer mean "back only") unconditionally,
for every journey. This is safe for exactly the same reason the earlier "arm early, before it's
known whether a gate will engage" fix already established: `_revealMountedChild()` unconditionally
calls `resolveRouteFocusTarget()` on every reveal (forward or back, gated or not), which clears the
flag as a side effect the moment it runs, whether or not it finds a candidate — so a fully
synchronous forward mount (the overwhelmingly common case) is unaffected in practice; only a
genuinely delayed mount (an `out:`/`navigate-out:` animation and/or a loading gate) leaves the flag
armed long enough to matter, on either direction now.

**Re-verified live after the fix, same device, same exact scenario, with `mostRecentlyFocusedElsewhere()`
deliberately pre-populated first** (moved focus to the sidebar once, to reproduce the realistic
"not a first-ever session" case): pressing OK on `prompt` no longer flipped focus to the sidebar —
`focusStateReadout` stayed `CONTENT` throughout the forward navigation, mid-flight and after settle
— and a subsequent Back correctly restored `prompt` (confirmed via `queryAppUi`'s `focused="true"`
on the exact `prompt` node, with `promptLabel`'s own "Welcome back!" text visible).

## The general redesign — and a false-positive that nearly hid a second real bug, and a real crash caught only by live testing

**User-requested, same session**, after a THIRD live round trip (sidebar → `menuSchedule` → sidebar
→ `menuLoading` → wait ~1.5s for `LoadingDemoScreen`'s own `readyButton` → Right → OK, which calls
`goBack()` → `router.back()`) landed back on `ScheduleScreen` with focus on the ROUTER OUTLET
container itself, not any real leaf — reported as "not schedule sidebar button." Investigating live
found the mechanism above still working exactly as designed for its own narrower scope — the "outlet
container" framing was a red herring (Roku's own `app-ui` marks EVERY ancestor of a focused leaf
`focused="true"`, including the outlet) — but investigating it surfaced the actual design gap: the
OLD mechanism only ever remembered focus that lived INSIDE the specific route's own mounted content.
Menu-driven navigation never loses focus from the sidebar in the first place, so nothing was ever
captured for a route left that way.

**The user's own explicit, simpler general rule, requested directly**: "when I'm navigating to any
other route, I need to save the component that is currently focused... and when I will be navigating
back to this route, I want to have this element/component to be focused again... regardless if this
focus was inside the Router Outlet or something above it or in parallel."

**First attempt (later reverted): centralize BOTH capture and arm in `FlashTheaterRouter.brs`'s own
`navigate()`**, capturing `currentlyFocused()` unconditionally, keyed by the OUTGOING route, right
before `activatedRoute` is reassigned. Live-tested and appeared to work — the reported sequence now
"restored" `menuLoading` on Back. **This was a false positive**, caught only by a follow-up,
harder test (focus a `ScheduleList` row, step back to the sidebar, THEN navigate away, THEN Back):
`menuLoading` was never actually lost in the first place — the sidebar is persistent chrome, never
torn down by this navigation, so `m.focusedNode` stayed `menuLoading` continuously throughout the
whole round trip. The vacuum rule (`applyPendingFocus()`'s `if not isExplicit and currentlyFocused()
<> invalid then return`) therefore discarded EVERY automatic proposal the whole time, correctly and
by design — the observed "restoration" had nothing to do with the new mechanism actually working;
it was the sidebar simply never having lost focus. **Lesson: a scenario where the currently-focused
element is persistent chrome can never distinguish "restoration works" from "nothing tried to change
focus at all" — the only trustworthy live check for this feature focuses CONTENT that will genuinely
be destroyed, so a real vacancy is unambiguously created.**

**The follow-up test that used a genuine vacancy found the REAL remaining bug**: literal
`currentlyFocused()` at the moment of `router.navigate()`/`router.back()` differs from "what the user
was last actually looking at inside the route being left" whenever they step back to the persistent
menu before pressing the navigation trigger — the ordinary way to navigate in this framework's own
canonical layout. Capturing `currentlyFocused()` at that point captures the MENU item, not the
content the user actually cares about remembering.

**The final design: capture stays per-outlet (it needs `m.currentChild`, which only the outlet
has), keyed continuously via `m.lastFocusedByOwner` instead of the literal instant of navigation;
suppression-arming stays centralized in the router (that half never had this problem)**:
- `FlashTheaterFocusManager.brs` gained `mostRecentlyFocusedWithin(root)` — walks
  `m.lastFocusedByOwner` (already continuously updated by `rememberLastFocused()` on every real
  `moveFocusTo()`, most-recent-first) and returns the first entry whose own NODE (not owner) is a
  descendant of `root`, still registered. `captureRouteFocusMemory(routeKey, node)` now takes the
  target node as a parameter instead of reading `currentlyFocused()` itself, and
  `resolveRouteFocusTarget(routeKey)` searches `m.sceneRef.FindNode(id)` (Scene-wide, not
  outlet-scoped) since the remembered element may live outside any outlet's own mounted content.
- `FlashTheaterRouterOutlet.brs`'s `_unregisterCurrentChildFocus()` calls
  `mostRecentlyFocusedWithin(m.currentChild)` and passes the result to `captureRouteFocusMemory`,
  keyed by a NEW per-child-instance field, `m._renderedGlobalRouteKey` — snapshotted once in
  `_mountRouteImmediate()` from `m._router.activatedRoute` at the moment that specific child was
  actually created, deliberately NOT re-derived live at capture time (by then `activatedRoute` has
  already moved on to the INCOMING route) and deliberately NOT a single shared router-level field
  either (a rapid/interrupted re-navigation — a real, already-tested scenario, see
  `_cancelInFlightTransition()` — can reach this same teardown for a STALE, still-mounted child
  while a completely different navigation is already underway; a per-child snapshot survives that,
  a shared "most recent" field would not). The standalone `_routeKey()` helper was deleted; both its
  former call sites (capture, and `_revealMountedChild`'s own restore-side lookup) now read
  `m._renderedGlobalRouteKey` directly.
- `FlashTheaterRouter.brs`'s `navigate()` keeps arming `beginSuppressedNavigation` unconditionally
  for the INCOMING route (this half of the original redesign was sound and stayed) but no longer
  captures anything itself.

**A second nested-ownership gap, found by the SAME harder test**: even after fixing the "menu vs.
literal focus" mismatch above, a first version of the fix used `lastFocusedFor(m.currentChild)` —
exact OWNER identity — which still missed the `ScheduleList` row: `register()`'s own `owner`
parameter is always the DIRECTLY enclosing component's own `m.top` (confirmed by reading the actual
generated code, `ScheduleList.brs`'s `callFunc("register", ft_n1, m.top, false)`), so a row's owner
is `ScheduleList` itself, never `ScheduleScreen` (`m.currentChild`) — an exact-owner lookup can never
find it regardless of how correctly it's triggered. `mostRecentlyFocusedWithin`'s ancestry-based
match (`isDescendantOrSelf`, not `owner.IsSameNode`) is what actually fixes this, for any nesting
depth.

**A real, self-inflicted crash, caught only by live testing, not the unit suite**: fixing the
nested-ownership gap by RENAMING `lastFocusedFor` to `mostRecentlyFocusedWithin` (rather than adding
the new function alongside the old one) silently broke a completely unrelated, pre-existing,
load-bearing caller — `enterOwner()` (used by cross-component arrow-key `navigate()` and
`focusComponent()`, nothing to do with routing at all) still called `lastFocusedFor(owner)` by name.
Calling a function name Roku no longer has any definition for produces `Function Call Operator ( )
attempted on non-function` at runtime — a genuine crash, confirmed via the device's own debug console
(port 8085; `queryAppUi`/`querySgNodes` timing out while `queryActiveApp`/`queryAppState` stayed
`active` was the tell — see `findings/dev-environment.md`'s own entry on this exact signature). The
structural "parses as valid BrightScript" test suite never catches this class of bug — an undefined
function CALL is syntactically valid BrightScript, only failing once that exact code path actually
executes. **Fix**: restored `lastFocusedFor(owner)` as its own, separate function (exact-owner
semantics, still exactly what `enterOwner()` needs — a nested child's own remembered focus is that
CHILD's own concern to resurface via its own `enterOwner()` call when navigation reaches it, not
something an outer component's entry decision should reach into) — `mostRecentlyFocusedWithin` is an
ADDITION to this file's vocabulary, not a replacement. A new structural regression test
(`runtime-assets.test.ts`) now pins `enterOwner()`'s own call to `lastFocusedFor(owner)` down
explicitly, specifically to catch a repeat of this exact mistake. **Lesson: before renaming or
removing a function in a shared runtime asset, grep the WHOLE file (and the whole `runtime-assets/`
tree) for every caller, not just the ones already in view from the current edit — a same-file,
same-script call has no `callFunc`/XML-interface trail to notice by construction, so it's invisible
to any search scoped to "cross-component call sites" alone.**

**Verified live, the full matrix, one continuous session** (not separate cold boots, to also catch
interaction effects): (1) content-triggered round trip (`HomeScreen`'s `prompt` ↔ `ScheduleScreen`,
sidebar pre-touched once first) — `prompt` correctly restored, confirmed via a real re-navigating
`Select` press, not a stale `focused="true"` attribute; (2) the harder nested-content test (focus
`ScheduleList`'s own `row_d3`, step back to the sidebar, navigate to `LoadingDemoScreen`, Back) — no
crash, capture now structurally correct (confirmed by code review + unit test, since this exact path
is the one the vacuum rule makes UNOBSERVABLE via focus state alone — see the false-positive lesson
above); (3) re-confirmed the crash is gone by repeating the exact key sequence that triggered it.
`npm test --workspace packages/compiler`: 1221 passing, `npm run lint` clean, all three edited
`.brs` files still parse as valid BrightScript with zero diagnostics.

**Known, deliberate limitation surfaced by this whole investigation, not a bug**: route-memory
restoration can only ever be OBSERVED when returning to a route creates a genuine focus vacancy —
i.e., when whatever holds focus at that moment is ALSO being destroyed by the same navigation. If
the user has manually returned to persistent chrome (a sidebar) before triggering navigation away,
that chrome keeps focus continuously (it's never torn down) and the vacuum rule correctly refuses to
steal it back on return, exactly as the vacuum rule's own stated design requires ("the framework
never takes focus away from a living focus"). The route's own content-level memory is still captured
correctly underneath, ready to apply the next time a genuine vacancy actually occurs for that route
— it simply has no observable effect while something else remains legitimately focused. An author
who wants to override this — force focus onto a specific element regardless of vacuum state — should
use the existing `focus(<id>)` statement, which always wins over any automatic restoration.
