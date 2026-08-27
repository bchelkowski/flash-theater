# Focus system — live focus-loss bug postmortems

Two confirmed-live focus-loss bugs in `FlashTheaterFocusManager` and their fixes:
`recoverFocusFor(owner)`'s scoping rule, and the two-part `currentlyFocusedEntry()`/
`applyPendingFocus()` postmortem. See [focus-system.md](focus-system.md) for compile-time module
ownership and confirmed platform facts, and
[focus-runtime-registry.md](focus-runtime-registry.md) for the standing registry design these bugs
were found in (`navigate()`, `enterOwner`, the vacuum rule, `claimFocusIfVacant`).

**`recoverFocusFor(owner)` must be scoped to the owner that actually lost focus, not "is anything in
the app focused."** The blunt, app-wide version ("if nothing anywhere holds focus, grab the first
registrant") is correct in isolation and wrong in composition: during a still-under-construction
parent (e.g. a router-mounted screen whose child calls `load()` in the parent's own `setup()`),
nothing holds focus yet for reasons that have nothing to do with the child asking — the child's own
reconcile would grab an arbitrary, unrelated registrant and (via `rememberLastFocused`) permanently
outrank the parent's own not-yet-declared default. Fix: `unregister()`/`unregisterSubtree()` record
*whose* content the vanishing focused node belonged to (`noteFocusLoss`); `recoverFocusFor(owner)`
acts only when that owner is the caller, every other call is a no-op. Fallback order once it does
apply: this owner's own default/first registrant → the most recently focused element in some
*other* still-registered component (`mostRecentlyFocusedElsewhere` — "close a dialog, land back
where you were", needing no per-app bookkeeping since `lastFocusedByOwner` is kept most-recent-first)
→ the Scene.

**`currentlyFocusedEntry()`/`currentlyFocused()` used to violate the exact principle
[focus-runtime-registry.md](focus-runtime-registry.md)'s "Reactive focus state" paragraph states —
confirmed live as a real, reported bug: back-navigating out of a router-mounted screen via its own
currently-focused element permanently lost focus, app-wide, unrecoverable by any further key
press.** These two functions back `applyPendingFocus()`'s vacuum-rule check, `recoverFocusFor()`'s
"something else already legitimately took focus" guard, `claimFocusIfVacant()`'s vacancy check, and
`navigate()`'s own "where does LRUD search from" starting point — but the original implementation
answered "what currently has focus" by scanning the registry for `node.IsInFocusChain()`, the SAME
native field [focus-system.md](focus-system.md)'s own Platform-facts section already documents as
unreliable ("`IsInFocusChain()` is reliable for chain membership... but proves nothing about real
key routing"), rather than reading `m.focusedNode` (the single-writer authoritative record
`moveFocusTo()`/`noteFocusLoss()` already maintain for exactly this purpose).

**The failure mode this produced, confirmed live via `queryAppUi`/`EcpClient`-driven reproduction**:
press OK on a routed screen's own focused element whose own handler both (a) triggers a
`router.back()`/`router.navigate()` that tears down and replaces the screen currently holding
focus, in the SAME key-press cascade (see `apps/sample-app`'s `LoadingDemoScreen.thr`'s
`readyButton`, `on:key[OK]="{goBack()}"` where `goBack()` calls `router.back()`). The teardown
(`FlashTheaterRouterOutlet._teardownCurrentChild()` → `unregisterSubtree()` → `noteFocusLoss()`)
correctly clears `m.focusedNode` to `invalid` and correctly proposes the newly-mounted screen's own
default-focus element as the pending target — but `applyPendingFocus()`'s vacuum check
(`currentlyFocused() <> invalid`) then found some OTHER, unrelated, still-registered node
apparently still reporting `IsInFocusChain() = true` (plausibly the menu item that held real focus
one step earlier, before the destroyed screen was even entered — Roku's own focus-chain state isn't
guaranteed to fully invalidate just because the terminal node was destroyed), wrongly concluded
"something already has focus," and skipped `moveFocusTo()` on the pending target entirely. Net
result: `m.focusedNode` (already `invalid`) and real native focus (nothing was ever `SetFocus()`'d)
both end up empty, and every other focus-recovery path in this file gates on the SAME broken check,
so nothing ever repairs it — a genuinely permanent, app-wide loss.

**Fix: `currentlyFocusedEntry()` now looks up `m.focusedNode` in the registry
(`indexOfNode(m.focusedNode)`) instead of scanning for `IsInFocusChain() = true`.** All four call
sites above needed no change — they only consume the returned `{node, owner}`/node, not the lookup
mechanism. Verified live end to end (cold launch → splash → enter app → Shell menu → Loading demo →
wait for `readyButton` → OK) that `HomeScreen`'s own `prompt` now genuinely holds focus afterward
(confirmed both via the framework's own state and a follow-up arrow-key press actually moving focus
from it, not just `queryAppUi` reporting a chain), not silently nothing.

**A second, distinct focus-loss gap survived the fix above — `applyPendingFocus()` had no fallback
at all when NOTHING was proposed, only when something was wrongly blocked.** Confirmed live with
the user's own real repro, which turned out to differ from the one used to find/verify the fix
above: `Shell`'s menu → Cards demo (`CardsScreen.thr`) → Loading demo → wait for `readyButton` →
focus it → OK (→ `router.back()`, landing back on Cards). `CardsScreen.thr` has **no focusable
content of its own** — every focusable element belongs to one of its own `RichCard` children, each
its own separate registered owner (see "A routed screen that owns no focusable elements of its
own..." in `findings/router.md`) — so `FlashTheaterRouterOutlet._mountRoute()`'s own
`proposeFocusTarget(resolveEntryTarget(CardsScreen's own m.top))` call resolves to `invalid` and is
a no-op (`proposeFocusTarget` itself early-returns on an invalid node). `m.pendingTarget` therefore
stays `invalid` for this whole navigation — a state `applyPendingFocus()` had always treated as
"nothing to do, leave focus wherever it already was" (correct for the ordinary case: a persistent
menu, or any other STILL-ALIVE holder, simply keeps focus untouched). But here `readyButton` — the
actual focus holder — was destroyed as part of THIS SAME navigation
(`_teardownCurrentChild()` → `unregisterSubtree()` → `noteFocusLoss()`, which correctly recorded
`m.focusLostFromOwner = LoadingDemoScreen's own m.top`), so "leave focus wherever it already was"
had nothing left to leave it at. `applyPendingFocus()`'s `if target = invalid then return` bailed
out immediately, before ever reaching the vacuum-rule check the FIRST fix (above) touched — so that
fix alone couldn't have caught this path; it's a genuinely different branch of the same function.

**Fix: `applyPendingFocus()` now falls back to `recoverFocusFor(m.focusLostFromOwner)` when
`target` is invalid**, instead of unconditionally returning. `recoverFocusFor()` already has
exactly the right fallback chain for this (this owner's own default/first registrant → wherever
focus most recently was in some OTHER still-registered component → the Scene) — it was simply
never reachable from a router navigation before, since `FlashTheaterRouterOutlet`'s own teardown
never called it directly (unlike a compiler-generated `{#if:destroy}`/`{#each}` teardown, which
does, synchronously, right after its own mutations — see `recoverFocusFor()`'s own doc comment,
now updated to name both call sites). Calling it from `applyPendingFocus()` rather than from
`_teardownCurrentChild()` itself is what keeps this safe: `applyPendingFocus()` is already the one
shallow, single-hop call site every router navigation's own real focus move goes through (see
`findings/router.md`'s "Deferred focus application") — calling `recoverFocusFor()` (and therefore
`moveFocusTo()`) from deep inside the mount cascade would reintroduce the exact "2+ nested
`callFunc` hops doesn't route real key events" problem the whole deferred mechanism exists to avoid
(see [focus-system.md](focus-system.md)'s Platform facts). Verified live with the user's own exact
repro: focus now lands on `menuLoading` (Shell's own menu, `mostRecentlyFocusedElsewhere`'s pick —
where focus genuinely was, one step before `readyButton` took it), and a follow-up arrow-key press
still moves it from there, confirming this is real, not just recorded, focus.

**Lesson for verifying a focus fix**: confirm the reported repro's EXACT path before declaring a fix
complete, not just "a" path that produces the same-looking symptom — this bug had two independent
causes reachable via different navigation routes (via `HomeScreen`, which always has something to
propose, vs. via `CardsScreen`, which never does), and fixing the first while testing only that path
left the user's own actual repro still broken.

## An overflowing child Label can skew `bestCandidate()`'s own scoring enough to make LRUD skip the nearer, correct box entirely — an app-content gotcha, not a manager bug

**Live-verified.** `absoluteRect()` (`FlashTheaterFocusManager.brs`) calls Roku's own
`node.BoundingRect()`, which — like `queryAppUi`'s own `bounds` reporting (see
`findings/scale-device-verification.md`) — is the union of the node's own rect AND every
descendant's rect, not just the node's own declared `width`/`height`. `bestCandidate()`'s scoring
(`score = primary + perp * 2`) computes each candidate's CENTER POINT from that same possibly-
overflowing rect. A focusable `Rectangle` whose child `Label` text is significantly wider than the
Rectangle's own declared width gets a bounding rect — and therefore a computed center point —
skewed far off to one side, inflating the cross-axis (`perp`) term enough that a geometrically
FARTHER sibling with no overflow can out-score it and win the LRUD search, silently skipping the
nearer, visually "obvious" candidate in both directions (neither `Down` from above nor `Up` from
below ever lands on it).

**Confirmed live**: `apps/template-and-binding-demo`'s `AttributesDemo.thr` had `cascadeBox`
(declared width 450px at FHD) with a default label reading "Cascade — press OK: color+width+text
all change together" — long enough to overflow to a 922px-wide `BoundingRect()`. `Down` from
`toggleBox` (30px gap to `cascadeBox`, 165px gap to `infoButton`) landed on `infoButton` instead —
`cascadeBox`'s skewed center inflated its `perp` term past `infoButton`'s (which has `perp = 0`,
no overflow) enough to lose despite the much smaller `primary`-axis gap. `Up` from `infoButton`
skipped it too, landing on `toggleBox`. **Fix belongs in the app's own content, not the manager**:
shortened the default label text so it stays roughly within its own box's width (see
`findings/template-and-binding-demo-app.md`'s device-pass writeup) — re-verified live, `Down`/`Up`
both correctly reach `cascadeBox` afterward. **Lesson for any future focusable element whose label
text can vary in length**: keep it sized to roughly fit its own container, or this can silently
break LRUD reachability in a way no compile-time check catches (this compiles clean and looks
correct in every synthetic test — it's purely a live-geometry interaction, exactly the kind of gap
`findings/demo-app-conventions.md`'s "sample app catches what units miss" rationale exists for).
