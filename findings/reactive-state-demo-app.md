# reactive-state — `apps/reactive-state-demo` coverage

A brand-new, from-the-topic chapter app (not a migration — no prior `apps/*` app covered this
topic as its own dedicated deep-dive; the mechanic previously only appeared embedded in
`apps/sample-app`'s `FavoriteCounter.thr`/`Shell.thr`). Built the same way
`apps/task-manager-demo` was (see [task-manager-demo-app.md](task-manager-demo-app.md)): straight
against `GRAMMAR.md`'s own "Declarations in the `<script>` region" section and
`site/src/pages/docs/reactive-state.astro`, not migrated from an existing flat-screen app. See
[demo-app-conventions.md](demo-app-conventions.md) for the router+scale/chapter-app convention this
instantiates, and [reactivity-state.md](reactivity-state.md) for the underlying design this app
demonstrates.

`MainScene` is router-mounted (`router.setRouting`, `<FlashTheaterRouterOutlet>`,
REWIND/FAST-FORWARD chapter advance — same skeleton as `apps/animation-demo`/`apps/task-manager-demo`),
4 chapters: `/field-and-derived`, `/state`, `/global-store`, `/array-and-assocarray-defaults`.
`designResolution: "hd"` (1280x720 baseline), `ui_resolutions=hd,fhd` in the manifest.

## Chapters

- **`/field-and-derived`** — `FieldAndDerivedDemo.thr`. Default: `itemLabel`/`itemCount`/
  `unitPrice` (three `field`s) drive `totalPrice`/`summaryLabel` (two `derived`s) — mirrors
  `FavoriteCounter.thr`'s own `favoritesLabel` shape. **Customized addition**: `isBulkOrder`
  (a comparison, `itemCount > 10`) feeding `bulkOrderLabel` (a same-script function call) forms a
  derived CHAIN the checker can fully verify end to end, contrasted directly against
  `shoutingItemLabel` (`UCase(itemLabel)`) — a BrightScript builtin call, which
  `analysis/derived-type-check.ts` can never statically resolve, so it infers `unknown` and never
  flags the declared `string` type against it. A `field`'s value can only ever be set from OUTSIDE
  a component (there's no DSL syntax to mutate one from inside its own code — see
  `reactivity-state.md`'s shadowing entry) — since this is a standalone router-mounted screen with
  no parent ever setting an attribute on it, every field here simply stays at its compile-time
  default for the whole session. The only interactive control (a button toggling a `state` note)
  deliberately never touches a field, to avoid implying otherwise.
- **`/state`** — `StateDemo.thr`. Default: `state counter = counter + 1` (via an `increment()`
  button) triggers the same reactive cascade a `field` write does — `doubledLabel` (a `derived`
  reading `counter`) recomputes automatically. **Customized addition**: the real, documented
  field-shadowing gotcha. `baseCount` is a declared `field` (default `100`, never mutated).
  `demoShadowing()` executes a bare `baseCount = baseCount + 1` (no `state` keyword) — this
  compiles to an ordinary BrightScript local assignment, declaring a brand-new local that shadows
  the field for the rest of that function only. The chapter proves it live: pressing the button
  updates `shadowResultText` (a `state`, showing the LOCAL's new value) while `baseCountLabel` (a
  `derived` reading the actual `field`) never changes, no matter how many times the button is
  pressed.
- **`/global-store`** — `GlobalStoreDemo.thr`. Puts a `watch` and a `read` on the SAME store key
  (`demoCount`) side by side — `demoCountWatch`/`demoCountRead`, feeding `watchLabel`/`readLabel`.
  Pressing "Bump store(demoCount)" (`store(demoCount) = demoCountWatch + 1`) immediately
  recomputes `watchLabel`; `readLabel` was assigned once in this component's generated `init()`
  and never changes again, however many times the button is pressed afterward — the clearest
  possible live demonstration of the one-time-snapshot-vs-reactive split, since both readouts are
  on screen at once, reading the exact same key. `demoCount` is seeded to `0` by `MainScene.thr`'s
  own `setup()`, once, before any chapter (including this one) ever reads it — see "Store-seed-
  before-first-read ordering" below.
- **`/array-and-assocarray-defaults`** — `ArrayAndAssocArrayDemo.thr`. Default: `tags` (a
  `field: array` with a 3-string literal default) rendered via `{#each tags as tag (tag)}` inside
  a `<LayoutGroup>` (see "LayoutGroup for `{#each}` rows" below). **Customized addition**: `config`
  (a `field: assocarray`, 3 keys) read into three separate derived labels
  (`config.retries`/`config.timeout`/`config.label`, all plain dot-access into the field), plus
  `items` (a `state: array`, empty-literal default) populated at runtime via `addItem()` — the
  common "start empty, populate via a function body" shape. Demonstrates the real, documented
  asymmetry: `field`'s array/assocarray default is cross-checked against its declared `<Type>` at
  compile time (`dsl/field-default-type-mismatch` on a mismatch), while `state`'s declared type
  stays decorative — only the literal's own CONTENTS are validated (every leaf must itself be a
  literal, `dsl/state-default-not-literal` otherwise), never cross-checked against the annotation
  itself.

## Real gotchas hit while building this app

- **No backslash-escaped quotes in a string literal — BrightScript has no such escape at all.**
  First draft of `StateDemo.thr`'s `shadowResultText` default used
  `"(press \"Demonstrate shadowing\" below to see)"`, which the compiler rejected as
  `dsl/invalid-state` ("Invalid state declaration. Expected: `state <name>: <Type> = <literal>`")
  — the backslash sequence isn't a literal string boundary in this DSL's (or BrightScript's) own
  grammar at all, so the parser simply stopped seeing a valid string literal partway through and
  the whole declaration failed to match. Real BrightScript has no escape sequence for an embedded
  quote inside a string literal (the ordinary workaround in real BrightScript is a doubled `""`,
  but this DSL's own vendored string-literal grammar wasn't tested against that either) — simplest
  fix, and the one used here: don't put a quote character inside a DSL string literal at all,
  reword instead. This is a sharper version of the already-known "no single-quoted strings" gotcha
  — the safe rule is broader: avoid embedding ANY `"` character inside a DSL string literal, not
  just avoid single quotes as an alternative.
- **`{#each}` has no built-in index variable, so per-row layout needs either per-item positioning
  data or a layout container.** `tags`/`items` are both plain string arrays with no `x`/`y` of
  their own (unlike `apps/sample-app`'s `CardsScreen.thr`, whose items are AA objects carrying
  their own precomputed `x`/`y`). Wrapping each `{#each}` block in a `<LayoutGroup>` (confirmed
  usable this way — `apps/sample-app`'s `ScheduleDateMenuItem.thr` already uses one, just never
  around an `{#each}`) auto-stacks the rendered rows vertically with zero per-item position
  bookkeeping — no compiler feature needed, an ordinary SceneGraph layout node solves it.
- **`store(...)`'s write RHS must reference the `watch` binding's bare name, never `store(<path>)`
  inline again** — confirmed against `Shell.thr`'s own `store(favoriteCount) = favoriteCount + 1`
  (the `favoriteCount` on the right is the `watch` binding, not a second `store(favoriteCount)`
  call) before writing `GlobalStoreDemo.thr`'s own `store(demoCount) = demoCountWatch + 1`.
  `GRAMMAR.md`'s "Global store" section states this precisely (`store(<path>)` only ever appears
  in exactly the `read`/`watch`/write-statement positions, never inline inside an arbitrary
  expression) but a comment elsewhere in the codebase (`FavoriteCounter.thr`'s own top-of-file
  prose, describing the mechanism in shorthand) reads as if the inline form were used — it isn't;
  that comment is describing the CONCEPT, not literal syntax. Worth flagging in case a future
  reader copies the prose instead of the code.
- **Store-seed-before-first-read ordering, once again confirmed necessary**: `demoCount` must be
  written by `MainScene.thr`'s own `setup()` (`store(demoCount) = 0`) before the router ever
  constructs `GlobalStoreDemo` (whose `init()` immediately does a `read`/`watch` off that key) —
  otherwise the first read/watch would resolve against a key the `FlashTheaterStore` singleton
  doesn't have yet. Same pattern `apps/sample-app`'s `MainScene.thr` already established for
  `favoriteCount`; this app is the second confirmed real-world case of it.

## Live-device-confirmed — all 4 chapters, two real bugs found and fixed

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`). All 4 chapters walked, default
AND customized examples.

- **`/field-and-derived`**: `itemLabel`/`itemCount`/`unitPrice` → `totalPrice`/`summaryLabel`
  confirmed rendering correctly (`"Widgets" x 3 = $ 7.5`); the `isBulkOrder`/`bulkOrderLabel` chain
  and the `UCase(...)`-via-`shoutingItemLabel` contrast both confirmed; the type-inference note
  toggle button confirmed.
- **`/state`**: `state counter`/`derived doubledLabel` reactive cascade confirmed (3 presses →
  counter=3, doubled=6). **Real bug found and fixed**: the field-shadowing demo's own
  `baseCount = baseCount + 1` crashed live with `Use of uninitialized variable` — real BrightScript
  scoping determines local-vs-outer-scope by statically scanning the WHOLE function for assignment
  targets, so once `baseCount` is assigned anywhere in `demoShadowing()`, EVERY bare `baseCount`
  read in it (including the assignment's own right-hand side) resolves to that not-yet-initialized
  local, never the field. This is a demo-authoring bug, not a compiler bug — the DSL deliberately
  never special-cases this (see `findings/reactivity-state.md`'s shadowing section, now updated with
  this exact crash). Fixed by assigning a fresh literal (`baseCount = 999`) instead of
  self-referencing; re-verified live: field stays `100` across repeated presses, local readout shows
  `999`, no crash.
- **`/global-store`**: the `read`-vs-`watch` split confirmed directly — 3 presses of "Bump
  store(demoCount)" moved `watch` from `0` to `3` while `read` stayed frozen at its mount-time
  snapshot (`0`), both visible on screen at once.
- **`/array-and-assocarray-defaults`**: **real bug found and fixed — a genuine compiler bug, not
  app-source.** `tags` (`{#each tags as tag (tag)}`, `tags` a `field: array` literal default)
  crashed on mount: `'Dot' Operator attempted with invalid BrightScript Component or interface
  reference`. Root cause: `{#each}`'s own `_keys`/`_nodes` dicts were initialized too late in
  generated `init()` — a `field: array`/`assocarray`'s literal default is written via
  `m.top.<field> = <literal>` (XML can't represent either type), and that write's `onChange` handler
  fires synchronously, reconciling the `{#each}` before its own bookkeeping dicts existed. Fixed in
  `packages/compiler/src/codegen/brs-emitter.ts` — dict initialization now happens immediately after
  the `findNode()` loop, before any field-default write; the explicit initial `reconcile()` call
  stays at its original later position. See `findings/template-each-reconcile.md`'s new entry for the
  full writeup, including confirmation no other shipped app had the same `field: array`/`assocarray`
  + `{#each}`-in-the-same-file combination. Re-verified live after the fix: all 3 `tags` rows render
  correctly inside the `<LayoutGroup>` (`reactive`/`state`/`demo`), `config.retries`/`config.timeout`/
  `config.label` all read correctly, and pressing "Add item to state items" twice correctly grows
  the `items` `{#each}` list (a `state: array`, unaffected by the bug — only a `field`-backed
  collection can trigger the early `onChange`).

Root `npm test`/`npm run lint`/`npm run build:roku` re-confirmed green after the compiler fix
(golden fixtures `each-basic`/`each-nested` regenerated to reflect the corrected `init()` line
order — see `findings/template-each-reconcile.md`).
