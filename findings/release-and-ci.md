# CI and npm-release infrastructure

`.github/workflows/` follows a conventional npm-package CI/release shape: lint + test + a full
`build:roku` compile on every push/PR (`ci.yml`), a GitHub Pages deploy for `site/` (`gh-pages.yml`),
and a manual `workflow_dispatch` release per publishable package (version bump → conventional-commit
changelog → tag → GitHub Release → `npm publish --provenance`) in `release-flash-parser.yml`/
`release-compiler.yml`.

## `npm ci` doesn't link a workspace package's `bin` if its target file doesn't exist yet — breaks `build:roku` on a genuinely fresh clone

**Found live on the real first CI run after going public** — `ci.yml`'s `npm run build:roku` step
failed with exit code 127 (`'flash-theater' is not recognized`/`command not found`), even though
this exact command had succeeded dozens of times during development. The difference: every local
run during development reused a `node_modules/` that had already had `npm install`/`npm ci` run
*after* `packages/compiler/dist/bin/flash-theater.js` existed at least once, so the workspace
`"bin"` symlink (`node_modules/.bin/flash-theater`) was already there and just persisted. A
genuinely fresh `npm ci` (exactly what CI does, and what a new contributor's first clone does) runs
*before* `dist/` exists (`dist/` is gitignored, only produced by `npm run build`) — and confirmed by
direct reproduction (fresh clone, `npm ci`, then `npm run build --workspace packages/compiler`):
npm does **not** retroactively create the bin symlink once the target file shows up later in the
same session. Only running `npm install` again (not `npm ci` — a full install, not the lockfile-only
one) after the target exists actually links it.

**Fixed**: root `package.json`'s `build:roku` script now runs a plain `npm install` immediately
after building `packages/compiler`, before any app's own `build:roku` (which calls `flash-theater
compile` by name, relying on that symlink) — `... && npm run build --workspace packages/compiler &&
npm install && npm run build:roku --workspace apps/sample-app && ...`. Verified by a from-scratch
fresh clone + `npm ci` + `npm run build:roku` completing cleanly (all 15 apps) with the fix, and
failing with the exact same exit 127 without it.

## `site/`'s own `npm ci` alone is NOT enough to build it — the root workspace has to be installed too

**Also found live, same "works locally because of leftover root state" pattern as the bug above.**
`ci.yml`'s "site" job and `gh-pages.yml`'s "build" job both used to run `npm ci` scoped to `site/`
only (`working-directory: site`), never touching the repo root. This built fine locally in every
dev session (the root workspace was already installed from unrelated work) but failed on a
genuinely isolated checkout with:

```
[vite]: Rollup failed to resolve import "kopytko-brightscript-parser" from
".../packages/compiler/src/validate-generated-brs.ts".
```

**Root cause**: `site/astro.config.mjs`'s Vite aliases point `flash-theater-compiler/compile` and
`flash-parser` straight at `packages/compiler/src/compile.ts`/`packages/flash-parser/src/index.ts`
(source, not a published/built artifact — deliberately, so the playground always reflects the
latest compiler). `compile.ts` transitively imports `validate-generated-brs.ts`, which imports the
real npm dependency `kopytko-brightscript-parser`. Node/Rollup's module resolution for a bare
import inside `packages/compiler/src/validate-generated-brs.ts` walks **up from that file's own
directory** (`packages/compiler/src/` → `packages/compiler/` → `packages/` → repo root) looking for
`node_modules/kopytko-brightscript-parser` — it never looks inside `site/node_modules/`, since
`site/` is a **sibling** directory of `packages/`, not an ancestor of anything under `packages/`.
Adding `kopytko-brightscript-parser` to `site/package.json` directly (the first fix attempted,
confirmed **not** to work by testing it in isolation) does nothing, because it installs into the
wrong `node_modules` for this specific resolution path.

**Fixed**: both jobs now run a plain root-level `npm ci` (no `working-directory`) immediately before
the `site`-scoped `npm ci`/build — this is what actually needed to exist:
`packages/compiler`'s own declared dependencies, installed into the root workspace's shared
`node_modules`, reachable by walking up from `packages/compiler/src/`. Verified in full isolation:
a fresh clone with only `site/`'s own `npm ci` run reproduces the exact failure above; running the
root `npm ci` first (matching the fixed workflow order) builds clean, all 19 pages.

## GitHub Actions `run:` steps default to `bash -eo pipefail` — a `grep` with zero matches kills the whole step

Both release workflows' changelog-generation step builds `BREAKING`/`ADDED`/`FIXED`/`CHANGED`/
`MAINTENANCE` sections by piping `git log` commit subjects through `grep -E "..."` per category.
**First-draft version had a real bug, caught by an independent audit, never by reading the script**:
GitHub Actions runs every bash `run:` step as `bash --noprofile --norc -eo pipefail {0}` — `set -e`
+ `pipefail` both active — so the instant any one category has zero matches (the normal case; not
every release has a `fix` commit), `grep`'s exit 1 propagates through the pipe and aborts the whole
step immediately, before the changelog is even written, let alone tag/push/publish. **Every grep in
this script needs `|| true`** (`{ grep -E "..." || true; }`, not a bare `grep -E "..."`) so an empty
category degrades to an empty string instead of killing the job. Verified by extracting the exact
script and running it standalone with `bash --noprofile --norc -eo pipefail`, both for a
mixed-results case and for the all-categories-empty case (confirms the `wc -l`-based "- Release
$VERSION" fallback below it still fires correctly once the crash is fixed).

**Related bug fixed in the same pass**: the per-category patterns used `\($SCOPE\)!?:` (optional
`!`), which also matches a breaking-change commit (`feat(scope)!: ...`) — so a breaking commit was
double-listed under both "### Breaking Changes" (matched by its own dedicated `!:`-only pattern)
and "### Added"/whichever type it was. Fixed by dropping `!?` from the type-specific patterns
(`\($SCOPE\):` only) so `BREAKING`'s own `!:`-only grep is the sole place a breaking commit's line
appears.

## `dist/` is gitignored — `npm publish` needs an explicit `"files"` field or it ships empty

Both `packages/flash-parser` and `packages/compiler` write compiled output to `dist/`, and the
root `.gitignore` excludes `dist/` repo-wide. Without a `"files"` field, npm's default packing
falls back to `.gitignore` as its exclude list — so a bare `npm publish` would ship a tarball with
**no compiled JS at all** (silently "succeeds," installs, then fails at `require()` time). Fixed
by adding `"files": ["dist"]` (`packages/flash-parser/package.json`) / `"files": ["dist",
"runtime-assets"]` (`packages/compiler/package.json`, see below) plus `"prepublishOnly": "npm run
clean && npm run build"`, so publish always ships a fresh build regardless of what's gitignored.
Verify with `npm pack --dry-run` inside the package directory before ever trusting a release
workflow's publish step — it lists exactly what would ship.

## `packages/compiler`'s npm package must also ship `runtime-assets/`, not just `dist/`

`cli.ts`'s `copyRuntimeBrsAsset` locates `runtime-assets/<name>` via `join(__dirname, '..',
'runtime-assets', ...)` relative to the **compiled** file's own location (`dist/src/cli.js` or
`dist/bin/flash-theater.js`), i.e. one level above `dist/`, at the package root — not inside
`dist/` itself. `runtime-assets/` isn't compiled by `tsc` (it's `.brs`/`.xml`, not `.ts`), so it
needs its own top-level `"files"` entry alongside `"dist"` or every `flash-theater compile` run
from an npm-installed copy throws `internal: could not locate runtime-assets/<name>`.

## `packages/compiler`'s own test suite requires `packages/flash-parser` to already be built

`packages/compiler/test/**/*.test.ts` imports `flash-parser` by package name (`import { parse,
ThrFile } from 'flash-parser'`), which resolves through `node_modules/flash-parser` (the
workspace symlink) to that package's `"main"` field (`dist/src/index.js`) — there is no
TS-path-mapping shortcut to `flash-parser`'s source, so its `dist/` must exist before `mocha`
(via the `tsx` require hook) can run a single compiler test. The root `npm test` script already
encodes this ordering (`build flash-parser` → `test flash-parser` → `test compiler`) — any
workflow step that `cd`s into `packages/compiler` and runs its own `npm test` directly (bypassing
the root script) must build `flash-parser` first, or every compiler test fails on module
resolution. `flash-parser`'s own test suite has no such self-dependency (it only needs the
already-published `kopytko-brightscript-parser`), so its release workflow's test step can run
standalone from its own package directory.

## Publishing needs npm Trusted Publisher (OIDC) — and it CANNOT be configured before a package exists

`npm publish --access public --provenance` (used in both `release-flash-parser.yml` and
`release-compiler.yml`) needs `id-token: write` permission in the workflow (already set) **and**
npm's Trusted Publisher config for that exact package name. Read npmjs.com's own Trusted
Publishing docs in full (not just skimmed) — the setup flow is "navigate to **your package
settings** on npmjs.com → Trusted Publisher," and every step, troubleshooting note, and example
in that doc assumes the package already exists. There is no "pending publisher for a name that
isn't published yet" mechanism (unlike PyPI's own trusted-publishing feature, which this is
otherwise modeled after) — confirmed by checking `npmjs.com/package/flash-parser` directly
(`package 'flash-parser' not found`, no settings page to configure anything on) and by npm's
"Creating and publishing unscoped public packages" doc, whose only path to creating a new package
is an ordinary authenticated `npm publish`.

**This means neither release workflow can be used for the very first publish of either package —
there is no fallback to token auth in either workflow, so the first run would fail with
`ENEEDAUTH`.** Required one-time bootstrap, per package, before the automated workflow can ever
be used for it:
1. `npm login` locally (the repo owner's own npm account).
2. `cd packages/flash-parser && npm publish --access public` by hand — this both creates the
   package on the registry AND consumes version `0.0.1` (whatever `package.json` currently says).
   Repeat for `packages/compiler`.
3. *Only now* does each package have a "package settings" page — go configure Trusted Publisher
   there (Organization: `bchelkowski`, Repository: `flash-theater`, Workflow filename: exactly
   `release-flash-parser.yml` / `release-compiler.yml` — filename only, no `.github/workflows/`
   prefix, case-sensitive, npm does not validate this at save time, only at the next publish
   attempt).
4. From here on, `release-flash-parser.yml`/`release-compiler.yml` work as designed — every
   subsequent version bump publishes via OIDC, no stored token anywhere.

**Publish this repo publicly BEFORE running either release workflow, not after**: npm's automatic
provenance generation (what `--provenance` requests) requires "publishing from a public
repository" as one of three hard conditions — "Provenance generation is not supported for private
repositories, even when publishing public packages" (npm's own wording). Do the manual bootstrap
publish above only after flipping the GitHub repo to public, or the very first publish either
silently ships with no provenance attestation or fails outright, depending on which flag path npm
takes for a private-repo `--provenance` request (not worth finding out by trial).

**One more thing npm's docs call out as a common pitfall, worth a look if either publish ever
fails with a repo-mismatch-shaped error**: "your package's `repository.url` field in package.json
must exactly match your GitHub repository." Both `packages/flash-parser/package.json` and
`packages/compiler/package.json` already use the plain
`https://github.com/bchelkowski/flash-theater.git` form (matching this repo exactly) — this
should already be fine, flagged here only because it's the first thing to check if publish ever
complains about the repository, not because anything looks wrong today.

