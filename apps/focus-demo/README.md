# focus-demo

A second Roku app hosting `ScrollFocusDemo` plus a deliberately mixed set of
focusable content — split out of `apps/sample-app` so
`FlashTheaterFocusManager`'s focus registry starts from a clean slate.
`navigate()`'s directional (LRUD) search is intentionally app-wide: it looks
at every focusable node in the whole running app, not just the current
component. When `ScrollFocusDemo` shared a scene with `apps/sample-app`'s
`ScheduleList`, their screen regions genuinely overlapped and `navigate()`
would correctly, geometrically jump focus between the two unrelated
components — confirmed live, see
[`findings/focus-system.md`](../../findings/focus-system.md). This app avoids
that *unintentional* collision, while deliberately opting into a different
kind on purpose (see below) to actually observe how `navigate()` handles it.

Besides `ScrollFocusDemo`'s uniform 6×5 tile grid, `buildGrid()` also mixes in
a few irregular, non-grid-aligned cards (`wide1`/`tall1`/`small1` — varying
size, not row/column-aligned) into the same `{#each}` collection, and
`src/components/MainScene.brs` adds two more, deliberately simple components as
additional focusable siblings, so the app has three structurally distinct
kinds of focusable content sharing one registry, not just a uniform grid:

- **`SimpleFocusItem`** — a single focusable leaf (`Rectangle` + `Label`),
  no focusable children of its own.
- **`FocusGroup`** — a small static container with **its own** three
  focusable children (`row0`/`row1`/`row2`), a second, differently-shaped
  "container with focusable children" case alongside `ScrollFocusDemo`'s
  grid itself.

Both are intentionally minimal — no `on:key`, no functions, nothing beyond
`field label` on `SimpleFocusItem` for a per-instance caption — so there is
nothing to verify beyond focus/navigation itself. Neither needs any
hand-wired `focusable`/`register()`/`onKeyEvent`-forwarding in
`MainScene.brs` either: both declare `focusable="true"` directly in their
own template, so the compiler generates their registration and
`on:key`/LRUD-fallthrough dispatch the normal way, exactly like
`ScrollFocusDemo`'s tiles — unlike an earlier version of this app, which
reused real `apps/sample-app` components (`FavoriteCounter`,
`ScheduleDateMenuItem`) that declare no focusable content of their own and
so needed all of that wired by hand.

`src/components/MainScene.brs` creates a `ScrollFocusDemo` instance in `init()`
but deliberately does **not** call `load()` there — `load()`'s own
`{#if:destroy loaded}` reconcile ends with a `recoverFocus()` call that grabs
real focus via `SetFocus()`, and `init()` always runs before
`source/Main.brs` calls `screen.show()` (it completes synchronously inside
`CreateScene()`). Confirmed live that a `SetFocus()` issued before the screen
is shown does not establish a real root-to-leaf focus chain, so real remote
key events never reached `ScrollFocusDemo` at all. `load()` is instead called
on the first live `onKeyEvent`, well after `show()` — that first key press is
consumed to enter the grid; every press after that is handled directly by
`ScrollFocusDemo`'s own generated `onKeyEvent`/`FlashTheaterFocusManager`, not
by `MainScene.brs`. See `findings/focus-system.md` for the full trace,
including a first fix attempt that only deferred an extra hand-off call and
missed that `load()` itself still needed deferring.

`ScrollFocusDemo`'s 6×5 tile grid is deliberately larger than the 1280×720
screen, so navigating to the rightmost column or bottom row moves real focus
onto a tile that starts genuinely off-screen —
`FlashTheaterFocusManager.scrollIntoView()` is what brings it into view,
driven purely by two ordinary `field`s (`scrollOffsetX`/`scrollOffsetY`) on
`ScrollFocusDemo` itself, zero new DSL grammar. The currently-focused tile is
highlighted (a gold `color` swap via `moveFocusTo()`) so navigation is
visible on a real TV, not just inferable from `queryAppUi`.

## Building

From the repo root (builds the compiler first, then both apps):

```bash
npm run build:roku
```

Or from this directory, if `packages/compiler` is already built:

```bash
npm run build:roku
```

## Sideloading onto a real Roku device

Requires developer mode enabled on the device (see
[developer setup](https://developer.roku.com/dev/docs/developer-setup)) and
these environment variables:

```bash
export ROKU_HOST=192.168.x.x
export ROKU_PASSWORD=your-developer-password
npm run build:roku
npm run sideload
```

Sideloading replaces whatever dev-mode channel is currently installed — this
app and `apps/sample-app` can't both be installed at once, same as any two
sideloaded channels on one device.
