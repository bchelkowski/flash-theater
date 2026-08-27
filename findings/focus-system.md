# Focus / navigation system (`focusable`, `on:key`, `FlashTheaterFocusManager`)

Compile-time module responsibilities and confirmed real-device platform facts for the focus/
`on:key` navigation system. See `packages/compiler/GRAMMAR.md`'s "Focus system" and "`on:key` event
binding" sections for the grammar itself — this file is the *why*, not the *what*. This file is the
quick-reference index; the runtime design itself is split across four sibling files:

- [focus-runtime-registry.md](focus-runtime-registry.md) — the standing registry design:
  `navigate()`, `enterOwner`/`focusComponent`, the vacuum rule, `claimFocusIfVacant`, reactive focus
  state, hold-to-repeat, the bare-field-assignment gotcha, `ScrollFocusDemo`'s app isolation.
- [focus-runtime-bugs.md](focus-runtime-bugs.md) — two confirmed-live focus-loss bugs and their
  fixes: `recoverFocusFor(owner)`'s scoping rule, and the two-part `currentlyFocusedEntry()`/
  `applyPendingFocus()` postmortem.
- [focus-router-free-and-nested-gaps.md](focus-router-free-and-nested-gaps.md) — a router-free
  Scene's own default focus needing an explicit claim, `{#if:destroy}`'s generated teardown being
  blind to a nested custom component's own focusable content, and `navigate()`'s cross-owner
  fallback matching hidden toggle-mode content.
- [jump-focus.md](jump-focus.md) — `jumpFocus(<direction>, <count>, <press>)`, RowList-style
  multi-item jump: why it's opt-in rather than an automatic LRUD-style fallthrough, why its runtime
  (`navigateBy`) is hop-based rather than registry-index-based, why it's restricted to the SAME
  owner the jump started in (unlike `navigate()`'s own `stepOnce()`, which deliberately allows a
  cross-owner hop), and the hold-to-repeat wiring it shares with arrow-key repeat.

## Compile-time: which module owns which part

