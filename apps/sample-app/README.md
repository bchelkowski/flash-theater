# sample-app

A minimal Roku app (based on the official `hello-world` sample) serving as the
testbed for components compiled by `packages/compiler`.

`src/components/MainScene.thr` is itself compiled from `.thr` (`<component
extends="Scene">`, see `packages/compiler/GRAMMAR.md`'s "`<component>` — the
mandatory root tag" section) — the primary showcase of the router feature.
Its whole template is a single `<FlashTheaterRouterOutlet>`; `setup()`
registers a route tree (`router.setRouting([...])`) with two top-level
routes and navigates to `/splash` first:

- **`/splash`** activates `SplashScreen.thr` — the app's own true first-ever
  screen, mounted before anything else exists. Nothing anywhere holds focus
  at that moment; after a simulated ~1.5s load (a hand-wired `roSGNode`
  `Timer` — the compiler has no async primitive of its own), an "Enter app" button
  claims that genuine vacuum explicitly (`claimFocusIfVacant`) and navigates
  to `/browse` on OK.
- **`/browse`** activates `Shell.thr` — a persistent sidebar menu (wraps
  `FavoriteCounter`) that stays mounted across every navigation within
  `/browse/*`, plus its own nested `FlashTheaterRouterOutlet` that
  independently swaps `HomeScreen.thr`/`ScheduleScreen.thr`/
  `LoadingDemoScreen.thr` inside it, offset into a content pane to the right
  of the menu (a thin `divider` marks the boundary).

- **On `HomeScreen`, OK** — calls `router.updateBackJourneyData({
  visitedSchedule: true })` then `router.navigate("/browse/schedule", {
  day: "Mon" })`, moving into `ScheduleScreen` (wraps `ScheduleList`,
  reading the `day` param back via `router.params.day`) — verify live that
  `Shell`/`FavoriteCounter`'s own node identity is unchanged across this
  navigation (via `queryAppUi`), the actual proof persistent chrome isn't
  being rebuilt, not just that it compiles.
- **On `ScheduleScreen`, OK** — calls `router.updateBackJourneyData({
  lastDay: dayParam })` then `router.back()`, returning to `HomeScreen`;
  its `welcomeText` now reads the restored `backJourneyData` and shows a
  "Welcome back!" message, confirming that data survived a full
  destroy+recreate round trip through the back-journey history stack.
- **On `ScheduleScreen`, PLAY** — calls
  `router.navigate("/browse/schedule", { day: "Tue" }, true)`, the
  three-argument form (`skipInHistory = true`): switches the displayed day
  without pushing a new history entry, so a later **back** press returns
  straight to `HomeScreen` in one press, never stopping at the Tuesday view.
- **`*` / options** (from either screen) — calls `addFavorite()` on `Shell`'s
  `FavoriteCounter`, which writes the built-in global store's
  `favoriteCount` key (`store(favoriteCount) = favoriteCount + 1`) — reaches
  `Shell`'s own `on:key[options]` handler via real cross-component key
  bubbling (neither screen declares its own `on:key[options]`), demonstrating
  the same bubbling this app's focus system already relies on, now across a
  router-mounted boundary too. Deliberately not bound to an arrow key: an
  unconditional component-level `on:key[right]` would shadow the focus
  system's own LRUD fallthrough and make it impossible to walk right out of
  `Shell`'s menu into the mounted content.
- **`Shell`'s own menu (Home / Schedule / Loading demo), and the vacuum
  rule** — all three menu entries navigate, and focus **stays in the menu**
  the whole time. This is the canonical TV layout, and the reason automatic
  focus targets are only ever applied into a vacuum: the focused menu item is
  not inside the swapped subtree, so it survives every navigation, and each
  mounted screen's own `default-focus="true"` element only takes effect when
  focus actually enters that screen (**right** from the menu, lined up on the
  Y axis with the corresponding row). Verify live: move through the menu and
  confirm the gold highlight never leaves it while the content beside it
  changes — then verify `isFocused`/`isInFocusChain` (`Shell`'s own
  `focusStateReadout` label) flip between `focus: MENU` and `focus: CONTENT`
  in step.
- **`ScheduleScreen`'s `lateDefault`** — a `default-focus="true"` element
  that does not exist at `init()` time (it lives inside `{#if:destroy ready}`,
  and `ready` only flips in `setup()`). Entering the screen must land on it,
  not on the earlier-registered `backPrompt` — the case that used to break
  before focus recovery became owner-scoped. The day list sits to the left
  (reachable via **left**/**right** from either prompt) and chains **up**/
  **down** through its own rows, all without overlapping anything else on
  screen — verify live via `queryAppUi` that no two focusable elements'
  bounding boxes intersect.
- **`LoadingDemoScreen`'s `readyButton`, and `claimFocusIfVacant`** — the
  same delayed-`Timer` pattern as `SplashScreen`, but reachable mid-session
  from `Shell`'s own menu, where the menu already holds focus. Verify live
  that the menu item stays focused for the whole ~1.5s wait and is NOT
  stolen once `readyButton` appears — the non-vacuum half of the same rule
  `SplashScreen` demonstrates the vacuum half of.
- **`CardsScreen`'s two `RichCard` instances — OK-to-enter/back-to-exit
  drill-down.** Each card is its own compiled component (its own owner):
  **up**/**down** moves between the two cards' own roots (ordinary
  cross-owner LRUD — neither card declares `default-focus`, since whenever
  a card isn't entered its own root is the only registered focusable node
  around, already the plain geometric winner). **OK** on a card's root
  hands real focus to its first internal button (`focusable="{not
  entered}"`/`"{entered}"` toggling on the parent vs. its two children —
  the documented parent → child focus handoff, see
  `packages/compiler/GRAMMAR.md`'s "Focus system"); **left**/**right** then
  moves only between that card's own two buttons. **back** exits back to
  the card's own root regardless of which button was focused — handled by
  a per-button `on:key[back]`, not a component-level one, so it only
  intercepts **back** while actually entered and otherwise falls through to
  this screen's own back-navigation. Verified live end to end, including
  that pressing OK on the entered card's own second button genuinely routes
  (not just `IsInFocusChain()`-reports) — see
  `apps/sample-app/src/components/RichCard/RichCard.thr`'s own top comment and
  `findings/focus-system.md`.
- **back** (physical/ECP key, from anywhere) — mostly needs no `on:key[back]`
  handler anywhere in this demo: the compiler's own generated
  `onKeyEvent` fallthrough (`codegen/brs-emitter.ts`'s
  `emitOnKeyEventFunction`) walks the router's back-journey history
  automatically, and stops consuming the key once history is empty so
  Roku's own default unhandled-`"back"`-at-the-Scene behavior exits the app.
  From `HomeScreen`, that's a real, multi-stop chain worth walking end to
  end: **back** once returns to `SplashScreen` (a genuine earlier route, now
  showing "Enter app" again on a brand-new instance), **back** again exits
  the app cleanly — never a blank, dead screen. That last part used to be
  exactly the failure mode: a phantom history entry left over from the very
  first `navigate()` call meant a single **back** press on the very first
  screen blanked the whole app with no way back or forward; see
  `findings/router.md`'s "A phantom first history entry..." entry.

See [`packages/compiler/GRAMMAR.md`](../../packages/compiler/GRAMMAR.md)'s
"Router" section and `findings/router.md` for the full design — including
the `default-focus="true"` attribute each screen uses to declare its own
natural entry point (a router-mounted component is always a brand-new
instance, so there's never a "remembered last focus" to fall back on
instead) and the automatic `setup()` hook every router-mounted component
gets for one-time post-construction logic (`ScheduleScreen`'s own `setup()`
calls `ScheduleList`'s `load()`), mirroring this Scene's own hand-called
`scene.callFunc("setup")` convention below.

The pre-router demo's `left`-key `switchTheme("dark"|"light")` toggle isn't
wired into this flow — `MainScene.thr`'s own root now holds nothing but a
single router outlet, so there's no natural place left for an app-wide,
always-available key like that. Theme itself is still fully exercised
either way: `FavoriteCounter.thr` (rendered inside `Shell`) reads
`theme.colors.background`/`.highlight`/`.text` exactly as before, unchanged
by any of this.

The store itself has no `.thr` source at all — it's a built-in runtime
primitive (`packages/compiler/runtime-assets/Store`), auto-copied into
`out/components/FlashTheater/FlashTheaterStore/` by `flash-theater compile`
whenever any component uses it (see `FavoriteCounter/FavoriteCounter.thr`'s
`read`/`watch`/`store(...)` usage). `src/components/Theme/Theme.thr` (+
`Light.thr`/`Dark.thr` variants) is the hand-authored source for the theme
global — but unlike a regular component, its filename/location are a free
choice: `flash-theater compile` finds it structurally by its
`<theme-template>` root tag, not by name, and always compiles it to
`out/components/FlashTheater/FlashTheaterTheme/FlashTheaterTheme.xml`/`.brs`
regardless of what the source file is called or where it lives — see
[`packages/compiler/GRAMMAR.md`](../../packages/compiler/GRAMMAR.md)'s
"Global store" and "Theme" sections for the full grammar. Every piece of
compiler-owned output that isn't a component the app author wrote themselves
— the copied Store, the compiled theme, and the generated globals bootstrap
below — lives under a `FlashTheater/` subfolder of `out/components/` or
`out/source/`, one place regardless of build; the whole of `out/` is
generated output, never something to hand-edit (`src/components/Theme/`
above, by contrast, is real hand-authored source and lives wherever you like
under `src/`). Compiling also generates
`out/source/FlashTheater/FlashTheaterGlobals.brs`, wired into
`src/source/Main.brs` (copied through verbatim to `out/source/Main.brs`)
with one hand-written `FlashTheaterSetupGlobals(screen.getGlobalNode())`
call right before `CreateScene` — see that file.

## Project layout

```
src/            # 100% hand-written — manifest, images/, source/Main.brs, components/**/*.thr, *.flsh
out/            # 100% generated/copied by `flash-theater compile`, mirrors src/'s structure, gitignored
dist/           # the final packaged sample-app.zip, built by zipping out/ wholesale
```

See `packages/compiler/GRAMMAR.md`'s "Project layout" section and
`findings/build-layout.md` for the full design.

## Building

From the repo root (builds the compiler first, then this app):

```bash
npm run build:roku
```

Or from this directory, if `packages/compiler` is already built:

```bash
npm run build:roku
```

This runs `npm run compile` (`flash-theater compile` — discovers everything
under `src/`, wipes `out/` and regenerates it: compiled `.xml`/`.brs`
mirrored from each `.thr`/`.flsh`, every other `src/` file copied through
verbatim) followed by `npm run zip` (`flash-theater zip` — packages the whole
of `out/` into `dist/sample-app.zip`; zipping is a compiler CLI command, not
an app-level script, so no app needs its own zip script/`adm-zip` dependency).

## Environments

This app has two example environments (`environments/staging.config.json`/
`environments/production.config.json` — see `packages/compiler/GRAMMAR.md`'s
"Environments" section and `findings/environments.md`), each declaring an
`apiBaseUrl`/`buildLabel` pair read from `src/components/EnvDemo/EnvDemo.thr`
(`env.apiBaseUrl`/`env.buildLabel`), a `manifestOverrides.title` patch, and its
own `images/<env>-only/` folder brought in via `include` (the base
`flash-theater.config.json` excludes both env-only image folders and
`components/EnvDemo/` by default, so the plain build below ships neither):

```bash
npm run build:roku                                                        # unchanged: out/, dist/sample-app.zip
SAMPLE_APP_BUILD_LABEL=42 FLASH_THEATER_ENV=staging npm run build:roku    # out-staging/, dist/sample-app-staging-1.0.<build>.zip
FLASH_THEATER_ENV=production npm run build:roku                          # out-production/, dist/sample-app-production-1.0.<build>.zip
```

`staging`'s `buildLabel` is declared `{ "fromEnv": "SAMPLE_APP_BUILD_LABEL" }`
— compiling it without that variable set fails with
`environment-config/missing-env-var`. `production`'s `buildLabel` is a plain
literal instead, so it needs no environment variable at all. To override
either environment's values on your own machine (e.g. point `apiBaseUrl` at
`localhost` instead of the shared staging URL) without touching the committed
config, copy `environments/staging.local.config.json.example` to
`environments/staging.local.config.json` (git-ignored — see the repo root
`.gitignore`) and edit it; it's picked up automatically the next time you
build with `FLASH_THEATER_ENV=staging`.

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

`npm run sideload` runs
[`kopytko-roku-device`](https://www.npmjs.com/package/kopytko-roku-device)'s
own `kopytko-roku` CLI (`kopytko-roku installer install --zip
dist/sample-app.zip`) — `ROKU_HOST`/`ROKU_PASSWORD` are that CLI's own
built-in config-resolution fallback env vars (checked after `--host`/
`--password` flags and an optional `--config` file), not something this repo
invented. It's the dev web installer over HTTP, digest auth, username always
`rokudev`.
