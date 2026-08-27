# focus — `apps/focus-demo` chapter/router conversion

The chapter/router conversion notes and coverage audit for `apps/focus-demo` — the second app
converted to `findings/demo-app-conventions.md`'s pattern, after `apps/animation-demo` (see
[animation-demo-app.md](animation-demo-app.md)'s own conversion entry for the first). For the
underlying focus-system platform facts/bugs this app exists to demonstrate, see
[focus-system.md](focus-system.md), [focus-runtime-registry.md](focus-runtime-registry.md),
[focus-runtime-bugs.md](focus-runtime-bugs.md), and
[focus-router-free-and-nested-gaps.md](focus-router-free-and-nested-gaps.md) (updated in place by
this same conversion — its own two stale live-app citations now point here instead of at
`apps/animation-demo`'s since-removed flat-switching code).

## The conversion

`MainScene` used to be the app's own hand-written (non-`.thr`) root Scene, deliberately kept that
way as this repo's one worked example of hand-composed-Scene/`.thr`-child interop. It's now a
`.thr`-compiled, router-mounted Scene like every other app's — 7 chapters
(`/focusable-basics` through `/jump-focus`), advanced by REWIND/FAST-FORWARD, same
convention as `apps/animation-demo`. The interop lesson wasn't dropped, it moved: **one chapter,
`CrossSiblingRelayDemo`, is deliberately kept hand-written** — now used as a router route's own
`component:` target instead of as the app's root Scene, which is arguably a MORE relevant proof
than the original shape (a hand-authored routed screen is a real, documented, supported thing —
see `router.astro`'s own "Not supported" note about `loadingComponent`/`markReady()` on such a
screen — where a hand-authored root Scene was really just "the DSL can't compile a root Scene
extending `Scene` in some hypothetical case," never actually true).

**`CrossSiblingRelayDemo`'s own default-focus claim changed shape, not intent.** The original
hand-written root Scene deferred its first real focus move to the first live `onKeyEvent`
(`init()` runs during `CreateScene()`, before `screen.show()` — a `SetFocus()` that early never
establishes a real root-to-leaf chain, confirmed live at the time). This component is now created
by the router well after the app has already booted and is live, so that specific boot-timing
problem doesn't apply here — its `setup()` (called unconditionally by `FlashTheaterRouterOutlet`,
the same hook every `.thr`-compiled router-mounted screen gets) calls `claimFocusIfVacant`
directly and synchronously, matching every other chapter's own default-focus resolution timing.

**Device-confirmed 2026-08-25 — and found genuinely broken until this session.**
`CrossSiblingRelayDemo.xml` (hand-written, no compiler to generate its `<interface>` block) never
declared `<function name="setup" />` at all — so `FlashTheaterRouterOutlet`'s unconditional
`m.currentChild.callFunc("setup")` was **silently failing** (undeclared interface function,
no-op, no error) every single time this chapter mounted. `CrossSiblingRelayDemo.brs`'s own
`sub setup()` had therefore never run once since this app's router conversion: no
`claimFocusIfVacant(m.simpleItem)`, and (see below) no tile-populating forward call either — a
device screenshot showed literally nothing focused anywhere on screen and an empty grid viewport.
**Fixed** by adding the missing `<interface><function name="setup" /></interface>` to the XML —
this is the exact same silent-failure class documented in
[router-setup-lifecycle.md](router-setup-lifecycle.md), just on a hand-written component's own
top-level interface instead of a naming mismatch inside a `.thr` file. Live-confirmed after the fix:
`SimpleFocusItem`'s box takes real entry focus on mount, and pressing `play` on it relays focus
into `ScrollFocusDemo`'s own grid correctly (see the `ScrollableTileGrid` split below for why that
relay target changed).

