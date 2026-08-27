# `bind:` is one-directional only despite the "two-way" name

**Type:** Gap
**Area:** template
**Status:** Open

## Problem

`bind:<field>={<state>}` only propagates child-field → parent-state; there's no mechanism for the
parent's `state` change to flow back down into the child's own field after the initial mount. The
feature is referred to informally as "two-way binding" in some docs/commit history, but the actual
contract is one-directional-only.

## Impact

Authors reaching for `bind:` expecting genuine two-way sync (parent writes `state`, child's field
updates) get silently no-op behavior on the parent-to-child direction — the child simply never sees
the update. `site/src/pages/docs/template-and-binding.astro` documents the real contract, but the
naming mismatch (see `findings/reactivity-bind.md`) is a recurring source of confusion.

## Where

- `findings/reactivity-bind.md` — the one-directional design and why.
- `GRAMMAR.md` — "Two-way binding (`bind:`)" section (the name itself is arguably the bug here).
- `packages/compiler/src/codegen/template-bindings.ts` — where `bind:` codegen lives.

## Suggested fix

Two independent tracks: (1) a naming fix — rename the feature/docs to something accurate
("child-to-parent binding" or similar) is the cheapest true fix for the confusion, no code change;
(2) a real two-way implementation would need the parent's `state` write to also push down into the
child's field via `SetField`/observer wiring — check whether the child's field is already observed by
the parent (it must be, to make the current one-directional flow work) to see if the reverse wire is a
small addition or requires new plumbing.

## Related

- `findings/reactivity-bind.md`
- `apps/template-and-binding-demo`'s `/bind` chapter
