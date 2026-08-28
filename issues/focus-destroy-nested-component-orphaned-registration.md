# `{#if:destroy}` never unregisters a nested custom component's own focusable content

**Type:** Bug
**Area:** focus-system
**Status:** Fixed — `emitConditionalDestroySub`/`emitFocusPrepareLines`
(`codegen/conditional-block-emitter.ts`) now emit an unconditional
`focusUnregisterSubtreeCall(blockRef, 'm.top')` (`codegen/shared-emit.ts`) before `removeChild`, and
`recoverFocusFor(m.top)` is unconditional too (previously gated on the compiler's own template scan
finding a plain focusable id). `unregisterSubtree` (now `unregisterSubtree(root, recoveryOwner)`,
`runtime-assets/FocusManager/FlashTheaterFocusManager.brs`) walks the focus manager's own registry
by live ownership (`GetParent()` ancestry), not compile-time template visibility, so it reaches a
nested custom component's own focusable content without needing any new cross-component analysis —
and, critically, when the CURRENTLY FOCUSED node is one of the entries it removes, it rewrites
`m.focusLostFromOwner` to `recoveryOwner` (the enclosing component's own `m.top`) WHILE the subtree
is still attached, so the later, deliberately-deferred `recoverFocusFor(m.top)` call (which runs
AFTER `removeChild`, by design — see that sub's own doc comment) can still succeed via a trivial
`IsSameNode()` compare instead of needing to re-walk a tree link `removeChild` already cut. Live
device-confirmed both halves (unregister AND focus recovery) — see the "Live-confirmed" sections
below. See `findings/focus-router-free-and-nested-gaps.md`'s updated writeup.

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

**As actually implemented**: no new runtime helper was needed — `FlashTheaterFocusManager.brs`
already had exactly this walk in `unregisterSubtree` (built for `FlashTheaterRouterOutlet`'s own
whole-screen teardown), just never called from `{#if:destroy}`'s own destroy sub. The only runtime
change needed was widening `unregisterSubtree`'s own signature with a `recoveryOwner` parameter (see
`Status` above) to make the SEPARATE focus-recovery step work too, once unregistration itself no
longer had the compile-time-visibility limitation the original problem statement describes.

## Live-confirmed BEFORE the fix (bug reproduction), Roku Ultra, serial X02800C5FKLV

Reproduced while live-verifying an unrelated fix (`issues/task-manager-no-auto-cancel-on-teardown.md`)
against `apps/task-manager-demo`'s `/run-cancel` chapter: `LongTaskWidget` (a nested custom component
with its own internal `focusable="true"` root) held focus, Backspace toggled its enclosing
`{#if:destroy}` off, and `queryAppUi` afterward showed **no node in the entire app holding focus** —
not even a fallback landing on a sibling button. A further `Up` keypress did not reclaim it either.
Matches this issue's own description exactly (the nested component's own focusable content is
invisible to the enclosing `{#if:destroy}` teardown's structural scan, so no `unregister()`/
`recoverFocusFor` line is ever emitted for it) — not a regression from the task-manager fix, which
touches an unrelated compiler subsystem (`taskManager.run(...)`/`ft_unmount`'s task-cancel line, not
focus registration). This reproduction is what prompted fixing this issue in the same session.

## Live-confirmed AFTER the fix, same device/app/chapter

Re-sideloaded `apps/task-manager-demo` with the fix in place and repeated the EXACT same steps: OK
on `longTaskWidget` (starts its own 10s task, `runningReadout` → "Running: 1"), Backspace (destroys
the widget while it holds focus). `queryAppUi` immediately afterward showed `burstButton` —
`RunCancelDemo`'s own first-registered focusable element — correctly holding focus
(`focused="true"`, highlighted), and `runningReadout` back to "Running: 0". Confirmed the first fix
attempt in this same session (unconditional `unregisterSubtree(blockRef)`, no `recoveryOwner`
rewrite yet) unregistered the entry correctly but did NOT recover focus — same "nothing focused"
symptom as the pre-fix reproduction above, diagnosed as `recoverFocusFor`'s own `IsSameNode()` match
against `m.focusLostFromOwner` (recorded as the WIDGET's own `m.top`, not `RunCancelDemo`'s) never
matching `RunCancelDemo`'s `m.top` — which led to the `recoveryOwner` rewrite (done at
`unregisterSubtree` time, while the subtree is still attached, not re-derived later against an
already-`removeChild`'d tree) that actually closed the gap. Also confirmed REWIND/FAST-FORWARD
chapter-switching and `app-state` still `active` (no crash) after recovery.

## Related

- `findings/focus-router-free-and-nested-gaps.md`
- `findings/component-unmount-hook.md`
- [animation-toggle-mode-focus-leak.md](animation-toggle-mode-focus-leak.md) — same underlying
  mechanism gap (a hide/teardown path that doesn't call `unregister()`), different trigger
  (`{#if:destroy}` teardown here vs. a no-transition `{#if}` toggle there)
