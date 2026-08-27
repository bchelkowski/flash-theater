# Router-outlet transitions (`navigate-out:`/`navigate-in:`/`back-out:`/`back-in:`, `loadingComponent`, `router.markReady()`)

Design rationale for animating a `<FlashTheaterRouterOutlet>`'s own mount/unmount swap and gating a
mount behind a loading indicator. See `packages/compiler/GRAMMAR.md`'s "Router" → "Router-outlet
transitions" section for the grammar itself — this file is the *why*. See
[router-outlet-runtime.md](router-outlet-runtime.md) for the base (unanimated) outlet mechanics this
extends, and [animation-config-codegen.md](animation-config-codegen.md)/
[animation-scale-and-destroy-targeting.md](animation-scale-and-destroy-targeting.md) for Layer 2's
own `transition:`/`in:`/`out:` mechanics, which this deliberately mirrors in places and deliberately
diverges from in others (both noted below). For device-found runtime bugs and their fixes, see
[router-transitions-bugs.md](router-transitions-bugs.md). For `apps/router-demo`'s own
`Shell.thr`-specific layout lessons building this feature's own demo, see
[router-transitions-demo-notes.md](router-transitions-demo-notes.md).

## Direction (`isBackJourney`) was already free

`FlashTheaterRouter.brs`'s `navigate()` already threaded `isBackJourney` into `activatedRoute`
(defaulted `false`), and `back()` already forced it `true` before re-entering `navigate()` — set
correctly since that field existed, but never read anywhere. `FlashTheaterRouterOutlet._update()`
already holds `target = m._router.activatedRoute`, so `target.isBackJourney` was reachable with
**zero new field on the router singleton** — it's what `_resolveAnim(isBackJourney, phase)` reads to
pick the `navigate-*` vs. `back-*` pair.

## Every transition must target the OUTLET, not the screen — a hard constraint, not a style choice

A routed screen is `CreateObject`'d with no compile-time id (`route.component` is a runtime string),
so Layer 1's `target: <elementId>` mechanism — validated against `collectElementIds`, a compile-time
set — has nothing to point at for a per-screen animation. Only the outlet's own static template id
is reachable. `analysis/router-transitions.ts`'s `router/transition-target-must-be-outlet` check
(walking `collectEffectiveTargetIds` on every resolved config) enforces this at compile time — this
is what makes `FlashTheaterRouterOutlet.brs`'s own `_snapToFirstKeyframe` safe to write unconditionally
to `m.top`, instead of having to resolve a per-usage target the way Layer 2's compile-time-emitted
snap (`emitInitialKeyframeSnapLines`) does.

This also decided the visual model: the outlet's own `translation` slides, teleporting off-screen
between the out phase and the in phase (only one screen mounted at a time), not two screens
co-mounted and cross-fading. A dual-child crossfade model was considered and rejected — it would need
an entirely new, non-declarative runtime animation-construction path (a dynamically-created screen
has no id `fieldToInterp` could target either), duplicating Layer 1/2's whole compile-time resolution
machinery for no reachable win.

## `fieldToInterp` staleness (Layer 2's own bug) does NOT apply here

Layer 2's `{#if:destroy}` transitions need a `fieldToInterp` blank-then-reset before every
`.control = "start"` because the TARGET node is destroyed and recreated on every cycle (see
`animation-config-codegen.md`). The router outlet's own transitions target the **outlet itself**,
which is never destroyed/recreated by this feature (only its CHILD is) — its `fieldToInterp="<outletId>.translation"`
binding, once resolved on first `.control = "start"`, stays correctly bound for the outlet's whole
lifetime. `codegen/brs-emitter.ts`'s wiring for this feature deliberately does not collect any
`RefreshableInterpolatorRef`s — confirmed by design, not by omission.

## `router.markReady()` is a field assignment, not a `callFunc` — solves "which outlet is waiting" for free

Every other `router.*` action reaches the router SINGLETON (`m.global.ft_router.callFunc(...)`).
`markReady()` instead compiles to `m.top.ft_routeReady = true` — a plain field flip on the CALLING
component's own top node (`identifier-rewrite.ts`'s `buildRouterActionReplacement`, special-cased
before the generic `callFunc` builder). This means the outlet observes its own child's field
directly; there is no "which outlet, among however many might be gating a mount right now, does this
readiness signal belong to" question to answer with a global registry.

