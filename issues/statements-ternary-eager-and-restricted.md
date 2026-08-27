# Ternary evaluates both branches eagerly and is restricted to two host positions

**Type:** Gap
**Area:** statements
**Status:** Open

## Problem

Two related, both-documented-as-deliberate ternary limitations: (1) `cond ? a : b` lowers to a
hoisted temp variable plus an `if`/`else`, but evaluation of a nested ternary in the *untaken* branch
still happens (eager, not short-circuited) — a deliberate trade-off from how the feature was designed,
not an oversight; (2) ternary is only valid as a bare assignment RHS or a `state` write — it's rejected
in `derived`/`state` declarations, template `{expr}`, `{#each}` collection/key, `store(...)`/
`focus(...)` writes, `if` conditions, and `return`.

## Impact

(1) A ternary branch with a side-effecting or expensive nested expression can surprise an author
expecting short-circuit semantics (as in most C-family languages) — e.g. a nested ternary calling a
function with a side effect in the untaken branch still runs that call. (2) The two-host-position
restriction means ternary can't be used in several places an author might reasonably expect it to
"just work" given it's presented as a general expression-level operator.

## Where

- `GRAMMAR.md` — "Ternary (`? :`)" section, `GRAMMAR.md:893` area for the elision/eager-evaluation
  note.
- `findings/operators-ternary.md` — full design rationale for both restrictions.

## Suggested fix

(1) Eager evaluation is called out as intentional in `findings/operators-ternary.md` — closing this
would mean generating real branching (compute only the taken side) instead of the current
hoisted-temp-plus-if/else lowering, which is a real codegen change, not a quick fix; only worth it if
the eager-evaluation surprise turns out to bite real code (side-effecting nested ternaries are
probably rare and arguably bad style regardless). (2) The host-position restriction is more tractable
to narrow incrementally — each excluded position (`derived`, template `{expr}`, `{#each}`
collection/key) would need its own codegen to support hoisting a temp var, since ternary's whole
lowering strategy depends on having a statement list to hoist into (the same limitation anonymous
functions and raw-passthrough share in these same positions — see `GRAMMAR.md:1204`). Template
`{expr}` support is probably the highest-value one to add first (most commonly reached-for spot).

## Related

- `findings/operators-ternary.md`
