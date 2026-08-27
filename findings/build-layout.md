# Project layout (`src/`/`out/` split, `project-layout.ts`, `flash-theater.config.json`'s `srcDir`/`outDir`/`exclude`)

Compile-time module responsibilities and design rationale for the TypeScript-style `src/`
(hand-written project files) vs `out/` (fully generated, gitignored) split every app follows. See
`packages/compiler/GRAMMAR.md`'s "Project layout" section for the user-facing shape — this file is
the *why* and the non-obvious implementation traps it hit.

## Before this split, source and output shared one directory tree

Every app used to interleave hand-written and generated files in the same folders —
`components/HomeScreen/HomeScreen.thr` sat next to its generated `.xml`/`.brs`, and most of that
generated output was tracked in git (only one hand-picked file pair was gitignored, as an
inconsistent one-off). `cli.ts`'s old `writeCompiledOutput` derived the output path as
`dirname(inputPath)` — literally the same directory. This worked, but meant there was no single
place that was "just the project" vs "just the build", and packaging (`zip.mjs`) had to filter
`.thr` out at zip time by extension rather than by directory.

## The new layout: `srcRoot` and `outRoot` are genuinely different directories

Per app: `apps/<app>/src/` (100% hand-written: `manifest`, `images/`, `source/Main.brs`,
`components/**/*.thr`, `components/**/*.flsh`, and any hand-written `.xml`/`.brs` with no `.thr`
source — e.g. `apps/focus-demo/src/components/MainScene.xml`/`.brs`) and `apps/<app>/out/`
(100% generated/copied, mirroring `src/`'s exact structure, gitignored wholesale via
`apps/*/out/` in the root `.gitignore`). `apps/<app>/dist/<app>.zip` is unchanged — still just the
final packaged artifact, zipped straight from `out/` with no `.thr` filtering needed (see
"`dist/` and `flash-theater zip`" below).

## `source/Main.brs`'s presence is never validated — a missing one compiles and zips clean, silently

**Found auditing all 10 `apps/*` workspaces for consistency** (not device-reproduced — a static
gap, confirmed by inspecting `out/`/`dist/*.zip` contents directly): 5 of the demo-app-convention
chapter apps (`task-manager-demo`, `requests-demo`, `reactive-state-demo`, `router-demo`,
`template-and-binding-demo`) shipped with no `src/source/Main.brs` at all — an oversight from
being built by several independent sessions in parallel, none of which happened to copy this one
hand-written file over from an existing app the way every other convention (manifest, images,
`flash-theater.config.json`) already gets copied. `npm run build:roku` for every one of them
compiled clean, zipped clean, no error, no warning — `cli.ts`'s asset-copy step only ever copies
whatever `.brs`/`.xml`/other files happen to exist under `src/`, it never checks that
`source/Main.brs` specifically is among them. The resulting `.zip` is a structurally valid Roku
package (manifest present, `components/` present) that would fail to launch on a real device or
emulator — `sub Main()` is the channel's actual entry point (`CreateObject("roSGScreen")`,
`screen.CreateScene(...)`, `screen.show()`); without it there's nothing for Roku's own OS to call
at all. **Fixed**: copied the canonical, up-to-date `Main.brs` (the router-mounted-app shape —
`FlashTheaterSetupGlobals`, the focus-manager `setSceneRef` wiring, `screen.show()` before
`scene.callFunc("setup")`, never before) into all 5 missing apps, verified via
`unzip -l dist/<app>.zip | grep source/Main.brs` on each afterward — not just a clean compile.
**Lesson for the next new app**: `Main.brs` needs the exact same "copy it from an existing working
app, don't write it from memory" discipline every other per-app asset already gets in this repo's
own build-a-new-chapter-app instructions — a clean `npm run build:roku` is not proof an app can
actually boot; check the zip's own contents, or better, sideload it, before calling a new app done.

## `dist/` and `flash-theater zip` — packaging moved into the compiler, not per-app

