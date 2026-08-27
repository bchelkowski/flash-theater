# `{#each}` has no built-in loop-index variable

**Type:** Gap
**Area:** template
**Status:** Open

## Problem

`{#each}` provides no built-in per-item index or loop-position variable. An item body that needs to
know its own position (e.g. for zebra-striping, "item 3 of 10" labels, or numbering) has to bake that
position into the data model itself before rendering — there's no `{#each item, i in list}`-style
syntax.

## Impact

Explicitly flagged in `findings/template-each-blocks.md` as "a real, currently-unaddressed usability
gap" — not merely a design choice with a clean workaround. `apps/sample-app`'s `ScheduleList.thr` has
to pre-compute a `renumbered()` pass over its own data just to give each row an index field before
handing it to `{#each}`.

## Where

- `findings/template-each-blocks.md` — the gap statement and its rationale (always-static wrapper
  design, item-body caching rules).
- `packages/compiler/src/codegen/` — `{#each}` codegen, wherever the per-item scope/binding is
  established (would need to inject an index binding alongside the item's own field bindings).
- `apps/sample-app/.../ScheduleList.thr` (or wherever `renumbered()` lives) — the current workaround.

## Suggested fix

Add an optional index-binding form to `{#each}`'s grammar (e.g. `{#each item, index in list}`) that
injects a plain numeric local scoped to the item body, populated during the existing reconcile pass
(`findings/template-each-reconcile.md`) — the reconcile algorithm already tracks each item's position
when doing the keyed diff, so this may be a matter of exposing a value the runtime already computes
rather than adding new tracking. Confirm the keyed-diff/reposition logic keeps the index correct when
items are reordered before shipping — a stale index would be worse than none.

## Related

- `findings/template-each-blocks.md`
- `findings/template-each-reconcile.md`
