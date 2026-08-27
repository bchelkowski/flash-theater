# `jumpFocus(<direction>, <count>, <press>)` — RowList-style multi-item focus jump

The design rationale behind this feature (`docs/features.md`'s last remaining `⬜` item, closed
out in this session) — why it's opt-in rather than automatic, why its runtime (`navigateBy`) is
hop-based rather than registry-index-based, and the hold-to-repeat wiring it shares with arrow-key
repeat. See [focus-system.md](focus-system.md)/[focus-runtime-registry.md](focus-runtime-registry.md)
for the LRUD/`navigate()` mechanics this builds on, and
[jump-focus-demo-app.md](jump-focus-demo-app.md) for `apps/focus-demo`'s own `JumpFocusDemo`
chapter.

## Why `jumpFocus` is opt-in, never an automatic fallthrough

The obvious-looking design — generate an automatic `onKeyEvent` fallthrough for
`"fastforward"`/`"rewind"` any time a component has focusable content, exactly mirroring the
existing up/down/left/right LRUD fallthrough — is wrong for this codebase, and would have been a
real regression. Every `apps/*-demo` app (13+ of them) already reserves `on:key[fastforward]`/
`on:key[rewind]` at the `<component>` level on its own root Scene for chapter-to-chapter
navigation (`findings/demo-app-conventions.md` rule 3), specifically *because* `navigate()`/
`keyToDirection()` never touch those two keys — see
[focus-router-free-and-nested-gaps.md](focus-router-free-and-nested-gaps.md) for the original
discovery of this convention (`apps/animation-demo` moved chapter-switching onto FF/RW
specifically because `navigate()` never touches that key pair). Component-level `on:key[...]` is
the **last** branch generated in `onKeyEvent`, after the LRUD fallthrough
(`codegen/brs-emitter.ts`'s `emitOnKeyEventFunction`) — so an automatic FF/RW fallthrough on any
focusable-bearing screen would consume the keypress and `return true` before it ever bubbles up to
a `MainScene`'s own chapter-switch handler, silently breaking chapter navigation on every existing
demo app the moment focus sits inside any focusable region (i.e. almost always).

**Resolution: a new reserved-keyword statement, `jumpFocus(<direction>, <count>, <press>)`**,
parsed/compiled analogously to the existing `focus(<id>)` reserved statement but called from an
**author-defined `on:key[...]` handler function** — never directly as the `on:key[...]`
attribute's own value expression, matching how every `on:key` usage in this codebase already
targets an author-defined function the compiler auto-injects `key`/`press` into
(`selectTile(key, press, tile)`, `nextChapter(key, press)`, ...). Because per-element `on:key`
branches are generated *before* both the LRUD fallthrough and the component-level fallthrough,
this is a pure opt-in: nothing changes for any existing app unless an author explicitly wires
`jumpFocus(...)` into a handler on specific elements.

**Bind it once, on the list/grid's own wrapping container — not on every row/tile.** A user
flagged this session that repeating `on:key[fastforward]="{jumpDown()}"` on every single
`{#each}`-generated row (this file's own original `JumpFocusDemo.thr`, and
`apps/focus-demo`'s `ScrollFocusDemo`/`ScrollableTileGrid`, both did exactly this) is real,
avoidable per-element boilerplate, and asked whether a declarative container-level "this captures
FF/RW for its own descendants" setting could exist, closer to how `scrollOffsetX`/`scrollOffsetY`
opts a component in once. It already does, with zero new compiler work: `on:key[...]` does **not**
require `focusable` on the same element (GRAMMAR.md's own "on:key" section — "it fires purely from
being on the currently-focused node's ancestor chain") — a single `on:key[fastforward]`/`[rewind]`
on a plain wrapping `<Group>` around the list/grid fires for WHICHEVER row/tile inside it currently
holds focus. `ScrollableTileGrid.thr` (one binding on the component's own `root`, since its entire
content is the grid) was refactored this way — confirmed live, functionally identical hop behavior,
far less repetition. The opt-in-ness this section argues for is unaffected: this is still an author
explicitly placing `on:key[fastforward]/[rewind]` somewhere, just on a container instead of a leaf.

**Important follow-up, found one session later**: a plain wrapping `<Group>` only scopes the KEY
(on:key bubbling) — it does nothing to scope `navigateBy()`'s own geometric SEARCH, which is keyed
entirely to registry `owner` (component instance), a completely unrelated mechanism. `JumpFocusDemo`
originally used one `<Group>` per list this way and it was NOT enough — see this file's own "Why
`navigateBy` is hop-based" section below and [focus-demo-app.md](focus-demo-app.md) for the real
fix that was needed (extracting each list into its own component, `JumpRowList.thr`, so it has a
genuine registry owner boundary, not just an `on:key`-bubbling one).

## Why `<press>` must be forwarded unconditionally

`jumpFocus` needs real hold-to-repeat (same `repeatTuning()` timings as arrow-key repeat, by
explicit design decision — not a separately-tuned mechanism). The automatically-generated LRUD
fallthrough gets to structurally guarantee both branches exist (`if press then ... navigate +
startRepeat ... else ... stopRepeat`) because the compiler writes that whole `if`/`else` itself.
`jumpFocus` can't get the same guarantee for free — it's called from an *author-written* function
body — so the DSL statement itself takes `<press>` as its third argument and does the branching
internally at the codegen level:
```
if <press> then
  if m.global.ft_focus.callFunc("navigateBy", <direction>, <count>) then
    m.global.ft_focus.callFunc("startRepeat", <direction>, <count>)
  end if
else
  m.global.ft_focus.callFunc("stopRepeat")
end if
```
This means `jumpFocus(...)` must be called **unconditionally** every time its enclosing handler
runs — never wrapped in the author's own `if (press) { ... }` guard, the pattern every *other*
`on:key` handler in this codebase uses (including `focus(<id>)`'s own doc examples). Wrapping it in
`if (press)` would silently drop the release-side `stopRepeat()` call, leaving a held repeat
running forever once the physical key is released. This is a real, novel usage contract this
feature introduces — called out prominently in `GRAMMAR.md`'s own `jumpFocus` section, not left
implicit.

## Why `navigateBy` is hop-based, not registry-index-based

`FlashTheaterFocusManager.brs`'s `m.registry` stores `{node, owner, isDefault}` only (`register()`)
— **no ordering/index field**. Array position is set by `Push()` order at registration time and is
not a reliable "current list order" once `{#each}` has reconciled/reordered its own items (keyed
diff can reposition existing nodes without re-registering them in a new order). This ruled out the
tempting-looking alternative — "find the focused entry's registry index, jump `±count` array
slots" — before it was ever implemented: it would silently jump to the wrong row after any
`{#each}` reorder, with no compile-time or even obviously-wrong-at-runtime signal.

Instead, `navigateBy(key, count)` repeats `bestCandidate()`'s SAME-OWNER-ONLY search `count` times.
**Originally** this called the shared `stepOnce(direction, fromEntry, fromRect)` helper `navigate()`
itself uses too, including `stepOnce()`'s own cross-owner fallback ("mid-jump cross-owner
crossing") — **found live to be a real bug** (see
[focus-demo-app.md](focus-demo-app.md)'s own device-found writeup): a multi-hop jump that ran
out of same-owner candidates partway through (e.g., already at a list's own topmost row) would
fall through to a completely different owner (a header `Label` sharing the same owner as the
rows, or a genuinely different component) and commit to THAT as its landing — one successful
cross-owner hop was enough for `landing` to stop being `invalid`, even though the jump was meant to
stay within its own list. `navigate()`'s own single-press cross-owner fallback stays intentional
and unchanged (that's exactly how "press up from a list's top row reaches the header" works) —
only `navigateBy()`'s own multi-hop loop was changed to `bestCandidate(direction, currentEntry,
currentRect, true)` directly, never falling through past the SAME owner the jump started in. The
loop still stops early — accepting fewer hops — the moment a same-owner hop finds nothing, which is
what produces the "jump to the end if fewer than N items remain" behavior with zero special-casing:
a 3-row jump from row 6 of an 8-row list simply lands on row 8, not "nowhere," a crash, or (the bug)
escaping past row 8 into whatever owns the next thing outside the list.

**`moveFocusTo()` is called exactly once, on the final landing node** — never per intermediate hop.
`moveFocusTo()` also triggers the highlight-color swap and `scrollIntoView()`, so calling it
`count` times per press would visibly flash/scroll through every intermediate stop instead of
producing one clean jump — confirmed by reading `moveFocusTo()`'s own side effects before writing
`navigateBy()`, not discovered after the fact.

## Hold-to-repeat generalization — same Timer, same tuning, one new parameter

`startRepeat(key, count = 1)` gained an optional second parameter (BrightScript's own
`param = default as type` syntax — note the default sits *between* the name and `as Type`, not
after it). Every existing single-arg call site (the auto-generated LRUD fallthrough) keeps working
byte-for-byte unchanged, implicitly passing `count = 1`. `onRepeatTimerFire()` branches on
`m.repeatCount > 1` to call `navigateBy(m.repeatKey, m.repeatCount)` instead of the plain
`navigate(m.repeatKey)`, then falls through to the exact same re-arm/acceleration/floor logic
either way — `repeatTuning()` itself was never touched. This was a deliberate scope decision, not
an oversight: a `jumpFocus`-only, separately-tuned repeat mechanism would have doubled the amount
of Timer-arming code to maintain for a difference a user would likely never perceive as
intentional.

## Reserved keyword — grammar mechanics

`jumpFocus` is a new lexer-level reserved keyword (`TokenKind.JumpFocus`, alongside `TokenKind.Focus`
in `brightscript-lexer.ts`'s `DSL_ONLY_KEYWORD_KINDS` set) — this alone makes it unusable as a
`field`/`derived`/`state`/function name for free, the same mechanism `focus`/`store`/`for`/`while`
already use (no separate "reserved name" diagnostic needed). `parseJumpFocusStatement()` mirrors
`parseFocusStatement()`'s balanced-paren capture but needs **three** independent argument
expressions instead of one — split via `findTopLevelToken()` scanning for `TokenKind.Comma`, the
exact same bracket-depth-aware technique `parseForStatement()` already uses to split its own
`<start> to <end> step <step>` header, rather than a naive linear comma scan that would mis-split a
comma nested inside one argument's own call (e.g. `jumpFocus("down", listPageSize(a, b), press)`).

**A real gap found while writing tests, not while writing the parser itself**:
`parseBlockContent`'s fallback statement-region scanner has its own separate stop-list (used to
decide where an opaque, unstructured statement chunk ends) that already needed `TokenKind.Focus`
in it — `focus-statement.test.ts` has a dedicated regression test for exactly this ("a plain
statement followed by `focus(...)` in the same block"). `TokenKind.JumpFocus` needed the identical
addition to the identical stop-list, or `jumpFocus(...)` following a plain statement in the same
block would have been silently swallowed into the *preceding* statement's own raw text instead of
being recognized as its own `JumpFocusStatement`. Caught by writing the mirrored regression test
first, before assuming the new keyword's dispatch-table entry alone was sufficient — it wasn't.

Every place `FocusStatement` is handled across the compiler (`compile.ts`'s four `usesX` scanner
functions, `analysis/scope-resolution.ts`'s scope reconstruction, `analysis/focus-state.ts`'s
`isFocused`/`isInFocusChain`-usage scan, `codegen/class-emitter.ts`'s class-body rejection) needed
a mirrored `JumpFocusStatement` case — a `grep -rn FocusStatement packages/compiler/src` before
starting was what surfaced the complete list up front, rather than discovering each site one
`tsc` error at a time.
