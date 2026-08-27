# At most one `<theme-template>` per app

**Type:** Gap
**Area:** theme
**Status:** Open

## Problem

An app can only declare a single `<theme-template>`. There's no way to have two independently-shaped
theme templates (e.g. one for a "player chrome" theme group and a totally separate one for an
unrelated screen family) — every `<theme name="...">` variant must conform to the one app-wide
template shape.

## Impact

Low — most apps naturally want one consistent theme shape app-wide, so this is unlikely to bite most
authors. Would only matter for an app deliberately composing visually distinct sub-experiences (e.g.
a white-label shell hosting differently-themed sections) that don't share a shape.

## Where

- `findings/reactivity-theme-parsing.md` — `<theme-template>`/`<theme>` declaration and validation.

## Suggested fix

Not recommended without a concrete authoring need — the theme system's whole value (partial-override
validation against one known shape) depends on there being one canonical template to validate
against. If ever needed, would require namespacing (`<theme-template name="...">`) and validation
scoped per-namespace, a nontrivial redesign for a currently-hypothetical use case.

## Related

- `findings/reactivity-theme-parsing.md`
- `apps/theme-demo`'s `/theme-template` chapter
