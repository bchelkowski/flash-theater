# theme — `apps/theme-demo` chapter/router app

A genuinely new chapter app (no predecessor to split, no prior embedded example besides
`apps/sample-app`'s own `Theme.thr`/`Dark.thr`/`Light.thr`) — the `theme` doc-nav topic
(`site/src/pages/docs/theme.astro`) had no dedicated app before this. See
[demo-app-conventions.md](demo-app-conventions.md) for the router+scale/chapter convention this
instantiates, and [reactivity-theme-parsing.md](reactivity-theme-parsing.md) for the underlying `theme`
design this app doesn't re-derive.

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`), all 3 chapters, zero bugs found.
Chapter 1's fallback chain confirmed exactly as documented: switching to sunset showed
`colors.background`/`colors.accent` at sunset's own override values while `colors.text`/
`spacing.gutter`/`spacing.cardPadding` stayed at the TEMPLATE's defaults (`0xCCCCCCFF`/`24`/`12`),
not ocean's. Chapter 2 (read-only) confirmed the app-wide theme singleton stays consistent across a
chapter switch — `defaultSwatch` (via a `derived`) and `directSwatch` (direct inline `theme.a.b`)
both showed the identical sunset-carried-over color, and `spacing.gutter` correctly still read the
template default. Chapter 3 confirmed the full-screen retint (`root`'s own background flipped from
sunset's `0x3D1F0FFF` to ocean's `0x0B2545FF` on a "Switch to ocean" press) and the unknown-name
no-op exactly as documented: pressing "Switch to doesNotExist" updated `lastRequestedReadout` to
`doesNotExist` but left `activeVariantReadout` and the actual background color both unchanged at
`ocean`/`0x0B2545FF` — accepted, no crash, previous theme stayed active.

Root `npm test`/`npm run lint`/`npm run build:roku` already green — no changes needed for this app.

## The theme itself

`src/components/Theme/` — `Theme.thr` (the `<theme-template default="ocean">`, 2 groups:
`colors` {`background`/`text`/`accent`}, `spacing` {`gutter`/`cardPadding`}), `Ocean.thr` (a
**full** override — all 5 leaves), `Sunset.thr` (a **partial** override — only
`colors.background`/`colors.accent`). File names/location are free choices per GRAMMAR.md's
"Theme" section (the compiler finds `<theme-template>`/`<theme>` structurally, by root tag, not
filename) — nothing in `MainScene.thr` references them.

Deliberately, the template's own literal defaults for the leaves `Sunset.thr` omits
(`colors.text = 0xCCCCCCFF`, `spacing.gutter = 24`, `spacing.cardPadding = 12`) are distinct from
both variants' own values, so a reader can tell at a glance whether a rendered value came from the
active variant or fell through to the template — confirmed in the generated
`FlashTheaterTheme.brs`: `sunset`'s own per-variant table carries `text: "0xCCCCCCFF"` (the
template's default, copied in at compile time since the variant didn't declare it), not
`"0xEAF4FFFF"` (ocean's).

## Chapters

- **`/theme-template`** (`ThemeTemplateDemo.thr`). Default: boots with `ocean` active (the
  template's own `default="ocean"`), readouts for all 5 leaves plus two color swatches all show
  ocean's own values. Customized: pressing "Show sunset" calls `switchTheme("sunset")` — the
  `colors.background`/`colors.accent` readouts and swatches change to sunset's own values, while
  `colors.text`/`spacing.gutter`/`spacing.cardPadding` stay at the TEMPLATE's defaults, not
  ocean's — the concrete, on-screen version of the fallback-chain rule.
- **`/theme-access`** (`ThemeAccessDemo.thr`). Default: `bgColorFromDerived` (a `derived` reading
  `theme.colors.background`) feeds `defaultSwatch`'s own `color="{bgColorFromDerived}"` binding.
  Customized: three more theme paths read simultaneously — two still through their own `derived`
  (`textColorFromDerived`, `accentColorFromDerived`) and one, `directSwatch`, reading
  `theme.colors.background` **directly inline** in its own `color="{theme.colors.background}"`
  binding, no `derived` in between. `directSwatch` and the default example's `defaultSwatch` read
  the identical path and always render the identical color — the app-wide theme singleton feeds
  every reader from the same live snapshot, not staggered per-binding reads. This chapter has no
  buttons of its own — it's a pure readout screen, so its `default-focus="true"` sits on a
  non-interactive wrapping `Rectangle` (`card`), mirroring
  `apps/animation-demo/src/components/OutletTransitionsDemo/OutletTransitionsDemo.thr`'s own
  focusable-but-inert card, since a router-mounted chapter still needs SOME focusable element for
  the router's default-focus claim even when nothing on the screen is actionable.
- **`/switch-theme`** (`SwitchThemeDemo.thr`). Default: "Switch to ocean"/"Switch to sunset"
  toggle between chapter 1's own two variants, with `root`'s own
  `color="{theme.colors.background}"` binding visibly retinting the WHOLE screen on every press
  (not an isolated readout). Customized: "Switch to doesNotExist" calls `switchTheme()` with a
  name no `<theme name="...">` file declares — `lastRequestedText` (updated on every press,
  known or not) keeps reading `"doesNotExist"` afterward, while `activeVariantText` (updated only
  after a KNOWN-name press) and the actual background color both stay exactly what they were
  before, demonstrating the documented no-op directly: accepted, nothing crashed, previous theme
  stayed active.

## Real gotcha: a theme leaf can't have a method chained directly onto its own `theme.a.b` path

Writing `theme.spacing.gutter.ToStr()` (needed to turn an `integer` leaf into display text)
throws `expression/theme-path-through-leaf`: `"theme.spacing.gutter.ToStr" indexes through
"spacing.gutter", which is a leaf value, not a group.` — confirmed against
`packages/compiler/src/analysis/global-bindings.ts`'s `resolveThemePath`, which walks every
segment after the `theme` root looking for a declared group/leaf member; whatever collects the
dot-chain segments for this validation doesn't stop at the leaf and doesn't recognize a trailing
`(...)` call as anything other than one more member-access segment, so `.ToStr` gets treated as
an attempt to index further into an already-resolved leaf.

**Workaround, used throughout this app**: read the leaf into its own typed `derived` first, then
call the method on THAT derived's name instead of on `theme.*` directly — the second derived is
an ordinary identifier reference at that point, not a theme path, so it never re-enters
`resolveThemePath` at all:

```
derived gutterValue: integer = theme.spacing.gutter
derived gutterReadoutText: string = "spacing.gutter = " + gutterValue.ToStr()
```

Only bites integer/float theme leaves that need stringifying for display (or any leaf needing
*any* trailing method call) — a `string` leaf used as-is (e.g. directly as a `color=` value) never
hits this, since nothing gets chained onto it.

## What this app does NOT exercise

- **`<theme-template>`/`<theme>` compile-time error paths** (`theme/multiple-templates`,
  `theme/duplicate-variant-name`, `theme/variant-unknown-member`, indexing through a leaf as if it
  were a group) — all covered by `packages/compiler/test/app-compiler.test.ts`'s own describe
  block, not re-demonstrated here; this app only ever compiles a single valid template + 2 valid
  variants.
- **A group nested more than one level deep** — both `colors` and `spacing` here are flat
  (leaves only, no nested sub-group), unlike GRAMMAR.md's own claim of "unbounded nesting."
  `apps/sample-app`'s `Theme.thr` is equally flat — this repo has no live example of a
  genuinely 2+-level-nested theme group anywhere yet.
- **A `node`/`array`/`assocarray`-typed theme leaf** — every leaf across all 3 chapters is
  `string` or `integer`; `boolean`/`float` (both in the closed leaf-type set, same as `field`)
  are also unused here.
- **The three-tier initial-variant fallback's 2nd/3rd tiers** — `Theme.thr` always declares an
  explicit `default="ocean"`, so tier 1 (`default="name"`) is exercised on every boot; "no
  `default` attribute, falls back to first-declared variant" and "no variants at all, falls back
  to the template's own literals" are both documented in GRAMMAR.md but never actually exercised
  by this app's own compile.
