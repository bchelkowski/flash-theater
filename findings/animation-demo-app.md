# animation — `apps/animation-demo` coverage &amp; chapter/router conversion

Split out of [animation.md](animation.md) (which now holds only the feature's own real
compiler/runtime bug writeups and known limitations) once this file grew the app-coverage audit
plus the chapter/router conversion notes past the ~250-line split threshold. See `animation.md`'s
own header for the feature's other sibling findings files.

**Live-verified on a real Roku Ultra (15.3.4), before the chapter/router conversion below.** All 7
original `apps/animation-demo` screens confirmed: trigger sugar (`.start()`), sequential/parallel
composition, `scaled: true`'s runtime override, toggle-mode `transition:fade` with its retimed
focus-safety (hide a focused, animating panel — key routing recovers immediately, not stuck),
destroy-mode `in:`/`out:` correctly REPLAYING on every show/hide cycle (not just the first — see
`animation.md`'s `fieldToInterp` entry, a real bug this device pass found and fixed), and full
click-through navigation. Three real bugs in the feature's own codegen/authoring surface surfaced
along the way — see `animation.md`'s `fieldToInterp`/flash-on-fresh-`in:`/`duration`-units entries.
Two more, real but not specific to this feature, also surfaced (this app was simply the first
router-free, multi-sibling-toggle-mode Scene to exist) — see `findings/focus-system.md`'s
"Router-free apps: default focus needs an explicit claim" and "`navigate()`'s cross-owner fallback
can match hidden toggle-mode content" entries. A fourth bug — `repeat: true` on an exit animation
permanently hanging the deferred hide — was found by code review after the device pass; see
`animation.md`'s own entry. A fifth — a Layer 1 `target:` inside a `{#if:destroy}` block only
animating correctly on that block's first construction — was found in a later session, also by
code review, fixed, and confirmed live in a follow-up device pass — see
[animation-scale-and-destroy-targeting.md](animation-scale-and-destroy-targeting.md). A sixth,
`fly`/`slide` presets assuming a target's own resting `translation` is always `[0, 0]`, was fixed
in the same later session but is currently only unit/golden-tested, not yet live-device-confirmed.

## Chapter/router conversion — the first app converted to `findings/demo-app-conventions.md`'s pattern

`MainScene.thr` used to switch between 7 flat `{#if:destroy}`-toggled screens with ~70 lines of
hand-rolled focus bookkeeping (`unregisterCurrentDemoFocus`/`claimActiveDemoFocus`/`setup()`'s
manual `claimFocusIfVacant` — see "focus bootstrapping" in `animation.md` for why that existed at
all). It now mounts 8 router-declared chapters (one path per screen, `router.setRouting([...])`)
behind a single `<FlashTheaterRouterOutlet>`, still advanced by REWIND/FAST-FORWARD
(`router.navigate("/" + chapterPaths[activeChapterIndex])`) — `router.navigate()`'s own default-
focus proposal+claim and per-navigation vacuum supersede all of that bookkeeping outright, and
physical Back now does something it structurally could not before: the router's own automatic
back-key history walk. The outlet itself also carries `navigate-out:`/`navigate-in:`/`back-out:`/
`back-in:` (four declared slide animations, `target: outlet`) — every chapter switch is itself a
live `FlashTheaterRouterOutlet` transition demo, narrated on its own dedicated chapter 8
(`OutletTransitionsDemo.thr`, since router-outlet transitions have no per-route override — one
config, every route). See `findings/demo-app-conventions.md` for the convention this instantiates
and the roadmap for the other demo apps.

Three chapters (`BounceButtonDemo`, `TogglePresetDemo`, `AnimateAttrDemo`) were extended in place
with a second, deliberately-customized example alongside their original default one — see "What the
demo app does NOT exercise" below for which real coverage gaps this closed.

## `color` interpolator keyframes must be a plain decimal number, never a hex STRING — a real, easy-to-hit authoring trap

Every static `color="0x2A6A4AFF"`-style XML attribute in this codebase is a quoted hex STRING —
Roku's `Color` field type parses that shape natively. An `animation {}` declaration's own `color`
shorthand (or the `field: {as: "color"}` escape hatch) is different: `analysis/animation-config.ts`
requires each `keyValue` entry to be a plain BrightScript number literal — the packed RGBA `uint32`
— never a string, `animation/invalid-key-value-shape` otherwise. `0x2A6A4AFF` as an unquoted
hex-looking token isn't valid BrightScript either (this DSL/BrightScript has no `0x...` integer
literal syntax — hex literals are `&h...`, and this compiler's own literal validation doesn't
special-case that spelling here) — write the plain decimal instead (`0x2A6A4AFF` = `711609087`).
First hit converting `BounceButtonDemo.thr`'s `customized` animation to actually exercise
`ColorFieldInterpolator` (previously never used anywhere in this app — see below); confirmed live
at compile time (`ERROR [animation/invalid-key-value-shape] ... "color" keyValue entries ... must
each be a number, since "color" is a Color field.`), not device-reasoned.

## `animate:<field>`'s `{{...}}` override effectively can't carry `easeFunction` — GRAMMAR.md's own former example didn't compile

