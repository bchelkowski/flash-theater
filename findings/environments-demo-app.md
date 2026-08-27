# environments — `apps/environments-demo` chapter/router app

A NEW, from-a-topic-not-a-migration chapter app (no predecessor to convert or split, same
situation as `apps/statements-demo`) — same skeleton as `apps/animation-demo`'s own
`MainScene.thr` (`router.setRouting`, `<FlashTheaterRouterOutlet>`, REWIND/FAST-FORWARD chapter
advance). Built for the `environments` doc-nav topic (`site/src/pages/docs/environments.astro`),
the last topic on `findings/demo-app-conventions.md`'s own "New chapter apps for topics with none
today" roadmap list — that list is now empty. See [demo-app-conventions.md](demo-app-conventions.md)
for the app-structure convention this instantiates and [environments.md](environments.md) for the
underlying feature's own design rationale.

## Why this app looks structurally different from every other chapter app

Every other chapter app can produce a genuine "plain" build (no `--env`/`FLASH_THEATER_ENV`) —
`env.*` is opt-in elsewhere, `apps/sample-app`'s own `EnvDemo.thr` is deliberately excluded from
its plain build for exactly this reason (see `environments.md`'s own entry). This app is the
opposite: **both of its chapters read `env.*`**, since the whole topic being demonstrated only
exists once an environment is active. That means:

- **There is no meaningful "plain" build of this app at all.** `flash-theater compile` with no
  `--env`/`FLASH_THEATER_ENV` fails outright (`expression/env-requires-active-environment`) the
  moment it reaches either chapter component — not a bug, the correct behavior, but it means this
  app can never be the one exception to "every demo app compiles with a bare `flash-theater
  compile`."
- **`apps/environments-demo/package.json`'s `compile`/`zip`/`build:roku` scripts are NOT the plain
  `flash-theater compile`/`flash-theater zip` every other app uses.** They delegate through
  `scripts/with-env.mjs`, a tiny Node wrapper that defaults `FLASH_THEATER_ENV` to `"dev"` (and
  `ENVIRONMENTS_DEMO_BUILD_LABEL`, this app's own `fromEnv` variable — see below) whenever the
  caller hasn't already set one, then spawns the real `flash-theater` CLI. This is what lets root
  `npm run build:roku` — which calls `npm run build:roku --workspace apps/environments-demo` with
  no `--env` of its own, same as every other app in that chain — still succeed. An explicit
  `FLASH_THEATER_ENV=prod npm run build:roku` (from this app's own directory, or piped through the
  root script) is left completely untouched; the wrapper only supplies a fallback, the same
  precedence `cli.ts` itself already gives `--env` over `FLASH_THEATER_ENV`.
- **`scripts/sideload.mjs` globs `dist/` instead of hardcoding a filename** — an environment
  build's zip is named `dist/environments-demo-<env>-<version>.zip` (the version comes from the
  final, patched manifest), so unlike every other app's fixed `dist/<app>.zip`, the exact filename
  can't be hardcoded without going stale on every manifest version bump.
- **Every chapter narrates instead of live-toggles wherever the real mechanic is inherently
  build-time** (see CLAUDE.md's own note on this topic's nature) — which environment is active,
  whether `env.thisNameIsNotDeclaredAnywhere` would compile, what a build with no environment at
  all would do. None of those can be demonstrated by pressing a button in a *running* app, since
  the failure/success was already decided at compile time, long before this binary existed.

## Chapters

- **`/variable-reads`** — `EnvVariableReadsDemo.thr`. Reads three declared variables from the
  active environment, each a different shape even though `env.<name>` is always a plain string
  (GRAMMAR.md's own "Not (yet) supported" — no real booleans/numbers): `apiBaseUrl` (a URL-shaped
  literal, `http://localhost:3000` in `dev` / `https://api.example.com` in `prod`),
  `enableBetaFeatures` (a feature-flag-shaped literal, `"true"`/`"false"` as strings — read back
  with `== "true"` if you need to branch on it, not shown branching here since neither chapter
  needed to), and `buildLabel` (sourced via `{ "fromEnv": "ENVIRONMENTS_DEMO_BUILD_LABEL" }`, a
  real build-time/CI variable rather than a config-file literal — the same variant
  `apps/sample-app`'s own `EnvDemo.thr` already proved, included here too since it's a materially
  different mechanism from the other two). A focusable button toggles a narration block explaining
  `unknown-env-variable`/`env-requires-active-environment` — both compile errors, so neither can be
  triggered live (see "Why this app looks structurally different" above).
- **`/overrides-and-manifest`** — `OverridesAndManifestDemo.thr`. Reads `env.environmentLabel`
  (a fourth declared variable, `"dev"`/`"prod"`, added specifically so a viewer can see which
  environment produced this exact build without guessing from `apiBaseUrl`'s host). Two live,
  concrete runtime proofs rather than narration alone:
  - **`manifestOverrides` really patched the shipped manifest** — a button calls the real Roku
    platform API `CreateObject("roAppInfo").GetTitle()` and displays the result next to a static
    baseline label showing `src/manifest`'s own un-overridden title, so a viewer can compare the
    two directly on screen. `roAppInfo` is unrelated to flash-theater itself (ordinary BrightScript
    surface, already used elsewhere in this codebase — `FavoriteCounter.thr`/`SplashScreen.thr`
    both call `CreateObject("roDeviceInfo")` the same direct way, no raw-passthrough wrapper
    needed), but it's the only way to prove the override took effect on the actual artifact being
    run rather than just trusting the config file's own stated intent.
  - **`include`/`exclude` glob patterns really changed which files were packaged** — a button calls
    `ReadAsciiFile("pkg:/images/dev-only/only-in-dev.txt")` and
    `ReadAsciiFile("pkg:/images/prod-only/only-in-prod.txt")` and displays both results side by
    side; exactly one reads back non-empty in any given build. This is why include/exclude was
    folded into this chapter rather than becoming its own routed `/include-exclude` chapter (the
    optional third chapter CLAUDE.md's task brief allowed skipping) — **a routed component can't
    cleanly gate on which environment built it**, since every entry in `MainScene.thr`'s
    `router.setRouting([...])` has to exist in *every* environment's own compiled output (the same
    reason `apps/sample-app`'s own `EnvDemo.thr` is never wired into its router — see
    `environments.md`). Two small, unreferenced placeholder text files (mirroring
    `apps/sample-app/src/images/staging-only/`/`production-only/`'s own pattern) sidestep that
    entirely.
  - Local overrides (`environments/<name>.local.config.json`) are narrated only — a static label
    explaining the mechanism and pointing at this app's own
    `environments/dev.local.config.json.example` (the checked-in copy-paste starting point, kept
    out of `.gitignore`'s `**/environments/*.local.config.json` pattern by the `.example` suffix,
    same convention `apps/sample-app/environments/staging.local.config.json.example` already
    established). There's genuinely nothing further to render live here — a real local override
    always wins the exact same `env.*` reads this chapter and chapter 1 already display, so a
    "toggle it live" demo would just be re-showing the same labels with different config-file
    inputs, which the "recompile with a different environment active" framing throughout this app
    already covers honestly.

## Environment configs

Two real environment config files, `environments/dev.config.json` and
`environments/prod.config.json`, differing in every declarable dimension:

| | `dev` | `prod` |
|---|---|---|
| `environmentLabel` | `"dev"` | `"prod"` |
| `apiBaseUrl` | `"http://localhost:3000"` | `"https://api.example.com"` |
| `enableBetaFeatures` | `"true"` | `"false"` |
| `buildLabel` | `fromEnv: ENVIRONMENTS_DEMO_BUILD_LABEL` | `fromEnv: ENVIRONMENTS_DEMO_BUILD_LABEL` (same var, same mechanism, deliberately not re-demoed as a second literal) |
| `manifestOverrides.title` | `"Flash Theater Environments Demo (Dev)"` | `"Flash Theater Environments Demo (Prod)"` |
| `exclude`/`include` | excludes `images/prod-only/**`, includes `images/dev-only/**` | excludes `images/dev-only/**`, includes `images/prod-only/**` |

The base `flash-theater.config.json` permanently excludes both `images/dev-only/**` and
`images/prod-only/**` — each environment's own `include` is what pulls its own subtree back in,
the same base-exclude/environment-reincludes shape `apps/sample-app`'s own
`environments/staging.config.json`/`production.config.json` established first.

## Real gotchas hit this session

- **A ternary is unreachable from a `derived`/`state` *declaration*'s own default — the FIRST draft
  of `/variable-reads`' "toggle validation notes" button used exactly that shape
  (`derived validationButtonText: string = showValidationDetails ? "Hide..." : "Show..."`) and it's
  wrong per GRAMMAR.md's own "Ternary" section** (only a plain bare assignment's or `state <name>
  = ...` write's entire right-hand side, never a declaration default). Caught before ever
  compiling, by re-reading GRAMMAR.md's ternary section against the draft — fixed by making
  `validationButtonText`/`validationDetailsText` plain `state` variables written from inside
  `toggleValidationDetails()`'s own `if`/`else`, matching CLAUDE.md's own gotcha list.
- **`ReadAsciiFile`/`MatchFiles` are real BrightScript builtins already in this compiler's own
  identifier-resolution whitelist** (`kopytko-brightscript-parser`'s `builtinNames` — confirmed via
  `node -e "require('kopytko-brightscript-parser').builtinNames.has('readasciifile')"` before
  writing any DSL code, since neither name had a prior usage anywhere in this repo to copy from,
  unlike `CreateObject`/`CreateObject("roDeviceInfo")` which several existing `.thr` files already
  call directly). Both resolve and compile with zero special handling — no raw-passthrough needed,
  the same direct-call pattern `FavoriteCounter.thr`'s `CreateObject("roDeviceInfo").GetModel()`
  already uses. This is genuinely the first time this repo's own demo apps read a file back off the
  package filesystem at runtime to prove a *build-time* packaging decision, rather than just
  trusting the config file's stated intent.
- **`environment-config/missing-env-var` fires from a bare `npm run build:roku --workspace
  apps/environments-demo` unless the `fromEnv` variable is also defaulted** — the first working
  version of `scripts/with-env.mjs` only defaulted `FLASH_THEATER_ENV`, and compiling still failed
  (`buildLabel` declared `{ "fromEnv": "ENVIRONMENTS_DEMO_BUILD_LABEL" }`, unset in this shell).
  Two genuinely separate compile errors gate this app's build in sequence — no active environment
  at all, then (once that's fixed) an active environment's own unset `fromEnv` var — and root
  `npm run build:roku` has to survive both with zero manual setup, so the wrapper defaults BOTH
  environment variables, not just the one CLAUDE.md's task brief called out by name.
- **`npm` on Windows needs `shell: true` in `spawnSync` to resolve `flash-theater`/`kopytko-roku`
  from `node_modules/.bin`** — those are `.cmd` shims on Windows, not directly executable by
  `child_process.spawnSync` without a shell; both `with-env.mjs` and `sideload.mjs` pass
  `shell: true` for this reason. Confirmed working on this session's actual Windows dev box (see
  `findings/dev-environment.md` for the broader native-Windows-Node context) — not yet confirmed on
  macOS/Linux CI, though `shell: true` should resolve the equivalent plain-executable shim there
  too since it isn't Windows-`.cmd`-specific behavior.

## Live-device-confirmed — both chapters, both environments, zero bugs found

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`) — sideloaded BOTH the `dev` and
`prod` zips (built via `FLASH_THEATER_ENV=prod npm run build:roku`), confirming every claim this
app makes actually holds on the real, running artifact of each environment, not just in generated
source:

- **`/variable-reads`**: `env.apiBaseUrl`/`env.enableBetaFeatures` correctly flipped between builds
  (`http://localhost:3000`/`true` on dev, `https://api.example.com`/`false` on prod);
  `env.buildLabel` (the `fromEnv` variant) read `local-dev` on both, since both builds this session
  shared the same `ENVIRONMENTS_DEMO_BUILD_LABEL` default — expected, not a bug (the mechanism is
  what's demonstrated, not a specific value). "Show validation rules" confirmed toggling the
  narration label with no glitches.
- **`/overrides-and-manifest`**: the two on-device-only proofs this chapter exists for both
  confirmed genuinely reflecting the shipped artifact, not just the config file's stated intent —
  `roAppInfo.GetTitle()` read `Flash Theater Environments Demo (Dev)` on the dev sideload and
  `Flash Theater Environments Demo (Prod)` on the prod sideload (the channel's own plugin name in
  `queryAppUi` matched both times too); `ReadAsciiFile` against the two placeholder files showed
  exactly one present per build, correctly reversed — dev-only present/prod-only absent on the dev
  sideload, flipped on the prod sideload.

Root `npm test`/`npm run lint`/`npm run build:roku` already green — no changes needed for this app.
This was the last of the 11 apps pending a device pass — see `findings/demo-app-conventions.md`.

**Device-found and fixed 2026-08-26**: `EnvVariableReadsDemo.thr`'s own title and
`OverridesAndManifestDemo.thr`'s own local-overrides note had both manually pre-escaped a literal
`<`/`>` (`env.&lt;name&gt;`) — rendered as the literal entity code on screen instead of `env.<name>`.
See [template-attribute-value-escaping.md](template-attribute-value-escaping.md) for the general
rule; fixed by writing the raw character in both places.