**`SimpleFocusItem.thr` gained a `default-focus="true"`** it didn't have before (on `box`) —
needed so `CrossSiblingRelayDemo`'s own `claimFocusIfVacant(m.simpleItem)` has a real registration
to match by owner identity (`firstRegistrantOfOwner` matches by `IsSameNode`, not ancestry — see
`focus-router-free-and-nested-gaps.md`). Neither `ScrollFocusDemo`'s tiles nor `FocusGroup`'s rows
declare their own default-focus, so `SimpleFocusItem` was the only one of the three siblings that
could become the entry point without a similar change to one of the others.

**`ScrollFocusDemo.thr`** (chapter 2) picked up a `root`/title/subtitle wrapper and `scale`
throughout (`viewport`'s own size/position, every tile's `x`/`y`/`width`/`height`) to match the
other chapters' framing — previously it had neither, being reused as-is inside the old hand-written
root Scene rather than mounted as its own full chapter. Tile scaling uses the `scale <local> =
<expr>` statement form (`scale x = col * 220` then `tile.x = x`) rather than calling `ft_scale(...)`
directly — the latter was tried first and abandoned before it was ever tested: no precedent
anywhere in this codebase calls a bare `ft_`-prefixed runtime function directly from DSL source
(every other case goes through the `scale` keyword), and the statement form already does exactly
this with zero risk of hitting the reserved-`ft_`-prefix identifier check some other way.
**Its grid-populating function was originally named `load()`, not `setup()`** — since only a
literal `setup()` gets auto-called by the router (GRAMMAR.md's "Router" section), this meant
`state tiles` stayed `invalid` and the chapter rendered an empty grid on any real device; the
gap survived undetected because this conversion was never device-verified. Fixed by renaming to
`setup()`; see [jump-focus-demo-app.md](jump-focus-demo-app.md) for how it was found. Also updated
`CrossSiblingRelayDemo.brs`'s own `m.scrollFocusDemo.callFunc("load")` call to `callFunc("setup")`
— it embeds `ScrollFocusDemo` as a plain child and would otherwise have silently stopped
populating its grid the moment the rename landed.

**Split into `ScrollFocusDemo.thr` (chrome) + `ScrollableTileGrid.thr` (grid) — device-confirmed
scroll-into-view was silently broken.** Found while re-verifying the `load()`→`setup()` fix live:
holding FAST-FORWARD moved focus correctly (confirmed via `query/sgnodes`) but a real screenshot
showed the focused tile never actually scrolled into the visible 1000×500 viewport — the JSON tree
*looked* successful (`scrollOffsetY` changed to a nonzero value) while the device rendered the
tile off-screen. Root cause: GRAMMAR.md's "Scroll-into-view" contract requires the
`scrollOffsetX`/`Y`-declaring component's own **template root** to be the stable viewport window
(`scrollNode.GetChild(0)` in `FlashTheaterFocusManager.brs`'s `scrollIntoView()` is read as the
reference bounds) — but `ScrollFocusDemo`'s template root was a full-screen (1920×1080) background
`Rectangle`, with the real 1000×500 clipped `viewport` nested one level inside it. Every scroll
computed itself against the FULL SCREEN's bounds, not the actually-clipped window, so it always
under-scrolled for anything past the first couple of rows. This is a single-consumer bug (`grep -rn
scrollOffsetX apps/*/src` — only this one `.thr` file in the whole repo uses the feature), not a
framework regression with wider blast radius.

**Fix**: extracted the grid into its own `ScrollableTileGrid.thr`, whose template root directly
IS the 1000×500 clipped viewport (matching GRAMMAR.md's own worked example exactly), leaving
`ScrollFocusDemo.thr` as a thin chrome wrapper (background/title/subtitle/hint) that mounts it as
a plain nested child. This reopened a SECOND, related gap: a plain nested (non-router-mounted)
child gets neither an automatic `setup()` call nor the router outlet's automatic entry-focus
resolution (both keyed to `m.currentChild` — see
[router-setup-lifecycle.md](router-setup-lifecycle.md)'s "NOT auto-called for a plain child"
entry) — so `ScrollFocusDemo.thr`'s own `setup()` now explicitly forwards
(`m.tileGrid.callFunc("setup")`) and claims its own entry focus
(`m.global.ft_focus.callFunc("claimFocusIfVacant", m.tileGrid)`), the same pattern
`CrossSiblingRelayDemo` already used for its own all-nested-children shape. This in turn meant
`CrossSiblingRelayDemo.brs`'s own two focus claims (its own `simpleItem`, and forwarding into
`ScrollFocusDemo`) now race — fixed by claiming `simpleItem` BEFORE calling
`m.scrollFocusDemo.callFunc("setup")`, so the parent's own choice of entry point wins the vacancy
check; and its cross-sibling relay (`focusComponent`, which matches by EXACT owner identity) now
targets `m.scrollFocusDemo.findNode("tileGrid")` instead of `m.scrollFocusDemo` itself, since the
tiles register under the nested grid as owner, not the chrome wrapper. All three device-verified
after the fix: standalone chapter 2 grants Tile 1 real entry focus and scrolls correctly all the
way to the bottom irregular tiles; `CrossSiblingRelayDemo`'s own `simpleItem` still wins entry
focus; its `play`-key relay still reaches the grid's first tile.

**FAST-FORWARD/REWIND now jump 2 rows within the grid instead of switching chapters** — added
per explicit user feedback that a focusable grid/list should contain FF/RW internally rather than
leak out to chapter-switching the instant a tile is focused (this chapter previously had no
`on:key[fastforward]`/`[rewind]` binding at all, unlike `JumpFocusDemo`'s own rows). **Known,
accepted trade-off, confirmed live**: unlike `JumpFocusDemo` (a 1-D list with a separate,
non-bound header `Label` that acts as an escape hatch — pressing `up` from the top row returns
there, restoring ordinary chapter-switching), this is a 2-D grid with no non-tile focusable
element at all. Every tile traps FF/RW unconditionally the moment it's focused, with **no way
back to chapter-switching via FF/RW once inside** — confirmed live: repeatedly pressing `Fwd` from
inside the grid never advances past chapter 2 no matter how many presses, only `Left`/`Right`/
`Up`/`Down` geometric navigation (out to a sibling in `CrossSiblingRelayDemo`'s case) or the
physical BACK key can leave. If a future session wants an escape hatch here too, the
`JumpFocusDemo` header pattern doesn't directly transplant (no natural non-tile focusable
position in a grid) — would need a deliberately-placed sentinel element or a boundary-hop rule in
`jumpFocus` itself.

**Found, not fixed — BACK navigation desyncs `MainScene`'s own "Chapter X/7" hint label.**
Confirmed live: pressing BACK from inside chapter 2 correctly routes back to chapter 1 (title
correctly reads "1/7"), but the bottom hint label (driven by `MainScene`'s own `state
activeChapterIndex`, only ever mutated by `nextChapter()`/`prevChapter()`) still reads "Chapter
2/7" — router-driven BACK navigation bypasses both functions entirely. Cosmetic only (routing and
focus both work correctly); not fixed this session because the automatic `on:key[back]` fallthrough
(GRAMMAR.md's "Back key" section) is fully compiler-generated with no return-value plumbing — an
author's own `on:key[back]` on `<component>` would preempt it entirely and unconditionally
consume the key, silently breaking "BACK exits the app when history is empty" unless hand-replicated.
A real fix likely means driving the hint from `router.path` (looked up against `chapterPaths`)
instead of a manually-incremented counter, but `router.path` reads are documented as NOT
watch-reactive (GRAMMAR.md's "schemaless data reads" section) — needs its own investigation, not a
quick patch.

**Chapter-number labels were stale in 6 of 7 chapters** — every title/comment before `JumpFocusDemo`
was added still read "N/6" (the count before that chapter existed) while `MainScene`'s own
dynamically-computed hint label correctly read "N/7". Fixed by updating all six hardcoded
`title`/top-comment strings to "/7".

## New chapters (no equivalent before this conversion)

- **`VacuumRuleDemo`** (chapter 3) — two buttons appear at different times (`claimFocusIfVacant`
  via `setTimeout`, mirroring `apps/sample-app`'s `LoadingDemoScreen.thr`); the second must never
  steal focus from the first once it's already claimed. Self-contained (no persistent chrome
  needed to prove "don't steal already-held focus," unlike `LoadingDemoScreen`'s own reliance on
  `Shell`'s sidebar) — both stages live in one chapter, timed to make the vacuum rule observable
  without user interaction.
- **`FocusStateDemo`** (chapter 4) — `isFocused`/`isInFocusChain`, previously demonstrated only in
  `apps/sample-app`'s `Shell.thr` (a broad app, not a focused deep-dive). One component reading
  both fields about itself, contrasted between a direct focusable child (`plainButton` — both
  fields agree) and a nested custom component's own button (`FocusStateChild` — `isInFocusChain`
  only). New leaf component `FocusStateChild.thr`, existing for no reason other than to give this
  chapter a genuine one-level-nested subtree to focus into.
- **`DestroyNestedGapDemo`** (chapter 6) — see the `focus-router-free-and-nested-gaps.md` update
  above; the current live demonstration of the `{#if:destroy}`-plus-nested-custom-component gap's
  workaround (`unregisterSubtree` before the destroying state write, `claimFocusIfVacant` after
  the recreating one). Always uses the workaround — there's no compiler diagnostic or safe
  fallback for the gap itself, so demonstrating the BROKEN shape live would risk a genuine stale-
  node crash with no way to verify the exact failure mode without a device this session.
- **`FocusableBasicsDemo`** (chapter 1) folds in a second, customized example beyond the plain
  `focusable`/`on:key`/`default-focus` basics: a parent→child dynamic `focusable={expr}`
  drill-down/back-out card, adapted from `apps/sample-app`'s `RichCard.thr` (the original,
  live-verified worked example) — not previously demonstrated anywhere in this app.
- **`JumpFocusDemo`** (chapter 7, new) — `jumpFocus(<direction>, <count>, <press>)`, the
  RowList-style multi-item-jump counterpart to hold-to-repeat (`docs/features.md`'s last remaining
  `⬜` item before this). Two side-by-side lists (`defaultRows`, jump size 5; `customRows`, jump
  size 2 and shorter than its own jump size, so a jump from near the bottom visibly lands exactly
  on the last row instead of overshooting) demonstrate the option surface. A single focusable
  header carrying no `on:key[fastforward]`/`[rewind]` of its own sits above both lists — this is
  the ONE chapter in the app where FAST-FORWARD/REWIND mean something different depending on what
  currently holds focus (chapter-switch on the header, jump-N inside a list), resolved with pure
  composition (per-row `on:key` bindings winning the bubble order before `MainScene`'s own
  component-level handler ever runs), no compiler special-casing. See
  [jump-focus.md](jump-focus.md) for the feature's own design rationale (why `jumpFocus` is opt-in
  rather than an automatic LRUD-style fallthrough, why `navigateBy` is hop-based rather than
  registry-index-based, and the hold-to-repeat wiring shared with arrow-key repeat) and
  [jump-focus-demo-app.md](jump-focus-demo-app.md) for this chapter's own layout/coverage notes.

## Device-verified fix: the whole router never mounted anything — `Main.brs` was missing `scene.callFunc("setup")`

**Found and fixed 2026-08-25, live on a Roku Ultra.** While device-verifying the `ScrollFocusDemo`
`load()`→`setup()` rename above, renaming alone produced no visible change — `query/sgnodes`
showed `FlashTheaterRouterOutlet` mounting **zero children on every chapter**, not just chapter 2.
Root cause: `apps/focus-demo/src/source/Main.brs` never called `scene.callFunc("setup")` after
`screen.show()` — the one hand-written line every other `.thr`-compiled-`MainScene` app in this
repo has (see [router-setup-lifecycle.md](router-setup-lifecycle.md)'s "Every router-mounted
component gets an automatic `setup()` hook" section for why the root Scene is the one exception
that needs this called by hand). Confirmed via `grep -n 'callFunc("setup")' apps/*/src/source/Main.brs`
across all 14 apps — `focus-demo` was the only one missing it. Without it, `MainScene.thr`'s own
`setup()` (which calls `router.setRouting(...)` and the initial `router.navigate(...)`) never ran,
so the router had no routes registered and nothing was ever mounted — not a chapter-2-specific bug,
the entire app never rendered anything past the bare `root`/`hint` shell on any chapter, from the
very first router conversion. This means the router conversion had **never actually been run** on a
device before this session, despite compiling clean the whole time (a missing hand-written
`Main.brs` line is invisible to the compiler — nothing about it is a compile error).

**Fix**: added the same `scene.callFunc("setup")` call (with the same ordering comment) that every
other app's `Main.brs` already has, right after `screen.show()`. **Live-verified after the fix**:
cold-restarted the app, confirmed via `query/sgnodes --scope all` that chapter 1
(`FocusableBasicsDemo`) mounts with real focus established, then FAST-FORWARDed to chapter 2 and
confirmed `ScrollFocusDemo` renders its full 33-tile grid (30 uniform + 3 irregular) with `Tile 1`
focused by default; pressed Right then Down and confirmed focus moved to the geometrically correct
neighbor (`tile1_1`); pressed Down 4 more times and confirmed the `track` node's translation shifted
to `{-0, -80}` (scroll-into-view firing as focus moved below the viewport) while focus landed on
`wide1`, the first irregular tile below the grid.

**Lesson**: when a router-mounted device pass shows "nothing renders" on a component that compiles
clean, check `Main.brs` for the hand-written `scene.callFunc("setup")` line before assuming the bug
is in the component's own `.thr` file — a per-component naming mismatch (like `ScrollFocusDemo`'s
own `load()`/`setup()` bug just above) and a missing root-level wake-up call produce the identical
symptom (`{#if:destroy}`-gated content never appears), but only `query/sgnodes` showing the ENTIRE
outlet with zero children (not just one route's own content) distinguishes the app-wide cause from
the single-component one.

## Device-found and fixed 2026-08-25: `VacuumRuleDemo` never actually claimed real focus

**A user reported "chapter 3 doesn't look focused" — confirmed live, and it wasn't just cosmetic.**
`query/sgnodes --scope all` showed `focused="true"` nowhere in the whole scene except `MainScene`
itself; `stageOne`'s color was still its own static `0x2A6A4AFF`, never the framework's yellow
highlight. Root cause: `VacuumRuleDemo.thr`'s `setup()` called
`m.global.ft_focus.callFunc("claimFocusIfVacant", m.stageOne)` — passing the LEAF node itself as
the argument. `claimFocusIfVacant(owner)` calls `firstRegistrantOfOwner(owner)`, which searches the
registry for entries whose **owner** (not the node itself) matches by `IsSameNode` — and
`register(m.stageOne, m.top, false)` registered `stageOne` with owner **`m.top`** (this
component's own top-level node), never with `stageOne` as its own owner. So
`firstRegistrantOfOwner(m.stageOne)` always found nothing, and the claim silently no-op'd — every
single time, for both stages, since this chapter was written. This is the exact same call shape
GRAMMAR.md's own "Scroll-into-view"-adjacent focus-delay example documents
(`claimFocusIfVacant(m.top)`, not the leaf) — `VacuumRuleDemo.thr` just used the wrong argument.
**Fix**: both calls now pass `m.top` instead of the leaf (`m.stageOne`/`m.stageTwo`) — device-
confirmed after the fix: `stageOne` genuinely highlights yellow at ~0.6s, and `stageTwo`'s own
later claim at ~2s correctly does NOT steal it (still its own static blue), exactly the behavior
this chapter exists to demonstrate. **Lesson**: `claimFocusIfVacant`'s argument is always the
OWNER a registration was recorded against (typically `m.top` for a plain in-template element,
or the nested child component instance for one owned by a further-nested component — see
`ScrollFocusDemo`'s own `claimFocusIfVacant(m.tileGrid)` for that second shape) — never the
focusable leaf node itself, even though passing the leaf compiles and runs with no error at all.

## Device-found and fixed 2026-08-25: `ScrollFocusDemo`'s own chapter chrome leaked into chapter 5

**A user noticed chapter 5 (`CrossSiblingRelayDemo`) visibly showed "2/7" at the top of the screen**
while the bottom hint correctly read "Chapter 5/7" — confirmed live, reproducible on demand.
`CrossSiblingRelayDemo` embeds `ScrollFocusDemo` as a plain child (one of three composed
siblings), and `ScrollFocusDemo.thr`'s own title/subtitle/hint Labels ("2/7 — cross-component
LRUD...") are unconditional — correct when it's mounted as its own standalone chapter 2, actively
wrong/confusing when reused as embedded content under a DIFFERENT chapter number. **Fix**: added a
`field standalone: boolean = true` to `ScrollFocusDemo.thr`, wrapped the title/subtitle/hint in
`{#if:destroy standalone}` (the full-screen `root` background Rectangle stays unconditional —
`CrossSiblingRelayDemo` has no background of its own and relies on it showing through), and
`CrossSiblingRelayDemo.brs`'s `init()` now sets `m.scrollFocusDemo.standalone = false` right after
`createChild(...)`. Device-confirmed: chapter 5 no longer shows any "2/7" text; chapter 2 itself
(unaffected — still defaults to `standalone = true`) is unchanged.

## Resolved: per-element FF/RW wiring was unnecessary boilerplate, not a missing feature

A user flagged that binding `on:key[fastforward]`/`on:key[rewind]` on every single tile/row (what
this app's first pass at both `ScrollFocusDemo`/`ScrollableTileGrid` and `JumpFocusDemo` did) was
real, avoidable per-element repetition, and asked whether a declarative, container-level "this
component captures FF/RW for its own descendants" setting should exist — mirroring
`scrollOffsetX`/`scrollOffsetY`'s own no-per-element-wiring convention. It already exists, with
zero new compiler work: `on:key[...]` doesn't require `focusable` on the same element — it fires
from anywhere in the currently-focused node's own ancestor chain (see
[jump-focus.md](jump-focus.md)'s own expanded section on this). Both files were refactored to bind
`on:key[fastforward]/[rewind]` ONCE — on `ScrollableTileGrid`'s own root, and on a per-list
wrapping `<Group>` in `JumpFocusDemo` — instead of on every leaf. Confirmed live: identical hop
behavior, far less repetition.

**Separately, still a real, accepted trade-off, not a bug**: `ScrollFocusDemo`'s grid has no safe
non-captured element like `JumpFocusDemo`'s own header, so once any tile holds focus,
FAST-FORWARD/REWIND can never switch chapters again for the rest of that visit — confirmed live,
repeated `Fwd` presses from inside the grid never advance past chapter 2. This is inherent to a
grid having no natural "outside the capturing region" landing spot, not something the container-
level `on:key` fix above changes — see this file's own earlier note on the FF/RW containment
trade-off for the full reasoning.

## Device-found and fixed 2026-08-26: `jumpFocus` could escape its own list entirely — `on:key` bubbling scopes the KEY, not the SEARCH

**A user reported**: standing on the topmost row of `JumpFocusDemo`'s Default list and pressing
REWIND (expected: nothing, already at the boundary) instead moved focus to the `title` header
above the list. Confirmed live, reproducible on demand.

**Root cause, and why the container-level `on:key` fix above didn't prevent it**: `on:key`
bubbling (see the section above) scopes WHICH KEY PRESSES reach a handler — it has nothing to do
with `navigate()`/`navigateBy()`'s own geometric search, which is governed entirely by registry
**owner** identity (the enclosing component INSTANCE, from `register(node, owner, ...)`), a
completely separate concept. Both lists' rows AND the header were, at the time, all plain elements
directly in `JumpFocusDemo.thr`'s own template — so all three shared exactly ONE owner
(`JumpFocusDemo`'s own `m.top`). `bestCandidate()`'s same-owner search doesn't know or care about
the wrapping `<Group>` a `<on:key>` handler happens to be declared on; it only filters by
component-instance identity. Since `title` genuinely shares that one owner and sits geometrically
above row 1, it was always a valid same-owner "up" candidate — reached via `stepOnce()`'s ordinary
same-owner pass, no cross-owner fallback ever needed. This ALSO meant the demo's own documented
"a held REWIND from a short list's own bottom row lands exactly on its top row, never past it"
claim was never actually a guaranteed boundary — it only happened to hold for whatever hop count
was device-tested; a jump requesting more hops than remained in the list would have overshot past
the top row into the header, for the exact same reason.

**Fix, two parts, needed together**:
1. **`FlashTheaterFocusManager.brs`'s `navigateBy()`** now calls `bestCandidate(direction,
   currentEntry, currentRect, true)` directly (same-owner-only) instead of `stepOnce()` (which
   deliberately falls through to a cross-owner search — correct for `navigate()`'s own single
   arrow-key press, since "press up from a list's top row reaches the header" is exactly that
   fallback, and must keep working). A multi-hop `jumpFocus` jump must never leave the owner it
   started in, even when it runs out of same-owner candidates partway through.
2. **This alone wasn't sufficient** for `JumpFocusDemo` specifically, because "same owner" was
   already the WRONG boundary — title and rows shared one owner regardless. Extracted each list
   into its own component, `JumpRowList.thr` (`rowCount`/`jumpSize`/`labelPrefix`/`rowColor` fields,
   builds its own rows in `setup()`, binds `on:key[fastforward]/[rewind]` once on its own template
   root, exposes a `selectedLabel` field the parent reads via `bind:selectedLabel="{state}"` — the
   same child→parent relay `bind:` already documents). Now each list is a genuinely separate owner,
   so fix (1) actually has a real boundary to enforce. `ScrollFocusDemo`/`ScrollableTileGrid`
   already had this property (the grid IS its own component) — it needed only fix (1).

**Device-confirmed after both fixes**: REWIND on the Default list's topmost row now does nothing
(stays put); the arrow-key "up escapes to the header" behavior is unaffected (still uses
`navigate()`, not `navigateBy()`); a normal jump-of-5 still works; and the previously-unverified
overshoot-avoidance claim now genuinely holds — a held REWIND from the Custom list's bottom row
(6 rows, jump size 2) lands exactly on row 1, never past it into the header.

**General lesson**: `on:key` bubbling and `navigate()`/`navigateBy()`'s owner-based search are TWO
INDEPENDENT scoping mechanisms that happen to look similar (both talk about "containment"). Wrapping
something in a plain `<Group>` with an `on:key` binding scopes the KEY; it does nothing for the
SEARCH unless that wrapper is a genuine separate component instance (a real registry owner).

## Device verification status

**All 7 chapters walked and screenshot-confirmed 2026-08-25**, including the fixes above:
`FocusableBasicsDemo`'s entry focus and drill-down card; `ScrollFocusDemo`'s full grid render,
correct scroll-into-view all the way to the irregular tiles, and FF/RW jump-2-rows containment;
`VacuumRuleDemo`'s two-stage non-stealing claim; `FocusStateDemo`'s `isFocused`/`isInFocusChain`
readout (both true for the direct child, `isInFocusChain`-only for the nested one);
`CrossSiblingRelayDemo`'s entry focus and both relay directions (`focus("row0")` and the
`focusRequest` field relay into the grid); `DestroyNestedGapDemo` surviving two toggle cycles
without a crash; `JumpFocusDemo`'s hold-to-repeat jump (confirmed landing on the last row from a
held press, still contained on chapter 7 throughout).

Remaining, not yet exercised: `JumpFocusDemo`'s own **short-list overshoot-avoidance landing**
(a held REWIND from `customRows`' own bottom row settling exactly on row 1) and the header/list
FF-RW-meaning handoff in the `up`-from-top-row direction specifically — see
[jump-focus-demo-app.md](jump-focus-demo-app.md)'s own "Not yet exercised" note.
