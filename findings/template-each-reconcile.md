# Template blocks: `{#each}` reconcile algorithm

`{#each}`'s reconcile-pass design: the `init()`-ordering crash that forced a dict-initialization
split, dependency scanning for body bindings, the sequential-`insertChild` keyed-diff proof,
`findNode`-based item-update relocation, unconditional per-item rebinding, and the three-pass
ordering requirement. For marker parsing, the static wrapper, item-body id caching, and node-
collection iteration, see [template-each-blocks.md](template-each-blocks.md). For `{#if:destroy}`-only
runtime mechanics, see [template-conditional-blocks.md](template-conditional-blocks.md). For
cross-nesting interactions (a block nested inside `{#each}`'s body, or `{#each}` nested inside
`{#if:destroy}`), see [template-each-nesting.md](template-each-nesting.md). See
`packages/compiler/GRAMMAR.md` for the grammar itself.

## A top-level `{#each}`'s `_keys`/`_nodes`/`_items` dicts must initialize before ANY reactive field write in `init()`, not just before this block's own reconcile call — live-device-caught real crash

`brs-emitter.ts`'s `emitInitFunction` used to initialize each top-level `{#each}` block's
`_keys`/`_nodes`/`_items` dicts in the SAME loop that issues its initial `reconcile()` call, placed
late in `init()` (after derived assignments, bindings, focus registration). That ordering is correct
relative to the loop's OWN explicit `reconcile()` call — but wrong relative to a DIFFERENT,
IMPLICIT trigger: a `field: array`/`field: assocarray`'s own literal default is written via
`m.top.<field> = <literal>` inside `init()` itself (XML has no representable literal for either type
— see `reactivity-field-state-literals.md`), and that field's `onChange="..."` handler (SceneGraph's
own declarative wiring, see `xml-emitter.ts`) fires **synchronously** the instant that line runs.
If `{#each}` is bound directly to that field's own collection, its reconcile sub runs immediately,
mid-`init()`, reading `m.<id>_keys`/`m.<id>_nodes` in its remove-stale pass — but those dicts didn't
exist yet, since the (correctly-later-positioned) explicit reconcile-call loop hadn't run.

**Live-verified crash**: `apps/reactive-state-demo`'s `ArrayAndAssocArrayDemo.thr`
(`{#each tags as tag (tag)}`, `tags` a `field: array` with a 3-string literal default) crashed on a
real Roku Ultra the instant it mounted: `'Dot' Operator attempted with invalid BrightScript
Component or interface reference` at `m["$$ft_each_1_nodes"].DoesExist(ft_key)` — `m.top.tags =
[...]`'s own `onChange` fired `on_tagsChange` → the reconcile sub, ~170 lines before the dict-init
loop that was supposed to run first. Diagnosed via the debug console (port 8085) after `queryAppUi`
timed out while `queryActiveApp`/`queryAppState` stayed fast — the documented
"suspended BrightScript Debugger prompt" signature (`findings/dev-environment.md`).

**Fix**: split the single loop into two. Every top-level (and nested-inside-another-each) block's
`_keys`/`_nodes`/`_items` dicts now initialize in their own early pass, immediately after the
top-of-`init()` `findNode()` loop — before `state` defaults, before `scale field`/array/assocarray
field-default writes, before anything else that could reactively trigger a reconcile. The explicit
`reconcile()` call for each top-level block stays at its original later position (after bindings,
focus registration, derived values are all set up), now referencing dicts that already exist no
matter what triggered the first reconcile. Verified: only a `{#each}` bound directly to a
`field: array`/`field: assocarray` collection could ever hit this (a `state: array`/plain local
variable has no `onChange` handler to fire early) — grepped every other `apps/*` `.thr` file for the
same `field: array`/`assocarray` + `{#each}`-in-the-same-file combination; `ArrayAndAssocArrayDemo.thr`
was the only one, so no other shipped app was silently exposed to this. Golden fixtures
`each-basic`/`each-nested` regenerated to reflect the new (correct) line order.

## A binding inside an `{#each}` body referencing a component-wide source needed its own dependency scan — easy to miss, since the collection expression alone isn't the whole story

The first working version of `analyzeTemplateBindings`'s each-block wiring only scanned the
block's own `collectionExpression` for reactive-source dependencies (`field`/`state`/`derived`
names that should trigger a reconcile). That's insufficient: a body binding like
`text="{item.title + prefix}"`, where `prefix` is a component-wide `field`, has its own independent
reactive dependency that the collection expression alone says nothing about — without also scanning
every dynamic attribute expression inside the each-block's body (`collectEachBodyExpressions`,
element-only in this milestone) and folding *those* sources into the same
`affectedByEachSourceBlocks` registration, a `prefix` change would silently never re-render the
list even though every rendered item's text depends on it. Caught by writing a golden fixture
(`test/golden/each-basic/`) that deliberately includes exactly this mixed-dependency shape and
checking the generated `on_prefixChange` sub actually calls the reconcile sub — the bug wouldn't
have been visible from the collection-only fixture alone. There is still no narrower "just re-run
this one binding" fast path for this case — *any* source referenced anywhere in the block (the
collection or any body binding) triggers a full reconcile of the whole block, a deliberate
simplification (see the block above and the plan this feature is being built from).

## `{#each}`'s keyed diff needs no minimal-move-set computation — sequential ascending `insertChild` is provably sufficient, given one `InsertChild` API assumption

