# Router-outlet transitions — device-found runtime bugs

Real bugs caught only by a live device pass against router-outlet transitions
(`navigate-out:`/`navigate-in:`/`back-out:`/`back-in:`, `loadingComponent`, `router.markReady()`) —
none of these were caught by `validateGeneratedBrs`/the TypeScript unit-test suite, since none of
them execute the hand-authored runtime `.brs` at all. See [router-transitions.md](router-transitions.md)
for the feature's own core design/rationale, and
[router-transitions-demo-notes.md](router-transitions-demo-notes.md) for `apps/router-demo`'s own
`Shell.thr`-specific layout lessons found building this feature's demo.

## Bug: a synchronous `router.markReady()` call (inside `setup()` itself) was always silently lost — every mount fell through to the full `loadingTimeout`

`_mountRouteImmediate` calls `m.currentChild.callFunc("setup")`, then decides whether to enter the
loading gate. For every screen in this demo except `RouterTransitionDemo` (which defers `markReady()`
behind a real `taskManager` fetch), `setup()` calls `router.markReady()` **synchronously, before
returning** — the overwhelmingly common case, per Shell.thr's own top comment ("every screen under
this outlet now does so"). The bug: `_beginLoadingGate`, called immediately after `setup()` returns,
UNCONDITIONALLY did `m.currentChild.ft_routeReady = false` before starting to
`ObserveFieldScoped("ft_routeReady", ...)` — clobbering the `true` that `setup()`'s own synchronous
`markReady()` call had *already* written moments earlier, then arming an observer that would never
fire again (nothing else was ever going to call `markReady()` a second time). Every single navigation,
for every screen using this pattern, silently fell all the way through to the full `loadingTimeout`
(3s in Shell.thr's own config) before ever revealing — completely defeating the point of the
`markReady()` sugar, which exists specifically so the common case is near-instant. Live-reported as
"cards demo... disappears (not sliding out)" — not actually specific to Cards demo at all (every
screen sharing this setup() shape was equally affected); the `slideOutLeft`/`slideInFromRight` fix
above made the OUT phase's own instant-vanish bug go away, which is what made this SEPARATE, previously-
masked ~3s stall newly visible/confusing on its own.

**Why the compiled default also had to change** (`ROUTE_READY_FIELD_NAME`'s own default, `compile.ts`):
originally `value="true"`. Fixing `_beginLoadingGate` to check "is `ft_routeReady` already `true`
before I reset/observe it" only works if that check can tell "`setup()` explicitly called
`markReady()`" apart from "never called it at all, still sitting at the interface's own untouched
default" — with a `true` default, BOTH cases read back `true` after `setup()` returns, indistinguishable.
Flipping the default to `false` makes "still `false` after `setup()` returns" mean exactly "never
called `markReady()`" (`LoadingDemoScreen.thr`'s own deliberate case, which must keep waiting for its
own ~1.5s internal timer or the outer `loadingTimeout` fallback — unaffected by this fix, reverified
live) and "already `true`" mean exactly "called it synchronously" (skip the gate, reveal immediately —
`_mountRouteImmediate`'s own new `m.currentChild.ft_routeReady <> true` condition on whether to even
call `_beginLoadingGate` at all). All 28 golden `expected.xml` fixtures' own `ft_routeReady` field
line needed regenerating for the new default alongside this fix.

**What this does NOT fix**: the case where `markReady()` is called asynchronously (from a later
`taskManager.onResult`/timer callback, `RouterTransitionDemo.thr`'s own case) still works exactly as
before — `_beginLoadingGate` still arms the observer for that case (the field is genuinely still
`false` when the gate begins, since nothing set it synchronously), and the fix only ever short-circuits
the gate when the field already reads `true` at the moment `_mountRouteImmediate` checks it, right
after `setup()` returns.

Verified live (Roku Ultra, 2026-08-18): navigating to Cards demo settled well under 1s post-fix (down
from a consistent ~3s loadingTimeout-bound stall pre-fix), while `LoadingDemoScreen` — which
deliberately never calls `markReady()` — still correctly waits out its own ~1.5s internal timer before
its own `readyButton` default-focus behavior kicks in, unaffected by this change.

## Bug: comparing two `roSGNode` references with `<>` crashes at runtime — `releaseInnermostTransition`

First device pass crashed immediately on entering `RouterTransitionDemo` (any `loadingComponent`
reveal, in fact — `_revealMountedChild` unconditionally calls `releaseInnermostTransition` once
claimed): `Type Mismatch. Operator "<>" can't be applied to "roSGNode" and "roSGNode".` at
`FlashTheaterRouter.brs`'s `releaseInnermostTransition`, which had
`if m._innermostTransitionOwner <> outlet then return`. This is the exact same platform fact
`findings/focus-system.md`/`router-outlet-runtime.md` already document for every OTHER node-identity
check in this codebase (`FlashTheaterFocusManager.brs` uses `IsSameNode()` throughout, never `<>`/`=`
on two node references) — missed here specifically because this was the ONE node-to-node comparison
this feature introduced; every other `<>` in both modified runtime files compares a node against
`invalid` (always safe — confirmed both by this codebase's own established pattern, e.g.
`FlashTheaterFocusManager.brs`'s `if focusedOwner <> invalid then isFocused =
focusedOwner.IsSameNode(subscriber)`, and by this device pass never re-triggering after the fix).
**Fix**: `IsSameNode()`, guarded against `m._innermostTransitionOwner` itself being `invalid` first
(calling `IsSameNode()` on an invalid receiver would itself throw). Diagnosed via
`ConsoleStream({port: 8085})` after `queryAppUi`/`app-ui` started timing out while
`queryActiveApp`/`app-state` stayed fast — the exact "suspended at a BrightScript Debugger prompt"
signature `findings/dev-environment.md` already documents; the debug console's own auto-pushed stack
trace/backtrace named the exact line immediately, no guessing needed.

## Bug: `.control = "stop"` while still observing "state" re-enters the SAME handler synchronously, crashing `_cancelInFlightTransition`

Live-reported (Roku Ultra, 2026-08-18) via a Micro Debugger crash from rapid back-to-back `Back` key
presses: `Interface not a member of BrightScript Component (runtime error &hf3)` at
`_cancelInFlightTransition`'s own `m._armedAnim.UnobserveField("state")` line. Backtrace:
`onKeyEvent → back() → navigate() → _onRouterChanged() → _update() → _mountRoute() →
_cancelInFlightTransition()` — a SINGLE key press, not two overlapping ones, because
`ObserveFieldScoped` callbacks fire **synchronously** on Roku — this crash's own debugger backtrace is
the actual evidence for that (see `compiler-architecture.md`'s "Never call `.ObserveField(...)`" bullet
for the corrected writeup — plain `ObserveField`'s own timing isn't actually verified either way; an
earlier version of this note wrongly called it "message-port/async") — the
`m.top.changeToken = m.top.changeToken + 1` write inside `navigate()`
immediately, synchronously invoked the outlet's own `_onRouterChanged` observer, all still on the
original key-press's own call stack. That much is fine and expected. The actual bug was in
`_cancelInFlightTransition`'s own two-line sequence:

```
m._armedAnim.control = "stop"       ' <- (was) first
m._armedAnim.UnobserveField("state")  ' <- (was) second
```

Setting `.control = "stop"` changes the Animation node's own `"state"` field to `"stopped"` —
synchronously, for the exact same `ObserveFieldScoped` reason above. Since the `UnobserveField` call
hadn't run yet, the observer was STILL ATTACHED at that moment, so `.control = "stop"` reentrantly
invoked `_onOutAnimStopped`/`_onInAnimStopped` **right there**, mid-statement, on the same call stack.
That reentrant call runs its own full continuation — tears down the current child, mounts the next one,
and reassigns `m._armedAnim` to a brand-new (unrelated) animation node — all before control ever
returns to the original `_cancelInFlightTransition` frame. When that outer frame then resumed and ran
its own `UnobserveField("state")` line, `m._armedAnim` no longer held what the outer frame expected;
whatever it now held triggered the interface error.

**Fix**: capture `m._armedAnim` into a local variable and clear the field FIRST, then unobserve BEFORE
stopping — reversing the two lines. Once unobserved, `.control = "stop"`'s own resulting `"state"`
change has no callback left to reentrantly invoke, so the hazard is structurally impossible rather than
just less likely. Note this diverges from Layer 2's own precedent
(`conditional-block-emitter.ts`'s `emitToggleTransitionCascadeLines`), which does the OPPOSITE — stops
without ever unobserving, deliberately tolerating the reentrant invocation via a condition re-check
inside its own exit handler (`emitExitAnimationStateChangeHandler`) instead of preventing it. That
approach wasn't adopted here because `_onOutAnimStopped`/`_onInAnimStopped` aren't written to be
idempotent/re-entry-safe (no re-check of "is this still the in-flight transition I think it is") —
making the reentrant path impossible outright was the smaller, more surgical fix for this file as it
stands today; making the handlers themselves re-entry-safe (matching Layer 2's model) is a possible
future refactor but not needed to fix this specific crash.

Verified live: a 3-deep navigation history followed by 3 rapid-fire physical `Back` presses (no
inter-press delay beyond ECP's own request latency) no longer crashes — the app correctly pops all
three history levels and settles on the right screen, confirmed via `ConsoleStream` (clean, no
crash/backtrace output) and a post-stress screenshot. The EARLIER "no crash across the whole session
including the rapid-reentrancy stress case" claim (see [router-transitions.md](router-transitions.md)'s
own "Re-entrant navigation" entry) evidently didn't exercise a tight enough back-to-back sequence to
hit this specific window — a reminder that "I stress-tested it and it didn't crash" is only as strong
as the specific sequence tried, not a general guarantee.

**`UnobserveField` → `UnobserveFieldScoped`**: every `Unobserve*` call this file's own reentrancy fix
touches (and, in the same pass, every other `Unobserve*` call codebase-wide — `FlashTheaterTaskManager.brs`
and two codegen emitters) was switched to match its own `ObserveFieldScoped` registration. Not a
correctness fix (Roku's docs confirm plain `UnobserveField` already undoes a scoped registration too;
live-reverified against this file's own rapid-back-to-back-navigation and rapid-`onResult` stress
sequences before AND after) — a deliberate symmetry choice. Full rationale and the complete list of
touched call sites: `findings/compiler-architecture.md`'s own "always `ObserveFieldScoped`" bullet.

## Bug: `Timer` nodes don't need `AppendChild` — attaching them leaked 2 outlet children per navigation

The loading-gate's own `loadingTimeout`/remaining-`loadingMinDuration` `Timer` nodes were
`m.top.AppendChild`-ed on creation and `RemoveChild`-ed on settle/cancel — modeled (wrongly, without
checking) on the assumption that a Timer needs to be part of the render tree to fire, the way an
`Animation` node genuinely does (`animation-emitter.ts`'s own doc comment: an `Animation` node has to
be a real per-component child for Roku to resolve `fieldToInterp` via `findNode`). **A Timer node
needs neither** — confirmed against this codebase's own already-established `setTimeout`/
`setInterval` codegen (`statement-printer.ts`'s `lowerTimerStartCallsInText`): `CreateObject("roSGNode",
"Timer")` → `.duration`/`.repeat` → a registry-AA entry (what keeps it alive, not scene attachment) →
`ObserveFieldScoped("fire", ...)` → `.control = "start"`, with **no `AppendChild` at all**, anywhere in
that emitter. Live-caught as `childOutlet`'s own reported `children` count growing by 2 on every
single navigation (2 → 4 → 6...) via `kopytko-roku ecp app-ui`/`app-object-counts` — a real, silent
leak invisible to any unit test (nothing in the TypeScript test suite executes the hand-authored
runtime `.brs` at all). **Fix**: dropped every `AppendChild`/`RemoveChild` call on `m._loadingTimer`/
`m._minDurationTimer` — a Timer is just held as a bare node reference in `m`, exactly like the
established `setTimeout` pattern, and requires no tree management whatsoever. Re-verified live:
`childOutlet`'s own children count stayed at a constant 2 (`RouterLoadingSpinner` + the current
screen) across a dozen further navigations, including the rapid-reentrancy stress sequence.

## Bug: the `out:` auto-reverse Layer 2 relies on was wrongly reused here, silently flipping every declared out-animation backwards

`analysis/router-transitions.ts`'s `resolveOutletTransitions` reused `analysis/animation-presets.ts`'s
`resolveTransitionAnimation` as-is — the exact same function Layer 2's `transitions.ts` calls for
`{#if}`/`{#if:destroy}`'s own `transition:`/`in:`/`out:` attributes. That function has a load-bearing
convention baked in: `reverse = direction === 'out'`, applied to *every* interpolator of a **declared**
(non-preset) animation when it's resolved for the `'out'` side. For Layer 2 this is exactly right and
deliberate — an author writes ONE custom animation (e.g. `popIn`) and references the SAME name as both
`in:popIn` and `out:popIn`; the `out:` side auto-plays it backwards via Roku's own `reverse="true"`
interpolator attribute, so the author never authors two mirror-image animations by hand.

Router-outlet transitions were designed the opposite way on purpose (see
[router-transitions.md](router-transitions.md)'s "every transition must target the outlet" section and
[router-transitions-demo-notes.md](router-transitions-demo-notes.md)'s own demo): FOUR **independently,
already-directed** animations — `navigate-out:slideOutLeft` is already a complete rest→off-screen-left
tween in its own right, never intended to be "the reverse of" `navigate-in:slideInFromRight` (a
different declaration entirely). Reusing `resolveTransitionAnimation` unmodified meant `slideOutLeft`,
wired as `navigate-out:` (`phase === 'out'`), got a SECOND, unwanted reversal on top of its own
already-correct authored direction — flipping it into an off-screen→rest tween. Confirmed live (Roku
Ultra, 2026-08-18): the outlet's own `reverse="true"` interpolator snaps its translation *instantly* to
the LAST authored keyframe (`[-880, 0]`, fully off-screen) the moment `control = "start"` fires — Roku
sets a reverse-flagged interpolator's field to its own reversed-order first keyframe immediately,
before any per-frame interpolation begins — then spends the animation's own `duration` visibly sliding
it BACK to `[0, 0]`. From the user's point of view this read as "the outgoing screen instantly
vanishes, then slides back into place" instead of "the outgoing screen slides out" — and, once
`_onOutAnimStopped` then tore down/rebuilt/played the `in:` animation immediately after, compounded
into the earlier-reported "disappear → reappear at center → disappear again → next screen slides in"
sequence from the same root cause. The `in:`/`back-in:` side was never affected (`phase === 'in'` never
reverses), which is exactly why only the exit side ever looked broken.

**Fix**: `resolveTransitionAnimation` gained a `reverseDeclaredOnOut` parameter (default `true`,
preserving Layer 2's own two call sites in `transitions.ts` byte-for-byte). `router-transitions.ts`
passes `false` — its four attributes are never a shared bidirectional pair. Presets (`fade`/`fly`/
`slide`/`scale`) are **unaffected either way**: a preset step is always authored generically as an
"arrive at rest" shape, so it genuinely still needs `reverse` to become an exit — `navigate-out:slide`
still gets `reverse="true"` today, confirmed by a dedicated golden test. No existing test caught this —
`golden.test.ts`'s router-outlet-transitions suite only ever asserted structural wiring (which fields
got which node), never the emitted interpolator's own `reverse` attribute; two regression tests now
assert both directions explicitly (declared animations never reverse; presets always still do).

## Bug: `repeat: true` on `navigate-out:`/`back-out:` had no guard at all — found by code review, fixed before any device pass

**Not device-reproduced — found by auditing this feature against the existing, already-fixed
Layer 2 sibling bug** (see [animation.md](animation.md)'s own "`repeat: true` on an exit (`out:`)
animation would permanently hang the deferred hide" entry) after being asked to plan a fix for
that exact reasoning. `analysis/router-transitions.ts`'s `resolveOutletTransitions` resolves
`navigate-out:`/`navigate-in:`/`back-out:`/`back-in:` through the very same
`resolveTransitionAnimation` machinery `analysis/transitions.ts` uses for Layer 2's `out:`, but —
unlike `transitions.ts`'s `resolveBlockTransitions` — never called `stepHasRepeat` on the result.
`FlashTheaterRouterOutlet.brs` confirms the identical hang mechanism applies: `_mountRoute` arms
`outAnim.ObserveFieldScoped("state", "_onOutAnimStopped")`, and `_onOutAnimStopped` is the ONLY
place that tears down the outgoing screen (`ft_unmount`/`RemoveChild`) and mounts the next route
(`_mountRouteImmediate`) — gated entirely on `event.GetData() = "stopped"`, which a `repeat: true`
animation never reports on its own. A `repeat: true` `navigate-out:`/`back-out:` would leave the
outlet stuck showing the old screen, mid-exit-animation, forever — recoverable only in the sense
that the NEXT `router.navigate(...)`/`router.back()` call's own `_cancelInFlightTransition` would
force-stop it, but the originally-requested navigation itself is silently abandoned, never
completed, exactly the class of bug `animation.md`'s own entry warns about.

**Checked the `in:` side's own runtime behavior before assuming the same fix should apply there
too**: `_onInAnimStopped` does nothing but `UnobserveFieldScoped`/clear bookkeeping — it gates no
teardown or mount, so `repeat: true` on `navigate-in:`/`back-in:` is harmless. This mirrors Layer
2's own deliberate choice to leave `in:` unrestricted, but it was verified against THIS file's own
runtime asset rather than assumed by analogy — the two features' `in:`/`out:` runtime shapes are
similar but not identical (e.g. `_onOutAnimStopped` and `_onInAnimStopped` are two separate
handlers here, unlike some of Layer 2's own shared logic), so the "in: is exempt" conclusion is
only safe because it was re-derived from this file's own code, not copy-pasted from `animation.md`.

**Fix**: `router-transitions.ts` imports the exact same exported `stepHasRepeat` from
`./transitions.js` `compile.ts`'s own `animation/repeat-not-supported-with-onfinish` check
already reuses — no new recursive-walk logic needed, since a router-outlet transition's resolved
`ParsedAnimationConfig.step` is the exact same shape Layer 2 produces. The check runs inside
`resolveOutletTransitions`'s per-`(navDirection, phase)` loop, gated on `phase === 'out'`, right
after `resolveTransitionAnimation` resolves `config` and before the target-must-be-outlet
validation — new diagnostic `router/repeat-not-supported-for-exit-transition`, following this
file's own `router/*` naming convention. Covers a named custom `animation {}` declaration (top
level or nested in a `sequential`/`parallel` composition) and a built-in preset override
(`navigate-out:slide="{{repeat: true}}"`) identically, since both already produce a `step` tree
`stepHasRepeat` walks the same way for Layer 2.
