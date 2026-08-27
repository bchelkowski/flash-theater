# No automatic cancel when a tracking component is destroyed

**Type:** Gap
**Area:** task-manager
**Status:** Open

## Problem

`taskManager.run(...)` has no `ft_unmount`-driven auto-cancel for the component that started it.
When a component using `taskManager.run(...)` is torn down (via `{#if:destroy}` or an `{#each}`
removal), any task it started keeps running/queued — `taskManager` hasn't opted into the general
`ft_unmount` component-unmount hook that the timer-statements feature introduced.

## Impact

A task started by a since-destroyed component can still complete and try to call back into that
component's own `onResult` handler or update fields on a node that no longer exists, or simply waste
concurrency-slot budget on work nobody's still waiting for. Caller must remember to manually track the
task's id and call `cancel(id)` in its own teardown path — nothing enforces this.

## Where

- `findings/component-unmount-hook.md` — documents this as the open gap, in the section on
  `ft_unmount`'s current call sites and what hasn't adopted it.
- `findings/task-manager-core.md` — `run`/`cancel` surface.
- `packages/compiler/runtime-assets/TaskManager/FlashTheaterTaskManager.brs` — where a per-owner
  task-id registry + auto-cancel-on-unmount would need to hook in.

## Suggested fix

Register the task's owning node when `run(...)` is called (the manager already needs *some* identity
for `cancel(id)` to work), and wire an `ft_unmount` callback that cancels every task registered to the
unmounting node — this directly follows the same pattern `timer-statements` already established for
`setTimeout`/`setInterval` cleanup (`findings/timer-statements.md`), so that implementation is the
concrete template to copy.

## Related

- `findings/component-unmount-hook.md`
- `findings/timer-statements.md`
- `findings/task-manager-core.md`
- [timers-task-manager-no-unmount-hook.md](timers-task-manager-no-unmount-hook.md) — same gap, filed
  from the timers/`ft_unmount` side
