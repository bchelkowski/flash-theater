# Router-outlet transitions — `apps/router-demo`'s `Shell.thr` layout lessons

Layout-specific lessons from building `apps/router-demo`'s own `Shell.thr` against the
router-outlet-transitions feature — kept here because each round is a real lesson, not just history
to prune. See [router-transitions.md](router-transitions.md) for the feature's own core
design/rationale, and [router-transitions-bugs.md](router-transitions-bugs.md) for device-found
runtime bugs in the compiler/runtime asset itself (as opposed to this file's own demo-content-only
findings).

## Demo-app design, current state: a stationary clipped viewport wrapping the outlet, not the outlet itself carrying the fixed position

`Shell.thr`'s `childOutlet` went through three live-caught rounds of "the router outlet hovers over
the sidebar" before landing on the current, correct design — kept here because each round is a real
lesson, not just history to prune:

1. **Unscaled offset**: the array shorthand form (`translation: [[0, 0], [-880, 0]]`) is a plain,
   unscaled literal. At `designResolution: "hd"`, a device rendering at FHD applies
   `ft_scaleFactor = 1.5` to every `scale`d value, so `childOutlet`'s own real on-screen width was
   `880 * 1.5 = 1320px`, but the slide distance stayed unscaled at `880`. **Fix**: the object form
   with `scaled: true` — the same fix the built-in `fly`/`slide` presets already apply to their own
   pixel offset automatically (`analysis/animation-presets.ts`'s `flyOrSlideInterpolator`; a custom
   `animation {}` declaration has to opt in explicitly, the array shorthand form has no `scaled`
   support at all).
2. **Wrong rest coordinate**: every `in:` keyframe ended at `[0, 0]`, but `childOutlet`'s real
   resting position (set via `translation="{childOutletTranslation}"`, `[400, 0]`) was never
   `[0, 0]`. A custom `animation {}` declaration gets no automatic help here — unlike `fly`/`slide`,
   which read the target's own static `translation` and offset from it (`restingTranslationOf`),
   every keyframe in a hand-written declaration is an absolute coordinate the author supplies
   directly, and Roku's `FieldInterpolator` settles at `keyValue[last]` once an animation completes
   — ending at `[0, 0]` meant `childOutlet` permanently rested at the wrong x after **every single
   navigation**, not just a transient mid-slide glitch.
