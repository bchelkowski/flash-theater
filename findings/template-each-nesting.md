# Template blocks: cross-nesting interactions (`{#each}` × `{#if}`/`{#if:destroy}`)

What happens when the two block kinds nest against each other — a `{#if}`/`{#if:destroy}`/`{#each}`
nested inside an `{#each}`'s own body, and the reverse (`{#each}` nested inside `{#if:destroy}`).
The two directions are **not symmetric in implementation difficulty** — see below. For `{#each}`-only
mechanics (no nesting involved), see [template-each-blocks.md](template-each-blocks.md). For
`{#if:destroy}`-only mechanics, see [template-conditional-blocks.md](template-conditional-blocks.md).
For the shared block-marker parsing and the unified `analyzeTemplateBlocks` walk that makes nesting
between the two kinds possible at all, see [template-blocks.md](template-blocks.md). See
`packages/compiler/GRAMMAR.md` for the grammar itself.

## Nesting a block *inside* `{#each}`'s body — per-item state via a unique, item-key-suffixed `id` resolved by `findNode`

A `{#if}`/`{#if:destroy}`/`{#each}` nested inside an `{#each}`'s own body is genuinely different
from the reverse direction (`{#each}` inside `{#if:destroy}`, see below): the enclosing each really
does render N independent copies of whatever's nested inside it, so a single flat `m.<id>` slot (the
convention every other block kind uses) can't represent N simultaneous instances of the same
bookkeeping.

