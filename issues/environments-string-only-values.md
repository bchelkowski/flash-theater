# `env.<name>` is always a plain string; no numbers/booleans/nested groups

**Type:** Gap
**Area:** environments
**Status:** Open

## Problem

Every value read via `env.<name>` is a plain string — `environments/<name>.config.json` doesn't
support non-string variable values (numbers, booleans) or nested groups (`env.a.b` is invalid; the
config is a flat key→string map).

## Impact

An author wanting a numeric or boolean environment-config value (e.g. a feature-flag boolean, a
numeric timeout tuned per environment) has to store it as a string and parse it themselves at
runtime (`"true"` string comparison, `Val()` conversion) rather than getting a typed value directly.

## Where

- `GRAMMAR.md` environments section — `env.<name>` is fully static/structural, string-only.
- `findings/environments.md` — config file format, `env.*` resolution.

## Suggested fix

Since `env.<name>` resolution is compile-time/structural (a compile error for an undeclared name, not
a runtime lookup — see `findings/environments.md`), typed values are plausible without a runtime
redesign: the compiler could infer/require a declared type per key in the environment config schema
and emit the JSON value's real type (numeric/boolean literal) into generated code instead of always
wrapping it in a string literal. Nested groups are a separate, larger question (would need a real
schema, not just a flat map) — lower priority than typed scalars.

## Related

- `findings/environments.md`
- `apps/environments-demo`'s `/variable-reads` chapter
