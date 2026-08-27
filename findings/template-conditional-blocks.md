# Template blocks: `{#if:destroy}` core mechanics

`{#if:destroy}`'s own runtime design: the synthetic `Group` wrapper, the sibling-insertion-index
expression, the template root treated as a container, guarding a binding nested inside a destroy
subtree, and the `blocks` array's own ordering — everything specific to `{#if:destroy}` that
doesn't involve nesting against `{#each}`. For the shared block-marker parsing architecture and the
unified `analyzeTemplateBlocks` walk, see [template-blocks.md](template-blocks.md). For
`{#each}`-only mechanics, see [template-each-blocks.md](template-each-blocks.md). For cross-nesting
interactions (a block nested inside `{#each}`'s body, or `{#each}` nested inside `{#if:destroy}`),
see [template-each-nesting.md](template-each-nesting.md). See `packages/compiler/GRAMMAR.md` for
the grammar itself.

## `{#if:destroy}` compiles to a synthetic `Group`, not per-child creation — collapses "how many nodes to track" from N to 1

Every `{#if}`/`{#if:destroy}` block — regardless of how many real elements it contains — compiles
to exactly one synthetic `Group` wrapper (`packages/compiler/src/codegen/conditional-block-emitter.ts`'s
`analyzeConditionalBlocks`, id `ft_if_N`). This was a real design fork, not the obvious choice: an
earlier draft considered creating/destroying each of a destroy-mode block's top-level children
independently, which would have meant tracking a separate sibling-insertion-index and a separate
mount-state check *per child* instead of once per block. Wrapping in one `Group` collapses this to
"exactly one node to insert/remove, at exactly one position, regardless of how many real elements
are inside" — SceneGraph's own `visible`/child-tree containment already does the rest (a `Group`'s
children are only reachable through it, so removing/inserting the `Group` moves the whole subtree
atomically). The same wrapper is used for toggle mode too, for a different reason: it gives
`{#if}` a single node to bind `visible` on, so multiple sibling elements can be conditionally shown
together with **no author-written container element required** — the wrapper is compiler-inserted,
invisible in DSL source.

**Detach-and-reattach (keep the same `roSGNode` instance alive, just remove/re-append it) was
considered and rejected for destroy mode.** It would be cheaper (no reconstruction), but it
wouldn't reset the subtree's own state on remount — which is the entire reason `:destroy` is a
different feature from `:if` (a bare visibility toggle already gets you the cheap always-present
behavior). `codegen/conditional-block-emitter.ts`'s generated `<componentName>__create_<id>`/
`<componentName>__destroy_<id>` subs really do construct from scratch and let the old node become garbage once nulled — every
`(re)`-creation sees a clean slate, matching the `:destroy` name's own implication.

## `{#if:destroy}`'s sibling-insertion index must be a *runtime* expression, never a compile-time constant

`appendChild` always appends last; reattaching a destroy-mode block that isn't its parent's last
child would silently reorder it after every currently-present later sibling if `appendChild` were
used unconditionally. The fix (`emitConditionalCreateSub`) computes the insertion index as a short
runtime `ft_idx = ft_idx + 1` sequence, one line per preceding sibling under the same parent —
unconditional for an ordinary/toggle-mode sibling (always present), guarded by
`if m["$$<siblingId>"] <> invalid then` for another destroy-mode sibling (bracket-`$$`-accessed —
a preceding sibling here is always another destroy-mode block's own compiler-synthesized id, never a
DSL-author id). **The index cannot be a
compile-time-known integer** even though the *positions* are compile-time-known — a preceding
destroy-mode sibling's own mount state is a runtime fact, so "how many nodes precede me right now"
genuinely varies at runtime depending on which other destroy-mode siblings happen to be attached at
that moment. `test/golden/conditional-destroy-siblings/` locks this down with an exact `.brs` diff
(three siblings, the middle one `{#if:destroy}`) specifically because this is the easiest part of
the feature to get subtly wrong and have it look correct on a single-sibling fixture.

## The template's own root element was never treated as a container — a real, previously-undetected bug that put a root-level destroy-block *behind* root in paint order, confirmed on a real device

`analyzeTemplateBlocks`'s walk used to start as `walk(root.children, null, null, null)` — treating
the template's outermost element as if it weren't a container at all, so a `{#if:destroy}` block
that's a *direct child of root* (a very common shape — `<Rectangle id="root">{#if:destroy
cond}...{/if}</Rectangle>`) got `containerId = null` (→ `m.top`), with its sibling-insertion-index
computed only from *other children of root*, never counting root itself. Since XML always emits
exactly one static top-level child (root), `m.top` already has root at index 0 by the time any
destroy-block create sub runs — so `m.top.insertChild(m["$$ft_if_1"], ft_idx)` with an undercounted
`ft_idx` landed the block *before* root, not after it. Concretely, for `ScheduleList.thr` (its
`{#if:destroy hasLoaded}` is root's *only* child, zero preceding siblings → `ft_idx = 0`), this
put the each-block wrapper at `m.top`'s index 0 and pushed root to index 1 — root (an opaque
background `Rectangle`) then painted *on top of* the rows, hiding them completely, even though
`ScheduleList__reconcile_each_1` had already built them correctly (confirmed via an ECP
`/query/app-ui` dump showing the right text/colors/nesting — the SceneGraph tree was entirely
correct, only the paint order was wrong). A screenshot alone wouldn't have told us why; the
introspection dump was what pinned it down to child ordering specifically.

