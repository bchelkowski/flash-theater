# `derived` type inference has a permanent "unknown" boundary

**Type:** Gap
**Area:** reactive-state
**Status:** Open

## Problem

`derived`'s static type-inference pass can't see through several categories of expression: builtin
function calls, other member/dot access (`theme.*`/`router.*`), a class instance's own fields, and
schemaless `read`/`watch`/store-AA values. All of these infer as `unknown` and are never flagged —
not even as a warning — so a `derived` declared with an explicit type that's actually wrong for one
of these sources passes silently.

## Impact

A `derived <Type>` declaration gives false confidence: the declared type is enforced against
everything the inference pass *can* see, but silently trusted (not checked) for exactly the
expressions most likely to be wrong (cross-object/theme/class access). This is documented as an
accepted design boundary, not a bug, but it's the kind of gap worth closing incrementally.

## Where

- `findings/reactivity-derived-type-check.md` — the type-inference pass and its documented
  `unknown` boundary, including the "class instance held in a local variable" case.
- `packages/compiler/src/analysis/` — wherever the `derived` type-check pass lives.

## Suggested fix

Incremental, not all-or-nothing: `theme.*` access is actually the most tractable piece to close first
since `<theme-template>` declares a real shape at compile time (see `findings/reactivity-theme-parsing.md`)
— the inference pass could resolve a `theme.a.b` leaf's declared type instead of giving up at `unknown`.
Class-instance-field and schemaless-store inference are harder (no static shape exists for the latter
at all) and are reasonable to leave as permanently `unknown` rather than attempting full structural
inference across `.flsh` class boundaries.

## Related

- `findings/reactivity-derived-type-check.md`
- `findings/reactivity-theme-parsing.md`
