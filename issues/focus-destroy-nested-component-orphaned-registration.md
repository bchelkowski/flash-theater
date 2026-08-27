# `{#if:destroy}` never unregisters a nested custom component's own focusable content

**Type:** Bug
**Area:** focus-system
**Status:** Open

## Problem

When an `{#if:destroy}` block's condition flips to false, its generated teardown code removes the
block's synthetic wrapper Group (`removeChild`) but never walks into a nested custom component
inside that block to call `unregister()` on *that component's own* `focusable` elements. The
top-level node the block directly owns gets cleaned up; anything a child component registered on its
own gets orphaned in `FlashTheaterFocusManager`'s registry.

## Impact

A stale registry entry can outlive the subtree that produced it. Depending on what fills that slot
next, `navigate()`'s LRUD search can attempt to focus a destroyed node (silently a no-op on Roku, but
the registry stays polluted), or a differently-shaped replacement component can accidentally match a
stale registration. No compiler diagnostic or safe fallback exists for this today.

## Where

- `findings/focus-router-free-and-nested-gaps.md` — documents this as gap #2, including the specific
  line (teardown does `removeChild` but never `unregister()`).
- `findings/template-conditional-blocks.md` — `{#if:destroy}`'s teardown codegen.
- `findings/focus-runtime-registry.md` — registry `register()`/`unregister()` contract.

## Suggested fix

Teardown codegen for `{#if:destroy}` needs to recursively unregister focusable descendants before
`removeChild`, not just the block's own directly-owned node. The cleanest approach is likely a
runtime helper (`ft_unregisterFocusableSubtree(node)`) called from the generated teardown path that
walks `node`'s children looking for anything the focus manager tracks, mirroring how the `ft_unmount`
hook already walks a subtree for timer cleanup (see `findings/component-unmount-hook.md`) — that
hook's existing traversal code is a reasonable model to extend rather than writing a new one.

## Related

- `findings/focus-router-free-and-nested-gaps.md`
- `findings/component-unmount-hook.md`
- [animation-toggle-mode-focus-leak.md](animation-toggle-mode-focus-leak.md) — same underlying
  mechanism gap (a hide/teardown path that doesn't call `unregister()`), different trigger
  (`{#if:destroy}` teardown here vs. a no-transition `{#if}` toggle there)
