# No `.flsh` class-body `animation` form

**Type:** Gap
**Area:** animation
**Status:** Open

## Problem

Same gap as [classes-no-class-body-animation.md](classes-no-class-body-animation.md), filed from the
animation feature's own side: `animation {}` declarations are bound to template element `id`s, so
they have no equivalent form inside a `.flsh` class, which has no template at all.

## Impact

See [classes-no-class-body-animation.md](classes-no-class-body-animation.md) — animation logic can't
be factored into a reusable class.

## Where

- `findings/animation.md` — "Known limitations" section.
- `findings/class-pipeline.md` — class-body grammar restrictions.

## Suggested fix

See [classes-no-class-body-animation.md](classes-no-class-body-animation.md) for the fix direction —
this file exists so the gap is discoverable from either the `animation` or `classes` area without
duplicating the writeup.

## Related

- [classes-no-class-body-animation.md](classes-no-class-body-animation.md)
- `findings/animation.md`
