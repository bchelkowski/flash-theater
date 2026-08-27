# Re-running an already-queued task never moves it between priority tiers

**Type:** Gap
**Area:** task-manager
**Status:** Open

## Problem

`run()` has an idempotency check that treats a repeat call for an already-queued task id as a no-op —
but this means calling `run()` again with a *different* priority for the same task doesn't move it
between priority tiers. The original priority sticks until the task actually starts.

## Impact

An author trying to "bump" an already-queued task's priority in response to a later event (e.g. "the
user is now actively waiting on this download, treat it as high-priority") finds `run()` silently
ignores the new priority — has to `cancel()` the existing entry and `run()` fresh to get the new
priority, which restarts the task from scratch rather than just reordering it in the queue.

## Where

- `findings/task-manager-core.md:135` area — documents this as deliberately unsupported, with the
  cancel+re-run workaround.

## Suggested fix

Extend `run()`'s idempotency check: when called again for an id already in the *queue* (not yet
running), compare the new priority against the stored one and re-splice the entry into the correct
tier's position instead of no-op'ing. Once a task has actually started running, priority is moot
(nothing to reorder), so the fix only needs to touch the still-queued case — a narrower, safer change
than it might first sound.

## Related

- `findings/task-manager-core.md`
