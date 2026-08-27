# `navigate()`'s cross-owner fallback can match hidden toggle-mode content

**Type:** Bug
**Area:** focus-system
**Status:** Fixed — `bestCandidate()` in `FlashTheaterFocusManager.brs` now gates every candidate
(same-owner and cross-owner alike) on a new `isGenuinelyVisible(node)` check that walks the node up
through every ancestor to the Scene root, checking each one's own `visible` field. See
`findings/focus-router-free-and-nested-gaps.md`'s "Live-verified, and since fixed" note.

## Problem

`FlashTheaterFocusManager`'s `navigate()` has a cross-owner geometric fallback (used when LRUD
search doesn't find a candidate within the current owner) that considers every registered focusable
node app-wide. It doesn't check whether a candidate is inside a currently-hidden `{#if}` (toggle-mode)
block — a node can stay registered while its subtree is invisible (`{#if}` toggles visibility, it
doesn't destroy/unregister), so the fallback can propose focus to something the user can't see.

## Impact

A D-pad press can jump focus onto an off-screen/hidden element in a different component, with no
visible feedback that focus moved, effectively "swallowing" the next several key presses until the
user navigates back out. Most likely to surface in apps with several toggle-mode panels stacked in
the same screen region.

## Where

- `findings/focus-router-free-and-nested-gaps.md` — documents this as gap #3.
- `findings/focus-runtime-registry.md` — `navigate()`'s LRUD search + cross-owner fallback mechanics.
- `findings/template-conditional-blocks.md` — confirms `{#if}` toggles visibility only, node stays
  registered.

## Suggested fix

The cross-owner fallback candidate filter needs a visibility check (e.g. `node.visible` walked up
through ancestors, or a cheap "is any ancestor an inactive `{#if}` wrapper" flag maintained by the
conditional-block runtime) before considering a node a valid target. The `{#if}` wrapper already
knows its own active/inactive state at toggle time — the simplest fix is likely tagging the wrapper
node with a field the focus manager can check during candidate filtering, rather than a full
visibility tree walk on every `navigate()` call (which would be a real perf cost on a busy screen).

## Related

- `findings/focus-router-free-and-nested-gaps.md`
- `findings/template-conditional-blocks.md`
