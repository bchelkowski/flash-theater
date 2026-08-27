# flash-theater — CLAUDE.md

## Where to look

| Question | Source |
|---|---|
| **Where does X live?** | [MAP.md](MAP.md) — generated repo map: areas, entry points, package exports, commands. Regenerate with `npm run map`; never edit by hand. |
| **How does X behave, and what has already gone wrong in it?** | `findings/` — see the routing table in [findings/README.md](findings/README.md). |
| **Is this a known bug, or a gap we've deliberately not built yet — and how would I start fixing it?** | `issues/` — see the routing table in [issues/README.md](issues/README.md). |
| **What does X do for a user? What's the exact grammar?** | [docs/features.md](docs/features.md), [`packages/compiler/GRAMMAR.md`](packages/compiler/GRAMMAR.md), and `site/`. |
| **How do I actually use X? What's a working example, and what's NOT supported?** | `site/src/pages/docs/<topic>.astro` — see the routing table in "Keeping reference surfaces in sync" below. |

**`docs/`, `packages/compiler/GRAMMAR.md`, and `site/` are human-facing documentation.** Update
them when behavior changes, but **do not read them to answer a question about the code** —
`MAP.md` and `findings/` are faster and reflect what the code actually does.

## Internal knowledge base (`findings/`)

Before starting any task touching a feature area, read the matching file in `findings/` — see
the full routing table in [findings/README.md](findings/README.md#read-this-before-starting).
Reading and writing `findings/` is a required step, not optional.

**AFTER completing any task — update the relevant file if you discovered anything non-obvious:**
a constraint, a gotcha, a design decision, a pattern that worked. Keep entries concrete — real
examples, file paths, the *why*. **Update the reference file in place; do not append a dated
entry.** See [findings/README.md](findings/README.md) for the full writing rules.

## Issue tracking (`issues/`)

`findings/` explains *why* the code behaves as it does; `issues/` tracks *what's broken or
missing, and how to fix it* — one markdown file per bug or gap, written so a future session can
pick it up and start fixing without re-investigating from scratch. See the routing table in
[issues/README.md](issues/README.md).

**Before picking up open-ended "what should I work on" work, or before fixing something that
might already be tracked, check `issues/README.md`.** **AFTER completing any task**: if it fixes
something tracked in `issues/`, flip that file's `Status` to `Fixed` with a one-line pointer to
what changed, and move its row to the README's "Resolved" table; if it surfaces a new bug or gap
that isn't being fixed in this change, file it using the template in
[issues/README.md](issues/README.md#writing-rules).

**`issues/` doesn't stay in its own corner — a user-facing item touches `site/` too.** If a newly
filed issue is a limitation an author would actually run into (as opposed to a pure internal bug
nobody outside the compiler would notice), add a matching bullet to its topic's
`site/src/pages/docs/<topic>.astro` "Not (yet) supported" list in the same change — see the
topic→page table in "Keeping reference surfaces in sync" below. When that issue is later fixed,
remove the bullet again (and run the normal Definition-of-done items 3–6 below if the fix changed
what the grammar/runtime actually accepts — fixing an issue is a behavior change like any other).
An issue whose `Status` is `Fixed` but whose site bullet is still sitting there describing the old
limitation is exactly the kind of drift this rule exists to prevent.

---

## Project overview

A precompiler for **the flash-theater language** — a declarative DSL for
Roku/BrightScript/SceneGraph (`.thr` files → `.xml`/`.brs`). The full target language spec
lives outside this repo, in flash-theater's own language design document. This repo
implements a knowingly narrow subset — see `packages/compiler/GRAMMAR.md` for exactly what's
in and what's deferred.

Every `apps/*-demo` app now follows one convention — `router`+`scale` everywhere, one chapter app
per mechanic, default-and-customized coverage per chapter — see `findings/demo-app-conventions.md`
for the rule and the roadmap of which topics still need a dedicated app
(`apps/async-demo`, the last pre-convention app, was retired once its 3-way split into
`apps/task-manager-demo`/`apps/requests-demo`/`apps/timers-demo` was confirmed working).

Six workspaces:
- `packages/flash-parser` — the `.thr` file's own lossless CST + typed AST (the DSL grammar:
  `field`/`derived`/`private|public function`, the JS-shaped `if`, and the template markup),
  the flash-theater counterpart to `kopytko-brightscript-parser`. Owns the DSL-specific surface
  grammar **and** a full, self-sufficient BrightScript expression/statement grammar plus a
  SceneGraph XML parser (`brightscript-parser.ts`/`brightscript-lexer.ts`, `xml/`) — both
  vendored and adapted from `kopytko-brightscript-parser`, but parsed independently, not
  delegated to it at parse time. See `findings/compiler-parser-architecture.md`.
- `packages/compiler` — the `.thr` → `.xml`/`.brs` compiler (TypeScript). Consumes
  `flash-parser`'s AST (adapted in `dsl-parser/dsl-parser.ts`) instead of hand-parsing anything
  itself. `kopytko-brightscript-parser` (npm) survives here for two narrow roles, never for
  parsing DSL source: validating the compiler's own *generated* `.brs` output post-codegen
  (`validate-generated-brs.ts`), and supplying Roku's own builtin-function name catalog
  (`builtinNames`) that `analysis/scope-resolution.ts` consults during DSL identifier
  resolution.
- `apps/sample-app` — a minimal Roku app used as the testbed and end-to-end proof for compiled
  components, including sideload onto a real device. Its `MainScene` is itself compiled from `.thr`
  (`<component extends="Scene">` — see `packages/compiler/GRAMMAR.md`'s "`<component>` — the
  mandatory root tag"), the primary showcase of the "theater" architecture end to end, root
  included.
- `apps/focus-demo` — a second, dedicated Roku app for the focus/navigation feature, isolated from
  every `apps/sample-app` demo (`FlashTheaterFocusManager`'s LRUD registry is app-wide, so
  co-locating independently-laid-out focus demos on one screen lets `navigate()` geometrically
  jump between them unintentionally — see `findings/focus-system.md`). Router-mounted with 7
  chapter routes (one per mechanism, each with a default AND a customized example — see
  `findings/demo-app-conventions.md`), the 7th (`JumpFocusDemo`) added for `jumpFocus(<direction>,
  <count>, <press>)`, the RowList-style multi-item-jump counterpart to hold-to-repeat — see
  `findings/jump-focus.md`. One chapter, `CrossSiblingRelayDemo`, is deliberately
  **kept hand-written**, not `.thr`-compiled — the project's one worked example of a
  hand-composed component interoperating cleanly with already-`.thr`-compiled children
  underneath it, now used as a router route's own `component:` rather than as this app's root
  Scene (see that file's own top-of-file comment, and `findings/focus-demo-app.md` for the
  conversion).
- `apps/animation-demo` — a third, dedicated Roku app showcasing the `animation` feature (custom
  `animation {}` declarations + `.start()`/`.onFinish()`/... trigger sugar, `sequential`/`parallel`
  composition, `transition:`/`in:`/`out:` on both `{#if}` and `{#if:destroy}`, and `animate:<field>`),
  router-mounted with 8 chapter routes (one per mechanism, each with a default AND a customized
  example — see `findings/demo-app-conventions.md`, the reference conversion for every other demo
  app to eventually follow). Its own `MainScene` is `.thr`-compiled (no interop story to prove here,
  unlike `apps/focus-demo`'s deliberately-hand-written one) and mounts a single
  `<FlashTheaterRouterOutlet>` carrying its own `navigate-out:`/`navigate-in:`/`back-out:`/
  `back-in:` transitions — chapter switches double as a live router-outlet-transition demo.
- `apps/task-manager-demo` — a fourth, dedicated Roku app showcasing `taskManager` (priority
  queueing/`cancel`, hysteresis-gated alerting, promise-style `onResult`, and the global
  `onRequestSent`/`onResponseReceived` HTTP interceptors), router-mounted with 4 chapter routes
  (`/run-cancel`, `/alerting`, `/on-result`, `/interceptors`, each with a default AND a customized
  example). The interceptor readout is registered once in `MainScene.thr`'s own `setup()` and
  stays visible across every chapter switch — proving those interceptors are genuinely app-wide
  and register-once, the same way `apps/focus-demo` proves its own app-wide LRUD registry. The
  `taskManager`/`request Http {}`/Timer-statements third that used to be one `apps/async-demo` app
  is now this app plus `apps/requests-demo`/`apps/timers-demo` below — see
  `findings/task-manager-demo-app.md` for the conversion.
- `apps/timers-demo` — a fifth, dedicated Roku app showcasing Timer statements (`setTimeout`/
  `setInterval`/`clearTimeout`/`clearInterval`) and the general component-unmount hook
  (`ft_unmount`) they introduced. Router-mounted with 3 chapter routes (`/basic-lifecycle`,
  `/nested-and-list`, `/focus-teardown-ordering`) migrated from the retired `apps/async-demo`'s
  own `TimerDemoScreen`/`NestedAndListTimerDemo`/`FocusedTeardownDemo` — each migrated screen's
  old `startDemo()` (called explicitly by that app's pre-router `MainScene`) is now
  `public function setup()` for the chapter's own top-level, router-mounted component only; a
  plain nested child two-or-more levels below the router's own mount point (`MiddleWrapper`,
  `TimerLeafWidget`, `TickReadout`) keeps its own explicit `startDemo()` forwarding unchanged, same
  as before. Like `apps/animation-demo`, its `MainScene` is `.thr`-compiled — no interop story to
  prove here. See `findings/timers-demo-app.md` for the full conversion.
- `apps/requests-demo` — a sixth, dedicated Roku app showcasing `request Http {}`'s own
  declaration/calling, response-caching, and `buildRequest`/`parseResponse`/`parseError` crash-
  safety surface, router-mounted with 4 chapter routes (`/declare-call`, `/caching`,
  `/build-safety`, `/parse-safety`, each with a default AND a customized example). Migrated from
  the retired `apps/async-demo` — its own `taskManager`-interceptor-readout story moved to
  `apps/task-manager-demo` instead, not replicated here. Its own `MainScene` is `.thr`-compiled —
  no interop story to prove here, same as `apps/animation-demo`. See
  `findings/requests-demo-app.md` for the conversion.
- `apps/statements-demo` — a seventh, dedicated Roku app showcasing the statement/expression
  grammar (`if`/`else if`/`else` including the inline braceless form, ternary, crash-safe
  `==`/`!=`/`<`/`>`/`<=`/`>=`/`!`, automatic chain safety, `for`/`for each`/`while` loops, anonymous
  function expressions, and the raw BrightScript passthrough escape hatch), router-mounted with 4
  chapter routes (`/conditionals`, `/safe-operators`, `/chain-safety-and-loops`,
  `/anonymous-functions-and-raw`, each with a default AND a customized example). A genuinely new
  chapter app, not a split of a retired one — its own `MainScene` is `.thr`-compiled, no interop
  story to prove here, same as `apps/animation-demo`/`apps/requests-demo`. See
  `findings/statements-demo-app.md` for what each chapter covers.
- `apps/reactive-state-demo` — an eighth, dedicated Roku app showcasing `field`/`derived`/`state`
  and the global `store`'s `read`/`watch` split, router-mounted with 4 chapter routes
  (`/field-and-derived`, `/state`, `/global-store`, `/array-and-assocarray-defaults`, each with a
  default AND a customized example). Genuinely new content, not a migration — no prior app covered
  this topic as its own deep-dive; the mechanic previously only appeared embedded in
  `apps/sample-app`'s `FavoriteCounter.thr`/`Shell.thr`. `/global-store` puts a `read` and a
  `watch` on the SAME store key side by side to show the one-time-snapshot-vs-reactive distinction
  live; `/state` demonstrates the real field-shadowing gotcha (a plain assignment to a name
  matching a `field`'s own name is an ordinary new local, not a hidden field write). Its own
  `MainScene` is `.thr`-compiled — no interop story to prove here, same as `apps/animation-demo`.
  See `findings/reactive-state-demo-app.md` for what each chapter covers.
- `apps/template-and-binding-demo` — a ninth, dedicated Roku app showcasing the template
  surface: static vs dynamic attributes and automatic `id`-based node-ref caching, `{#if}`
  (toggle) vs `{#if:destroy}` (construct/destroy) conditional rendering, `{#each}` keyed
  add/remove/reposition, and `bind:`'s one-directional-only contract. Router-mounted with 4
  chapter routes (`/attributes`, `/if-toggle-vs-destroy`, `/each`, `/bind`, each with a default AND
  a customized example). Genuinely new content, not a migration — no prior app covered this topic
  as its own deep-dive. `/if-toggle-vs-destroy` puts a shared `StepCounter.thr` child inside both a
  toggle-mode and a destroy-mode panel side by side, so the real internal-state-survival
  difference (toggle keeps its count across a hide/show cycle, destroy resets to 0) is directly
  observable, not just asserted; `/each` reorders the SAME backing rows to prove keyed node
  identity survives a reposition (each row's own color travels with it). Its own `MainScene` is
  `.thr`-compiled — no interop story to prove here, same as `apps/animation-demo`. See
  `findings/template-and-binding-demo-app.md` for what each chapter covers.
- `apps/router-demo` — a tenth, dedicated Roku app showcasing the `router` global itself as its own
  deep-dive topic — unlike every other chapter app, where the router is invisible plumbing for that
  app's own chapter-to-chapter navigation, here the router's own mechanics (navigate/params/
  backJourneyData, directional focus, outlet transitions, the loading gate) ARE the subject being
  taught, one chapter at a time. Router-mounted with 4 chapter routes (`/navigate-and-params`,
  `/directional-focus`, `/outlet-transitions`, `/loading-gate`, each with a default AND a
  customized example). `/navigate-and-params` is the one chapter in this app needing real router
  nesting (a "list" -> "detail" -> back round trip via its own `children: [...]`), so
  `router.params.*`/`router.backJourneyData.*` have somewhere genuine to travel between;
  `/directional-focus` adapts `apps/sample-app`'s own `DirectionalFocusDemo.thr`/
  `DirectionalFocusDemoDetail.thr` round trip into this app's chapter framing;
  `/outlet-transitions` narrates the same transition every other chapter switch already plays,
  contrasting REWIND/FAST-FORWARD (always `navigate-out:`/`navigate-in:`) against the physical Back
  key (the only thing in the app that ever plays `back-out:`/`back-in:`); `/loading-gate`
  demonstrates both the deferred-`markReady()` and the never-calls-it/relies-on-`loadingTimeout`
  shapes. Its own `MainScene` is `.thr`-compiled — no interop story to prove here, same as
  `apps/animation-demo`. See `findings/router-demo-app.md` for what each chapter covers and why its
  own REWIND handler deliberately stays a `router.navigate()` call instead of `router.back()`.
- `apps/streams-demo` — another dedicated Roku app showcasing the `stream` primitive (`stream
  <name>: <Type>`, `.emit`/`.subscribe`'s synchronous BehaviorSubject-style replay, a
  class-declared stream field, and the `.subscribe(<target>.<methodName>)` bound-method sugar).
  Router-mounted with 3 chapter routes (`/emit-subscribe`, `/class-stream`, `/bound-method-sugar`,
  each with a default AND a customized example). Genuinely new content, not a migration — no prior
  app covered this topic as its own deep-dive; the mechanic previously only appeared embedded in
  `apps/sample-app`'s `StreamDemo.thr`. `/bound-method-sugar` wires the RAW, hand-written `{
  target, action }` descriptor and the `.subscribe(m.methodName)` sugar that lowers to it side by
  side, both subscribed to the same class-instance stream, so a live run confirms both forms fire
  identically. Its own `MainScene` is `.thr`-compiled — no interop story to prove here, same as
  `apps/animation-demo`. See `findings/streams-demo-app.md` for what each chapter covers.
- `apps/theme-demo` — another dedicated Roku app showcasing the `theme` surface
  (`<theme-template>`/`<theme name="...">` declaration + partial-override validation, bare
  `theme.a.b` access from both a `derived` and directly inline in a template binding, and runtime
  `switchTheme(name)` including its unknown-name no-op). Router-mounted with 3 chapter routes
  (`/theme-template`, `/theme-access`, `/switch-theme`, each with a default AND a customized
  example). Genuinely new content, not a migration — no prior app covered this topic as its own
  deep-dive; the mechanic previously only appeared embedded in `apps/sample-app`'s
  `Theme.thr`/`Dark.thr`/`Light.thr`. `/theme-template` declares a small 2-group template
  (`colors`/`spacing`) with a full-override default variant and a partial-override second variant,
  labeled readouts showing exactly which leaves fall back to the template's own defaults under the
  partial variant. Its own `MainScene` is `.thr`-compiled — no interop story to prove here, same as
  `apps/animation-demo`. See `findings/theme-demo-app.md` for what each chapter covers, including
  the `.ToStr()`-chained-onto-a-theme-leaf gotcha found while building it.
- `apps/classes-demo` — another dedicated Roku app showcasing `.flsh` classes (fields declared both
  top-level and via the constructor-parameter shorthand, all three visibility levels, `extends`/
  `override`/`super`, and reaching `theme`/`router`/`taskManager` from a class method). Router-
  mounted with 3 chapter routes (`/fields-and-methods`, `/extends-override-super`,
  `/global-singletons-from-class`, each with a default AND a customized example). Genuinely new
  content, not a migration — no prior app covered this topic as its own deep-dive; the mechanic
  previously only appeared embedded in `apps/sample-app`'s `Classes/` directory. `/fields-and-methods`
  contrasts a successful withdrawal against one deliberately exceeding a private-field-backed
  overdraft limit, since its `BankAccount` class has no direct public getter for the private field
  at all; `/extends-override-super` constructs the base and derived class from the same starting
  value behind ONE shared button, so `override`'s actual effect is visible by direct comparison
  rather than asserted. Its own `MainScene` is `.thr`-compiled — no interop story to prove here,
  same as `apps/animation-demo`. See `findings/classes-demo-app.md` for what each chapter covers,
  including the exact `class/task-manager-on-result-not-supported` diagnostic confirmed live for
  one of the documented class-body exclusions.
- `apps/environments-demo` — another dedicated Roku app showcasing the `environments` feature
  (`env.<name>` reads, `environments/<name>.config.json`, `manifestOverrides`, local overrides,
  `include`/`exclude` glob patterns). Router-mounted with 2 chapter routes (`/variable-reads`,
  `/overrides-and-manifest`) — smaller than most chapter apps since this topic is inherently
  build-time/config-shaped rather than something a running app can toggle interactively (see
  `findings/environments-demo-app.md` for why). Genuinely new content, not a migration — no prior
  app covered this topic as its own deep-dive; `apps/sample-app`'s own `EnvDemo.thr` only proved
  the mechanism exists, never wired into a router. Unlike every other chapter app, both chapters
  read `env.*`, so there is no meaningful build with no environment active — its own
  `package.json` defaults `FLASH_THEATER_ENV` (and its own `fromEnv` variable) via
  `scripts/with-env.mjs` rather than compiling unconditionally. `/overrides-and-manifest` proves
  `manifestOverrides` and `include`/`exclude` took effect on the actual shipped artifact via two
  live runtime reads (`roAppInfo.GetTitle()`, `ReadAsciiFile` against two environment-only
  placeholder files) rather than narration alone. Its own `MainScene` is `.thr`-compiled — no
  interop story to prove here, same as `apps/animation-demo`. See
  `findings/environments-demo-app.md` for what each chapter covers and the gotchas found building
  its env-aware build scripts.

---

## Repository structure

See [MAP.md](MAP.md) — every source directory with its purpose, generated from the tree so it
cannot drift.

Adding a new source directory? Add its one-line purpose to `scripts/map-areas.json` — `npm run
lint` fails on an undescribed directory.

---

## When a multi-agent Workflow run is worth suggesting

This repo's own recurring task shapes are a good fit for the Workflow tool's
parallel/pipeline agent orchestration — but it still requires the user's own explicit
opt-in each time (the `ultracode` keyword, ultracode being on for the session, or an
explicit "use a workflow" ask). Treat the cases below as **when to propose one to the
user**, not as license to invoke it unprompted:

- **Landing a new DSL feature.** "Definition of done" below names several surfaces
  that all need touching once the core compiler change is implemented (`GRAMMAR.md`,
  `docs/features.md`, the `site/` page, `apps/sample-app`, `findings/`). That fan-out
  — plus a verify stage that re-checks each surface against the checklist — is a
  natural `pipeline()`/`parallel()` candidate once the implementation itself is done.
- **Findings/docs audits.** Checking all `findings/*.md` for staleness after a
  grammar change, or diffing `docs/features.md` against `GRAMMAR.md` and `site/` for
  drift, fits a multi-modal-sweep workflow (one agent per file/surface) better than a
  single serial pass.

---

## Development

```bash
npm install                          # install dependencies
npm run build --workspace packages/flash-parser   # required before packages/compiler can build/test —
                                                    # it's a workspace source dep, not a published package,
                                                    # so it has no dist/ until built (see findings/dev-environment.md)
npm run build --workspace packages/compiler
npm test --workspace packages/flash-parser
npm test --workspace packages/compiler
npm run lint                         # generated-file check + ESLint
npm run map                          # regenerate MAP.md
npm run build:roku                   # compile .thr → .xml/.brs, zip every apps/* workspace
```

Root `npm run build`/`npm test`/`npm run build:roku` already do the `flash-parser` build step
first — only needed by hand when running a single workspace's script directly.

Sideloading onto a real Roku device needs a **native Windows** Node.js install, not WSL — see
`findings/dev-environment.md` for why and for the exact commands.

```bash
cd site && npm run dev               # docs site, Astro dev server
```

---

## Definition of done

**Nothing ships unexplained.** If a mechanic exists (a grammar construct, a runtime behavior, an
interaction between two features, a limitation), an author must be able to find out how it works
from `GRAMMAR.md`/`docs/features.md`/`site/`/a demo app — never by reading compiler internals or
guessing from trial and error. This is a hard rule, not a nice-to-have: a capability that only
works because of an accident of implementation (readable but never deliberately exposed, correct
but never shown working) is exactly as unfinished as one that doesn't compile yet. Items 3–6 below
are how this gets enforced per change; when a change surfaces a mechanic that was previously
implicit or undocumented (found via a bug report, a live device pass, a "does this even work"
question), documenting and demoing it properly is part of finishing that change, not a follow-up.

1. **Tests pass** — root `npm test` (flash-parser then compiler) exits 0. New behavior has new tests.
2. **Lint passes** — `npm run lint` exits 0. This also fails on a stale `MAP.md` or an undescribed
   source directory.
3. **`packages/compiler/GRAMMAR.md` updated** — if the grammar changed (a construct moved
   from "not yet implemented" to supported, or vice versa).
4. **`docs/features.md` updated** — every implemented or newly-deferred feature is reflected there.
5. **`site/` updated** — the corresponding page under `site/src/pages/docs/` (see the routing table
   in "Keeping reference surfaces in sync" below) reflects the change: syntax, a real showcase, and
   the "Not (yet) supported" list. A change that introduces an entirely new feature area (not an
   extension of an existing topic) needs a **new** `site/src/pages/docs/<topic>.astro` page, added
   to `site/src/data/docsNav.ts` (the single source of truth for both the docs sidebar and the
   homepage card grid — one entry there updates both automatically) and to the routing table below,
   same commit.
6. **`apps/sample-app` extended, incrementally, for new DSL syntax or a new compiler feature** —
   add a real `.thr` file (a new component, or a meaningful addition to an existing one) that
   exercises it, not just synthetic in-memory fixtures in `packages/*/test/`. Verify with
   `npm run build:roku` (generated `.xml`/`.brs` parses clean) and, when a device is reachable,
   sideload it — see `findings/dev-environment.md`. Synthetic unit/golden tests stay the primary,
   fast-iteration coverage; the sample app is what actually proves a feature works end to end
   (real cross-node interaction, a real generated bootstrap file wired into a real `Main.brs`,
   whatever unit tests can't reach) and is what catches the kind of bug unit tests miss — see the
   `store`/`theme` feature's own findings entries for two real examples this caught (an
   overlapping-splice bug and an `m.<name>` collision between an element `id` and a
   `field`/`derived`/`state` name) that every synthetic test had missed. **If the touched mechanic
   already has a dedicated chapter app** (see `findings/demo-app-conventions.md`), extend that app
   too, the same way — a new customized example if the change is a new option on an existing
   mechanic, a new chapter if it's a genuinely new one.
7. **Findings updated** — if anything non-obvious was discovered, the relevant `findings/` file is
   updated **in place**.
8. **Issues updated, and kept in sync with `site/`** — if this change fixes something tracked in
   `issues/`, flip its `Status` to `Fixed` (one line naming what changed, moved to the README's
   "Resolved" table) **and remove the matching bullet from its `site/src/pages/docs/<topic>.astro`
   page's "Not (yet) supported" list**, if it had one; if this task surfaced a new bug or a
   deliberate gap that isn't being fixed now, file it in `issues/` using the template in
   [issues/README.md](issues/README.md#writing-rules), **and add a bullet to the matching site
   page's "Not (yet) supported" list** if it's a limitation an author would actually run into
   (skip this for a pure internal bug with no user-visible symptom).

Never hand-edit a generated file: `MAP.md`. Change the source (`scripts/map-areas.json`,
`packages/compiler/src/index.ts`) and run `npm run map`.

---

## Keeping reference surfaces in sync

Each surface below answers a different question — don't duplicate the same
explanation across them; link instead (e.g. "see `GRAMMAR.md`'s ..."). Restated
content drifts and doubles token cost for no benefit: `docs/features.md` says *what*
exists, `GRAMMAR.md` the precise *syntax*, `findings/` the *why/gotchas*, `site/` the
human-friendly walkthrough.

| You changed... | Also update |
|---|---|
| Grammar (new/changed/removed construct) | `packages/compiler/GRAMMAR.md`, `docs/features.md`, the matching `site/src/pages/docs/<topic>.astro` page (see the table below) (+ `ThrPlayground.tsx`'s default source if it demos that construct), `apps/sample-app` (or the matching topic's chapter app — `focus-demo`/`animation-demo`/`task-manager-demo`/`requests-demo`/`timers-demo`/`statements-demo`) `.thr` fixture exercising it |
| Compiler/parser internals, no behavior change | The relevant `findings/` file only, if something non-obvious was learned |
| A `findings/` file added, removed, or renamed | `findings/README.md`'s table |
| A bug is fixed, or a new bug/gap is discovered | `issues/<file>.md` (flip `Status`, or add a new file per [issues/README.md](issues/README.md#writing-rules)) + the matching `site/src/pages/docs/<topic>.astro` page's "Not (yet) supported" list, if the item is a user-facing limitation |
| A source directory added/removed | `scripts/map-areas.json` + `npm run map` (already enforced by lint) |
| A workspace/app added | This file's "Six workspaces" list |

### `site/src/pages/docs/` — the narrative "how do I use X" surface

`site/src/pages/docs/<topic>.astro` is the one place a DSL feature gets prose + a real code
showcase + an explicit "Not (yet) supported" list — the thing a session should update so nothing
shipped is left undocumented for an actual user. It does **not** restate `GRAMMAR.md`'s precise
syntax or `docs/features.md`'s status table — link to both instead (`DocsFooterLinks.astro`).
`site/src/data/docsNav.ts` is the single source of truth for the page list (title/icon/one-line
blurb), consumed by both `DocsLayout.astro`'s sidebar and the homepage's card grid — add a row
there, not just a new `.astro` file, when a topic is added.

| Topic | Page | Source findings file(s) |
|---|---|---|
| Project layout, CLI, sideload | `site/src/pages/docs/getting-started.astro` | `findings/build-layout.md`, `findings/dev-environment.md` |
| `field`/`derived`/`state`, `store`, `read`/`watch` | `site/src/pages/docs/reactive-state.astro` | `findings/reactivity-state.md` |
| `if`/ternary/`==`/loops/`try`/anonymous functions | `site/src/pages/docs/statements.astro` | `findings/compiler-architecture.md` |
| Template attrs, `{#if}`/`{#if:destroy}`/`{#each}`, `bind:` | `site/src/pages/docs/template-and-binding.astro` | `findings/template-blocks.md`, `findings/reactivity-state.md` |
| `focusable`, `on:key`, LRUD, `isFocused`/`isInFocusChain` | `site/src/pages/docs/focus-and-navigation.astro` | `findings/focus-system.md` |
| `router.*`, `FlashTheaterRouterOutlet`, `default-focus` | `site/src/pages/docs/router.astro` | `findings/router.md` |
| `<theme-template>`/`<theme>`, `theme.a.b`, `switchTheme` | `site/src/pages/docs/theme.astro` | `findings/reactivity-theme-parsing.md` |
| `.flsh` classes, `extends`/`override`/`super` | `site/src/pages/docs/classes.astro` | `findings/compiler-architecture.md` |
| `stream`, `.emit`/`.subscribe` | `site/src/pages/docs/streams.astro` | `findings/streams.md` |
| `taskManager.*`, alerting, `onResult`/interceptors | `site/src/pages/docs/task-manager.astro` | `findings/task-manager-core.md`, `-alerting.md`, `-onresult.md`, `-request-interceptors.md` |
| `request Http {}`, caching, `buildRequest`/`parseResponse`/`parseError` | `site/src/pages/docs/requests.astro` | `findings/requests-config.md`, `-runtime.md`, `-caching.md` |
| `animation {}`, `transition:`/`in:`/`out:`, `animate:`, `.onFinish(callback)` | `site/src/pages/docs/animation.astro` | `findings/animation.md`, `findings/animation-onfinish.md` |
| `scale`, `flash-theater.config.json` | `site/src/pages/docs/scale.astro` | `findings/scale-config-and-codegen.md`, `-device-verification.md` |
| `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`, the `ft_unmount` component-unmount hook | `site/src/pages/docs/timers.astro` | `findings/timer-statements.md`, `findings/component-unmount-hook.md` |
| `env.*`, `environments/<name>.config.json`, `manifestOverrides`, `--env`/`FLASH_THEATER_ENV` | `site/src/pages/docs/environments.astro` | `findings/environments.md` |

This table and `site/src/data/docsNav.ts` must never diverge — same commit whenever a page is
added, removed, or renamed, mirroring `findings/README.md`'s own table-drift rule.

**Definition-of-done item 7 ("Findings updated") is widened**: also check whether a
change makes any *routing table* stale (a new or renamed file, a `findings/` file
that grew past its split threshold) — not just whether findings content itself needs
a new fact.

**Split by topic before a file becomes a grab-bag, in every reference surface** — not
just `findings/` (whose own "split past ~250 lines" and density rules live in
[findings/README.md](findings/README.md)). For human-facing docs (`docs/`,
`GRAMMAR.md`, `site/`) this means splitting into more *pages/sections*, not
compressing prose — terseness stays findings-only. A routing table (or a clear
header/TOC) is mandatory once a surface has more than one file covering the same
directory, so a session never has to open every file in `findings/` or
`site/src/pages/` to find the right one.

---

## Testing rules

- **Mirror source path**: `packages/flash-parser/src/parser.ts` →
  `packages/flash-parser/test/parser/parser.test.ts` (same convention in `packages/compiler`).
- **Grammar/diagnostic coverage lives in `packages/flash-parser`'s own test suite**, since it owns
  the DSL grammar — `packages/compiler/test/dsl-parser/dsl-parser.test.ts` only tests the thin
  adapter (flash-parser AST → `ThrScriptAst` shape), not grammar edge cases. Don't duplicate
  grammar-error test cases in both packages.
- **Prefer real fixtures over synthetic ones** where practical — several suites parse the actual
  `apps/sample-app/src/components/ScheduleDateMenuItem/ScheduleDateMenuItem.thr` rather than a
  hand-built stand-in, so a change to real-world shape is caught immediately.
- **Golden-file tests** (`test/codegen/golden.test.ts`) compare exact generated output against
  `test/golden/*/expected.{xml,brs}`. A deliberate output-format change updates the golden file in
  the same commit — that diff is the review artifact.
- **Cover happy path and error cases** (every diagnostic code should have a test asserting it).
- Run `npm test --workspace packages/flash-parser` and `npm test --workspace packages/compiler`
  before every commit (or just root `npm test`, which runs both in order).

---

## Documentation

**[docs/features.md](docs/features.md) is the master list** — every implemented and planned
language feature with status. A feature is not done until it appears there.

`packages/compiler/GRAMMAR.md` is the precise, current grammar reference — the ground
truth for what the compiler actually accepts right now.

**Every change that adds, modifies, or removes a feature must update `docs/features.md`, the
grammar reference if the grammar changed, and the corresponding `site/src/pages/docs/<topic>.astro`
page** (see the routing table in "Keeping reference surfaces in sync") — a feature with no page
covering it, or a page whose showcase no longer matches real behavior, is treated the same as a
missing `docs/features.md` row: not done.

**Every task that uncovers non-obvious knowledge must update the relevant `findings/` file.**

---

## Docs site

Lives in `site/` (Astro 5 + Tailwind v4 + React islands).
Run via `cd site && npm run dev`.

**The site must always reflect the true state of the compiler.** Treat `site/src/pages/` with the
same discipline as `docs/*.md`. `site/src/pages/docs/` (one page per topic, listed in
`site/src/data/docsNav.ts`) is the narrative "how do I use X, with a real showcase" surface —
`site/src/pages/index.astro` (the landing page) links to it rather than restating feature detail
inline, to avoid the same content drifting across three places at once.

---

## Commit conventions

**No `Co-authored-by:` lines, ever.** Use conventional commits.

| Scope | Meaning |
|---|---|
| `feat/fix/refactor(flash-parser):` | `packages/flash-parser` |
| `feat/fix/refactor(compiler):` | `packages/compiler` |
| `feat/fix/refactor(sample-app):` | `apps/sample-app` |
| `feat/fix/refactor(focus-demo):` | `apps/focus-demo` |
| `feat/fix/refactor(animation-demo):` | `apps/animation-demo` |
| `feat/fix/refactor(task-manager-demo):` | `apps/task-manager-demo` |
| `feat/fix/refactor(requests-demo):` | `apps/requests-demo` |
| `feat/fix/refactor(timers-demo):` | `apps/timers-demo` |
| `feat/fix/refactor(statements-demo):` | `apps/statements-demo` |
| `feat/fix/refactor(reactive-state-demo):` | `apps/reactive-state-demo` |
| `feat/fix/refactor(template-and-binding-demo):` | `apps/template-and-binding-demo` |
| `feat/fix/refactor(router-demo):` | `apps/router-demo` |
| `feat/fix/refactor(streams-demo):` | `apps/streams-demo` |
| `feat/fix/refactor(theme-demo):` | `apps/theme-demo` |
| `feat/fix/refactor(classes-demo):` | `apps/classes-demo` |
| `feat/fix/refactor(environments-demo):` | `apps/environments-demo` |
| `feat/fix/refactor(site):` | `site/` |
| `feat(scope)!:` | Breaking change to the grammar |
| `chore(scope):` | Maintenance, no behavior change |
| `test:` / `docs:` / unscoped | Housekeeping |

---

## Compiler pipeline — module responsibilities

| Question | Module |
|---|---|
| "Does this tokenize/parse the whole `.thr` file (the `<script>`/template split, `field`/`derived`/`private\|public function`, the JS-shaped `if`, and the template markup) into a lossless CST/AST?" | `packages/flash-parser/src/parser.ts` (+ `lexer.ts`, `ast.ts`) |
| "Does this parse an embedded BrightScript expression/statement with flash-parser's own vendored grammar, or the template with its own XML parser?" | `packages/flash-parser/src/embedded.ts` |

Strict, non-overlapping stages in `packages/compiler/src/` (all consuming flash-parser's AST, not
hand-parsing anything):

| Question | Module |
|---|---|
| "Does this adapt flash-parser's typed AST into this package's `ThrScriptAst`/`ThrTemplateAst`?" | `dsl-parser/dsl-parser.ts` |
| "Does this parse a single BrightScript expression's identifiers?" | `analysis/expression-region.ts` (delegates to flash-parser's memoized `parseEmbeddedExpression`) |
| "Does this decide what a `field`/`derived`/function name becomes in generated code?" | `analysis/identifier-rewrite.ts` |
| "Does this build the `derived` dependency graph or detect cycles?" | `analysis/dependency-graph.ts` |
| "Does this connect a template attribute to the field(s) that affect it?" | `codegen/template-bindings.ts` |
| "Does this decide a generated name (`private_foo`, `on_fooChange`)?" | `codegen/naming.ts` |
| "Does this emit `.xml`?" | `codegen/xml-emitter.ts` |
| "Does this emit `.brs`, including printing DSL-shaped `if` as BrightScript's `then`/`end if`?" | `codegen/brs-emitter.ts` (prints from flash-parser's structured `Block`/`IfStatement` AST — not a text-splice rewrite) |
| "Does this run the whole pipeline for one file?" | `compile.ts` |
| "Does this touch the filesystem, argv, or exit codes?" | `cli.ts` (kept separate from `bin/flash-theater.ts` so it's testable without spawning a process) |

**Key check:** before hand-parsing anything that looks like BrightScript syntax (an expression, a
statement, a function body) or XML, ask *"does flash-parser's own vendored grammar
(`brightscript-parser.ts`/`xml/`) already give me this?"* This repo never reimplements
BrightScript or XML parsing outside flash-parser's own owned grammar — see
`findings/compiler-parser-architecture.md`. New DSL syntax (a new statement kind, a new declaration)
gets added to `packages/flash-parser`, not to `packages/compiler`.
