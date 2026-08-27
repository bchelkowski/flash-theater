# Environments — build-time variables, manifest patch, file include/exclude

`env.<name>`, `environments/<name>.config.json`, `--env`/`FLASH_THEATER_ENV`, `out-<env>/`,
`environments/<name>.local.config.json`. See GRAMMAR.md's "Environments" section for the full
user-facing grammar/config shape — this file is the *why*, not the *what*.

## `env` validates like `theme`, not like `store`/`router`

`store`/`router` are schemaless because there's genuinely no way to know a store key's or a route's
`params` shape at compile time. An environment's variable set has no such excuse — it's declared,
in full, in that environment's own config file, read before any `.thr` file is compiled. So `env`
went through the exact same generic dot-chain mechanism `theme.a.b` uses
(`GLOBAL_ROOT_NAMES`/`findGlobalPathAccesses`/`resolveGlobalPath` in `analysis/identifier-rewrite.ts`/
`analysis/global-bindings.ts`), not a redesigned three-production grammar like `store`. This buys two
real diagnostics for free: `expression/env-requires-active-environment` (no active environment) and
`expression/unknown-env-variable` (declared elsewhere but not in the active one) — both compile
errors instead of a runtime `invalid` field read. `GlobalBindingsContext.envVariableNames` is
`undefined` for "no environment," a present-but-empty `Set` for "environment active, zero variables
declared" — collapsing those two would silently turn the first diagnostic into the second, a worse
error message for a very different mistake.

## No runtime asset — `ft_env` is a literal, not a node

Store/Theme/FocusManager/Router/TaskManager are all `runtime-assets/*` SceneGraph components,
copied via `cli.ts`'s `copyRuntimeAsset` and instantiated with `CreateObject("roSGNode", "...")` in
`FlashTheaterGlobals.brs`. `env` needed none of that — its values are fixed at compile time and
never reassigned at runtime, so `scale`'s `ft_scaleFactor` (a plain number baked directly into
`emitFlashTheaterGlobalsBrs`'s generated `.brs`) is the correct precedent, not Store's. `ft_env` is
one `globalNode.addFields({ ft_env: { "name": "value", ... } })` line, using `codegen/naming.ts`'s
`brsStringLiteral` for both keys and values so a value containing `"` doesn't break codegen.

## `usesEnv` is decided post-hoc, unlike `usesRouter`/`usesTaskManager`

`router`/`taskManager` need a dedicated pre-emission raw-text AST scan
(`usesRouterAnywhere`/`textHasRouterAccess`/...) because their codegen has real ordering
dependencies (trampoline subs, `init()`-time registration) that have to be decided before `.brs` is
even emitted. `env` has none of that — like `usesComparisonHelper`, `compile.ts` just checks
`brs.includes(GLOBAL_FIELD_NAMES.env)` on the already-emitted string, and `class-emitter.ts` does
the identical `brs.includes(...)` check for `.flsh` classes. This is also why `.thr` and `.flsh`
detection are symmetric for `env` in a way router/taskManager's aren't (those need genuinely
different detection mechanisms for the two file kinds — see `class-pipeline.md`).

## Splicing only the root token — the one real bug hit building this

`identifier-rewrite.ts`'s theme-leaf branch splices only `[access.rootStart, access.rootEnd)` (the
bare `"theme"` token), leaving the original `.colors.primary` member text after it untouched — the
replacement is just `globalFieldRef('theme', accessRoot)` (`"m.global.ft_theme"`), not the full
path. The first `env` implementation replaced with `` `${globalFieldRef('env', accessRoot)}.${resolution.name}` ``
instead, duplicating the member: `env.apiBaseUrl` compiled to
`m.global.ft_env.apiBaseUrl.apiBaseUrl`. Fix: mirror the theme-leaf splice exactly — replacement is
just `globalFieldRef('env', accessRoot)`, letting the untouched trailing `.apiBaseUrl` in the
original text do its own job. Caught immediately by actually building `apps/sample-app`'s
`--env staging` output and reading the generated `.brs`, not by a unit test in isolation (the unit
tests exercise the splice with a real dot-chain too, but this specific duplication only became
obvious staring at real generated output) — worth remembering next time a new global root's
splice logic is written from the theme precedent instead of copy-pasted from it.

## `include` needed a real algorithmic change to `walkSrcTree`, not just a new field