**Current design (the fourth tried — rejected: 1) an AA nested on the item's own node
(`ft_item.ft_state.ft_if_2 = ...`), which didn't reliably persist across a later read on real
hardware; 2) `findNode(id)` with the same literal id reused across sibling items, which on real
hardware sometimes returned a *different* sibling's node than the one actually under that item's
own subtree; 3) a flat `AddFields`-based ref-field per node, which worked but added real
generated-code weight per item — see git history for the full narrative of each)**: give every
dynamically-created node inside an `{#each}` a genuinely unique id — the compile-time-known literal
plus the item's own reconcile key (`uniqueIdExpr` in `each-block-emitter.ts`, e.g. `"row_" +
ft_key`) — and resolve it via `<itemRoot>.findNode(<uniqueId>)` at the point of use, no cached field
of any kind. No two dynamically-created siblings ever share an id, which is the precondition
design 2's real-device failure never actually tested (that test ran with every sibling sharing one
literal id, by design at the time) — the working theory is design 2's failure was itself an id
-collision artifact, not a genuine `findNode`-doesn't-respect-subtree-scoping bug.

- A nested destroy-mode `{#if:destroy}`'s mount check is `<itemRoot>.findNode(<uniqueId>) <>
  invalid`, resolved fresh every access.
- No `_parent` reference is stored — a nested destroy-block's parent is always statically known at
  compile time, resolved the same way via `syntheticParentIds`/`conditionalParentElementId`.
- A nested `{#each}`'s own `_keys`/`_nodes` (a real key→node map) lives in the **enclosing
  component's own `m` scope**, not on any node — keyed by the chain of enclosing items' reconcile
  keys (`m["$$<id>_keys"][<outerKey>]`, one more `[...]` per nesting level — see the `$$`-prefix
  naming section above). Since this lives on `m`, it isn't garbage-collected when an item is
  removed — the outer each's stale-removal pass explicitly `.Delete()`s every transitively-nested
  each's dict entry for a removed key (`EachBlock.nestedEachIds`, collected by recursing into a
  nested each's own body too — unlike the destroy-mode-only `collectNestedIds`, which doesn't).

**Not yet confirmed on a real device under load-bearing conditions** (a keyed-list reorder cycle, a
nested-destroy-`{#if}` toggle cycle) as of this writing — this file has been burned twice already
by "compiles and runs in a simulator" not implying "correct on real hardware" for exactly this kind
of node-reference/`findNode` claim (the rejected designs 1 and 2 above). Update this note once that
device test runs.

**A real bug this design sidesteps**: `roSGNode.AddFields()` silently fails to register a field
whose *initial* value is `invalid` (no error on the `AddFields` call itself — the failure only
surfaces as a runtime warning on the *next* write to that field, several lines away from the real
cause). Only relevant if a future design ever caches a node field again — the current design never
calls `AddFields` for per-item state at all.

A nested block's create/update logic is generated *inline* into the enclosing each's own
`emitItemConstruct`/`emitItemUpdate`, not as separately-named subs — BrightScript has no closures,
so inlining sidesteps threading every enclosing item alias (`{#each day.events as event (event.id)}`
needs `day` in scope) through as explicit parameters, and composes naturally to arbitrary nesting
depth via recursion (a shared `emitInlineEachDiff` helper handles a nested `{#each}`'s own
three-pass diff).

Update semantics for a nested destroy-mode block match the top-level idempotent create/destroy check
(create only on false→true, destroy only on true→false, update in place otherwise when already
mounted and staying mounted) — not a simpler always-tear-down-and-maybe-rebuild rule, since
generating unconditional destroy-then-rebuild code on every reconcile pass, even when nothing
changed, is real wasted work every deployed app would pay for on every list update.

Generated plumbing function names use `<componentName>__<name>` (`naming.ts`'s
`conditionalCreateSubName`/`conditionalDestroySubName`/`eachReconcileSubName`/
`eachCreateItemSubName`/`eachUpdateItemSubName`/`eachKeyNormalizerName`), not a flat `ft_`-prefix —
deliberately scoped narrowly to just these six (not `private_`/`on_<field>Change`/theme-variant
naming, a separate already-working scheme) since it's what makes generated code traceable by hand
(`ScheduleList__reconcile_each_1` reads as "the reconcile sub for ScheduleList's each block 1" vs.
`ft_reconcile_ft_each_1` as noise). Node/element ids (`ft_if_N`, `ft_each_N`, `ft_parent_N`) stay
`ft_`-prefixed and, for anything dynamically created inside an `{#each}` item, get the item's own
reconcile key suffixed too.

**An id-collision bug was caught and fixed while first wiring this up**: an early version
re-derived a nested block's own id by re-running `analyzeTemplateBlocks` on just the enclosing
each's own `children`, which restarted that analysis's id counters from zero on every call — a
nested `{#each}` could end up assigned the *same* id (`ft_each_1`) as its own top-level enclosing
`{#each}`, wrong once ids are meant to be globally unique. Fix: never re-derive ids for a subtree —
thread through the *same* `ifBlockIdByNode`/`eachBlockIdByNode` map instances the one canonical,
whole-template `analyzeTemplateBlocks(root)` call already produced (`each-block-emitter.ts`'s
`buildItemEmitContext`). `test/golden/each-nested/` locks this down directly (asserts the nested
each's own id, `ft_each_2`, never collides with its enclosing each's `ft_each_1`) — this bug was
invisible from a single-each-only fixture and only showed up once a genuinely nested case compiled.

## `{#each}` nested inside `{#if:destroy}` needs none of the per-item-state design that a block nested *inside* `{#each}` needs — the two nesting directions are not symmetric in difficulty

An `{#each}` block itself is never duplicated by nesting it inside a `{#if:destroy}` block — a
destroy-mode block is still exactly 0-or-1 instances, so the each's own flat `m.<id>`/`m.<id>_keys`/
`m.<id>_nodes` state works completely unchanged; it just doesn't exist until the ancestor's create
sub runs, and gets nulled (all three slots) on the ancestor's teardown, exactly like an ordinary
nested `{#if:destroy}` block's own id already does. `conditional-block-emitter.ts`'s
`emitSubtreeConstruction` gained a real `'each'` branch (previously a "not yet supported" stub) that
constructs the wrapper, initializes the two state AAs, and calls the reconcile sub once — mirroring
`brs-emitter.ts`'s own top-level each-block init sequence almost line-for-line. `nestedEachIds`
(a new, separate field on `ConditionalBlock`, alongside the existing `nestedIds`) exists specifically
because tearing down a nested each needs **three** null-outs (`m.<id>`/`_keys`/`_nodes`), not the
one `nestedIds`' plain `m.<id> = invalid` already handles — conflating the two lists would have
under-nulled every nested each on teardown.

This is the *reverse* of the direction that actually needs the novel per-item-state design (a block
nested *inside* an `{#each}`'s body, where the enclosing each genuinely does render N copies of
whatever's nested in it — see the "Nesting a block *inside* `{#each}`'s body"
section above for that design, implemented in a later pass than this one). Concretely, both
directions were originally assumed to need comparable new machinery; in practice only one did —
worth remembering the two directions of a "block A nested inside block B" feature are not
automatically symmetric in implementation cost just because they're symmetric in DSL surface
syntax. (This finding predates the forward-direction implementation — kept as-is since the
comparison itself, and the reasoning about *why* the reverse direction is cheap, is still exactly
the useful/non-obvious part.)