Each app used to carry its own `scripts/zip.mjs` (`zip.addLocalFolder(join(appRoot, 'out'), '')`
via the `adm-zip` npm package, plus a hand-duplicated `readManifestVersion`) — byte-identical
across all four apps except one `APP_NAME` constant. That's now `packages/compiler/src/packaging.ts`'s
`writeAppZip`, dispatched via `flash-theater zip` (`cli.ts`'s `zip` subcommand — see GRAMMAR.md's
"Packaging" section). Every app's `package.json` `"zip"` script is now just `"flash-theater zip"`,
no `scripts/zip.mjs` file and no `adm-zip` devDependency of its own required. `<appName>` (the zip's
base filename) defaults to the app's own `package.json`'s `"name"` field — matching what each
`zip.mjs` used to hardcode as `APP_NAME` — falling back to the app root directory's basename if
there's no `package.json`, overridable with `--app-name`. See `findings/environments.md`'s
"Packaging moved into the compiler" entry for how this also fixed a latent `outDir`-override gap
the old per-app scripts had. Sideloading stays out of the compiler's scope on purpose —
`kopytko-roku-device`'s job — but each app's own `scripts/sideload.mjs` wrapper is also gone now,
replaced by that package's own `kopytko-roku` CLI bin called directly from `package.json`'s
`"sideload"` script; see `findings/dev-environment.md`'s "Sideloading is now `kopytko-roku` CLI"
entry.

`packages/compiler/src/project-layout.ts` owns resolving `srcRoot`/`outRoot`
(`resolveProjectLayout`) and walking `srcRoot` into compile-targets vs pass-through files
(`walkSrcTree`) — kept separate from `cli.ts` because it's pure path/string logic with no
filesystem *writes* of its own (only `readdirSync` reads), matching this repo's existing
"`compile.ts` touches no `fs`" separation philosophy one level up the call stack.

## `flash-theater.config.json`'s `srcDir`/`outDir`/`exclude` — same file, new keys

