# Compiler architecture — pipeline & build

How the compile pipeline avoids filesystem access, guards against clobbering hand-written output,
groups its optional knobs, keeps the docs-site playground in sync with grammar changes, and why
`packages/flash-parser` needs its own local build step. See
[compiler-architecture.md](compiler-architecture.md) for the pitfall checklist, naming conventions,
and module-reorganization history this file assumes as background.

## Generated-file collision detection

`cli.ts` stamps every generated `.xml`/`.brs` with a `flash-theater:generated` marker (an XML
comment / `'`-comment first line — see `withXmlMarker`/`withBrsMarker`). Before overwriting a
target path, it checks for that marker; if absent, it's presumed hand-written and the compiler
refuses to overwrite it (`assertWritable`). This is what let `ScheduleDateMenuItem.xml`/`.brs`
exist as real, committed, hand-written source during early bring-up
(`apps/sample-app/src/components/ScheduleDateMenuItem/`) without the compiler silently clobbering
them the first time it ran against that directory — the collision error is the intended signal
to delete the hand-written files and let the compiler take over.

## Why `compile.ts` has no filesystem access

`compile.ts` (`compileThrSource`) takes a source string and a component name in, returns
`{xml, brs}` out — no `fs`, no `path`. All filesystem/argv/exit-code concerns live in `cli.ts`.
This is what makes `compile.ts` (and everything it calls — flash-parser's `parse()`,
`dsl-parser`'s adapters, `analysis/*`, `codegen/*`) testable via plain string fixtures with no
temp-directory setup, and is why `test/codegen/golden.test.ts` can assert exact output against
`test/golden/*/expected.*` without touching disk beyond reading the fixture. Keep it that way —
if a future feature seems to need `compile.ts` to read another file (e.g. resolving an
`@import`), pass its *content* in from the caller instead of reaching for `fs` inside
`compile.ts`.

## `compileThrSource`'s optional knobs live in one `CompileThrOptions` object, not positional params

`compileThrSource(source, componentName, options: CompileThrOptions = {})` — every optional knob
beyond the two args every caller always supplies (`globalBindings`, `extraScriptUris`,
`validateOutput`, the six Pattern-B runtime-asset script-uri fields, `classShapesByName`) is a
named field on `CompileThrOptions`, not a positional parameter. This mirrors
`codegen/xml-emitter.ts`'s `emitXml(script, template, fieldsNeedingOnChange, componentName,
options: EmitXmlOptions = {})` precedent. It used to be 12 positional parameters, added one at a
time as each runtime-asset feature (SafeCompare, SafeNot, Stream, Http, Scale, SafeRelational)
shipped — by the end, reaching a late parameter like `scaleHelperScriptUri` from a test call site
meant writing three `null` placeholders first (`compileThrSource(source, 'X', CONFIGURED, [],
false, null, null, null, scaleUri)`), and the one production call site
(`app-compiler.ts`'s `compileApp`) was a 12-argument positional call only decipherable by counting
position against the declaration. **The next new runtime-asset feature adds one more named field
to `CompileThrOptions`, never a new positional parameter.**

## A breaking grammar change must also update `site/src/components/ThrPlayground.tsx`'s `DEFAULT_SOURCE`

`site/astro.config.mjs` aliases `flash-theater-compiler/compile` and `flash-parser` straight to
their TypeScript **source** (`packages/compiler/src/compile.ts`, `packages/flash-parser/src/index.ts`),
not a built/published package — deliberately, so the docs site always reflects the latest compiler
without a build/publish step. `ThrPlayground.tsx` calls `compileThrSource` on its `DEFAULT_SOURCE`
**live, in the browser**, on every render. This means `DEFAULT_SOURCE` isn't documentation-only
text like the rest of the site's code samples — a grammar change that doesn't also update it
breaks the live playground's default example with a real `CompileError`, not just a stale-looking
doc. Caught live when `derived` grew a required type annotation: `site/src/pages/index.astro`'s
own code sample and `ThrPlayground.tsx`'s `DEFAULT_SOURCE` both needed the same fix independently —
check both whenever `derived`/`field`/`state`/`if` grammar changes.

## `packages/flash-parser` needs a local `npm run build` before `packages/compiler` can build or test

Unlike `kopytko-brightscript-parser` (a real npm dependency, fetched from the registry with its
`dist/` already built), `flash-parser` is a **workspace source dependency** — `npm install` only
symlinks `node_modules/flash-parser` to `packages/flash-parser`, it doesn't build it. Since
`flash-parser`'s `package.json` `main`/`types` point at `dist/src/index.js`/`.d.ts`,
`packages/compiler`'s `tsc` (and even its `tsx`-run tests, since `flash-parser` is a real package
import, not a relative path) will fail with a missing-module error until `npm run build
--workspace packages/flash-parser` has run at least once. Root `npm run build`/`npm test`/`npm
run build:roku` already sequence this correctly — only bite when running a single workspace's
script directly on a fresh checkout, or after `git clean`-ing `packages/flash-parser/dist`.
