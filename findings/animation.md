# animation — findings

The real device-found bugs and known limitations for the `animation {}`/`transition:`/`in:`/
`out:`/`animate:` feature. See `packages/compiler/GRAMMAR.md`'s "animation" section for the
grammar/API itself. For config-parsing and codegen design notes not tied to a specific
device-found bug, see [animation-config-codegen.md](animation-config-codegen.md). For the deferred
hide/removal guard, focus-safety timing, `{#if:destroy}` targeting, and `scaled: true`
scale-integration design, see
[animation-scale-and-destroy-targeting.md](animation-scale-and-destroy-targeting.md). For the
live-device-verification narrative, the `apps/animation-demo` coverage audit ("what does the demo
app NOT exercise"), and the chapter/router conversion, see
[animation-demo-app.md](animation-demo-app.md).

## `repeat: true` on an exit (`out:`) animation would permanently hang the deferred hide — fixed at analysis time, found by code review

**Not device-reproduced — found by auditing the code for what the demo app leaves untested (see
above), then reasoning through the actual mechanism**, prompted directly by the user asking what
other issues might be lurking in paths the demo never exercises. `emitExitAnimationStateChangeHandler`
(the `ObserveFieldScoped("state", ...)` handler backing every deferred `visible=false`/`removeChild`)
only acts when the exit animation's own `state` field reports `"stopped"`. Roku's own `repeat: true`
animations loop indefinitely and never report `"stopped"` on their own — only an explicit
`control = "stop"` call would, and nothing in this feature's generated code ever issues one. A
`repeat: true` exit animation would therefore leave its block PERMANENTLY visible (toggle mode) or
never actually `removeChild`'d (destroy mode) — animating forever, with no way to recover short of
navigating away and back (which tears down the whole enclosing component, not just this block).
This applies even when `repeat: true` sits on a NESTED step buried inside a `sequential`/`parallel`
composition, not just the outermost node — a composition's own `state` never reaches `"stopped"`
until every one of its own child steps has, so one never-completing child is just as fatal as
`repeat: true` on the composition's own top level.

**Fix**: `analysis/transitions.ts`'s `resolveBlockTransitions` now recursively walks a resolved
`outConfig`'s entire step tree (`stepHasRepeat`, mirroring the same recursive-walk shape
`validateEffectiveTargets`/`animation-emitter.ts`'s own tree walks already use) and rejects with
`animation/repeat-not-supported-for-exit-animation` if `repeat: true` appears anywhere. Deliberately
NOT rejected on the `in:` side — nothing waits for an enter animation to finish, so a looping
"pulse while shown" effect on `in:` works exactly as an author would expect; only `out:`'s own
dependency on eventually reaching `"stopped"` makes `repeat: true` there a real, silent, forever-
stuck bug rather than just an unusual choice.

**A sibling of this exact bug also existed in `<FlashTheaterRouterOutlet>`'s own `navigate-out:`/
`back-out:` transitions** (same "waits on state=\"stopped\", a repeating animation never reports
it" mechanism, different feature) — found later by auditing this feature's own fix for other code
paths with the same shape, and fixed the same way. See
[router-transitions.md](router-transitions.md)'s own "`repeat: true` on `navigate-out:`/
`back-out:` had no guard at all" entry.

## A `{#if:destroy}` block's `in:`/`out:` animation only ever played on the FIRST show — a real codegen bug, fixed

**Live-verified, found and fixed in this session.** `DestroyCustomDemo`'s `in:popIn` (a custom
`scale: [0.5, 1]` pop-in) played correctly the very first time the card was shown — a genuine,
measurable mid-flight size change confirmed via `query/app-ui`'s reported `bounds`. Every
SUBSEQUENT show (hide, then show again — even with generous waits, no race condition involved)
snapped straight to full size instantly, with NO animation at all: `bounds` at 90ms into a 0.3s
animation was already the fully-settled value, identical to the animation never having run.

**Root cause**: Roku's `Animation`/`*FieldInterpolator` `fieldToInterp="<id>.<field>"` resolves the
target node BY ID exactly once — the first time that interpolator's `.control` field is ever set to
`"start"` — and does NOT re-resolve on a later `.control = "start"`, even once a NEW node with the
same id has replaced the original. `{#if:destroy}` destroys and recreates its content on every
hide/show cycle (a fresh `CreateObject` each time, same `id="card"`), so after the FIRST cycle, the
`in:`/`out:` interpolator stays bound to the ORIGINAL, now-detached node forever — every later
`.control = "start"` animates a node nothing can see, while the NEW node's field just sits at
whatever Roku's own default is. Toggle mode (`{#if}`) never hits this: its target is the SAME node
instance for the whole component lifetime, so the one-time resolution never goes stale.

**Fix**: `codegen/conditional-block-emitter.ts`'s `emitConditionalCreateSub` (for `in:`) and
`emitConditionalBlockCascadeCheck`'s hide branch (for `out:`) now emit a `fieldToInterp` reset
immediately before every `.control = "start"` line — but a SINGLE re-assignment to the exact same
string value was confirmed live to be a silent no-op (Roku's `SetField` appears to skip the
field-change side effect entirely when the new value equals the current one, leaving the stale
binding untouched). The working fix blanks the field to `""` first, then sets it back to the real
value — two genuinely different assignments, confirmed live to force fresh resolution on every
cycle. Each such interpolator gets its own synthesized `id` (`ft_anim_<name>_ref_<n>`, generalized
from the pre-existing `scaled: true` id-assignment mechanism — see `ScaledInterpolatorRef`/
`RefreshableInterpolatorRef` in `codegen/animation-emitter.ts`, sharing one id/counter since a
SceneGraph node has only one `id` field and an interpolator can need both purposes at once, e.g. a
`scaled: true` `fly`/`slide` preset used as `in:`/`out:` on a `{#if:destroy}` block). Scoped
strictly to `isDestroyMode` transitions (a new field on `ResolvedBlockTransition`) — a toggle-mode
block's own transition interpolators get no id, no refresh lines, and are structurally identical to
before this fix (confirmed by a dedicated test).

**Lesson**: a "does it animate at all" check on the FIRST use of a feature is not sufficient
verification for anything involving `{#if:destroy}` — the interesting failure mode here only
appeared on the SECOND cycle. Any future `{#if:destroy}`-related animation work should explicitly
test at least 2-3 full show/hide cycles, not just one.

## A freshly-shown `in:` target could flash at its bare Roku default before the animation's own snap applied — fixed, not fully device-confirmed

**Reported by the user, reasoned through and fixed; the exact single-frame mechanism is NOT
independently device-confirmed** (screenshot/bounds-polling at 80-90ms granularity is far too
coarse to catch a single render frame — this fix is based on sound reasoning about SceneGraph's
architecture and a plausible match to the reported symptom, not a directly observed root cause).
Reported symptom: on demo 4 (`TogglePresetDemo`, toggle-mode `transition:fade`) and demo 5
(`DestroyCustomDemo`, destroy-mode `in:popIn`+`out:fade`), the FIRST animation after switching to
that screen "looks like it's triggered 2 times." A dedicated debug probe (a counter incremented
inside the toggle handler, relayed into a label) confirmed the underlying STATE toggle fires
exactly once per physical press — ruling out a logic-level double-invocation.

**Reasoned mechanism**: a freshly `CreateObject`'d node (destroy mode) — or a toggle-mode node
whose field was never explicitly initialized to match the `in:` animation's own `key[0]` — is
visible at Roku's own bare field default (e.g. `scale = [1, 1]`, full size; `opacity` unset, i.e.
`1`) for whatever window exists between `insertChild`/`visible = true` and the interpolator's own
automatic "snap to key[0]" actually applying once `.control = "start"` runs. SceneGraph's render
thread runs independently of the script thread, so even a run of purely-synchronous BrightScript
statements with no explicit yield between them is not guaranteed immune to the render thread
sampling scene state in between two of them. A `scale: [0.5, 1]` pop-in landing in that window would
render one frame at the bare-default full size, THEN visibly snap down to 0.5, THEN grow back to
1.0 — reading to a viewer as "the animation played twice" (an unexplained flash to full size,
immediately followed by a shrink-then-grow) — matching the reported symptom closely. A plain
`opacity` fade (demo 4) would show the analogous but much subtler version (a one-frame flash to
full opacity before the fade-from-0 starts), consistent with the SAME root cause being reported for
both screens despite one (destroy mode, freshly-created node) and the other (toggle mode, an
existing node whose field was simply never pre-set) reaching it by slightly different paths.