The config file stays at the **app root** (sibling to `src/`/`out/`/`package.json`), **not** inside
`src/` — it's tooling config, not Roku package content. Defaults: `srcDir: "src"`, `outDir: "out"`,
`exclude: []`. A `--src-dir <dir>`/`--out-dir <dir>` CLI flag overrides the config value, mainly for
tests — both are resolved against the app root with `path.resolve` (not `path.join`), so an
absolute override (a test's own tmp dir) replaces the app root entirely instead of nesting under it
(`path.join('/app', '/tmp/x')` would produce the wrong, nested `'/app/tmp/x'`; `path.resolve` does
not).

**Windows gotcha**: `path.resolve('/app', 'src')` folds in the *current drive letter* on Windows
(a leading `/` with no drive is only "root-relative", not fully absolute) — a bare POSIX-style
`/app` fixture in a test produces `C:\app\src`, not `\app\src`. Any test asserting an exact
resolved path needs to `resolve()` its own fixture root once up front (see
`project-layout.test.ts`'s `APP_ROOT`), not hand-build the expectation with `path.join`.

## The CLI is convention-based now — no pattern argument

`flash-theater compile [--check] [--src-dir <dir>] [--out-dir <dir>]` — no `<pattern>` argument
anymore (the old `compile "components/**/*.thr"` shape). It always compiles the *whole* project:
discover everything under `srcRoot` via `walkSrcTree`, and route every non-`.thr`/`.flsh` file
through as a pass-through copy. This mirrors `tsc` reading `tsconfig.json` with no args, rather than
being told a glob every time.

## Every `compile` run wipes `out/` clean first — no more marker-based overwrite protection

`out/` is deleted (`rmSync(outRoot, { recursive: true, force: true })`) and fully regenerated on
every non-`--check` run. This replaces the old `GENERATED_MARKER`/`assertWritable` machinery, which
existed only because source and output used to share a directory — `assertWritable` refused to
clobber a file that didn't carry the marker comment, protecting a hand-written file that happened to
sit in the same folder as compiled output. Once `out/` is 100% derived and gitignored, nothing
hand-written can ever live there to protect, so that whole mechanism was deleted outright rather
than kept as dead weight. Marker comments (`flash-theater:generated`) are still stamped into
generated file headers, purely for human readability — they no longer gate anything.

**This caught a real bug during the migration itself**: `apps/animation-demo`'s old, in-place-write
tree had a stale `components/FlashTheater/FlashTheaterStore/Store.{xml,brs}` left over from when
some component used to call the store — no `.thr` file in the app actually uses it anymore, but the
old incremental-write model never had a reason to delete it. The clean-rebuild recompile correctly
omitted it. **Lesson**: clean-rebuild isn't just tidier, it's a correctness fix for exactly the kind
of drift the old marker-protected in-place model was structurally prone to.

## `exclude` — a small hand-rolled glob matcher, not a dependency

`isExcluded`/`globToRegExp` in `project-layout.ts` supports `**` (any number of path segments),
`*` (anything but `/`), and `?` (one non-`/` char) — tsconfig-`exclude`-style, matched against a
posix-normalized path relative to `srcRoot`. Deliberately not a new npm dependency, consistent with
this repo's existing no-glob-library convention (`cli.ts`'s old `resolveThrFiles` did the same kind
of minimal hand-rolled matching).

**`dir/**` must also match `dir` itself, not just its descendants** — `walkSrcTree` checks a
directory *entry* against `exclude` before recursing into it (so an excluded subtree is never
descended into at all, not just filtered file-by-file after the fact), so the pattern needs to match
the bare directory path too. The fix: when `**` is preceded by a literal `/`, the whole `/**` unit
compiles to the optional group `(/.*)?` instead of a plain `'/' + '.*'` — `components/Foo/**` then
matches both `components/Foo` (the directory itself, via the empty branch) and
`components/Foo/Bar.thr` (via the `/.*` branch). Only checked at directory-entry time in the walker,
never at file-entry time twice — this is purely about the regex being correct for both callers.

## `compileApp`'s `appRoot` split into `srcRoot`/`outRoot` — a real correctness fix, not just a rename

See `findings/class-pipeline.md`'s "An import path resolves one of three ways" section for
the full before/after. The one-line summary: `resolveImportTargetPath`'s bare-import branch resolves
against `srcRoot` (source-to-source reference), while `toScriptUri` and every `<script uri="...">`
absolute-path input (`safeCompareAbsolutePath`, `ownBrsPath` in `compileFlshClasses`, etc.) must be
`outRoot`-based, since that's where the compiler actually *writes* the file. Before the split these
were the same directory, so a bug here was invisible; `ownBrsPath` used to be computed as
`dirname(input.path)` (the `.flsh` source's own directory) — under the split, that no longer matches
where the compiled `.brs` physically lands, so it's now mirrored the same way `cli.ts` mirrors
compiled output: `join(outRoot, relative(srcRoot, dirname(input.path)), className + '.brs')`.

## Migration note: most generated `.xml`/`.brs` used to be git-tracked

Before this split, only one hand-picked pair (`ScheduleDateMenuItem.xml`/`.brs`) was gitignored —
every other app's generated output was tracked in git alongside its `.thr` source, an inconsistency
nobody had cleaned up. The migration itself (`git mv` each app's hand-written files into `src/`,
`git rm -f` every generated sibling) is what finally made `apps/*/out/` a single, complete gitignore
rule instead of one-off exceptions. `git rm` on a path that only exists as a rename-in-progress (the
new `src/...` path, before HEAD has ever seen it) needs `-f` — plain `git rm` refuses, reporting
"changes staged in the index," since from git's low-level view a detected rename is really a
delete-at-old-path + add-at-new-path pair, and removing a newly-*added* index entry is exactly what
`-f` is for.
