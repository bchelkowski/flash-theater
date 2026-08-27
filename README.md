# flash-theater

[![CI](https://github.com/bchelkowski/flash-theater/actions/workflows/ci.yml/badge.svg)](https://github.com/bchelkowski/flash-theater/actions/workflows/ci.yml)
[![npm: flash-parser](https://img.shields.io/npm/v/flash-parser.svg?label=flash-parser)](https://www.npmjs.com/package/flash-parser)
[![npm: flash-theater-compiler](https://img.shields.io/npm/v/flash-theater-compiler.svg?label=flash-theater-compiler)](https://www.npmjs.com/package/flash-theater-compiler)
[![license](https://img.shields.io/github/license/bchelkowski/flash-theater.svg)](LICENSE)

A precompiler for the **flash-theater language** — a declarative DSL for
Roku/BrightScript/SceneGraph, inspired by Svelte: declare `field`/`derived` bindings, focus
rules, and routes, and the compiler generates the SceneGraph XML and BrightScript wiring that
would otherwise be hand-written — no `ObserveFieldScoped` chains, no manually tracked LRUD
focus state, no hand-wired store/theme plumbing.

📖 **[Docs site](https://bchelkowski.github.io/flash-theater/)** — narrative docs, a live
in-browser playground, and per-package reference pages.

## Status

This project implements a knowingly narrow subset of flash-theater's full language spec — enough
to validate the architecture end to end, not the whole design. What's in and what's deliberately
deferred is documented precisely in [`packages/compiler/GRAMMAR.md`](packages/compiler/GRAMMAR.md)
and [`docs/features.md`](docs/features.md).

The pipeline is validated end to end against real, `.thr`-compiled components across 14 dedicated
Roku apps (one per language feature, plus the primary sample app) — compiled, zipped, and
sideloaded onto real Roku hardware, not just unit-tested in isolation.

```
component.thr → flash-parser (lossless CST/AST) → packages/compiler → .xml + .brs
                                                  → apps/* → sideload → a working component on Roku
```

## Packages

| Package | | Description |
|---|---|---|
| [`flash-parser`](https://www.npmjs.com/package/flash-parser) | [![npm](https://img.shields.io/npm/v/flash-parser.svg)](https://www.npmjs.com/package/flash-parser) | The `.thr`/`.flsh` DSL's own lossless CST + typed AST, plus a full vendored BrightScript + SceneGraph XML grammar. [Docs](https://bchelkowski.github.io/flash-theater/parser/) |
| [`flash-theater-compiler`](https://www.npmjs.com/package/flash-theater-compiler) | [![npm](https://img.shields.io/npm/v/flash-theater-compiler.svg)](https://www.npmjs.com/package/flash-theater-compiler) | The `.thr`/`.flsh` → `.xml`/`.brs` compiler — CLI (`flash-theater compile`/`zip`) and library API, built on `flash-parser`. [Docs](https://bchelkowski.github.io/flash-theater/compiler/) |

## Repo structure

- `packages/flash-parser` — the DSL's lossless CST + typed AST parser, and an independent,
  vendored BrightScript + SceneGraph XML grammar (embedded expressions/statements, template
  markup).
- `packages/compiler` — the `.thr`/`.flsh` → `.xml`/`.brs` compiler (TypeScript), consuming
  `flash-parser`'s AST — never hand-parsing BrightScript or XML itself.
- `apps/sample-app` — the primary Roku testbed, including a `.thr`-compiled root `MainScene`,
  used for real end-to-end verification (build → sideload → real device).
- `apps/*-demo` (13 apps) — one dedicated, router-mounted Roku app per language feature (focus/
  navigation, animation, task manager, requests, timers, reactive state, template/binding, router,
  streams, theme, classes, environments, statements), each with default and customized examples
  per mechanic.
- `site/` — the docs site (Astro 5 + Tailwind v4), including a live in-browser compiler
  playground.

See [`MAP.md`](MAP.md) (generated — `npm run map`) for the full, current repo map with every
source directory's purpose.

## Development

```bash
npm install                          # install dependencies
npm run build                        # build flash-parser, then packages/compiler
npm test                             # flash-parser's tests, then packages/compiler's
npm run lint                         # generated-file check + ESLint
npm run build:roku                   # compile .thr → .xml/.brs, zip every apps/* workspace
```

```bash
cd site && npm run dev               # docs site, Astro dev server
```

Sideloading onto a real Roku device needs `ROKU_HOST`/`ROKU_PASSWORD` — see
[`apps/sample-app/README.md`](apps/sample-app/README.md).

## License

[MIT](LICENSE)
