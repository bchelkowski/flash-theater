# `store(a.b) = x` rejected; only whole top-level keys are writable

**Type:** Gap
**Area:** reactive-state
**Status:** Open

## Problem

The global `store` is schemaless and accessed via `read`/`watch`/`store(...)`, but a write through
`store(...)` only accepts a bare top-level key (`store(a) = x`) — writing to a nested path
(`store(a.b) = x`) is rejected at compile time as `statement/store-nested-write`. An author who wants
to update one nested field of a stored object has to read the whole object, mutate it in a local, and
write the whole thing back.

## Impact

Verbose, error-prone read-modify-write pattern for any store value shaped as a nested
object/assocarray — easy to accidentally drop sibling keys during the "read whole, write whole"
round trip since there's no structural merge helper either.

## Where

- `GRAMMAR.md:744` area — documents `statement/store-nested-write` as a compile error.
- `findings/reactivity-state.md` — the store's schemaless read/watch/write design.

## Suggested fix

Two independent options, either useful on its own: (1) support `store(a.b) = x` directly, lowering
to whatever nested-assocarray-write helper the runtime already uses internally for object stores;
or (2) keep the restriction but add a documented helper pattern/runtime function for a shallow merge
write (`store(a) = ft_merge(read(a), { b: x })`-shaped) so the read-modify-write dance isn't fully
manual. Option (1) is the more complete fix and worth checking against the store's runtime codegen in
`packages/compiler/src/codegen/` for whatever already handles top-level `store(...)` writes.

## Related

- `findings/reactivity-state.md`
