# timers — `apps/timers-demo` coverage &amp; split-off-from-async-demo conversion

`apps/timers-demo` is the Timer-statements third of `apps/async-demo`'s three-way split
(task-manager, requests, timers — see `findings/demo-app-conventions.md`'s "Roadmap"). Unlike
`apps/animation-demo`/`apps/focus-demo`'s own conversions (an existing flat app rebuilt in place),
this app was built fresh, migrating three existing `apps/async-demo` screens
(`TimerDemoScreen`/`NestedAndListTimerDemo`+`MiddleWrapper`+`TimerLeafWidget`/`FocusedTeardownDemo`+
`TickReadout`) into router-mounted chapters. `apps/async-demo` itself was left untouched — a
separate step retires it once all three split-off apps are confirmed working.

For the underlying Timer-statements/unmount-hook platform facts this app exists to demonstrate, see
[timer-statements.md](timer-statements.md) and [component-unmount-hook.md](component-unmount-hook.md).

## The three chapters

1. **`/basic-lifecycle`** (`TimerDemoScreen.thr`) — `setTimeout`/`setInterval`/`clearTimeout`/
   `clearInterval` basics, three distinct code paths: "Fire setTimeout" (one-shot, left to fire),
   "Cancel pending timeout" (**new** — `clearTimeout` on a one-shot timer specifically, cancelling it
   before it ever fires; the original `apps/async-demo` screen only ever demonstrated
   `clearInterval` on a recurring timer, a genuinely different code path — no `repeat` field, a
   fresh handle every press), and "Start/Stop interval" (manual `clearInterval`/`setInterval`
   re-arming). The interval auto-starts in `setup()` so switching chapters away is always a live
   proof that the unmount hook stops a still-ticking interval.
2. **`/nested-and-list`** (`NestedAndListTimerDemo.thr` + `MiddleWrapper.thr` +
   `TimerLeafWidget.thr`) — two unmount-cascade shapes chapter 1 can't reach: a genuinely
   two-component-level-deep nested cascade (`{#if:destroy}` → `MiddleWrapper` → `TimerLeafWidget`,
   toggled via "Toggle nested widget") and `{#each}` list-item removal (`TimerLeafWidget` instances
   as list items, each its own OK-to-start/stop button, removed via "Remove last list widget").
3. **`/focus-teardown-ordering`** (`FocusedTeardownDemo.thr` + `TickReadout.thr`) — the ordering
   between focus-recovery and the `ft_unmount` cascade for a **synchronous** (non-animated) destroy:
   Backspace removes a currently-focused, directly-focusable `widget` Rectangle (with a nested,
   non-focusable `TickReadout` supplying the Timer content) in one destroy sub, proving both the
   timer stops and focus recovers to `fallback` in the same synchronous pass. The companion
   **animated** (`out:`) case lives in `apps/animation-demo`'s `DestroyCustomDemo.thr`, not here.

## `startDemo()` → `setup()` conversion, file by file

The pre-router `apps/async-demo` shape: `MainScene` explicitly called `callFunc("startDemo")` on
whichever screen it just constructed, since a router-free app has no other one-time
post-construction hook. Converting to a router (GRAMMAR.md's "Router" section: "a router-mounted
component gets an automatic `setup()` call") changes this **only for the top-level, directly
router-mounted component of each chapter** — a plain nested child two or more component-levels
below the router's own mount point is never itself router-mounted, so it still needs its parent's
own explicit forwarding call, unchanged from before.

| File | Router-mounted? | Change |
|---|---|---|
| `TimerDemoScreen.thr` | Yes (chapter 1's own route target) | `startDemo()` → `public function setup()`, body unchanged (`startInterval()`) |
| `NestedAndListTimerDemo.thr` | Yes (chapter 2's own route target) | `startDemo()` → `public function setup()`, body unchanged (populate `widgets`, forward to `m.middle.callFunc("startDemo")`) |
| `MiddleWrapper.thr` | No — nested inside chapter 2, two levels below the router | Kept `public function startDemo()` verbatim, still called explicitly by `NestedAndListTimerDemo` |
| `TimerLeafWidget.thr` | No — nested inside `MiddleWrapper` (three levels below the router) or rendered as an `{#each}` item | Kept `public function startDemo()` verbatim |
| `FocusedTeardownDemo.thr` | Yes (chapter 3's own route target) | `startDemo()` → `public function setup()`, body unchanged (forward to `m.widgetTicker.callFunc("startDemo")`); also gained `default-focus="true"` on `widget` (see below) |
| `TickReadout.thr` | No — nested inside `FocusedTeardownDemo`, one level below the router | Kept `public function startDemo()` verbatim |

**Why `MiddleWrapper`/`TimerLeafWidget`/`TickReadout` keep `startDemo()` rather than also becoming
`setup()`**: the router's automatic call only ever reaches the ONE component it directly mounts per
route (`FlashTheaterRouterOutlet`'s own `_mountRoute`) — it has no visibility into, and makes no call
against, anything nested further inside that component's own template. Renaming these would just
mean nothing ever calls them at all (a silently-dead function, not a compile error — an unreferenced
`public function` is not diagnosed).

## `default-focus="true"` replaces the old `claimActiveDemoFocus()` registration-order guess

`apps/async-demo`'s `MainScene` used `m.global.ft_focus.callFunc("claimFocusIfVacant", m.demoN)` —
claiming demoN's *first-registered* focusable descendant, whatever that happened to be. A
router-mounted chapter has no equivalent external caller, so each chapter now declares its own
explicit `default-focus="true"` (paired with a static `focusable="true"`) on the element that should
receive it: `fireButton` (chapter 1), `toggleMiddleButton` (chapter 2, already had this from the
original fixture), and `widget` (chapter 3 — **new**, since the original `apps/async-demo` fixture
relied entirely on `MainScene`'s own registration-order guess and never declared its own
default-focus at all). The router's own vacuum-rule proposal+claim (GRAMMAR.md's "Router" section)
picks this up automatically on mount — no `claimFocusIfVacant` call anywhere in this app.

## `flash-theater.config.json` — `designResolution: "hd"`, matching `apps/async-demo`'s own choice

`apps/async-demo`'s three migrated screens were all authored at an 880×720 baseline (a side panel
next to `MainScene`'s own 1280×720 canvas, offset `[200, 0]`), and its own `flash-theater.config.json`
already declared `designResolution: "hd"` (1280×720) despite that mismatch — evidently picked to
match the OVERALL canvas the screens rendered inside, not their own individual box size. Since every
chapter here is now a full-screen, router-mounted component filling the whole outlet (not a
200px-offset side panel), `rootWidth`/`rootHeight` on every chapter — and on `MainScene` itself — was
changed to the literal `1280`/`720` HD dimensions, matching the `"hd"` tier this app declares
(`designResolution` only accepts `"hd"` or `"fhd"` — see `findings/scale-config-and-codegen.md`).
`manifest`'s `ui_resolutions=hd,fhd` keeps both tiers so `scale`'s runtime factor is actually
exercised on a real FHD device (factor 1.5), not just the design tier itself (factor 1.0).

## No new compiler gotchas beyond the ones already listed in the task brief

This app compiled clean on the very first `npm run build:roku --workspace apps/timers-demo` attempt
— every gotcha the task brief already flagged (`scale <local> = <expr>` statement form inside
`makeWidget()`, no single-quoted strings, ternary position restrictions) was avoided by migrating the
existing, already-correct `apps/async-demo` source rather than writing these files from scratch.

## Live-device-confirmed — all 3 chapters, no bugs found

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`) via `npm run build:roku` +
`installChannel` + ECP driving (`queryAppUi` for node/focus state), one cold restart per install.
All of the previously-open questions below are now closed — no divergence found between the
pre-router-conversion fixture behavior (`timer-statements.md`/`component-unmount-hook.md`) and this
router-mounted shape.

- `default-focus` lands correctly on mount for all 3 chapters (`fireButton`, `toggleMiddleButton`,
  `widget`) — confirmed via `queryAppUi`'s `focused="true"` attribute on first mount of each.
- Chapter 1: the interval keeps ticking while visible; switching chapters away and back shows the
  tick count reset to a fresh low value (`1`), not resumed from where it left off (`81`) — the
  router-outlet teardown genuinely destroys the old `TimerDemoScreen` instance and its interval,
  and mounting fresh creates a brand-new one, confirming this specific router-mounted teardown call
  site (not just the general mechanism, already confirmed elsewhere). The NEW "Cancel pending
  timeout" button works exactly as designed: firing then cancelling within the 3s window leaves
  `timeoutStatus` at "cancelled before it fired" and it never flips to "fired!", confirmed by
  re-checking after the original 3s window had fully elapsed.
- Chapter 2: both cascades confirmed. Toggling `showMiddle` off removes `MiddleWrapper` (and its
  nested `TimerLeafWidget`) from the tree entirely — the two-component-level-deep `ft_unmount`
  cascade reaches through both boundaries. `{#each}` list-item removal: started `listWidget_w3`'s
  timer (confirmed ticking via its `readout` label), pressed "Remove last list widget", and the
  node vanished from `queryAppUi` entirely — no leftover, no crash.
- Chapter 3: the synchronous-destroy ordering guarantee holds exactly as designed — pressing
  `Backspace` while `widget` (default-focused) is focused removes `widget` (and its nested
  `widgetTicker`) from the tree AND flips `fallback` to `focused="true"`, both visible in the SAME
  `queryAppUi` response taken right after the keypress — i.e. genuinely one synchronous pass, not
  two separately-timed effects. `on:key[backspace]` reaches this screen correctly as the router's
  current outlet content.