## `packages/compiler`'s dependency on `flash-parser` — real semver, not a workspace wildcard

`"flash-parser": "*"` only resolves inside this npm-workspaces monorepo (root `"workspaces":
["packages/*", "apps/*"]` symlinks it locally regardless of version). Anyone installing
`flash-theater-compiler` from the public npm registry outside this repo needs a real resolvable
range — changed to `"^0.0.1"`, matching `flash-parser`'s current published-intent version. npm
workspaces still prefers the local workspace package over the registry as long as its own
`"version"` satisfies the declared range, so this doesn't change local dev at all.
`release-flash-parser.yml`'s last two steps re-`npm install flash-parser@<new-version>` inside
`packages/compiler` and commit the bump — the standard "update dependents" shape any monorepo
needs whenever a shared package releases and its own consumers must have their declared version
range bumped in the same flow; here there's exactly one dependent (`packages/compiler`).

**First draft had a pointless registry-propagation retry loop before this install** (5 attempts,
15s apart, polling `npm view flash-parser@<version>`) — removed after an audit pointed out it
guards nothing: `flash-parser` is a workspace member, and by the time this step runs the earlier
"Bump version" step (same job) has already set `packages/flash-parser/package.json`'s own
`"version"` to exactly `<new-version>`, so `npm install "flash-parser@<version>"` from inside
`packages/compiler` resolves to the **local workspace symlink**, never the registry, regardless of
propagation state — confirmed against the real `package-lock.json`'s `"node_modules/flash-parser":
{"resolved": "packages/flash-parser", ...}` entry. The wait loop just burned up to 75s without
verifying anything real (it also had no failure path — a `for`/`break` loop with nothing after it
that checks whether it actually broke out on success).

**Confirmed the local-symlink claim above with a real experiment, not just re-reading the
lockfile**: bumped `packages/flash-parser/package.json`'s version to `0.0.2` locally, then ran
`npm install "flash-parser@0.0.2" --offline` from inside `packages/compiler` — `--offline` makes
npm hard-fail if it would need the network for anything. It succeeded (`up to date, audited 215
packages`), `npm ls flash-parser` showed the link (`flash-parser@0.0.2 -> .\packages\flash-parser`),
and the regenerated lockfile entry had `"link": true`. Zero network access needed, confirmed, not
assumed.

## A `flash-parser` release does NOT bump `packages/compiler`'s own npm version — and at `0.0.x`, that's a real gap, not just a formality

The "update dependents" step above only rewrites `packages/compiler/package.json`'s own
`dependencies.flash-parser` field and commits it — it does **not** touch `packages/compiler`'s own
`"version"`, and does **not** publish a new `flash-theater-compiler` to npm. This looks harmless at
first (`vscode-kopytko`'s own parser-release workflow has the identical shape for its own
dependents), but there's a sharp edge specific to `0.0.x` versions: verified with node's own
`semver` package —

```
^0.0.1  →  >=0.0.1 <0.0.2   (an EXACT pin — no patch/minor wiggle room at all)
^0.1.0  →  >=0.1.0 <0.2.0   (normal caret behavior starts at minor >= 1)
^1.0.0  →  >=1.0.0 <2.0.0
```

Since `packages/compiler` currently depends on `"flash-parser": "^0.0.1"`, that range is pinned to
the single exact version `0.0.1` — not a floor. So even a **fresh** `npm install
flash-theater-compiler` from the registry, any time after `flash-parser` ships `0.0.2`, would still
resolve `flash-parser@0.0.1`, because that's what the *already-published* `flash-theater-compiler`
tarball's own `package.json` says — the git-level dependency bump above never reaches real npm
consumers until `flash-theater-compiler` itself is republished with the updated range. This
wouldn't be nearly as sharp once both packages are past `1.0.0` (a `^1.x` range picks up newly
published minor/patch versions automatically, without needing to republish the dependent, because
npm resolves ranges against the live registry at install time, not at the dependent's own publish
time) — but at `0.0.x` it's the difference between "the fix ships" and "the fix silently never
reaches anyone who already has `flash-theater-compiler` installed."

**Fixed**: `release-flash-parser.yml`'s "Commit and push compiler dependency update" step now
records whether it actually made a commit (`bumped=true`/`false` step output), and a follow-up step
— gated on that output — runs `gh workflow run release-compiler.yml --ref "${{ github.ref_name }}"
-f bump=patch` to automatically dispatch a patch release of `flash-theater-compiler` right after,
closing the gap without relying on a human to remember. Needs `permissions: actions: write` added
to the workflow (the default `contents`/`id-token` pair isn't enough to dispatch another workflow
run). `gh` is preinstalled on GitHub-hosted `ubuntu-latest` runners — no extra setup.

**⚠️ Unverified — check on the very first real flash-parser release**: dispatching a workflow run
via `gh workflow run` using the default `secrets.GITHUB_TOKEN` (rather than a personal access
token) is a documented, commonly-used pattern, but it has not been exercised in this repo on real
GitHub infrastructure (nothing here can run GitHub Actions locally). If the dispatch silently does
not appear in the Actions tab after a flash-parser release, the fallback is a fine-grained PAT with
`actions:write` on this repo, stored as a repo secret (e.g. `DISPATCH_TOKEN`), swapped in for
`secrets.GITHUB_TOKEN` in that one step's `GH_TOKEN` env var.

## The site's per-package "badge" is a live `v{version}` pill, not a static image, and needs a post-release redeploy to update

`site/src/pages/parser.astro`/`compiler.astro` (and the homepage's "Packages" cards in
`index.astro`) import that package's own `package.json` directly (`import parserPkg from
'../../../packages/flash-parser/package.json'`) and render `v{parserPkg.version}` as a small pill —
a common shape for a docs site that lives in the same monorepo as the packages it documents. This
is resolved once, at site **build** time, not live in the browser — so it only reflects a version
bump after the next site rebuild. Since a release workflow's own commit only touches
`packages/*/package.json` (never `site/**`), `gh-pages.yml`'s push-triggered `paths: ['site/**']`
filter never fires for it. Fixed by widening the trigger: `gh-pages.yml` also accepts
`workflow_call: {}`, and both `release-flash-parser.yml`/`release-compiler.yml` end with a
`deploy-pages` job (`needs: release`, `uses: ./.github/workflows/gh-pages.yml`) that redeploys
right after publish. **Two READMEs also carry a standard npm badge**: `packages/flash-parser/README.md`/
`packages/compiler/README.md` each carry a `https://img.shields.io/npm/v/<name>.svg` badge (npm's
own registry-backed shields.io badge, always current with no CI step needed — unlike the site's
build-time pill) — ordinary npm-listing practice, independent of the site's own pill mechanism.

## Site page slugs are short bare names (`/parser/`, `/compiler/`), not the npm package names

`site/src/pages/parser.astro` (not `flash-parser.astro`) — uses a short, bare-name page slug
rather than the full npm package name, keeping both package pages' URLs the same shape
(`/parser/`, `/compiler/`) even though the real npm package names aren't symmetric
(`flash-parser` vs. `flash-theater-compiler`, not `flash-compiler`). The page's own visible text
(breadcrumb, install command, code examples) still names the real package — only the URL slug is
shortened. Renaming the actual npm package names themselves to make them symmetric was
deliberately ruled out: `flash-parser`/`flash-theater-compiler` are referenced throughout the
codebase (every cross-package `import` statement, the `flash-theater` CLI bin name, `CLAUDE.md`,
`GRAMMAR.md`, `findings/`, `astro.config.mjs`'s Vite aliases) — a rename would be a repo-wide,
high-risk change for a cosmetic naming concern, not a one-file fix.

## Every code sample on `parser.astro`/`compiler.astro` (and the matching READMEs) must be run, not just written

First-draft versions of both pages shipped several examples that looked plausible but would have
failed for real for anyone who copy-pasted them — found only by actually executing each snippet
against the built `dist/` (`node -e "require('./dist/src/index.js')..."`), not by re-reading the
prose:
- `field count: number` / `derived doubled: number` — **`number` is not a valid field type**
  (`dsl/invalid-field-type`; the real set is `string, integer, float, boolean, node, array,
  assocarray`) — used in both `parser.astro`'s and `compiler.astro`'s flagship "quick start"
  example, so both would have thrown immediately.
- `<Label text="{doubled}" />` with no `id` — throws `template/missing-id` (a dynamic binding
  needs an `id` to generate `findNode`) — every other example already in `site/src/pages/docs/`
  gets this right; only the two hand-written package-page examples missed it.
- `walk(root, { visitFieldDeclaration(node) {...} })` — written by analogy with
  `kopytko-brightscript-parser`'s own per-kind-visitor-object API, but flash-parser's `walk`
  (`visitor.ts`) is a **plain `(node: SyntaxNode) => void` callback over every node**, not a
  per-kind-visitor-methods object. The correct way to collect one kind is `findAll(root,
  SyntaxKind.FieldDeclaration, (n) => new FieldDeclaration(n))`, and the typed AST class exposes
  `.name`/`.type`/`.defaultLiteral` as plain string getters — there is no `.declaredType` node
  with a `.getText()` method (that was fabricated by analogy with a different part of the API).
- `parseSceneGraphXml(...)` does not return a `{ root, diagnostics }` pair — it returns the typed
  root `XmlElement` directly (`| undefined` if the document has none), with `.tagName`/
  `.attributes` (not `.name`).

**Lesson**: for a library's own doc/marketing pages, "does this read as plausible TypeScript" is
not a sufficient bar — verify every snippet against the actual built package (`npm pack` +
`node -e`, or the package's own test suite) before publishing, the same discipline this repo
already applies to `.thr` fixtures in `apps/sample-app`. A wrong showcase example is worse than no
example — it fails on the very first thing a new user tries.

## `softprops/action-gh-release` is pinned to a commit SHA, not `@v3` — the only third-party action here

Every `actions/*` action (`checkout`, `setup-node`, `configure-pages`, `upload-pages-artifact`,
`deploy-pages`) is first-party GitHub tooling, tag-pinned (`@v7`, etc.) — standard, accepted
practice at this project's scale, no SHA-pinning needed. `softprops/action-gh-release` is the one
exception: third-party, and it runs in both release workflows holding `contents: write` right next
to `npm publish --access public --provenance` — a hijacked/re-pointed mutable tag on that one
action has real blast radius (repo-write + a path that runs immediately before a publish step),
unlike the low-risk first-party ones. Pinned to the commit the `v3`/`v3.0.2` tag currently resolves
to (`3d0d9888cb7fd7b750713d6e236d1fcb99157228`), with a `# v3.0.2` comment for readability — bump
the SHA by hand (resolve the new tag → commit via the GitHub API, don't just trust the tag name)
when a new release is actually needed, rather than floating on the tag.

## `docs/features.md` was the one file in the whole repo committed with CRLF line endings

Found by an independent audit scanning every tracked file's actual git-blob bytes (not the
Windows-checkout `LF will be replaced by CRLF` warnings this session's own commits kept printing —
those are checkout-side noise from `core.autocrlf`, not evidence of what's stored; everything else
in the repo was already pure LF). Normalized `docs/features.md` to LF and added a root
`.gitattributes` (`* text=auto eol=lf`) so a future Windows commit can't reintroduce this — cheap
insurance now that external contributors are expected.
