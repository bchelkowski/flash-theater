# `catch`'s variable is mandatory; no catch-less `try`

**Type:** Gap
**Area:** statements
**Status:** Open

## Problem

`catch` always requires a bound error variable (`catch e { ... }`) — there's no way to write a
catch-less `try` (`try { ... } catch { ... }` with no variable) for the common case where the caught
error's contents genuinely don't matter, only that something was caught.

## Impact

Minor ergonomic friction: an author who doesn't care about the error object still has to name and
never use a `catch` variable, and (depending on unused-local elision rules — see
`findings/compiler-codegen-conventions.md`) may need to be mindful of unused-variable diagnostics.

## Where

- `GRAMMAR.md` `try`/`catch` section — mandatory catch-variable grammar.
- `findings/statement-grammar-features.md` — loops/`try`-`catch` grammar.

## Suggested fix

Small, low-risk grammar addition: allow `catch { ... }` with no bound name, lowering to
BrightScript's own `catch e` with a compiler-generated, guaranteed-unused variable name under the
hood (matching how other reserved-but-invisible generated names work, per
`findings/compiler-architecture.md`'s naming conventions) so the emitted code still satisfies
BrightScript's own catch-needs-a-name requirement without exposing that detail to the author.

## Related

- `findings/statement-grammar-features.md`
- `findings/compiler-architecture.md`
