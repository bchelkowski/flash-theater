# No manifest-file or runtime-decided initial theme

**Type:** Gap
**Area:** theme
**Status:** Open

## Problem

The only way to set an app's starting theme is the compile-time `<theme-template default="name">`
attribute. There's no manifest-file-driven or runtime-decided (e.g. based on a stored user
preference, or system dark/light mode if the platform ever exposes one) initial theme selection —
`switchTheme(name)` exists for changing theme *after* boot, but the very first theme is always the
compiled-in default.

## Impact

An app wanting to remember a user's last-chosen theme across launches has to call `switchTheme(...)`
itself very early in boot (e.g. from `MainScene`'s `setup()`, reading a stored preference) rather than
having a declarative way to say "pick the initial theme from this source." Works today via that
manual call — this is a convenience gap, not a blocker.

## Where

- Named in `GRAMMAR.md`'s former "Not yet implemented" section (now removed from that doc, tracked
  here instead) and `docs/features.md`'s former "Deferred, with rationale" section.
- `findings/reactivity-theme-parsing.md` — theme declaration/switching mechanics.

## Suggested fix

Lowest-effort version: document the manual-`switchTheme`-in-`setup()` pattern as the sanctioned
approach in `site/src/pages/docs/theme.astro` (may already partially exist) rather than building new
grammar — this covers the practical need (remembered preference) without new compiler surface. A true
manifest-file mechanism would need a new build-time config source (similar to `environments/`'s
`.config.json` pattern) and is a bigger, likely lower-priority undertaking.

## Related

- `findings/reactivity-theme-parsing.md`
- `apps/theme-demo`'s `/switch-theme` chapter
