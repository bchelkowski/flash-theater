# `designResolution`/`srcDir`/`outDir` can't be overridden per environment

**Type:** Gap
**Area:** environments
**Status:** Open

## Problem

`environments/<name>.config.json` can override `manifestOverrides` and `include`/`exclude` globs, but
not the base `flash-theater.config.json`'s own `designResolution`, `srcDir`, or `outDir` — those stay
fixed across every environment.

## Impact

Low — these are build-layout/scale settings that rarely need to differ by environment in practice
(unlike manifest values or included files, which commonly do). Would only matter for an unusual setup
wanting, say, a different output directory per environment build.

## Where

- `findings/environments.md` — what an environment config can and can't override today.
- `findings/build-layout.md` — `srcDir`/`outDir` base config.
- `findings/scale-config-and-codegen.md` — `designResolution`'s role in `scale`.

## Suggested fix

Not recommended without a concrete need — extending environment-config overrides to these three
fields is straightforward mechanically (same override-merge logic already used for
`manifestOverrides`), but `designResolution` in particular interacts with `scale`'s compile-time
codegen (`findings/scale-config-and-codegen.md`) in ways that would need checking before allowing it
to vary by environment — a per-environment `designResolution` change could silently produce
differently-scaled builds that are easy to mix up.

## Related

- `findings/environments.md`
- `findings/scale-config-and-codegen.md`