This was latent in every *existing* fixture, not something the each-nesting-state redesign
introduced: `conditional-destroy` and `conditional-destroy-siblings` both happen to have exactly
one *other* preceding sibling inside root before their destroy-block, which coincidentally produces
the same index root already occupies at `m.top` — masking the bug for both. `ScheduleList` was the
first real case with zero preceding siblings, and only real-device visual inspection (not the
golden text-diff suite, which only ever asserted exact-match against output that was itself
already wrong) caught it.

**The fix**: `resolveContainerId(root)` — the exact same "does this element need a synthesized
parent id" logic every other container already runs (`conditionalParentElementId` when it has a
direct destroy-mode child and no author-given id) — now also runs for the template's root element
itself, and `walk(root.children, resolveContainerId(root), null, null)` seeds the walk with that as
the starting `containerId` instead of a hardcoded `null`. A root-level destroy-block now correctly
attaches to `m.root` (or a synthesized parent id), with its existing sibling-index computation
(unchanged) now operating against the *right* reference frame — root's own children, which is
exactly where it's actually inserted. `collectStaticallyPresentIds` needed the matching fix
(`root.id ?? analysis.syntheticParentIds.get(root)`, not just `root.id`) so a *synthesized* root
parent id also gets `findNode`-cached in `init()` — otherwise `m.<syntheticRootId>` would be
`invalid` when a create sub tries to use it.

## A binding nested inside a `{#if:destroy}` subtree needs *different* treatment in `init()` vs. in its cascade — exclude vs. guard, not the same filter reused twice

Two real correctness traps, easy to conflate into "just skip it" but requiring opposite fixes:

1. **`emitInitFunction`'s unconditional loops must *exclude*** anything living inside a
   destroy-mode subtree (both the `findNode`-based id-caching loop and `bindings.all`'s initial
   attribute-value loop) — the target node doesn't exist yet unless the block's initial condition
   is already true, in which case its own generated create sub already sets these values as part of
   construction. Filtering here is a hard *exclusion*: there is nothing to guard, the assignment
   would target a node that plain doesn't exist.
2. **`emitCascadeLines`'s ordinary binding-assignment lines must instead be *guarded*** at runtime
   (`if m.<nearestDestroyAncestor> <> invalid then ... end if`,
   `conditional-block-emitter.ts`'s `wrapWithNearestDestroyGuard`) — a change to an unrelated
   reactive source can fire this cascade while the destroy-mode subtree is currently torn down, and
   unlike the `init()` case, that's a valid, expected runtime state, not something to statically
   exclude. Guarding produces a correct no-op; excluding would silently drop a real update that
   should apply once the subtree is later reconstructed with a fresh initial value anyway (which it
   is — the create sub sets it), so guarding vs. excluding both end up correct here, but excluding
   is simpler to reason about and was picked for `init()` specifically because `init()` only ever
   runs once, right when mount state is still fully known.

**"Nearest" (not every) enclosing destroy ancestor is sufficient** for the guard, which is easy to
assume needs walking the full ancestor chain and doesn't: a destroy-mode block's own teardown sub
nulls every id in its subtree transitively, *including a nested block's own id* — so if the nearest
ancestor is un-mounted, every ancestor above it is un-mounted too, by construction. Checking only
the nearest one (`ConditionalBlockAnalysis.nearestDestroyAncestorById`, computed once during the
same top-down walk that assigns block ids) is both correct and avoids the guard clause growing with
nesting depth. The same guard machinery is reused, not duplicated, for a *nested destroy block's
own* create/destroy cascade check — this was a bug caught during manual verification, not part of
the original design draft: a block nested inside another destroy-mode block can have its own
condition change (independent of the outer block's condition) while the outer block is currently
torn down, and calling `<invalid>.appendChild(...)` inside the inner block's own create sub would
crash. `emitConditionalBlockCascadeCheck` wraps a block's own create/destroy check in the exact
same `wrapWithNearestDestroyGuard` an ordinary binding uses — verified live: `toggleInner()` in a
manual nested-destroy repro correctly wraps its `ft_if_2` create/destroy check in
`if m["$$ft_if_1"] <> invalid then ... end if`.

## The `blocks` array order is post-order relative to nesting, not strict document order — and no consumer needs it to be

`ConditionalBlockAnalysis.blocks` (conditional-block-emitter.ts) pushes a destroy-mode block only
after recursing into its children (needed to compute its `nestedIds` for teardown), so a nested
block's own entry appears *before* the entry of whichever block directly contains it — sibling
blocks at the same nesting level still appear in ordinary document order relative to each other.
Worth knowing before writing a test or a new consumer that assumes array order mirrors source
order: index into the array by content (`.find(b => b.expression === ...)`), not by position, once
nesting is involved — `test/codegen/conditional-block-emitter.test.ts` originally got this wrong
and had to be fixed to search by content instead of asserting `blocks[0]`/`blocks[1]` directly.
