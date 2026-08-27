# `scale` — live-device verification lessons (`runtime-assets/Scale/FlashTheaterScale.brs`)

Live-device gotchas hit while verifying the `scale` modifier and `flash-theater.config.json` on
real Roku hardware — manifest tiers, ECP bounds reporting, cold-restart discipline, and picking a
correct `designResolution`. See `findings/scale-config-and-codegen.md` for the compile-time design
and codegen rationale, and `packages/compiler/GRAMMAR.md`'s "`scale`" section for the grammar/API
itself.

## The manifest MUST declare every resolution tier you want `scale` to ever do anything for — a single-tier manifest makes `scale` a permanent no-op

**Live-verified 2026-08-12** (Roku Ultra, physically set to 720p output) — and this one cost real
debugging time before the actual mechanism was understood, so it's worth stating as a hard
requirement, not a soft "keep them consistent" suggestion.

`designResolution` (the new `flash-theater.config.json`) and `ui_resolutions` (the existing
manifest key) are two different knobs, but they are NOT independent in practice — the manifest
setting decides whether `scale` can ever observe anything to scale FOR:

- **`ui_resolutions=fhd`** (single tier, this sample app's original setting): Roku renders the
  ENTIRE app internally at a virtual 1920×1080 canvas and auto-upscales/downscales the whole
  composited frame to fit whatever the physical display actually is — a real device fact, not an
  assumption. Under this mode, `roDeviceInfo().GetDisplaySize()` reports the **virtual FHD canvas
  size** (1920×1080), not the physical panel's real resolution, REGARDLESS of what the device
  actually is. `ft_scaleFactor` then computes `1920 / 1920 = 1.0` on every device, always — `scale`
  silently becomes a permanent no-op, indistinguishable from working correctly unless you actually
  measure rendered pixel sizes on a real non-FHD device.
- **`ui_resolutions=fhd,hd`** (multi-tier — what this app now uses): Roku picks the tier matching
  the actual device and renders NATIVELY at that resolution — no automatic OS-level scaling.
  `GetDisplaySize()` then reports the device's real pixel dimensions (confirmed live: `{w: 1280,
  h: 720}` on a device set to 720p), which is what makes `ft_scaleFactor` compute a real,
  non-1.0 factor and makes `scale` actually do something observable.

**Fix applied**: `apps/sample-app/manifest`'s `ui_resolutions` changed from `fhd` to `fhd,hd`.
**Lesson**: declaring `scale` in `.thr` source and a valid `flash-theater.config.json` is NOT
sufficient on its own — the app's manifest must also declare every `ui_resolutions` tier you want
Roku to natively render at, or the OS's own single-tier auto-scaling silently absorbs the exact
problem `scale` exists to solve, and every `ft_scale(...)` call computes a no-op factor forever.
This is worth a loud comment in any app's manifest that uses `scale`, not just a documentation
footnote — GRAMMAR.md's "scale" section states this as a requirement now, not a suggestion.

## `query/app-ui`'s reported node `bounds` is the real, un-clipped rendered bounding box — not the node's own field values

**Live-verified 2026-08-12.** Debugging an apparent "scale isn't working" symptom (`cardRoot`
reporting `bounds="{0, 0, 484, 110}"` when `cardWidth`/`cardHeight` should have scaled to
`333`/`73`) turned out to be a correct, honest reading of two separate real facts, not a bug:

1. `m.top.cardWidth`/`m.top.cardHeight` WERE correctly `333`/`73` — confirmed via a direct
   `print` inside the component, and by reading the generated `init()`'s exact line order (the
   `ft_scale(...)` override runs before the field's own template-binding assignment reads it, so
   there's no ordering race).
2. ECP's `query/app-ui` `bounds` attribute reports each node's REAL on-screen bounding box,
   which — since Roku SceneGraph never clips a node's children to its own declared width/height
   by default (already documented in GRAMMAR.md's "Scroll-into-view" section for an unrelated
   reason) — is the union of the node's own rect AND every descendant's rect, even ones that
   render outside it. `484` was exactly `btnRight`'s own unscaled `translation.x (284) +
   width (200)`; `110` was exactly `statusLabel`'s own unscaled `translation.y (86) + ~24px text
   height`. Both children had hardcoded, never-`scale`d FHD positions in the first version of this
   fixture, so they visibly overflowed the now-smaller (333×73) scaled card.

**Fix applied**: every translation/width/height inside `RichCard.thr` is now `scale`d (widths/
heights via `scale field`, translations via `scale derived` returning a 2-element array — see
GRAMMAR.md's "scale" section, array scaling is element-wise). Re-verified live: `cardRoot` bounds
now report `{0, 0, 333, 81}` — width matches exactly; the residual `81` vs. the true `73` is
`statusLabel`'s own un-scaled text glyph height (Label nodes have no explicit height field to
scale — font/text metrics are a separate concern `scale` doesn't touch), not a scaling defect.
**Lesson for verifying `scale` (or any geometry feature) live**: read the actual field VALUE
(`print`/a debug field) as ground truth, not `query/app-ui`'s bounding-box report — the two answer
different questions (what did I compute vs. what pixels did something end up occupying), and a
partially-scaled fixture makes the second one misleading on its own.

## `installChannel` not guaranteeing a cold restart bit hard during live verification

**Live-verified 2026-08-12**, a second real instance of the exact failure mode
`findings/dev-environment.md` already documents (`installChannel` doesn't guarantee killing a
still-running instance). Sideloaded an update with the manifest fix above, then queried/navigated
the app WITHOUT an explicit `Home` + `launchApp('dev')` cold restart first — the resulting
navigation and reported bounds were internally consistent but came from the STALE, still-running
pre-manifest-fix instance (still auto-upscaled from a virtual FHD canvas), not the new build.
**Always force a cold restart (`keypress Home` → wait → `launchApp('dev')` → wait) immediately
after every `installChannel` before trusting anything queried afterward** — this is not optional
when verifying a change that affects rendering/resolution behavior specifically, since a stale
instance's visual output can look plausible enough to mistake for the new build's real behavior.

## Get `designResolution` right by checking the app's OWN existing hardcoded pixel values, not by guessing

**Live-verified 2026-08-12.** The sample app's `flash-theater.config.json` was first set to
`{"designResolution": "fhd"}` — a guess, not derived from anything. This looked fine in isolation
(`RichCard.thr`'s own `scale`d values computed correctly relative to that config), but broke visibly
the moment the WHOLE app was compared side by side at both resolutions: every root layout in this
app (`Shell.thr`'s `root` Rectangle, `CardsScreen.thr`'s own `root`, `SplashScreen.thr`'s `root`,
...) was **already hardcoded to `width="1280" height="720"`** — this app's real design baseline was
HD all along, not FHD. With the wrong config, the FHD build correctly computed `factor = 1.0` (no
scaling needed, by definition, since FHD *was* declared as the baseline) but the app's own
UNSCALED 1280-wide layout then only filled the left ~2/3 of a 1920-wide screen, leaving visible
blank space — this looked exactly like a scale bug from the outside, but was actually a config
error: `scale` was doing exactly what it was told, against the wrong baseline. **Fix**: changed
`designResolution` to `"hd"`, matching the app's actual authored pixel values. **Lesson for the
next app adopting `scale`**: `designResolution` isn't a free choice — audit the app's own existing
literal pixel values (root Rectangle widths/heights are the fastest tell) before choosing it,
don't default to whichever tier sounds more "modern."

## Partially applying `scale` doesn't just look inconsistent — it can break focus navigation between scaled and unscaled siblings

**Live-verified 2026-08-12.** After fixing `designResolution` and scaling `Shell.thr` +
`CardsScreen.thr` + `RichCard.thr` (but not yet `HomeScreen.thr` or the other screens), `Left` from
`HomeScreen`'s own `prompt` element stopped reliably reaching `Shell`'s sidebar menu at FHD. Root
cause: `Shell`'s menu items moved to new (correctly scaled ×1.5) absolute Y positions, but
`HomeScreen`'s own `prompt` element — still using its original hardcoded, unscaled translation —
stayed exactly where it always was. The two no longer vertically overlapped enough for the focus
system's geometric LRUD (`findings/focus-system.md`'s "genuinely overlaps the focused box on the
perpendicular axis" rule) to find a path between them at all. **This is a real functional
regression, not just a visual one** — a screen that was perfectly reachable before scaling anything
became unreachable by remote control once ONE of its two geometric neighbors scaled and the other
didn't. **Fix**: `scale` was applied throughout every remaining screen in the sample app (`Home`,
`Schedule`, `ScheduleList`, `Loading`, `Task`, `Stream`, `Request` demos, `FavoriteCounter`,
`SplashScreen`) so every screen's own elements move by the same app-wide factor, keeping their
relative alignment intact at any resolution. **Lesson**: `scale` adoption in an app with
cross-component LRUD dependencies (anything using the "y-aligned rows so `Right`-from-menu lands
correctly" pattern this app's own findings already document) is closer to all-or-nothing than
per-component — a half-migrated app can be BOTH visually inconsistent AND navigationally broken in
ways that only show up once you actually drive the remote at a non-native resolution, not from
reading the generated code.

## Changing the device's actual display resolution needs a real channel relaunch before `ft_scaleFactor` reflects it

**Live-verified 2026-08-12.** Switched the test device's real output back to 1080p (confirmed via
`GET /query/device-info`'s `<ui-resolution>1080p</ui-resolution>`) but kept driving the
already-running sideloaded channel without relaunching it first — every scaled value still
rendered shrunk as if the device were still at 720p. Root cause is the deliberate design itself,
not a bug: `ft_scaleFactor` is computed exactly ONCE, in `FlashTheaterSetupGlobals` at app boot
(see `findings/scale-config-and-codegen.md`'s "First compiler config file" section), specifically
so no component ever repeats a `GetDisplaySize()` call — it is never re-evaluated for the lifetime
of that running process. Flipping the device's output resolution does not restart an already-running
channel, so it keeps compositing with whatever factor it booted with. **Fix**: `Home` → relaunch the
channel (the same cold-restart discipline `findings/dev-environment.md` already documents for
`installChannel`, here triggered by a resolution change instead of a new build) — confirmed after
relaunch: `MainScene bounds="{0, 0, 1920, 1080}"`, `cardRoot bounds="{0, 0, 500, 122}"` (the exact
raw FHD-authored `500`, un-scaled — the correct `factor = 1.0` no-op case). **Lesson for anyone
testing `scale` (or reporting a "scale looks wrong" symptom)**: always ask/confirm whether the
channel was actually relaunched after the last resolution change — a stale-factor symptom looks
identical to a real scaling bug from the outside (values render at the WRONG size), but the fix is
a relaunch, not a code change.

## Reaching a specific deep route via blind ECP remote-control needs the REAL default route, not an assumed one

**Live-verified 2026-08-12.** Attempting to script a path to `apps/sample-app`'s Cards demo via
blind `keypress` sequences repeatedly produced inconsistent focus landings across otherwise
identical script runs — traced to two compounding mistakes, not device flakiness: (1) assuming the
default post-splash route was `/browse/schedule` (observed once, from a STALE app instance per the
finding above) when the real fresh-boot default route is `/browse` (`HomeScreen`); (2) `Left` from
deep inside `ScheduleList`'s row items does not reliably reach `Shell`'s sidebar menu (no valid
geometric LRUD candidate from that exact position — content and menu don't overlap enough on that
axis from every row). The reliable path from a genuine cold boot: `Select` (splash → `HomeScreen`,
focus on `HomeScreen`'s own default-focus prompt) → `Left` (prompt is close enough to the divider
to reach `menuHome` directly) → `Down` × N (sidebar order: Home, Schedule, Loading, Cards, Tasks,
Streams, Requests) → `Select`. **Lesson**: don't assume a router's default route or a deep-content
element's LRUD reachability to the menu — confirm both from an actual fresh cold boot via
`query/app-ui`'s `focused="true"` trail before scripting a longer navigation sequence.
