# `bind:` inside an `{#each}` body is a compile error

**Type:** Gap
**Area:** template
**Status:** Open

## Problem

`bind:` is rejected at compile time when it appears inside an `{#each}` block's item body. Each
`{#each}` item is a dynamically-created instance, and `bind:`'s current codegen assumes a single
static binding target wired once at parent-component compile time — it has no per-item state slot to
bind into.

## Impact

Any list UI where each row needs to report a child-field change back up to a per-row piece of state
(not just a single shared parent field) can't use `bind:` at all — the author has to hand-roll the
equivalent with an explicit field-write callback pattern instead.

## Where

- `findings/reactivity-bind.md` — documents the `{#each}` rejection.
- `findings/template-each-blocks.md` — `{#each}`'s item-body caching/instantiation model that `bind:`
  codegen would need to hook into per-item.

## Suggested fix

Would need `bind:`'s codegen to resolve its target against the *current* `{#each}` item's own state
slot rather than a single parent-level field — likely requires threading the each-item's index/key
into the generated binding wire-up, similar to how `{#each}`'s own item bodies already resolve
per-item field references. Worth scoping as "does this fit the existing reconcile architecture" before
committing to an approach — read `findings/template-each-reconcile.md` first.

## Related

- `findings/reactivity-bind.md`
- `findings/template-each-blocks.md`
- `findings/template-each-reconcile.md`
