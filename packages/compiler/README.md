# flash-theater-compiler

[![npm version](https://img.shields.io/npm/v/flash-theater-compiler.svg)](https://www.npmjs.com/package/flash-theater-compiler)
[![license](https://img.shields.io/npm/l/flash-theater-compiler.svg)](https://github.com/bchelkowski/flash-theater/blob/main/LICENSE)

The `.thr`/`.flsh` → `.xml`/`.brs` compiler for the
[flash-theater](https://github.com/bchelkowski/flash-theater) language — a declarative DSL for
Roku/BrightScript/SceneGraph. Parses with
[`flash-parser`](https://www.npmjs.com/package/flash-parser)'s own vendored grammar (never
hand-parses BrightScript or XML itself), and generates static SceneGraph `.xml` plus generated
`init()`/`onChange` handler `.brs` — no vdom, no diffing, no hand-wired observer cascades.

## Installation

```bash
npm install --save-dev flash-theater-compiler
```

Installing the package also puts the `flash-theater` CLI on your `PATH` via `npx flash-theater`
(or an npm script). Requires Node.js ≥ 24.

## CLI

The primary way to use this package — compiles a whole project convention-based (like `tsc`
reading `tsconfig.json`, no glob argument):

```bash
flash-theater compile [--check] [--src-dir <dir>] [--out-dir <dir>] [--env <name>]
flash-theater zip [--out-dir <dir>] [--env <name>] [--app-name <name>]
```

- `compile` — compiles every `.thr`/`.flsh` file under `src/` into `out/` (per
  `flash-theater.config.json`, or the `srcDir`/`outDir` defaults), copying every other `src/` file
  through untouched. Wipes and fully regenerates `out/` every run.
  - `--check` — same discovery/compile pass, but writes nothing: reports `OK <path>` per file, or
    the first compile error. Use in CI.
  - `--env <name>` — loads `environments/<name>.config.json` (+ an optional, git-ignored
    `environments/<name>.local.config.json` layered on top), writes to `out-<name>/` instead of
    `out/`, and patches `src/manifest`'s declared `manifestOverrides` into the copied manifest.
    Falls back to the `FLASH_THEATER_ENV` env var when `--env` isn't passed.
- `zip` — zips an already-compiled `out/` (or `out-<name>/`) into `dist/<app-name>.zip`, ready to
  sideload onto a Roku device. `<app-name>` defaults to the current directory's `package.json`
  `"name"` field, or its own directory name. No `--src-dir` — zipping never reads `src/`. With
  `--env <name>` active, the filename instead becomes `dist/<app-name>-<name>-<major>.<minor>.<build>.zip`,
  with the version read from the built `out-<name>/manifest`.

## Configuration — `flash-theater.config.json`

The file itself is entirely optional, sibling of `src/`/`out/`/`package.json`. But once it exists
— for any reason, even just to set `srcDir`/`outDir` — `designResolution` becomes mandatory in it,
whether or not the project uses `scale` anywhere. With no config file at all, defaults apply and
using `scale` anywhere becomes a compile error instead (`dsl/scale-requires-config`):

```jsonc
{
  "designResolution": "fhd",   // "hd" | "fhd" — mandatory once this file exists
  "srcDir": "src",             // optional, defaults to "src"
  "outDir": "out",             // optional, defaults to "out"
  "exclude": ["**/*.snap.thr"] // optional glob patterns, relative to srcDir
}
```

`environments/<name>.config.json` (for `--env`) is a separate, per-environment file with its own
`variables`/`manifestOverrides`/`exclude`/`include` shape — see
[`GRAMMAR.md`'s "Environments" section](https://github.com/bchelkowski/flash-theater/blob/main/packages/compiler/GRAMMAR.md#environments)
and [`GRAMMAR.md`'s "scale" section](https://github.com/bchelkowski/flash-theater/blob/main/packages/compiler/GRAMMAR.md#scale)
for the full reference.

## Library API

For embedding the compiler directly (a build tool integration, a playground, a linter).
`compileThrSource`/`compileFlshSource` compile **one file in isolation** and throw a
`CompileError` on any diagnostic (never a partial/best-effort result):

```typescript
import { compileThrSource } from 'flash-theater-compiler';
import { CompileError } from 'flash-theater-compiler/dsl-ast';

try {
  const { xml, brs, usesStore, usesFocusSystem, usesRouter } = compileThrSource(
    `<script>
field count: integer = 0
derived doubled: integer = count * 2
</script>
<component>
  <Label id="label" text="{doubled}" />
</component>`,
    'DoubledCounter',
  );
  // xml — a static SceneGraph component definition
  // brs — generated init()/setFields()/onChange handlers, no hand-written observers
} catch (err) {
  if (err instanceof CompileError) {
    // err.diagnostic — { code: string, message: string, span?: { line: number } }
    console.error(`[${err.diagnostic.code}] ${err.diagnostic.message}`);
  }
}
```

**What `compileThrSource` does NOT do**: it does not copy the built-in runtime components (the
focus manager, router, store, task manager, or any of the `Safe*`/`Scale`/`Stream`/`Http` codegen
helpers) into your output — it only tells you which ones this one file needs, via the
`usesStore`/`usesFocusSystem`/`usesRouter`/`usesTaskManager`/`usesComparisonHelper`/
`usesSafeNotHelper`/`usesStreamHelper`/`usesHttpRequestHelper`/`usesScaleHelper`/
`usesRelationalHelper` boolean flags on its return value. For a whole project's worth of files,
compiled and wired together the same way the CLI does it, use
[`compileApp(inputs, srcRoot, outRoot, config, envVariables)`](https://github.com/bchelkowski/flash-theater/blob/main/packages/compiler/src/app-compiler.ts)
instead — see [`cli.ts`](https://github.com/bchelkowski/flash-theater/blob/main/packages/compiler/src/cli.ts)
for the exact reference implementation (which runtime asset gets copied for which flag).

A browser-safe subpath (no `node:fs`/`node:path` pulled in, unlike the package's main entry point
which also re-exports the Node-only CLI) is available for bundling into a web playground:

```typescript
import { compileThrSource } from 'flash-theater-compiler/compile';
import { CompileError } from 'flash-theater-compiler/dsl-ast';
```

## Documentation

- [flash-theater docs site](https://bchelkowski.github.io/flash-theater/compiler/) — architecture
  overview and more examples.
- [`GRAMMAR.md`](https://github.com/bchelkowski/flash-theater/blob/main/packages/compiler/GRAMMAR.md) —
  the exact grammar this package compiles.
- [`docs/features.md`](https://github.com/bchelkowski/flash-theater/blob/main/docs/features.md) —
  full feature status.
- [Source](https://github.com/bchelkowski/flash-theater/tree/main/packages/compiler)

## License

MIT
