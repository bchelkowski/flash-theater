# No `.flsh` class-body `animation` declaration form

**Type:** Gap
**Area:** classes
**Status:** Open

## Problem

`animation {}` declarations are inherently tied to template element `id`s (an animation targets a
named element in a `.thr` file's own template) — there's no `.flsh` class-body form, since a class has
no template to hold ids at all. Same underlying cause is tracked from the animation side in
[animation-no-class-body-form.md](animation-no-class-body-form.md) — filed on both sides since either
area's own future work could be the one that closes it.

## Impact

Animation logic can't be factored out into a reusable class the way other cross-cutting behavior can
— it has to stay declared per-`.thr`-file even when the same animation shape is duplicated across
several components.

## Where

- `findings/animation.md` — "Known limitations" section, explicitly names this.
- `findings/class-pipeline.md` — class-body grammar restrictions in general.

## Suggested fix

Would require decoupling `animation {}`'s targeting model from template-element-ids — e.g. a class
method that receives a node reference as a parameter and drives an animation against it generically,
rather than the current id-bound declarative form. This is a real design question (not just plumbing)
about what a "portable" animation declaration would even look like — worth a design pass before
implementation, not a quick fix.

## Related

- `findings/animation.md`
- [animation-no-class-body-form.md](animation-no-class-body-form.md)