- **`analysis/focusable-elements.ts`** — `focusable="true"`/`"{expr}"` reuses SceneGraph's own
  native `focusable` field name (`ifSGNodeFocus`), not new DSL grammar. `collectFocusableElements`
  requires an `id` on every focusable element regardless of static/dynamic
  (`template/focusable-missing-id`). `checkNestedFocusableConflicts` rejects two elements at any
  nesting depth where **both** are *statically* `focusable="true"` (a provable, permanent ambiguity
  — both would report `IsInFocusChain() = true` simultaneously). A *dynamic* `focusable="{expr}"` on
  either side is allowed — the sanctioned parent→child focus-handoff pattern (flip the parent's
  reactive `focusable` off in the same handler that hands focus to the child) — only a literal
  `"true"` on both sides is provably wrong at compile time. `isStaticallyDefaultFocusTrue` (same
  file) is exported and reused, unchanged, by all three static-registration codegen sites
  (`brs-emitter.ts`'s top-level loop, `conditional-block-emitter.ts`, `each-block-emitter.ts`) — one
  detection, not three reimplementations. `default-focus="true"` is validated static-only, paired
  with a static `focusable="true"` on the same element (`template/default-focus-must-be-static`/
  `-requires-static-focusable`), at most one per component (`template/multiple-default-focus`) —
  same "provable ambiguity, reject at compile time" treatment as the nested-focusable check.
  **Mutually exclusive with the parent→child handoff pattern above, by construction**: the
  handoff's whole point is a dynamic `focusable="{expr}"` on the parent (`{not entered}`, say), and
  `default-focus` requires *static* `focusable="true"` on that same element — so a drill-in card's
  own collapsed root can never carry `default-focus`. Confirmed unneeded in practice
  (`apps/sample-app/src/components/RichCard/RichCard.thr`): whenever the card isn't entered, its
  `cardRoot` is the only registered focusable node in the whole component, so it's already the
  plain geometric winner on cross-owner arrow-key entry — no declared default required.
- **`analysis/key-bindings.ts`** — `on:key[Key1,Key2]={expr}` groups every raw attribute by owning
  element, validating: `template/on-key-duplicate-key` (two entries claiming the same literal key),
  `template/on-key-multiple-wildcards` (two `on:key[*]` on one element),
  `template/on-key-expression-not-call` (the expression's root isn't a single call expression),
  `template/on-key-inside-nested-each` (an `{#each}` nested inside another `{#each}` — the per-item
  `_items` companion dict is scoped to top-level each blocks only). `rewriteKeyHandlerCall`
  auto-prepends `key`/`press` before author-written args, rewriting callee and each argument
  independently through the normal identifier-rewrite path (a `private function` callee gets its
  `private_` rename for free).
- **`flash-parser/src/onKeyPreprocess.ts`** — `on:key[Key1,Key2,...]={expr}` isn't legal XML (`[`,
  `]`, `,` aren't legal `Name` characters). One deliberate exception to "the template region is
  always handed to the real, unmodified `parseXml`": a same-length, position-preserving
  transliteration pass swaps every illegal character inside an `on:key[...]` attribute-**name** span
  for a legal one before `parseXml` ever sees it (`[`/`]`/comma/whitespace → `_`, `*` → `-`; comma
  and whitespace use *different* filler characters so `on:key[OK, play]` stays distinguishable from
  a doubled-comma error once collapsed). `parser.ts`'s `classifyAttribute` reverses this.
- **`codegen/brs-emitter.ts`'s `emitOnKeyEventFunction`** — Roku only bubbles key events
  automatically *across* component boundaries, not within one component's own template, so this
  simulates bubbling with a static, compile-time-known, **deepest-first** (post-order) list of every
  `on:key`-bearing element/`{#each}` block, each gated by a live `.IsInFocusChain()` check —
  checking deepest-first and returning on the first match reproduces "bubble from the focused leaf
  up through my own on:key ancestors, stop at the first handler." An `{#each}`-scoped `on:key` has
  no static `id`/`m.<id>` slot, so it gets its own dispatch inserted at the each-block's own
  document position: iterate the block's `_nodes` dict, `findNode` each on:key-bearing element via
  the per-item id scheme (`"<id>_" + <key>`), check `IsInFocusChain()`, recover the item's raw value
  from the `_items` companion dict as a real local named after the item alias. A component with at
  least one focusable element also gets a directional-nav fallthrough (`up`/`down`/`left`/`right` →
  `FlashTheaterFocusManager.navigate(key)`, whole app-wide registry) — gated on `usesFocusSystem`
  (mirrors `usesStore`). Emitted (even with zero `on:key`/focusable content) on the app's one
  `Scene`-extending component too, for the router's back-key fallthrough — see `findings/router.md`.
  Returns `null` (no function emitted) only when there's genuinely nothing for `onKeyEvent` to do.
- **`analysis/focus-state.ts`** — `isFocused`/`isInFocusChain` are reserved, read-only names (see
  [focus-runtime-registry.md](focus-runtime-registry.md)'s "Reactive focus state"), synthesized as
  ordinary `field`s only for a component whose script or template actually mentions one.
  `checkReservedFocusStateNames` rejects a `field`/`derived`/`state`/`read`/`watch`/function using
  either name (`dsl/reserved-focus-state-name`).

## Platform facts (Roku/BrightScript, confirmed live)

- **`SetFocus()` reached via 2+ nested `callFunc` hops from the currently-executing native handler
  does not establish real `onKeyEvent` routing** — even though `IsInFocusChain()` reports `true`
  immediately and stays `true`. This is the single most important, most counter-intuitive platform
  fact this codebase depends on; every focus-granting code path in this framework is shaped around
  staying within a one-hop budget from whatever native event is currently executing (an `onKeyEvent`
  call, a Timer's own `fire` observer). A raw `node.SetFocus(true)` (zero hops) or one direct
  `callFunc` (one hop) from the live handler both work. **Observing a *native* SceneGraph field
  (e.g. `focusedChild`) and re-asserting focus from that observer does NOT reset the hop count** —
  tried three ways (a `callFunc` from the observer, an inline `SetFocus()` in the observer, and
  re-kicking `Scene.SetFocus(true)` after every navigation) and none routed real events, despite this
  reading like the "proper" fix. The only design that reliably works: never move focus from deep in
  a call chain — record the target (safe at any depth), then apply it via a *separate*, shallow
  (≤1 hop) call from the code that's actually handling the triggering event.
- **Destroying the currently-focused node does not return focus to any ancestor or the Scene** — all
  future key events silently stop routing anywhere, app-wide, until something explicitly reassigns
  focus. Roku does not implicitly reclaim it.
- **`IsInFocusChain()` is reliable for chain membership** (`true` for the focused node and every
  ancestor, `false` for an unrelated sibling) but proves nothing about real key routing — see above.
- **`node.BoundingRect()` composes only relative to the node's own immediate parent, never full
  ancestor transforms**, and **auto-expands to the union of its own box and every overflowing
  descendant's rendered extent** — both position and size. Reliable only for a genuinely childless
  leaf, or a direct child of `m.top` (where "relative to immediate parent" happens to equal "fully
  composited", which is what made the very first spike here look safe before a nested case was
  measured). Never use it for a scroll viewport window, a cross-component distance comparison, or to
  discover an unconstrained `Rectangle`'s true rendered size — read the node's own declared
  `translation`/`width`/`height` fields directly instead, and sum `translation` up to the Scene root
  by hand for cross-component comparisons (`absoluteRect()`). Corollary: **a `Rectangle`'s declared
  `width` is not authoritative if a child (typically a `Label` with no explicit width) overflows it**
  — the parent silently widens to contain it, which both looks wrong on screen and — since
  `absoluteRect()` reads `BoundingRect()` for width/height — distorts `navigate()`'s own candidate
  scoring. No framework fix; get the declared width/text right.
- **`scrollIntoView`'s own scroll-offset math must be a pure function of the target's *logical*
  (offset-independent) position**, never incremental from the current offset — an incremental
  version left the same logical tile rendered at different positions depending on navigation
  history, which made `navigate()`'s (correctly) live-position-based LRUD scoring produce different
  results for "the same" press depending on path taken to get there.
- **SceneGraph does not clip scrolled content to its viewport by default** — content past a
  scrollable region's declared bounds still renders, and remains fully real for `navigate()`'s own
  geometry, unless the author sets `clippingRect` explicitly. `clippingRect` alone only stops
  *rendering*; `navigate()`'s own cross-owner scoring needs the separate `clippedToOwnViewport` fix
  above to stop scoring off-screen content as if it were fully visible.
- **`roSGNode` reference equality via `=` throws a runtime `Type Mismatch`**, not a silent `false` —
  always use `IsSameNode()`.
- **Writing to `m.top.<name>` for a field that isn't declared in the component's own `<interface>`
  fails silently** (a non-fatal "Tried to set nonexistent field" warning, not an error) — the app
  keeps running with the value still `invalid`, and the real crash surfaces later, far from the
  cause, on the first actual read. Internal, non-interface component state belongs on plain
  `m.<name>`, never `m.top.<name>`.
- **`CreateObject("roSGNode", "Timer")` (and other SceneGraph node construction) fails silently
  before a Scene/render thread exists** — `FlashTheaterFocusManager.init()` runs from `Main.brs`'s
  globals setup, before `screen.CreateScene()`. `CreateObject` just returns `invalid`; the crash
  comes one line later setting a field on it, dropping the app into the Micro Debugger with no
  rendered output — indistinguishable from a hang from the outside. Create any such node lazily, on
  first actual use, never in `init()`.
- **`SetFocus()` called during `init()`, before `screen.show()`, does not establish a real focus
  chain** — `init()` runs synchronously inside `CreateScene()`, which returns before `Main.brs` ever
  calls `show()`. Defer any first-time focus grab to the first live `onKeyEvent`. If the focus grab
  is embedded inside other generated code (e.g. a reconcile's own `recoverFocus()` call), deferring
  the outer trigger isn't enough — find and defer the actual embedded call.
- **A physical (or ECP) key press delivers exactly two `onKeyEvent` calls, `press=true` then
  `press=false`** — never a repeating stream while held. Any generated fallthrough that reacts to a
  key must gate on `press=true` explicitly, or it double-fires (confirmed live: an unguarded LRUD
  fallthrough moved focus two hops per physical press).
- **A long `print` statement chaining many semicolon-separated expressions can parse cleanly but
  fail Roku's own on-device compilation** (`Install Failure: Compilation Failed`, no further detail).
  Ordinary string concatenation compiles and runs fine. Prefer concatenation for any debug trace
  added to a runtime asset.
- **`InstallerClient.takeScreenshot` can return byte-identical (cached/stale) images** across genuinely
  different app states — don't trust a screenshot-based check without confirming consecutive
  captures actually differ. `EcpClient.queryAppUi` (live rendered-tree XML) and a live
  `ConsoleStream` are the two mechanisms confirmed to give real, non-cached signal.
- **Any function added to a runtime asset's `.brs` must also be added to its `.xml`
  `<interface>`, or `callFunc` on it silently no-ops** (no crash, no error — the call site continues
  normally, the target function's body simply never runs). Check this first whenever a `callFunc`
  call appears to "do nothing."
- **ECP's `Info` keypress never reaches a `.thr` component's `onKeyEvent` as `"info"` at all** on
  this device/firmware — confirmed with focus placed directly on the same component declaring
  `on:key[info]` (no cross-component bubbling involved, ruling that out as the cause). Likely
  intercepted at the OS/firmware level before app delivery, the same general family as `Rev`/`Fwd`
  not matching their own `onKeyEvent` strings (`"rewind"`/`"fastforward"`) elsewhere in this file —
  but unlike that pair, no working `onKeyEvent` string was found for `Info` at all. `Backspace`
  (ECP name matches its `onKeyEvent` string directly) is confirmed working and used instead in
  `apps/timers-demo`'s `FocusedTeardownDemo.thr` (migrated from `apps/async-demo`, same shape) and
  `apps/animation-demo`'s `DestroyCustomDemo.thr`.
