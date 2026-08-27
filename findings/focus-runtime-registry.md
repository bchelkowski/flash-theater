# Focus system — runtime registry (`FlashTheaterFocusManager`)

The standing-registry design behind `focusable`/`on:key`/`FlashTheaterFocusManager` — `navigate()`'s
two structural rules, `enterOwner`/`focusComponent` resolution, the vacuum rule, the
`claimFocusIfVacant` escape hatch, reactive focus state, hold-to-repeat, the bare-field-assignment
gotcha, and `ScrollFocusDemo`'s app isolation. See `packages/compiler/GRAMMAR.md`'s "Focus system"
and "`on:key` event binding" sections for the grammar itself, and
[focus-system.md](focus-system.md) for compile-time module ownership and confirmed platform facts.
Sibling files: [focus-runtime-bugs.md](focus-runtime-bugs.md) (two confirmed-live focus-loss bugs),
[focus-router-free-and-nested-gaps.md](focus-router-free-and-nested-gaps.md) (router-free default
focus, `{#if:destroy}`'s blind spot on nested components, and a hidden-toggle-content LRUD leak).

**`FlashTheaterFocusManager` is a single flat, cross-component, whole-app registry**, `{node,
owner}` pairs (`owner` = the registering component instance's own `m.top`) — not scoped per
component, by design: an app-wide LRUD tab order is the point. Comparisons always use
`IsSameNode()`, never `=` (see [focus-system.md](focus-system.md)'s Platform facts). Two structural
rules follow from this:

- **`navigate(direction)` searches the currently-focused element's own owner first**, and only
  widens to the whole app-wide registry once that pass finds nothing (a genuine boundary — no more
  of this component's own content in that direction). Without this, a component with a large or
  irregular focusable area (a scrollable grid) would leak focus to a closer-but-unrelated neighbor
  before exhausting its own content. The cross-owner pass scores against the *whole exiting
  component's* bounding box (`ownerBoundingRect`, a union over all its registered nodes) — except
  for a **scrollable** owner (`HasField("scrollOffsetX"/"Y")`), where the focused leaf's own rect is
  used instead: a scrollable owner's full virtual content extent is a bad proxy for "where the user
  is exiting from", but a small static component's bounding box genuinely is its visible footprint.
  **The cross-owner pass's own owner check must require a genuinely *different* `owner`, not merely
  skip the one already-focused node** — `bestCandidate(direction, focusedEntry, focusedRect,
  sameOwnerOnly)` gates every candidate on
  `entry.owner.IsSameNode(focusedEntry.owner) = sameOwnerOnly`, so pass 2 (`sameOwnerOnly=false`)
  only ever considers a *different* owner's registrants. Confirmed live as a real, previously-shipped
  bug when this was instead `(not sameOwnerOnly or entry.owner.IsSameNode(focusedEntry.owner))`
  (always true when `sameOwnerOnly=false`): a same-owner sibling the same-owner pass had already
  correctly rejected could still be scored in pass 2 and — since its own primary-axis distance from
  a *leaf's* position is typically much smaller than any genuinely different owner's — out-score a
  real cross-owner candidate whenever the exiting component has any internal x/y spread among its
  own registrants. `crossOwnerBest` then belonged to the SAME owner already being exited,
  `enterOwner()` re-entered that same owner, and its first branch (`lastFocusedFor`) resolved back
  to the node already focused (just remembered there via `rememberLastFocused` on the very move that
  put focus there) — a "successful" `navigate()` that visibly did nothing and consumed the key press.
  Reported live as "Left does nothing" leaving `apps/sample-app`'s `TaskDemoScreen` (a real 2-column
  button grid — a same-x-column candidate always beat Shell's sidebar) and leaving a
  `ScheduleList` day row (multiple rows/`searchBox` at slightly different auto-sized x-centers, same
  mechanism one owner deeper).
- **A candidate counts as being "in" a direction only if it genuinely overlaps the focused box on
  the perpendicular axis** (any amount) — the standard spatial-navigation rule (same one CSS Spatial
  Navigation and most game-UI focus engines use), not a same-sign/cone test and never a
  same-sign-but-non-overlapping fallback. A direction with no genuinely-overlapping candidate leaves
  focus exactly where it was — a real boundary, not a case needing a best-guess move. A cross-owner
  candidate is additionally clipped to its own scroll ancestor's *current* viewport window before
  scoring (`clippedToOwnViewport`) — a same-owner candidate is exempt (a not-yet-visible neighbor
  within one scrollable component is the ordinary case scroll-into-view exists for).

**Which specific element gets focus on cross-component entry is that component's own concern, not a
fresh geometric pick.** `enterOwner(owner, fallbackNode)` — used by `navigate()`'s cross-owner pass,
`focus(<id>)`/`focusComponent()`'s owner-target case, and LRUD cross-owner entry alike — prefers, in
order: the owner's own most-recently-focused element (`lastFocusedByOwner`, updated in
`moveFocusTo()`; a stale/unregistered memory is discarded, not returned) → its declared
`default-focus="true"` element → the caller's own fallback (typically the geometric winner, or
`firstRegistrantOfOwner` for a non-directional entry). This is what makes leaving and re-entering a
component resume where you left off, and what makes `default-focus` mean the same thing regardless
of how focus arrives (router mount, `focus(<id>)`, or an arrow key from a neighboring component).

**`focusComponent(target)` is polymorphic**: `indexOfNode(target) >= 0` means `target` is already a
registered leaf (focus it directly); otherwise `target` is treated as a component's own root and
resolved via `enterOwner`. `focus(<id>)` compiles to
`m.global.ft_focus.callFunc("focusComponent", m.top.findNode(<id>))` — resolution happens at the
**call site**, via `m.top.findNode` (SceneGraph's own subtree-scoped search), not inside the runtime
singleton. This is deliberate, not an oversight: an earlier version resolved scene-wide
(`m.sceneRef.findNode`), letting any component reach into any unrelated branch of the app — rejected
as a real encapsulation break (nothing else in the DSL lets one component reach an arbitrary,
unrelated branch of the tree; `bind:`/props are strictly parent↔child). **Reaching a sibling still
has to go through the parent**: the child sets its own outbound `field`, the parent observes it
(`bind:` if a compiled `.thr` component, hand-wired `ObserveFieldScoped` if hand-composed — see
`apps/focus-demo`'s `MainScene.brs`) and calls `focus(<siblingId>)`/`focusComponent(<ownChildNode>)`
itself, valid because the sibling **is** the parent's own child.

**The vacuum rule — automatically-chosen focus is applied only when nothing currently holds focus;
it never takes focus away.** One rule covers all four mechanisms that can establish focus
automatically: router mount, `{#if:destroy}`/`{#each}` recovery after removing the focused node, and
app start (the degenerate vacuum — nothing has ever held focus). An **explicit** `focus(<id>)` (or
`claimFocusIfVacant`, below) bypasses it, since the author asked by name. Two designs were tried and
rejected before this one — "the newly mounted screen's default always gets focus" and "the deepest
mounted outlet's proposal always wins" — both break the canonical TV layout (a persistent side menu
beside content that reloads as you move through it): either would rip focus out of the menu on
every single move. `default-focus="true"` does not mean "grab focus when I appear" — it means "when
focus *enters* this component and it has no remembered last focus, land here"; a screen mounted
behind the user's back keeps its default in reserve until focus genuinely arrives. "Deepest outlet
wins" survives only as a tie-break once a vacuum exists (first-writer-wins in `proposeFocusTarget`,
correct because nested outlets construct inside-out), not as what decides *whether* to take focus.

**`claimFocusIfVacant(owner)` is the explicit escape hatch for content that appears well after the
ordinary mount/reconcile cascade already settled** — the shape neither the vacuum rule nor
`recoverFocusFor` (see [focus-runtime-bugs.md](focus-runtime-bugs.md)) cover, since both are tied to
a specific synchronous event (a mount, a teardown). The compiler has no async primitive (no fetch,
no promise, no timer statement), so "well after" here means a hand-wired `roSGNode` Timer. `if
currentlyFocused() <> invalid then return; target = firstRegistrantOfOwner(owner); if target <>
invalid then moveFocusTo(target)` — claims only into a genuine, still-existing vacuum, so it
composes with the vacuum rule automatically (if the user moved focus elsewhere by the time the
content appears, it does nothing). **Deliberately not wired automatically into
`{#if:destroy}`/`{#each}` create paths** — that would reintroduce the exact `recoverFocusFor`
ordering bug (a nested child's synchronous reconcile claiming a vacuum an enclosing,
still-constructing component's own not-yet-run entry decision should have had first refusal on).
Calling it from a genuinely async callback is safe specifically because every synchronous mount
decision has already run to completion by the time such a callback fires. See
`apps/sample-app/src/components/SplashScreen.thr` (a genuine vacuum — the app's own true first route)
and `LoadingDemoScreen.thr` (reachable from `Shell`'s sidebar menu, which already holds focus) for
both directions, verified live.

**Reactive focus state (`isFocused`/`isInFocusChain`) is derived from one value, one writer.** The
focus manager holds a single `m.focusedNode`, written only by `moveFocusTo()`, which recomputes both
fields for every subscribing component in one pass on every real focus move — two components
reporting `isFocused = true` simultaneously is unrepresentable, not merely prevented by a check.
Deliberately **not** derived from native `hasFocus()`/`IsInFocusChain()` (see
[focus-system.md](focus-system.md)'s Platform facts: those can report focus on a node real key
events never reach). `isFocused` = this component owns the focused element; `isInFocusChain` = the
focused element is anywhere in its subtree, nested child components included (a persistent-chrome
wrapper reads `isInFocusChain = true`, `isFocused = false` while the screen it mounts holds focus).
Synthesized as ordinary `field`s — `derived`, template bindings, and `{#if}` all work through the
existing reactive machinery, zero new grammar.

**Hold-to-repeat directional navigation** is `FlashTheaterFocusManager`'s own responsibility, not an
`onKeyEvent` primitive — Roku's `onKeyEvent` does not auto-repeat while a button stays held (see
[focus-system.md](focus-system.md)'s Platform facts). A single `Timer` (`m.repeatTimer`, created
lazily on first use — see Platform facts) drives it: `startRepeat(key)` (called after a `press=true`
`navigate()` succeeds) arms an initial delay; each `fire` performs one more `navigate(key)` then
re-arms with a **shorter** duration (down to a floor), producing acceleration — deliberately not the
Timer's own `repeat=true` (fixed rate). Stops itself the moment `navigate()` returns `false` (no
further candidate). Tuning (`repeatTuning()`) is fixed, not DSL-exposed: 0.45s initial delay, 0.2s
starting interval, ×0.85 acceleration, 0.06s floor — reasonable first-guess defaults, not
comfort-tuned against a physical remote.

**Bare `<field> = <value>` inside a function body is silently wrong — always write `m.top.<field> =
<value>`.** Real BrightScript scope rules mean a bare `x = expr` declares `x` as a local; this
compiler's own scope reconstruction agrees, so (a) `elideUnusedLocalAssignments` can drop the whole
statement as dead code if nothing reads `x` again in the same function, and (b) even once elision is
taught to recognize a declared-binding target as never-dead, identifier resolution still sees a
"local" and never rewrites it to `m.top.<field>` — either way, the real SceneGraph field is never
written. The explicit `m.top.<field> = <value>` form works correctly today and is required; giving
field writes their own dedicated grammar production (mirroring `state`'s `StateAssignment`) would be
the complete fix and hasn't been taken on.

**`ScrollFocusDemo` lives in its own app (`apps/focus-demo`), not `apps/sample-app`** — the app-wide
registry means any two focusable regions whose screen areas come close enough are LRUD candidates
for each other, confirmed live as real cross-component focus leakage once a large grid and an
unrelated list shared a screen. Keep any future large/irregular focus-system demo in its own app, or
deliberately verify live (`queryAppUi` + `EcpClient`) that LRUD candidates never cross a boundary
you care about — reasoning about layout alone isn't enough; overlap is about rendered screen
position, not visual grouping.