Found while extending `AnimateAttrDemo.thr` for the chapter conversion, then reproduced directly
against `compileThrSource`: GRAMMAR.md's own former Layer 3 example
(`animate:opacity={{duration: 0.2, easeFunction: "inOutCubic"}}`, no surrounding XML quotes) throws
`Expected an attribute value` — the "omit the value entirely" bare-attribute exception (Template
section) never covered "write the value without its own XML quotes," only "write no `=value` at
all." The quoted form that would seem to be the fix
(`animate:opacity="{{duration: 0.2, easeFunction: "inOutCubic"}}"`) fails differently
(`Expected ">" or "/>"`) — the inner `"inOutCubic"`'s own quotes close the outer XML attribute
early, standard XML behavior, and this DSL has no alternate string-literal syntax (no single-quoted
strings) to route around it. Net effect: `easeFunction` is reachable in a script-level
`animation {}`/`transition:`/`in:`/`out:` declaration (never inside an XML attribute's own quotes)
but not through `animate:`'s inline `{{...}}` override — only `duration`/`delay` (plain numbers)
survive that position today. **Fixed at the docs layer**: GRAMMAR.md's own example rewritten to a
verified-compiling `duration`-only form (also dropped a second, unrelated bug in the same example —
a ternary directly inside a dynamic attribute binding, `opacity="{isActive ? 1 : 0.4}"`, which
`statements.astro`'s own NotSupported list already correctly forbids but this GRAMMAR.md example
contradicted — confirmed non-compiling with `Unexpected token ":"`). No compiler change — this is a
real, load-bearing gap in what `animate:` can express, not a bug to fix in codegen;
`AnimateAttrDemo.thr`'s `poster2` now demonstrates the actual reachable surface (customized
`duration`/`delay`, default `easeFunction`) as the live, compiling reference.

## What the demo app does NOT exercise — a real device pass only covers what it drives

`apps/animation-demo`'s 8 chapters are not, and were never meant to be, exhaustive coverage of the
whole feature surface. Audited after the fact (once the fieldToInterp/initial-snap bugs raised the
obvious question "what ELSE has never actually run on hardware") and again after the chapter
conversion above closed several of the original gaps:

- **`ColorFieldInterpolator`** — now exercised (`BounceButtonDemo`'s `customized` animation,
  Replay key) — see the decimal-literal entry above for what that took to get right. NOT yet
  live-device-confirmed (added in a code-only session, no device pass since).
- **The `field`/`as` escape hatch** — now exercised (same `customized` animation, animating `width`
  via `field: {name: "width", as: "float", ..., scaled: true}`). NOT yet live-device-confirmed.
- **`.pause()`/`.resume()`** — now exercised (`BounceButtonDemo`'s Backspace key toggles
  `customized.pause()`/`.resume()`). Roku's own RUNTIME behavior (does resume correctly continue
  from the paused point, or restart?) still NOT independently confirmed — the codegen-identical
  argument for low compiler-bug risk still holds, but the actual on-device visual behavior of
  `.pause()`/`.resume()` specifically has never been observed.
- **`.stop()`/`.finish()`** — still never called anywhere in the demo app.
- **A custom `animation` used as `transition:`/`in:`/`out:` (not a built-in preset)** — now
  exercised for toggle mode (`TogglePresetDemo`'s `panel2`, Replay key, `transition:customPop`);
  destroy mode already had this (`DestroyCustomDemo`'s `in:popIn`).
- **`delay`** — now exercised (`BounceButtonDemo`'s `customized` animation; `AnimateAttrDemo`'s
  `poster2`).
- **`fly`/`slide` presets** — still never used as `in:`/`out:` anywhere in this app; only `fade`
  (preset) and two custom declarations (`popIn`, `customPop`) appear. Still the least-tested
  presets overall (`scaled: true` set unconditionally, UNLESS the target has its own static resting
  `translation` — unit/golden-tested but not live-device-confirmed).
- **Multi-level composition** (a `sequential` step containing a nested `parallel` step, or vice
  versa) — still only one level of composition each, though GRAMMAR.md documents composition as
  "arbitrarily nestable."
- **Per-field `target:` override** inside a composed animation — still never demonstrated; every
  demo uses a single top-level `target:` for the whole declaration.
- **Rapid/overlapping toggles** — every device test in the original live-verification session
  waited for full completion between presses specifically to keep bounds/screenshot checks
  unambiguous. The MOST complex branch in the whole feature (an in-flight exit cancelled via
  `.control = "stop"` on a fast hide→show, and the stale-completion re-check in
  `emitExitAnimationStateChangeHandler`) has never been exercised by a genuinely rapid, overlapping
  key-press sequence on real hardware — only reasoned through and unit-tested.
- **`animate:<field>` scaling** — `AnimateAttrDemo`'s own `posterOpacity` state is still a plain
  (unscaled) float; `animate:`'s own interaction with a `scale`d state feeding into the same
  dynamic attribute has never been exercised.
- **A non-1.0 `ft_scaleFactor`** — the original live-verification device's native resolution
  (1080p) happened to match the app's own FHD design baseline, so `factor` was always exactly `1.0`
  for every device check in that session. `scaled: true`'s own runtime CODE PATH (findNode + the
  override line executing) is confirmed; the actual MULTIPLICATION producing a visually-correct
  non-1.0 result has not been observed for this feature specifically (though `ft_scale`'s own
  general correctness at a non-1.0 factor IS separately live-verified elsewhere — see
  `findings/scale-device-verification.md`). Still open after the chapter conversion — no device
  pass at a second `ui_resolutions` tier has happened since.
- **The chapter conversion itself (router-driven navigation, the outlet transitions, and every
  newly-added customized example above) is NOT yet live-device-confirmed** — compiled clean
  (`npm run build:roku`) and covered by the existing unit/golden suites, but this was a code-only
  session with no device reachable. The next device pass for this app should specifically re-walk
  all 8 chapters via REWIND/FAST-FORWARD, confirm the outlet slide transition on every switch, and
  confirm physical Back actually walks chapter history (new behavior this app never had before).
