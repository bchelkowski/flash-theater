# No timeout for a task whose `state` never leaves `"init"`

**Type:** Gap
**Area:** task-manager
**Status:** Open

## Problem

If a task node's `state` field never transitions out of `"init"` (e.g. a buggy or hung Task
implementation), `taskManager` has no timeout mechanism to notice and reclaim that concurrency slot.
The task just occupies a running-slot forever.

## Impact

A single misbehaving task type can permanently reduce the manager's effective concurrency (one fewer
slot available for every other task, indefinitely) with no visible error — `runningCount` stays
elevated with no way to tell which task is stuck without manual investigation.

## Where

- `packages/compiler/runtime-assets/TaskManager/FlashTheaterTaskManager.brs` — the run-loop/slot
  accounting logic that would need a stuck-task watchdog.
- `findings/task-manager-core.md` — core run/cancel/concurrency semantics.

## Suggested fix

Add an optional per-task (or global default) timeout: track when a task entered `"running"`, and on
a periodic manager tick, force-`cancel()` anything that's exceeded the timeout, surfacing it through
the existing alerting mechanism (`findings/task-manager-alerting.md`) rather than a silent reclaim —
an author should be told a task was force-cancelled for hanging, not just have it quietly disappear.

## Related

- `findings/task-manager-core.md`
- `findings/task-manager-alerting.md`