`codegen/each-block-emitter.ts`'s `emitEachReconcileSub` does **not** compute a minimal set of
moves the way a classic virtual-DOM keyed diff would — it walks the new key order `0, 1, 2, ...`
and unconditionally calls `insertChild(node, i)` for every surviving/new item, every reconcile pass.
This is correct (not just "good enough"), by a simple invariant: finalizing target indices in
ascending order never disturbs an already-finalized position (each `insertChild(node, i)` only ever
touches positions `≥ i`), so by the time the loop ends, every node sits at its correct final index
regardless of where it started. Verified by hand-tracing a remove+reorder+add scenario (`[A,B,C]` →
`[C,A,D]`, keys `1,2,3` → `3,1,4`) through the generated algorithm.

**This whole approach rests on one specific `roSGNode` API behavior**: `InsertChild(child, index)`,
when `child` is already one of the node's children, removes and re-inserts it at `index` rather
than erroring or duplicating it — i.e. it's both an insert-if-new *and* a move-if-existing
primitive. This repo already relies on `insertChild` for `{#if:destroy}`'s sibling-positioning (see
[template-conditional-blocks.md](template-conditional-blocks.md)), but only ever for a *newly created* node there, never a
repositioning of an existing one — so `{#each}`'s reconcile is the first place this codebase leans
on the "moves an existing child" half of that documented behavior.

**✅ Real-device-confirmed, 2026-08-04**, against a Roku Ultra (`apps/sample-app`'s `ScheduleList`,
driven via ECP `Rev`→`Fwd`→`Play`→`Rev`, the same session that landed the ref-field redesign
above): `shuffleDays()` (`Play`, moving the last row to the front) correctly repositioned every
surviving row via `insertChild` alone — node identity, and everything nested inside a repositioned
node (a mounted nested `{#if:destroy}` badge), survived the reorder intact, with no
duplication and no crash. `app-ui` dumps before/after confirmed exact expected ordering
(`[Monday, Tuesday, Wednesday, Day 4]` → `[Day 4, Monday, Tuesday, Wednesday]`) and correct
per-item translation. This closes out the original open question this whole feature's design
rested on — no `RemoveChildIndex`+`InsertChild` two-step fallback is needed.

## `{#each}` item updates re-locate a bound element via `findNode` against its own unique, key-suffixed id — not a cached field, even at the top level of an item

`{#if:destroy}`'s subtree construction caches an element-with-an-`id` straight into `m.<id>`
because that same generated code (the create sub) is the only place that ever needs to reference it
again, and it's a persistent `m.` slot. An `{#each}` item's *create* function
(`emitCreateItemSub`) uses fresh local/temp variables instead (see
[template-each-blocks.md](template-each-blocks.md)'s "item-body elements are never cached" section
for why), which means those references don't survive past that one function call — so the separate
*update* function (`emitUpdateItemSub`, called on a later, different reconcile pass against a key
that survived) has no construction-time reference left to reuse at all.

**This has gone through the same design history as
[template-each-nesting.md](template-each-nesting.md)'s "Nesting a block inside `{#each}`'s body"
section** — `findNode` (rejected on-device with non-unique ids) → a flat `AddFields` ref-field
per node (worked, but added generated-code weight and a `hasField()`-guard wrinkle) → back to
`findNode`, now against a genuinely unique id (the current design). This wasn't ever limited to
nested blocks — it applies equally to an ordinary bound element directly in an item's own top-level
body, since those share the identical id-uniqueness shape. `emitCreateItemSub` sets every id-bearing
node's `.id` to `uniqueIdExpr(id, keyChainParts)` (the compile-time-known literal suffixed with the
item's own reconcile key, e.g. `"row_" + ft_key`) at construction, and `emitUpdateItemSub` resolves
it again the same way: `ft_item.findNode("row_" + ft_key)`. Nothing is cached in a field, so there is
no stale-reference class of bug to reason about here — every resolution is a fresh lookup. This
still only works because GRAMMAR.md already requires an `id` on any element with a dynamic attribute
(`template/missing-id`), so there's always a real id to build the unique lookup key from. Multiple
dynamic attributes on the same element still share one `findNode` read
(`groupEachBodyBindingsByElementId` groups them, unchanged by this) rather than one lookup per
attribute. See [template-each-nesting.md](template-each-nesting.md) for the standing caveat: this
`findNode` reliance needs real-device confirmation under the new unique-id precondition before it
can be trusted as settled.

## `{#each}`'s update pass always re-runs every per-item binding, unconditionally, every reconcile — including for a key whose underlying value didn't actually change

There is no finer-grained "did this specific field of this specific item actually change" check —
`emitUpdateItemSub`'s body re-assigns every bound attribute on a surviving item's node every time
the block reconciles, even if that particular item's data is identical to last time. This matches
the "cascade unconditionally reassigns" style already used everywhere else in this codebase
(`brs-emitter.ts`'s `emitCascadeLines` doesn't diff old-vs-new values either) rather than
introducing a new pattern just for this feature — a deliberate simplification, not an oversight.

## `{#each}`'s reconcile is a three-pass algorithm, and pass order matters: remove-stale must run *before* the position pass

`emitEachReconcileSub` computes the full new key list first (pass 1), removes every key no longer
present (pass 2), and only then walks the new order creating/updating/positioning survivors (pass
3) — in that order, not interleaved. This isn't just clean code structure: `insertChild`'s target
index is relative to the node's *current* child list at the moment it's called, not the eventual
final one, so if a stale node were still present when an early position-pass `insertChild` ran, every
subsequent index in that same pass would be off by however many stale nodes hadn't been removed yet.
`test/codegen/each-block-emitter.test.ts` locks this ordering down directly (asserting the
generated `removeChild` line's string index precedes the generated `insertChild` line's), the same
kind of "don't just eyeball it, assert the ordering" discipline `test/golden/conditional-destroy-siblings/`
already established for `{#if:destroy}`'s own trickiest ordering concern.
