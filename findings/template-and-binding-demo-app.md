# template-and-binding — `apps/template-and-binding-demo` coverage

A brand-new, from-a-topic-not-a-migration chapter app (no `apps/async-demo`-style predecessor to
split off of, unlike `apps/task-manager-demo`/`apps/requests-demo`/`apps/timers-demo`) — the
`template-and-binding` doc-nav topic had no dedicated app before this session (see
`findings/demo-app-conventions.md`'s "Roadmap"). Router-mounted from the start, following
`apps/animation-demo`'s `MainScene.thr` skeleton (`router.setRouting([...])`, one
`<FlashTheaterRouterOutlet>`, REWIND/FAST-FORWARD chapter advance) — 4 chapters, one per mechanism
in `packages/compiler/GRAMMAR.md`'s "Template"/"Conditional rendering"/"Keyed list rendering"/
"Two-way binding (`bind:`)" sections and `site/src/pages/docs/template-and-binding.astro`.

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`), all 4 chapters, default AND
customized examples, with two real bugs found and fixed. See "Live-device results" below.

## Chapters

- **`/attributes`** (`AttributesDemo.thr`) — static vs dynamic attributes, and automatic
  `id`-based node-ref caching. Default: `toggleBox` flips ONE dynamic attribute (color+text)
  per press. Customized: `cascadeBox` flips THREE dynamic attributes (color/width/text) from a
  SINGLE press — the "one write, several bindings react" cascade — and a "Read cached ref" button
  reads `m.cascadeBox.width` directly inside a `' flash-theater:raw` passthrough block, proving the
  auto-cache (no `findNode` call exists anywhere in this component's source).
- **`/if-toggle-vs-destroy`** (`IfToggleVsDestroyDemo.thr`) — `{#if}` (toggle mode) vs
  `{#if:destroy}` (construct/destroy mode), side by side. Each panel wraps its own
  `StepCounter.thr` instance (a tiny reusable child with its own `state count`). Toggling a panel
  off and back on demonstrates the real, structural difference concretely rather than just
  asserting it in prose: the LEFT (`{#if}`) counter's `count` survives the hide/show cycle (the
  node is never destroyed, only hidden); the RIGHT (`{#if:destroy}`) counter's `count` resets to 0
  every time (a fresh instance is constructed from scratch). A third, always-focusable
  `belowButton` sits underneath both panels to show that `navigate()`'s hidden-candidate skip (see
  GRAMMAR.md's "`{#if}` (toggle)" entry) already lets LRUD reach through either panel once hidden —
  the remaining difference between the two modes is registry persistence + internal state, not LRUD
  reachability, which both already get right.