`ft_routeReady` (`type="boolean" value="false"`) is declared **unconditionally on every compiled
`.thr` component**, gated on nothing — mirrors `naming.ts`'s `UNMOUNT_FUNCTION_NAME` precedent
exactly (`compile.ts:327`'s own comment: leaf-gating would be unsound, since a component's own
template can't statically know whether it'll end up mounted under a `loadingComponent`-gated
outlet). Added via `codegen/xml-emitter.ts`'s existing `extraInterfaceFields` option — the same
mechanism `request {}` already uses for its own compiler-manufactured fields
(`requestInterfaceFields`), not a new emission path. The default is `false`, not `true` — see
[router-transitions-bugs.md](router-transitions-bugs.md)'s "synchronous `markReady()` got silently
lost" entry for why that matters.

**`markReady()` is unsupported from a `.flsh` class body** (`class/router-mark-ready-not-supported`)
— every other `router.*` action reaches `m.global`/`GetGlobalAA().global` equally from either
context, but a class instance is a plain BrightScript object with no SceneGraph node of its own for
"its own top" to mean. This is a structural mismatch, not a someday-fixable gap — contrast with
`taskManager.onAlertChanged`/`onResult`/etc.'s own class-body rejections
(`class-pipeline-global-singleton-access.md`'s `GetGlobalAA()` entry), which stem from unverified
platform behavior and trampoline-naming risk, not
an inherent conceptual impossibility.

`markReady()` needs the same standalone-statement restriction `navigate`/`back` get
(`expression/router-mark-ready-must-be-statement`), for an unrelated reason: it lowers to an
assignment, not a `callFunc(...)` expression, so splicing it anywhere but a statement's own line
would emit invalid BrightScript — not (like `navigate`/`back`) because a follow-up statement needs
somewhere to live. Deliberately checked as its own boolean (`method === 'markReady'`), not folded
into `ROUTER_NAVIGATION_METHODS` — that set is also used to find already-emitted navigation calls
needing a focus-handoff follow-up line, which `markReady()` must never get.

## Innermost-outlet spinner suppression — "first claim per navigation cycle wins", not "last"

A single navigation can cause more than one nested outlet to gate a mount at once (an ancestor
re-rendering persistent chrome around a deeper route change). Only the deepest one should show its
`loadingComponent` — `FlashTheaterRouter.brs`'s `claimInnermostTransition(outlet)` implements this
as **first claim within one `changeToken` value wins**, not last-write-wins. This is the opposite of
the naive answer, and deliberately so: nested outlets construct inside-out (a nested outlet's whole
mount cascade runs as part of the ENCLOSING outlet's own `CreateObject` call, inside that outlet's
own `_mountRouteImmediate`, itself called BEFORE the outer outlet's own gating decision runs) — so
if both gate in the same navigation, the INNER outlet's claim attempt always happens chronologically
first. First-wins therefore resolves to the innermost outlet for free, with no depth-counting or
explicit "am I nested" signal needed at all.

## `_snapToFirstKeyframe` is genuinely generic runtime code — a departure from Layer 2's compile-time snap

Layer 2's own "snap to first keyframe before starting `in:`" (`emitInitialKeyframeSnapLines`) is
emitted PER USE SITE at compile time, since it always knows the exact target/field pair. This
feature's runtime equivalent (`FlashTheaterRouterOutlet.brs`'s `_snapToFirstKeyframe`) instead walks
whichever `Animation`/`SequentialAnimation`/`ParallelAnimation` node was wired into
`ft_navigateInAnim`/`ft_backInAnim` at runtime, reading each leaf interpolator's own `fieldToInterp`/
`keyValue[0]` and writing `m.top[fieldName] = keyValue[0]` generically. This is only safe *because*
`router/transition-target-must-be-outlet` guarantees every interpolator's effective target is always
`m.top` — a hand-authored runtime asset has no per-app compile-time knowledge of which fields a given
app's own custom transition animations touch, unlike Layer 2's own emitter.

## Loading-gate timing — `roTimespan` for `loadingMinDuration`, a separate `Timer` for `loadingTimeout`

`loadingTimeout`'s fallback and `loadingMinDuration`'s floor are two independent concerns, not one
knob: timeout answers "how long do we wait for `router.markReady()` before giving up", minDuration
answers "once ready (real or forced), how much LONGER (if any) does the spinner stay up so it
doesn't flash for one frame on a fast local mount". Implemented as one `Timer` node for the timeout
race (unobserved/removed the moment readiness settles, whichever way), plus a `roTimespan` marked at
gate-start to measure real elapsed time — `loadingMinDuration` minus that elapsed time becomes a
SECOND, separate one-shot `Timer` only when positive. No polling, no wall-clock-diffing loop.

## Re-entrant navigation — cancel-and-retarget, not queued

A second `router.navigate(...)`/`router.back()` arriving before a prior transition through the same
outlet has settled (a still-playing animation, or an unsettled loading gate) is real on a physical
remote, and more likely now that a loading gate can genuinely wait on async work.
`_cancelInFlightTransition()` stops/unobserves whatever's armed (animation, loading timer,
`ft_routeReady` observer, spinner claim) and immediately tears down whatever child is currently
attached but not-yet-settled, before `_mountRoute` proceeds fresh against the newest target — mirrors
`conditional-block-emitter.ts`'s own "cancel in-flight exit on rapid re-toggle" precedent
(`emitToggleTransitionCascadeLines`). Guarded so an ORDINARY idle outlet (nothing armed, nothing
pending) reaching a fresh `_mountRoute` call is untouched by this — only a genuinely-in-flight
transition triggers the emergency teardown; the everyday case still tears down its (fully settled)
previous child via `_mountRoute`'s own explicit immediate-path branch.

