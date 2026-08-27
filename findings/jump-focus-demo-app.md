# `apps/focus-demo`'s `JumpFocusDemo` chapter

Chapter 7/7 (route `/jump-focus`), added to `apps/focus-demo` to demonstrate `jumpFocus(<direction>,
<count>, <press>)`. See [jump-focus.md](jump-focus.md) for the feature's own design rationale and
[focus-demo-app.md](focus-demo-app.md) for the rest of this app's chapters.

## The FF/RW-meaning handoff, resolved by pure composition — and a real device bug this surfaced

This is the one chapter in `apps/focus-demo` where FAST-FORWARD/REWIND mean something different
depending on what currently holds focus — every other chapter (and every other `apps/*-demo` app)
has FF/RW mean exactly one thing, always: chapter switching, via `MainScene`'s own component-level
`on:key[fastforward]`/`on:key[rewind]`. `JumpFocusDemo.thr` resolves this with layout alone, no
compiler special-casing:

- The header `Label` (title, `focusable="true" default-focus="true"`) carries **no**
  `on:key[fastforward]`/`[rewind]` of its own. While it holds focus, those two keys are never
  consumed by anything in this component's own generated `onKeyEvent`, so they fall straight
  through, unconsumed, all the way up to `MainScene`'s own component-level handler — chapter
  switching behaves exactly as it does everywhere else in the app.
- Each list is now its own component, **`JumpRowList.thr`** (extracted from this file — see
  [focus-demo-app.md](focus-demo-app.md)'s own device-found writeup for why), which binds
  `on:key[fastforward]`/`[rewind]` ONCE on its own template root (not per-row — `on:key` bubbles
  from wherever focus sits, up through the ancestor chain, so one binding covers every row).
- Pressing `up` from either list's own top row is ordinary LRUD — no special code — and lands back
  on the header (the only other focusable content above the lists), restoring ordinary
  chapter-switch behavior. **Pressing REWIND from the top row, by contrast, correctly does
  nothing** — a held jump stays confined to its own list even at the boundary, never escaping to
  the header the way a plain arrow-key press deliberately does. These look like they should behave
  identically (both "you're at the top, what happens next") but are two independent mechanisms —
  see the device-found bug below for why they used to collapse into the same behavior by accident.

This is the reference example [jump-focus.md](jump-focus.md) points to for "resolves the app-wide
FF/RW convention clash with pure composition."

## Two lists, two jump sizes — the required default+customized coverage

Per `findings/demo-app-conventions.md` rule 4:

- **`defaultList`** (`JumpRowList` with `rowCount="{12}" jumpSize="{5}"`).
- **`customList`** (`JumpRowList` with `rowCount="{6}" jumpSize="{2}"`) — deliberately shorter than
  its own jump size, so a repeated jump overshoots the boundary (a 3rd forward jump from row 1
  would want row 7, but only 6 rows exist) — this is what makes `navigateBy`'s "stop early, land on
  the last reachable row" behavior directly observable rather than merely asserted, mirroring how
  `ScrollFocusDemo` mixes irregular tiles into its own grid specifically to exercise a real edge
  case, not just the common path.

Each list writes its own `selectedLabel` field on `on:key[OK]` (`JumpRowList.thr`'s own
`selectRow`), read by the parent via `bind:selectedLabel="{state}"` into two SEPARATE readouts
(`selectedDefaultLabel`/`selectedCustomLabel`) — not one shared readout as originally designed,
since `bind:` has no built-in "which of several bound children changed most recently" ordering;
two independent readouts sidesteps that ambiguity entirely rather than needing one.

## Why `setup()`, not `load()`, and a bug this surfaced in a sibling chapter

`JumpFocusDemo.thr` populates its two row arrays inside `public function setup()` (per
GRAMMAR.md's "Router" section: "a router-mounted component gets an automatic `setup()` call... the
moment it's mounted" — the *only* function name the router auto-calls). Both `state defaultRows =
buildRows(...)`/`state customRows = buildRows(...)` are set **before** `state loaded = true`,
mirroring `ScrollFocusDemo.thr`'s own documented ordering-safety comment: `{#each}`'s reconcile
inside `{#if:destroy loaded}` fires the moment `loaded` turns true, so the backing arrays must
already be valid by then, not still `invalid`.

**While confirming this pattern, found that `ScrollFocusDemo.thr` itself (chapter 2, `/lrud-navigation`)
declared `public function load()` instead of `public function setup()`** — a name the router never
auto-calls (confirmed via `grep -rn 'callFunc("load")' packages/compiler/runtime-assets`, zero
hits). This meant chapter 2's own grid-populating code had likely never actually run on a real
device since this app's router conversion — `state tiles` stayed `invalid`, `state loaded` stayed
`false`, and the `{#if:destroy loaded}` block never constructed anything. Compiled clean (nothing
about a mismatched-but-otherwise-valid function name is a compile error), and
`findings/focus-demo-app.md`'s own "Not yet exercised" section already noted this app's router
conversion was never device-verified — which is exactly why a name mismatch like this survived
undetected. **Fixed** by renaming `load()` to `setup()` in `ScrollFocusDemo.thr` (function body
unchanged) — device-confirmed working in a later session (see [focus-demo-app.md](focus-demo-app.md)).

## Device-found bug, fixed: `jumpFocus` could escape its own list at the boundary

A user reported REWIND on the Default list's topmost row moving focus to the header instead of
doing nothing. Root cause was NOT this chapter's own layout (the FF/RW handoff design above is
correct) — it was that `navigateBy()`'s multi-hop search allowed crossing into a different
registry `owner` mid-jump, and (before the fix below) every row plus the header shared exactly ONE
owner anyway, since both lists were plain elements directly in this file's own template. Full
writeup, the two-part fix (`navigateBy()` restricted to same-owner-only hops, `JumpRowList.thr`
extracted so each list is a genuine separate owner), and why the container-`<Group>`-based on:key
simplification alone didn't catch this: [focus-demo-app.md](focus-demo-app.md) and
[jump-focus.md](jump-focus.md).

## Device verification status

All confirmed live, including two items previously flagged as untested:

- **Hold-to-repeat** — holding FAST-FORWARD/REWIND on a row accelerates correctly (same
  delay-then-speed-up curve as arrow-key repeat).
- **The short-list overshoot-avoidance landing** — a held REWIND from the Custom list's own bottom
  row (6 rows, jump size 2) lands exactly on row 1, confirmed only AFTER the bug above was fixed —
  before that fix it would have overshot into the header instead, so this guarantee was never
  actually true until this session, despite being documented as working since this chapter shipped.
- **The header/list FF-RW-meaning handoff, both directions** — entering a list via `down` correctly
  switches FF/RW to jump-mode; leaving via `up` from the top row correctly restores chapter-switch
  mode, with no stale armed repeat left over.
