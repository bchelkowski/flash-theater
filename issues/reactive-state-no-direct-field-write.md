# No grammar for writing a `field` directly from component code

**Type:** Gap
**Area:** reactive-state
**Status:** Open

## Problem

A `field` can only be changed from inside its own owning component by going through `state` — there's
no DSL syntax that writes to a `field` directly from component code (`field` is meant as the
externally-settable/scaled surface; `state` is the internal mutable cell). This is a deliberate design
split, not an oversight, but it means an author reaching for the "obvious" `myField = x` inside a
method gets silently wrong behavior (an ordinary new local, not a field write — see
`findings/reactivity-state.md`'s field-shadowing gotcha) rather than a compile error steering them
toward `state`.

## Impact

New authors hit this as a confusing runtime bug (their assignment appears to do nothing) rather than
a clear compile-time message. `apps/reactive-state-demo`'s `/state` chapter demonstrates the gotcha
live, but the grammar itself doesn't guard against it.

## Where

- `findings/reactivity-state.md` — the field/state split and the shadowing gotcha.
- `packages/compiler/src/analysis/identifier-rewrite.ts` — where a bare assignment to a name matching
  a `field` would need to be detected and rejected (or redirected) at compile time.

## Suggested fix

Rather than adding a new write form, the higher-value fix is a compiler diagnostic: when a plain
assignment's LHS name matches a `field`/`derived` name declared on the same component, and it isn't a
`state` declaration, emit a diagnostic ("did you mean `state`?") instead of silently allowing a
same-named local to shadow it. This closes the gotcha without changing the field/state design.

## Related

- `findings/reactivity-state.md`
- `apps/reactive-state-demo` (`/state` chapter already demos the gotcha)
