# A no-transition (or `in:`-only) toggle-mode block's focusable content isn't unregistered when hidden

**Type:** Bug
**Area:** animation
**Status:** Open

## Problem

`FlashTheaterFocusManager`'s registry has no unregister step tied to a plain `{#if}` (non-destroy)
toggle going invisible — a real fix now exists, but it's scoped **only** to blocks that declare an
`out:` animation: for those, every focusable element in the subtree is unregistered (and
`recoverFocusFor` called) at the moment the exit animation starts. A block with **no** transition at
all, or an **`in:`-only** transition (still an instant hide, no exit animation to hook), keeps the
old behavior unchanged — its focusable content is never unregistered when the block hides.

Note this is narrower than it used to be: `navigate()`'s own candidate scoring was separately fixed
to check real visibility for every candidate (see the now-`Fixed`
[focus-navigate-cross-owner-hidden-match.md](focus-navigate-cross-owner-hidden-match.md)), so a
D-pad press can no longer actually land on this stale content — the visibility check filters it out
at search time regardless of registry state.

## Impact

With the `navigate()` fix in place, this is now a **registry-hygiene issue, not a focus-landing
issue**: a no-transition/`in:`-only toggle-mode block's focusable elements stay registered
indefinitely across repeated show/hide cycles, growing `FlashTheaterFocusManager`'s registry with
entries that can never be selected but are never pruned either — a slow memory/bookkeeping leak
rather than a visible navigation bug.

## Where

- `findings/animation-scale-and-destroy-targeting.md` — "Focus-safety" section: documents the
  `out:`-animation fix in detail and explicitly scopes it away from the no-transition/`in:`-only
  case, calling that remainder a "KNOWN, un-fixed gap."
- `findings/focus-router-free-and-nested-gaps.md` — the `navigate()` visibility fix that narrowed
  this issue's impact to registry hygiene.

## Suggested fix

Generalize the `out:`-animation fix's own trigger: instead of hooking unregister into
animation-start specifically, a plain `{#if}` toggle's generated code needs its own
"this subtree just became inactive" signal to the focus manager, independent of whether an
animation is attached at all — so animated and non-animated toggles share one unregister/reclaim
path. This is the same underlying mechanism gap as
[focus-destroy-nested-component-orphaned-registration.md](focus-destroy-nested-component-orphaned-registration.md)
(both are "a hide/teardown path that doesn't call `unregister()`") — worth designing one fix that
covers both call sites rather than two narrow ones.

## Related

- `findings/animation-scale-and-destroy-targeting.md`
- `findings/focus-router-free-and-nested-gaps.md`
- [focus-navigate-cross-owner-hidden-match.md](focus-navigate-cross-owner-hidden-match.md) (Fixed —
  the related bug that used to make this visible to `navigate()`)
- [focus-destroy-nested-component-orphaned-registration.md](focus-destroy-nested-component-orphaned-registration.md)
