# `try`/`catch` has no `finally` clause

**Type:** Gap
**Area:** statements
**Status:** Open

## Problem

The DSL's `try`/`catch` has no `finally` block — there's no way to declare cleanup code that runs
whether or not the `try` block threw.

## Impact

Cleanup that must always run (releasing a resource, resetting a flag) has to be duplicated at the end
of both the `try` block and the `catch` block, or restructured to avoid needing `finally` at all —
easy to accidentally miss the duplicate in one branch when the code is edited later.

## Where

- `GRAMMAR.md` `try`/`catch` section — no `finally` grammar exists.
- `findings/statement-grammar-features.md` — `try`/`catch` codegen (`for`/`for each`/`while`, loops,
  string-literal escaping).

## Suggested fix

BrightScript's own `try`/`catch` (which this lowers to) has no native `finally` either — so this would
need the compiler to synthesize `finally`-equivalent behavior by duplicating the finally-block's
statements into both the normal-fallthrough path and the generated `catch` block's own end, which is
exactly the manual duplication authors do today, just automated. Worth checking `brs-emitter.ts`'s
existing `if`/`try` codegen conventions (`findings/compiler-codegen-conventions.md`) for the cleanest
way to inject a statement list at two exit points.

## Related

- `findings/statement-grammar-features.md`
- `findings/compiler-codegen-conventions.md`