**Fix**: `conditional-block-emitter.ts`'s `emitInitialKeyframeSnapLines` walks an `in:` transition's
entire step tree (recursing through `sequential`/`parallel` composition, same shape
`animation-emitter.ts`'s own walk uses) and emits one `m.<targetId>.<field> = <key[0]'s value>` line
per interpolator, immediately before that transition's own `.control = "start"` line — in BOTH
`emitConditionalCreateSub` (destroy mode) and `emitToggleTransitionCascadeLines`'s show branch
(toggle mode). This removes the bare-default window entirely: the target is never observably at any
value other than `key[0]` before the animation takes over, regardless of what the render thread
does or doesn't sample in between. Only applied to the `in:` side — the `out:` side's own
first-applied value (via `reverse`) is whatever the target ALREADY visibly has, so there is no
bare-default window to close there. This fix is safe/idempotent even if the reasoned mechanism turns
out not to be the real cause: explicitly setting a target field to its own animation's first
keyframe value, right before starting that exact animation, can never produce an incorrect result.

## `duration`/`delay` are in SECONDS, not milliseconds — an easy, silent authoring mistake

Roku's own `Animation.duration`/`.delay` fields are `float`, in seconds — the compiler passes the
literal straight through with no unit conversion (`animation-emitter.ts`: `` `duration="${step.
duration}"` ``), which is correct and matches GRAMMAR.md's own `duration: <seconds>` documentation.
But every duration/delay value originally authored across all 6 `apps/animation-demo` screens (and
GRAMMAR.md's own example snippets) used millisecond-scale numbers — `duration: 400`, `300`, `500`,
`200` — the natural instinct when thinking "a quick 400ms bounce." The compiler has no way to catch
this (400 is a perfectly valid number of SECONDS, just an unusual one for a UI animation), so it
compiled clean and looked structurally correct in every test — the bug only became visible by
actually timing an animation on a real device: a "400ms" bounce was actually a **6-minute 40-second**
one, and a "300ms" fade was actually a **5-minute** one. `apps/animation-demo`'s own early
device-verification runs in this session were fooled by this for a while — screenshots taken
50-800ms after a trigger looked plausible either way (a card that hasn't moved yet, since the
"animation" is still 0.1% into a multi-minute duration, looks identical to one that's already
settled if you don't check the actual elapsed-vs-duration ratio). **Fix**: every `duration: 400`
became `duration: 0.4`, etc., in both `apps/animation-demo` and GRAMMAR.md's own examples. Confirmed
live afterward: a panel fade with `duration: 0.3` is fully opaque by 350ms; before the fix, at the
same 350ms mark it was still barely visible. **Lesson for the next demo/example using `animation`:
sanity-check that a duration "looks like a fraction of a second," not a suspiciously round
hundred-or-more number** — there's no compiler diagnostic for this, since any positive number is a
structurally valid `Animation.duration`.

## `apps/animation-demo`'s own focus bootstrapping — two real gaps, and a real focus-system bug found via it

Device-verifying this app surfaced three findings that belong to the FOCUS system, not this
feature — `apps/animation-demo` was simply the first-ever Scene-rooted `.thr` component in the repo
with focusable content but no router, and the first to compose several sibling components each
with their own toggle-mode content. See `findings/focus-system.md`'s own "Router-free apps: default
focus needs an explicit claim" and "`navigate()`'s cross-owner fallback can match hidden
toggle-mode content" entries for the full writeup — not duplicated here.

## Known limitations (see GRAMMAR.md's own "Known limitations" for the user-facing version)

- No `.flsh` class-body `animation` form — animations are inherently tied to template element ids.
- `fly`/`slide` presets can only account for a target's own STATIC resting `translation` — a
  DYNAMIC one (`{expr}`/`bind:`) is rejected at compile time
  (`animation/preset-target-has-dynamic-translation`), since the preset's own absolute keyframes are
  computed once, at compile time, from a literal it can read directly off the template; there's no
  way to fold a runtime-computed value into that same computation. Use a custom `animation {}`
  declaration instead in that case — see `analysis/animation-presets.ts`'s `restingTranslationOf`.
- `scale` animations are invisible to `FlashTheaterFocusManager`'s LRUD geometry — `absoluteRect()`
  only sums `translation` and reads `BoundingRect()`'s width/height, never `scale`. Pre-existing
  limitation of that function, not something this feature could safely change without risking a
  regression to every other focus-system consumer.
- `target:` inside a `{#if:destroy}` block is validated for existence only, not reachability — see
  [animation-scale-and-destroy-targeting.md](animation-scale-and-destroy-targeting.md)'s own entry
  (a genuinely separate limitation from the fieldToInterp-staleness one, which is now fixed).
- `scaled: true` is opt-in and easy to forget — no diagnostic flags an absolute `translation`
  keyframe that "looks like" it should probably be scaled; see
  [animation-scale-and-destroy-targeting.md](animation-scale-and-destroy-targeting.md)'s own entry.
