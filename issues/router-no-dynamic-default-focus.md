# `default-focus` must be a static literal, no `{expr}` form

**Type:** Gap
**Area:** router
**Status:** Open

## Problem

`default-focus="true"` only accepts a static literal — `default-focus="{expr}"` (a dynamic/reactive
condition) isn't supported. This mirrors the same static-vs-reactive restriction that ordinary
`focusable="{expr}"` *does* support (see `GRAMMAR.md`'s focus section) — `default-focus` didn't get
the same reactive form.

## Impact

An author who wants "the default-focused element depends on some runtime condition" (e.g. focus the
first incomplete item in a list, chosen dynamically) can't express that declaratively — has to fall
back to an explicit `claimFocusIfVacant` call in `setup()` with hand-written logic instead of a
template attribute.

## Where

- `GRAMMAR.md:1991` area — documents the static-literal-only restriction.
- `findings/focus-system.md` — compares this to reactive `focusable="{expr}"`, which is supported.

## Suggested fix

Since reactive `focusable="{expr}"` already exists and is "undetectable so becomes a runtime
contract" per `GRAMMAR.md:1944`, a reactive `default-focus="{expr}"` would need the same treatment —
evaluated at the point a vacancy/mount actually happens rather than compile time. Worth checking
whether the existing reactive-`focusable` runtime plumbing can be reused directly for this rather than
building parallel machinery.

## Related

- `findings/focus-system.md`