- **`/each`** (`EachDemo.thr`) — a plain array-backed list of 5 labeled rows (mirrors
  `ScheduleList.thr`'s array-of-AA/`renumbered()` shape). "Reverse order" and "Rotate order" both
  re-trigger the `{#each}` against the SAME backing items, only reordered. Each row's `color` is
  assigned once, by the row's own identity (`makeRow`), and never recomputed from position — a
  reorder visibly carries each row's own color along with it, proving the keyed diff repositions
  existing nodes rather than destroying and rebuilding them. A code comment (not a live demo) notes
  the SceneGraph-node-as-collection option per GRAMMAR.md, since a live second collection shape
  would dilute the one lesson this chapter needs to land clearly.
- **`/bind`** (`BindDemo.thr`) — a single built-in `TextEditBox` demonstrates BOTH directions at
  once, on two different fields: `bind:text={typedText}` pulls the user's typed text OUT into a
  `state`, mirrored live by a separate label; `hintText="{hintPrompt}"` is an ordinary dynamic
  attribute pushing a value IN, cycled by its own button. Making both directions visible on the
  SAME element (rather than two separate elements) is what makes the one-directional-only
  distinction concrete instead of just asserted in a comment, per the task's own framing.

## Real gotchas hit this session

- **`scale field` used as an intermediate for a further `scale`-statement computation
  double-scales.** `EachDemo.thr`'s `renumbered()` needed a per-row `y` computed from a base
  top-offset plus an index-dependent step (`rowsTopY + i * rowStep`), scaled once via the `scale y
  = ...` statement form (the same pattern `ScheduleList.thr`'s own `renumbered()` uses for
  `i * 40`). The first draft declared `rowsTopY`/`rowStep` as `scale field` — wrong: a `scale
  field`'s own default is already scaled once in `init()` (see GRAMMAR.md's "scale" section,
  "Scaling only ever fires where `scale` is explicitly written"), so feeding that already-scaled
  value into a second `scale <local> = <expr>` statement would scale it AGAIN. Fixed by declaring
  those two as plain (unscaled) `field`s — the raw design-space constants — and letting the single
  `scale y = rowsTopY + i * rowStep` statement do the only actual scaling. `rowX` (used directly in
  a template `translation="{[rowX, row.y]}"` binding, with no further scale statement in the path)
  correctly stays a `scale field`. This is a real, easy-to-hit trap whenever a `scale`d field feeds
  into a *second* scale operation rather than being read directly — caught immediately at review,
  not at compile time (the compiler has no way to detect double-scaling; see the "scale
  watch`/`scale read` double-scaling risk" entry already documented in GRAMMAR.md's "Known
  limitations" for the analogous store case).
- **BrightScript has no escaped-quote syntax inside a DSL string literal the way the task's own
  gotcha list implied might work.** A first draft of `AttributesDemo.thr` wrote
  `state cachedInfoText: string = "Focus \"Read cached ref\" and press OK"` — `\"` is not a
  recognized escape in this DSL's (or BrightScript's) string grammar; BrightScript's own convention
  is a doubled `""` to embed a literal quote inside a string, and even that would need care inside
  an XML-attribute-embedded `{expr}` (a doubled `""` reads fine as a *script-level* string default,
  but the safest fix — and the one used here — is simply avoiding embedded quotes in any
  user-facing string literal entirely: reworded to "Focus the Read cached ref button and press OK".
  Confirmed via a real compile error (`ERROR ... [dsl/invalid-state] ... Expected: state <name>:
  <Type> = <literal>` — the escaped quote broke the literal's own tokenization enough that the
  parser reported it as not-a-literal, not as an escape-syntax error specifically).
- **A custom child component gets positioned by its own `translation` attribute from the parent,
  even inside `{#if}`/`{#if:destroy}`.** `StepCounter.thr` (used by `/if-toggle-vs-destroy`) needs
  no `translation` field of its own — `<component>` with no `extends=` defaults to `Group` (see
  GRAMMAR.md's "`<component>`" section), which already has a `translation` field, so
  `<StepCounter id="toggleCounter" translation="{[leftColumnX, panelY]}" />` works exactly like
  `DestroyCustomDemo.thr`'s own `<TickReadout id="cardTicker" translation="{...}" />` usage inside
  a `{#if:destroy}` block — confirmed by that existing, already-compiling example before writing
  this one, not rediscovered from scratch.
- **`itemAlias`/element-`id` collision inside `{#each}` is real but narrower than GRAMMAR.md's own
  wording first suggested.** GRAMMAR.md's "Keyed list rendering" section says an `{#each}` alias
  colliding with "an existing... element-id name **anywhere in the component**" is a compile error
  (`template/each-alias-collision`) — but `apps/focus-demo/src/components/ScrollFocusDemo/
  ScrollFocusDemo.thr` uses `{#each tiles as tile (tile.id)}` immediately followed by
  `<Rectangle id="tile" ...>` (alias and id both literally `"tile"`), and that file compiles today.
  Not independently re-verified by this session (no reason to — `EachDemo.thr` sidesteps the
  question entirely by using a different alias/id pair, `row`/`rowCard`, matching
  `ScheduleList.thr`'s own `day`/`row` split instead), but worth flagging as a real discrepancy
  between the doc's own wording and at least one already-shipped, compiling example, for whoever
  next touches that diagnostic's implementation or wording.

## Live-device results — two real bugs found and fixed

- **`/attributes`**: `toggleBox`'s single-attribute flip and `cascadeBox`'s three-attribute cascade
  both confirmed; "Read cached ref" confirmed `m.cascadeBox.width` resolves correctly via the raw
  passthrough, no `findNode`. **Real bug found and fixed**: `cascadeBox` was completely unreachable
  via `Down`/`Up` LRUD from `toggleBox`/`infoButton` — its default label text
  ("Cascade — press OK: color+width+text all change together") overflowed its own narrow width so
  far (922px vs. a 450px box) that `FlashTheaterFocusManager`'s `BoundingRect()`-based candidate
  scoring computed a badly-skewed center point, letting the farther, non-overflowing `infoButton`
  out-score it. See `findings/focus-runtime-bugs.md`'s new entry for the scoring mechanics. Fixed by
  shortening the default label text to roughly fit its own box; re-verified live: `Down`/`Up` both
  correctly reach `cascadeBox` now. (Also gave `cascadeWidth` its own `scale state` — a real, if not
  the root-cause, scale-consistency fix, since its default literal was the one unscaled dimension in
  an otherwise fully-scaled chapter.)
- **`/if-toggle-vs-destroy`**: state-survival contrast confirmed exactly as designed — the toggle
  (`{#if}`) counter kept its count (6, after two full off/on cycles and repeated increments) across
  every hide/show; the destroy (`{#if:destroy}`) counter reset to 0 on every reappearance. `Down`
  from either toggle button reaches `belowButton` correctly once both panels are hidden again.
  **Real bug found and fixed**: with a panel VISIBLE, its own nested `StepCounter` was completely
  unreachable via `Down`/`Up` — `navigate()`'s same-owner candidate pass runs before the cross-owner
  one and wins unconditionally on any match, so `belowButton` (same owner as the toggle button)
  always beat the counter (a different owner — `StepCounter` is its own component instance) no
  matter how much closer the counter geometrically sat. The `.thr`'s own top comment had asserted
  this was "already gotten right" without ever having been live-verified — it wasn't. Fixed by
  having `toggleLeft()`/`toggleRight()` call `focus("toggleCounter")`/`focus("destroyCounter")` the
  moment their panel becomes visible (GRAMMAR.md's documented "nested custom component's own root"
  form) — re-verified live: pressing the toggle button now lands focus directly inside the counter,
  ready for `OK` to increment immediately.
- **`/each`**: "Reverse order" and "Rotate order" both confirmed — every row's own color and label
  traveled WITH its identity across a full reversal (row4/red/"Row E" moved from bottom to top,
  etc.), confirming keyed reposition, not destroy+rebuild. Row selection (`OK` on a focused row)
  confirmed correctly reporting `Selected: Row B (id=row1)`. Focus-follows-a-reordered-row was not
  independently re-tested (triggering a reorder requires focus to already be on a button, not a
  row) but is a direct consequence of the already-confirmed "same node, just repositioned" fact —
  Roku's own focus flag lives on the node itself, wherever the keyed diff moves it.
- **`/bind`**: `bind:text` confirmed pulling typed input out to `state typedText` live (typed "Hi",
  echo label updated). The push direction (`hintText` as a plain dynamic attribute) exercises the
  same mechanism chapter 1 already proved working under a much heavier cascade — not independently
  re-observed visually here (Roku's `TextEditBox` only renders its `hintText` placeholder while
  empty, and the box already had real typed content by the time this was checked), but no error and
  no reason to doubt it given the precedent.
- **One unreproduced anomaly, noted for a future session, not filed as a confirmed bug**: once,
  after a long chain of manual navigation through chapters 2 and 3 (nested-component `focus()`
  entry/exit, an `{#each}` reorder, several chapter switches), `queryAppUi` on arrival at `/bind`
  showed NOTHING focused anywhere in the whole app — not even the `<screen>` element itself — with
  the app otherwise alive and responsive (`queryActiveApp`/`queryAppState` fine, no console error).
  A careful replay of a comparable navigation sequence from a fresh cold start did not reproduce it.
  ⚠️ Unconfirmed — could not pin down a repro; flagging in case it resurfaces.

Root `npm test`/`npm run lint`/`npm run build:roku` re-confirmed green after both fixes (app-source
only — no `packages/*` change this time).

## Device-found and fixed 2026-08-25: every chapter duplicated `MainScene`'s own hint label

**Confirmed live via a real screenshot** (not just `query/sgnodes`, which would have missed this —
both labels existed and rendered normally, just overlapping/stacked): `AttributesDemo`,
`IfToggleVsDestroyDemo`, `EachDemo`, and `BindDemo` each declared their OWN hardcoded `<Label
id="hint" text="Chapter N/4 — REWIND / FAST-FORWARD to switch, BACK to return" .../>` at some
per-chapter translation, duplicating `MainScene.thr`'s own reactive `derived hintText` label (which
already renders the identical info, correctly, at the bottom of every chapter — see every other
demo app's own `MainScene.thr` for the same convention). The screen showed the exact same sentence
twice, at two different y-positions. Unlike `apps/focus-demo`'s stale "N/6" numbering bug (a content
mismatch), this was a straight content duplication with no drift — but still visibly wrong.

**Fix**: removed the redundant `<Label id="hint">` (and its now-unused `hintTranslation` field) from
all four chapter files — `MainScene`'s own hint is the single source of truth for chapter position,
matching every other `apps/*-demo` app's own convention. Re-verified live: only one "Chapter 1/4..."
line renders now, at the bottom.

## Device-found and fixed 2026-08-26: `BindDemo.thr`'s own title showed a literal `-&gt;` instead of `->`

Same root cause as three other apps' own titles that session — see
[template-attribute-value-escaping.md](template-attribute-value-escaping.md) for the general rule.
`BindDemo.thr`'s title had manually pre-escaped `->` as `-&gt;`; fixed by writing the raw `->`.
