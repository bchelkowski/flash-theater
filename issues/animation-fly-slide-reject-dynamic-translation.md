# `fly`/`slide` presets reject a target with a dynamic resting `translation`

**Type:** Gap
**Area:** animation
**Status:** Open

## Problem

The `fly`/`slide` animation presets compute their motion relative to a target element's resting
`translation` value. If that target's `translation` attribute is itself dynamic (a `{expr}` or
`bind:` binding, not a static literal), the compiler rejects the preset at compile time
(`animation/preset-target-has-dynamic-translation`) — the preset can't know what "resting position"
to animate from/to.

## Impact

An element whose position is already reactive (e.g. repositioned based on some state) can't also use
the `fly`/`slide` shorthand presets for its own show/hide animation — the author has to fall back to a
fully custom `animation {}` block that reads the current position at animation-start time instead of
relying on a static resting value.

## Where

- `findings/animation.md` — "Known limitations" section, names this exact diagnostic.
- `packages/compiler/src/analysis/` or `codegen/` — wherever preset validation checks the target's
  `translation` attribute kind (static vs. dynamic).

## Suggested fix

Rather than rejecting outright, the preset codegen could read the target's *current* `translation`
value at animation-start time (a runtime read, not a compile-time constant) instead of requiring a
compile-time-known resting value — this is more work than the current static-only assumption but
would remove the restriction entirely. Worth checking how much of the preset's math genuinely depends
on knowing the value at compile time vs. could be deferred to runtime before committing to this
approach.

## Related

- `findings/animation.md`