3. **No clipping, plus the loading spinner riding along with the slide** (the actual last-mile fix,
   superseding #2's approach entirely rather than patching it further): fixing #2 by using `[400, 0]`
   as the rest keyframe made `childOutlet` settle in the right place, but Roku never clips a node's
   children to its own bounds by default (see GRAMMAR.md's "Scroll-into-view" section) — mid-slide,
   `childOutlet`'s own content still rendered wherever its translation put it, visibly crossing over
   the sidebar. **Fix**: wrapped `childOutlet` in `childOutletViewport`, a plain `Rectangle` with
   `clippingRect` set to its own bounds — the EXACT scroll-viewport pattern GRAMMAR.md already
   documents ("the field-declaring component's own template root element must NOT itself be the
   thing that translates — only content nested further inside it should move, so the root element's
   own bounds stay a stable reference window throughout"). `childOutletViewport` now carries the
   fixed absolute position (`childOutletTranslation`); `childOutlet` itself never moves relative to
   ITS OWN parent except during the slide, so every "rest" keyframe reverted to `[0, 0]` — now
   correct again, since that really is `childOutlet`'s own local rest position once the wrapper
   carries the absolute offset. No compiler/runtime-asset change needed — purely an existing,
   already-shipped DSL primitive (`clippingRect`, ordinary nesting), used the same way any other
   scrollable/clipped region in this DSL would be.

   This surfaced a SECOND bug the clipping change made visible: `FlashTheaterRouterOutlet.brs`'s own
   `_showSpinner` positioned the loading indicator at a fixed `[width/2, height/2]` **relative to the
   outlet's own local origin** — but the outlet IS the thing being translated, so the spinner (a
   child of it) rode along with every slide, and — once clipped — was invisible for the entire
   loading-gate wait (parked off-window along with the rest of the outlet). **Fix**: `_showSpinner`
   now compensates for the outlet's own CURRENT translation every time it runs
   (`spinner.translation = [width/2 - outlet.translation.x, height/2 - outlet.translation.y]`),
   canceling it out so the spinner renders at a fixed point within the STATIONARY viewport regardless
   of where the outlet itself currently sits. Safe to compute once per gate (not per frame) because
   the outlet's own translation is static for the gate's whole duration — it only moves during the
   brief in/out animation phases, never while parked waiting on `router.markReady()`/`loadingTimeout`.
   Confirmed live: spinner `translation` exactly matches the compensation formula
   (e.g. outlet at local `{1320, 0}` → spinner at `{-660, 540}`, summing to the viewport's own local
   center `{660, 540}`) in every captured snapshot, both directions.

**Lesson for anyone authoring a router-outlet transition against a `scale`d, sidebar-adjacent
outlet**: don't animate the outlet's own translation directly if anything else on screen sits beside
it — wrap it in a stationary, `clippingRect`-bounded viewport FIRST (same pattern as any other
scrollable/clipped DSL region), THEN write every keyframe relative to the OUTLET's own local `[0, 0]`
(now genuinely its rest position, since the wrapper carries the fixed absolute offset) — and if
`loadingComponent` is also configured, verify the spinner still renders somewhere sensible once
you've done this, since a spinner that's a child of the thing sliding needs its own position
compensation to stay visible during the gate.

## Compiler bug found via this same demo (unrelated to router-outlet-transitions itself), fixed 2026-08-19: a second statement next to a solo `setTimeout(...)` broke its own elision, emitting invalid BrightScript

Adding `router.markReady()` to `LoadingDemoScreen.thr`'s `setup()` (which already had exactly one
statement — a bare, handle-discarded `setTimeout(function() {...}, 1500)`) caused a REAL on-device
compile failure (`Install Failure: Compilation Failed.\nLoadingDemoScreen\n`) that this project's own
`validateGeneratedBrs` did not catch (a leniency gap: its vendored parser tolerates a bare
expression-statement Roku's real compiler rejects). Root-caused and fixed same day — full writeup,
including why it wasn't actually specific to "solo statement" (any second bare statement sharing the
same `StatementRegion`, before or after, triggered it — even two bare `setTimeout(...)` calls with
nothing else), now lives in [timer-statements.md](timer-statements.md) (the correct home for a
general timer-codegen bug, not a router-transitions-specific one). `LoadingDemoScreen.thr` now calls
`router.markReady()` again — the workaround (deliberately never calling it, relying on
`childOutlet`'s own `loadingTimeout`) is gone, live-reverified: the screen installs and runs cleanly,
`readyButton` still appearing right on its own ~1.5s schedule (that internal delay is entirely
independent of the outlet-level `markReady()` call — see that file's own updated comment).

## Sidebar label overlap — pre-existing, worsened by this session, now fixed

`Shell.thr`'s `interceptorUrlTranslation`/`interceptorStatusTranslation` already sat inside
`FavoriteCounter`'s own rendered text area (`counterTranslation` `[40, 40]` + `FavoriteCounter`'s own
~252px-tall content) even before this session — confirmed by checking `git show HEAD` on the
pre-session file. This session made it worse by moving `focusReadoutTranslation`/
`menuHintTranslation` INTO the same zone too (to make room for an 8th menu row), which a live
screenshot (not just position-only `app-ui` XML dumps) caught as genuinely illegible: two unrelated
plain-text `Label`s at overlapping coordinates render as interleaved, unreadable glyphs — unlike the
menu's own OPAQUE `Rectangle` items, which safely tolerate overlapping `FavoriteCounter`'s own render
area since their solid fill occludes whatever's underneath (later z-order wins). **Fix**: shrunk
`menuItemHeight` (60 → 50) and the row pitch (66 → 56px) to free real vertical space BELOW the whole
8-item menu, and moved all four plain-text labels there instead of above/beside the menu. A residual,
unrelated cosmetic issue remains and is NOT fixed here: `FavoriteCounter`'s own declared width
(883px scaled ≈ 589px unscaled) is wider than the 380px-wide sidebar column, so its own longer labels
visibly extend past the menu's own 300px-wide buttons into the gap before the divider — pre-existing,
not part of this feature, out of scope for this pass.

**Lesson**: position-only verification (`app-ui`'s XML dump, translation/bounds values) is not
sufficient for catching visual-only defects like overlapping unclipped text — a real screenshot
caught this immediately where several rounds of position-checking had not, since every individual
element's own reported coordinates looked "fine" in isolation.