**⚠️ Live-verified 2026-08-18** against a Roku Ultra (`X02800C5FKLV`) — cold boot →
`SplashScreen` → `Shell`, then repeated forward/back navigation through `childOutlet`
(`HomeScreen`/`ScheduleScreen`/`CardsScreen`/`RequestDemoScreen`/`RouterTransitionDemo`), including
rapid back-to-back keypresses (no settle time between presses) and a physical Back-key press
mid-transition. Confirmed live, across several passes and two rounds of live-caught bugfixes: the
teleport (`childOutlet.translation` caught mid-flight during real `back-out:`/`back-in:` playback),
the loading spinner created once and reused, centered exactly at `[width/2, height/2]`
(`{440, 360}` for `width="880" height="720"`), a REAL `router.markReady()` call after
`RouterTransitionDemo`'s own `GetPosts` fetch actually completing (`resultReadout` showing
`"Loaded 10 posts — router.markReady() called from here"`), `childOutlet` settling back at its own
correct resting translation (`{600, 0}`) after both a forward navigation and a `router.back()`, and
no crash across that session's own rapid-reentrancy stress case (later proven NOT exhaustive — see
[router-transitions-bugs.md](router-transitions-bugs.md)'s own `_cancelInFlightTransition` reentrancy
entry, only reproduced by a later session's own rapid back-to-back `Back` key stress test). Several
real bugs were caught this way and are fixed in the current code (see that same file): most in the
compiler-generated/hand-authored runtime itself, one in the demo app's own `.thr` content — this is
exactly the class of bug this repo's own `animation.md`/`focus-system.md` findings warn a synthetic
test suite cannot catch on its own; do not treat a green `validateGeneratedBrs`/unit-test run (or
even an EARLIER, incomplete device pass — the resting-position bug survived one full round of "looks
fixed" before its own live check, and "no crash in this particular stress sequence" survived one full
round too before a DIFFERENT rapid-fire sequence reproduced a real crash) as proof of correctness
without actually verifying the specific behavior in question, settled state included, not just "no
crash in the sequence I happened to try."

## `loadingComponent`/`width`/`height` are plain camelCase attributes, not colon-namespaced — a deliberate correction mid-design

An earlier design considered `loading:component`/`loading:minDuration`/`loading:timeout`, mirroring
`transition:`/`in:`/`out:`'s own colon-prefix convention. Rejected: those existing colon-prefixed
families are NEVER printed as literal XML attribute names — flash-parser classifies them into a
structured `TemplateAttribute` variant and the compiler fully regenerates real BrightScript-safe
identifiers from them (e.g. `ft_anim_<name>`). `loadingComponent`/etc. need to reach the RUNTIME
as literal SceneGraph interface field ids/BrightScript member names (`m.top.loadingMinDuration`),
and a colon is not legal in either — same reason `on:key[...]`'s own `[`/`]`/`,` need
`onKeyPreprocess.ts`'s dedicated transliteration layer before real XML parsing ever sees them. Rather
than build an equivalent transliteration layer for a three-attribute family, `width`/`height`/
`loadingComponent`/`loadingMinDuration`/`loadingTimeout` are plain, un-namespaced static attributes —
zero new flash-parser classification needed at all (confirmed: `classifyAttribute` already falls
through to `{kind: 'static', ...}` for anything not matching a known prefix).