`walkSrcTree`'s exclude fast-path skips a matched-excluded directory without ever descending into
it. `include` breaks that: a file that should be exempted from exclusion can be arbitrarily deep
inside an otherwise-excluded directory, so the walker can't know to look unless it descends. Fix:
`walkSrcTree` takes a third `include` parameter; when it's non-empty, EVERY directory is descended
into regardless of exclusion (exclusion is then decided per-file via `isExcludedNotIncluded`), and
when it's empty (every build with no active environment, or one that doesn't declare `include`) the
original fast path is preserved exactly — confirmed via a test asserting `walkSrcTree(dir, exclude)`
and `walkSrcTree(dir, exclude, [])` return identical results. Tradeoff accepted deliberately: an
environment build with even one `include` pattern loses the "skip whole excluded subtree" fast path
for every excluded directory in that build, not just the one the pattern targets — fine given real
app source trees are small (dozens to low hundreds of files), and correctness (a file `include`
should reach staying unreachable) matters more than this specific optimization.

## Packaging moved into the compiler (`flash-theater zip`) — fixes a latent per-app `zip.mjs` gap

Each app used to carry its own `scripts/zip.mjs` (byte-identical across all four apps except the
output filename), hardcoding the literal `out`/`out-<env>` rather than calling
`resolveProjectLayout` — it had no knowledge of `flash-theater.config.json`'s `outDir` override at
all, a latent inconsistency for any app that both overrode `outDir` and adopted environments. Each
`zip.mjs` also duplicated a ~15-line copy of `readManifestVersion` rather than importing
`packages/compiler/src/manifest.ts`'s version, specifically to avoid taking a dependency on the
compiler package for one small function.

Moving zipping into the compiler itself (`packaging.ts`'s `writeAppZip`, dispatched via `cli.ts`'s
`zip` command) fixes both by construction: `runZipCommand` calls the exact same
`resolveProjectLayout` `compile` does, so `--out-dir`/`flash-theater.config.json`'s `outDir` are
honored correctly regardless of whether an environment is active; `writeAppZip` imports
`readManifestVersion` directly, so there's nothing left to keep in sync by hand. See
`build-layout.md`'s "`dist/` and `flash-theater zip`" entry for what replaced `zip.mjs` in each app.

One deliberate simplification worth knowing: `zip`'s `--env <name>` does **not** load or validate
`environments/<name>.config.json` the way `compile --env` does — `resolveProjectLayout`'s `outRoot`
only depends on `outDir` and the env *name* (for its `-<env>` suffix), never on that config file's
contents, so `zip --env <name>` only requires that `out-<name>/` already exists from a prior
`compile --env <name>`, not that the environment config file is still present at zip time.

## `environments/<name>.config.json` rejects unknown top-level keys — deliberately stricter than the base config

`flash-theater.config.json`'s `loadFlashTheaterConfig` silently ignores unrecognized keys.
`loadFlashTheaterEnvironmentConfig` does not (`environment-config/unknown-key`) — the single most
likely mistake here is someone assuming `designResolution`/`srcDir`/`outDir` are overridable
per-environment (they explicitly are not; those stay base-config-only, app-wide settings), and a
silently-ignored key would hide exactly that mistake instead of surfacing it.

## Local overrides (`environments/<name>.local.config.json`) reuse the same type/loader

No second config type — `environments/<name>.local.config.json` is validated by the exact same
`loadFlashTheaterEnvironmentConfig`, just merged with higher precedence via `config.ts`'s
`mergeEnvironmentConfigs` (`local` wins per-key on `variables`/`manifestOverrides`, including
introducing a variable key the committed file never declared — e.g. a developer's own sandbox-only
secret; `exclude`/`include` concatenate, committed patterns first). This is the `.env.local`-style
escape hatch: optional, git-ignored (`**/environments/*.local.config.json` in the root
`.gitignore`), picked up automatically whenever that environment is selected, no extra flag. The
checked-in `environments/<name>.local.config.json.example` (the `.example` suffix keeps it OUT of
the gitignore pattern) is the copy-paste starting point — see `apps/sample-app/environments/`.

## `apps/sample-app`'s fixture: `EnvDemo.thr` is excluded from the plain build by construction

`env.*` is a hard compile error with no active environment, so `EnvDemo.thr` (the component
proving `env.apiBaseUrl`/`env.buildLabel` compile and resolve) could never be part of the plain
(no `--env`) build in the first place — it's excluded via the base `flash-theater.config.json`'s
own `exclude: ["components/EnvDemo/**", ...]`, and each of `staging`/`production`'s own `include`
re-includes it. This is also why it's NOT wired into `MainScene.thr`'s router — a route referencing
a component name that doesn't exist in a given build's own `out/` would be a latent (if
never-triggered, since nothing navigates there) landmine in the base build's compiled routing
table. `staging`/`production`'s own `images/<env>-only/` placeholder files are plain `.txt`, not
real images — sufficient to prove the include/exclude mechanics since neither is referenced from
any `.thr` template or the manifest; a real image adds nothing a text file doesn't already prove
here.
