# High-priority work still waits behind running low-priority tasks

**Type:** Gap
**Area:** task-manager
**Status:** Open

## Problem

`taskManager`'s priority queueing only affects *queue order* — a newly-`run()` high-priority task
still has to wait for a concurrency slot to free up if all slots are currently occupied by
already-running low-priority tasks. There's no preemption (pausing/requeueing a running low-priority
task to make room).

## Impact

Under sustained load with `setMaxConcurrent` near its limit, a burst of low-priority tasks can delay a
subsequently-submitted high-priority one for as long as the low-priority tasks take to finish, which
somewhat undercuts the point of having priority tiers at all under contention.

## Where

- `findings/task-manager-core.md` — priority queueing / concurrency-slot mechanics.

## Suggested fix

True preemption (pause/resume a running Task) isn't really possible with Roku's own Task node model —
a running Task can only be cancelled, not paused and resumed. A more realistic fix: when a
high-priority task is submitted and all slots are full, allow the manager to `cancel()` (not pause) the
*lowest*-priority currently-running task to free a slot immediately, then requeue that cancelled
task's work at the front of its own tier — trades a bit of wasted work for bounded high-priority
latency. Needs explicit opt-in (a `preemptible: true` flag on `run(...)`) since forced cancellation
isn't safe for every task shape.

## Related

- `findings/task-manager-core.md`
