# `taskManager` hasn't opted into the `ft_unmount` teardown hook timers introduced

**Type:** Gap
**Area:** timers
**Status:** Open

## Problem

This is the same underlying gap as
[task-manager-no-auto-cancel-on-teardown.md](task-manager-no-auto-cancel-on-teardown.md), filed here
from the timers/`ft_unmount` side: the general component-unmount hook (`ft_unmount`) that the timers
feature introduced (for auto-clearing `setTimeout`/`setInterval` on teardown) exists and works for
timers themselves, but `taskManager` never wired itself up to the same hook.

## Impact

See [task-manager-no-auto-cancel-on-teardown.md](task-manager-no-auto-cancel-on-teardown.md) — running
tasks outlive the component that started them.

## Where

- `findings/component-unmount-hook.md` — the general hook's design and current call sites; explicitly
  names `taskManager` as not yet opted in.
- `findings/timer-statements.md` — the hook's origin, the pattern to copy.

## Suggested fix

See [task-manager-no-auto-cancel-on-teardown.md](task-manager-no-auto-cancel-on-teardown.md) — filed
on both sides so whichever area's own future work picks this up, it's discoverable.

## Related

- `findings/component-unmount-hook.md`
- [task-manager-no-auto-cancel-on-teardown.md](task-manager-no-auto-cancel-on-teardown.md)
