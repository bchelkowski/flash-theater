# findings/ — internal knowledge base

What we learned the hard way, written for whoever works here next. Not user documentation —
that is `docs/`, `packages/compiler/GRAMMAR.md`, and `site/`.

## Read this before starting

| Working on | Read |
|---|---|
| Build, test, sideload, or any Roku device communication | [dev-environment.md](dev-environment.md) |
| Pitfall checklist, naming conventions (`private_`/`ft_`/`$$ft_`), or module-reorganization history — the base reading for anything in `packages/compiler/src/` or `packages/flash-parser/src/` | [compiler-architecture.md](compiler-architecture.md) |
| flash-parser's CST/AST design, `kopytko-brightscript-parser` identifier-rewrite text-splicing, or template-markup-as-XML parsing | [compiler-parser-architecture.md](compiler-parser-architecture.md) |
| `analysis/scope-resolution.ts`'s identifier resolver, or the private-function-survives-a-second-rewrite-pass bug | [compiler-identifier-resolution.md](compiler-identifier-resolution.md) |
| `brs-emitter.ts`/`statement-printer.ts`/`class-emitter.ts` codegen conventions — AST-printing, `else`/`else if` flattening, no-`void`-type design, unused param/local elision | [compiler-codegen-conventions.md](compiler-codegen-conventions.md) |
| `compile.ts`'s no-fs-access design, `CompileThrOptions`, generated-file collision detection, or the site-playground grammar-change trap | [compiler-pipeline-and-build.md](compiler-pipeline-and-build.md) |
| `.flsh`/`class` codegen — separate-pipeline rationale, visibility/`override` checking, or cross-file import/extends resolution | [class-pipeline.md](class-pipeline.md) |
| Global-singleton access (`theme`/`router`/`taskManager`) from inside a `.flsh` class body — `GetGlobalAA()` aliasing, hoisting bug, or a class method's `m` | [class-pipeline-global-singleton-access.md](class-pipeline-global-singleton-access.md) |
| `apps/classes-demo`'s chapters, its class-field-literal-can't-be-negative gotcha, or the confirmed `class/task-manager-on-result-not-supported` diagnostic | [classes-demo-app.md](classes-demo-app.md) |
| DSL function/parameter declarations, reserved `ft_` prefix, Scene setup ordering, `init`/`onKeyEvent` collisions, loops/`try`-`catch`, or string-literal escaping | [statement-grammar-features.md](statement-grammar-features.md) |
| Ternary (`cond ? a : b`) operator | [operators-ternary.md](operators-ternary.md) |
| Comparison/relational (`==`/`!=`/`<`/`>`/`<=`/`>=`) operators | [operators-comparison.md](operators-comparison.md) |
| Safe NOT (`!`) operator | [operators-safe-not.md](operators-safe-not.md) |
| Optional chaining (`?.`/`?[`/`?(`) inserted into generated `.brs` | [operators-optional-chaining.md](operators-optional-chaining.md) |
| Anonymous function expressions (`function (...) { }`) | [anonymous-functions.md](anonymous-functions.md) |
| `store`, `state`, or `read`/`watch` — the core reactive data-flow design | [reactivity-state.md](reactivity-state.md) |
| `theme.a.b` access resolution, or `.thr` root-tag dispatch (`<theme-template>`/`<theme>`/`<store>`-rejection/`<component>`) | [reactivity-theme-parsing.md](reactivity-theme-parsing.md) |
| `derived`'s declared-type enforcement — the static type-inference pass and its `unknown` boundary | [reactivity-derived-type-check.md](reactivity-derived-type-check.md) |
| `field`/`state` array or assocarray literal-default validation | [reactivity-field-state-literals.md](reactivity-field-state-literals.md) |
| `bind:<field>={<state>}` — one-directional binding, teardown, or `{#each}` rejection | [reactivity-bind.md](reactivity-bind.md) |
| Reactivity codegen conventions — `init()`/`setFields()`, binding-collision checks, `FlashTheater/` output subfolder | [reactivity-codegen-conventions.md](reactivity-codegen-conventions.md) |
| `apps/reactive-state-demo`'s chapters, its field-shadowing/read-vs-watch demos, or gotchas found while building that app | [reactive-state-demo-app.md](reactive-state-demo-app.md) |
| `apps/theme-demo`'s chapters (`<theme-template>`/`<theme>` declaration + partial-override validation, `theme.a.b` access from a `derived` vs. inline in a template binding, runtime `switchTheme` including the unknown-name no-op), or the `.ToStr()`-chained-directly-onto-a-theme-leaf gotcha | [theme-demo-app.md](theme-demo-app.md) |
| `stream` — pub-sub between objects within one component | [streams.md](streams.md) |
| `apps/streams-demo`'s chapters, its raw-descriptor-vs-sugar bound-method chapter, or gotchas found while building that app | [streams-demo-app.md](streams-demo-app.md) |
| `{#if}`/`{#if:destroy}`/`{#each}` — shared block-marker parsing and analysis architecture | [template-blocks.md](template-blocks.md) |
| `{#if:destroy}` runtime mechanics — synthetic Group wrapper, sibling-insertion index, guard/exclude cascade | [template-conditional-blocks.md](template-conditional-blocks.md) |
| `{#each}` marker parsing, the always-static wrapper design, item-body caching rules, or the no-built-in-index-variable gap | [template-each-blocks.md](template-each-blocks.md) |
| `{#each}`'s reconcile algorithm — `init()`-ordering bug, dependency scanning, keyed diff, `findNode` item relocation | [template-each-reconcile.md](template-each-reconcile.md) |
| A block nested inside `{#each}`'s body, or `{#each}` nested inside `{#if:destroy}` | [template-each-nesting.md](template-each-nesting.md) |
| `apps/template-and-binding-demo`'s chapters, its `scale`-statement double-scaling gotcha, or that app's own coverage audit | [template-and-binding-demo-app.md](template-and-binding-demo-app.md) |
| A literal `<`/`>`/`&` inside a template attribute value, or `&lt;`/`&gt;` rendering on screen instead of the intended character | [template-attribute-value-escaping.md](template-attribute-value-escaping.md) |
| `focusable`, `on:key`, or `FlashTheaterFocusManager` — compile-time ownership + confirmed platform facts (quick-reference index) | [focus-system.md](focus-system.md) |
| `navigate()`/LRUD registry mechanics, the vacuum rule, `claimFocusIfVacant`, reactive focus state, or hold-to-repeat | [focus-runtime-registry.md](focus-runtime-registry.md) |
| Focus-loss bugs — `recoverFocusFor(owner)` scoping, or `currentlyFocusedEntry()`/`applyPendingFocus()` | [focus-runtime-bugs.md](focus-runtime-bugs.md) |
| Router-free default-focus claims, `{#if:destroy}` with nested custom components, or `navigate()`'s cross-owner fallback | [focus-router-free-and-nested-gaps.md](focus-router-free-and-nested-gaps.md) |
| `jumpFocus(<direction>, <count>, <press>)`, `navigateBy`/`stepOnce`, or why FF/RW jump-by-N can't be an automatic LRUD-style fallthrough | [jump-focus.md](jump-focus.md) |
| `apps/focus-demo`'s chapter/router conversion, its hand-authored `CrossSiblingRelayDemo` routed screen, or that app's own coverage audit | [focus-demo-app.md](focus-demo-app.md) |
| `apps/focus-demo`'s `JumpFocusDemo` chapter (the `jumpFocus` feature's own dedicated tour) | [jump-focus-demo-app.md](jump-focus-demo-app.md) |
| `animation {}`, `.start()`/`.stop()`/..., `transition:`/`in:`/`out:`/`animate:`, or `Animation`/`*FieldInterpolator` codegen — real device-found bugs, known limitations | [animation.md](animation.md) |
| `apps/animation-demo` coverage audit, its chapter/router conversion, or animation-feature authoring gotchas found while building/extending that app | [animation-demo-app.md](animation-demo-app.md) |
| `animation {}` config/codegen — `target`, scale broadcast, `transition:`/`in:`/`out:`, or `animate:<field>` | [animation-config-codegen.md](animation-config-codegen.md) |
| `animation {}` inside `{#if}`/`{#if:destroy}`, focus-safety during animated removal, or `scaled: true` | [animation-scale-and-destroy-targeting.md](animation-scale-and-destroy-targeting.md) |
| `.onFinish(callback)` — animation-finished hook design, shared per-name state-change handler | [animation-onfinish.md](animation-onfinish.md) |
| `router.*`, `FlashTheaterRouter`/`FlashTheaterRouterOutlet`, or `default-focus` — namespace/codegen mechanics core | [router.md](router.md) |
| `FlashTheaterRouterOutlet` runtime — history/route matching, `changeToken`, teardown, or back-key fallthrough | [router-outlet-runtime.md](router-outlet-runtime.md) |
| Router/focus integration — persistent chrome under the vacuum rule, `focusComponent` from an outlet callback, or directional focus (`router.isBackJourney`) | [router-focus-integration.md](router-focus-integration.md) |
| Route-keyed focus-memory design for a gated back-navigation loading gate, or the early-arming bug | [router-focus-integration-route-memory-bugs.md](router-focus-integration-route-memory-bugs.md) |
| Focus-memory generalized to every navigation direction (`beginSuppressedNavigation`), `mostRecentlyFocusedWithin` redesign | [router-focus-integration-navigation-memory-redesign.md](router-focus-integration-navigation-memory-redesign.md) |
| `setup()` lifecycle — router-mounted vs. plain non-router-mounted components | [router-setup-lifecycle.md](router-setup-lifecycle.md) |
| Router-outlet transitions — `navigate-out:`/`navigate-in:`/`back-out:`/`back-in:`, `loadingComponent`, `router.markReady()`, innermost-outlet spinner suppression | [router-transitions.md](router-transitions.md) |
| Router-outlet transition bugs — device-found crashes/leaks/reversal bugs and their fixes | [router-transitions-bugs.md](router-transitions-bugs.md) |
| `apps/sample-app`'s `Shell.thr` outlet-viewport layout lessons (clipping, spinner compensation, sidebar overlap) | [router-transitions-demo-notes.md](router-transitions-demo-notes.md) |
| `apps/router-demo`'s own chapter deep-dive into the router itself (as opposed to every other chapter app, which just uses it as plumbing), its nested navigate-and-params round trip, or why REWIND deliberately stays a `router.navigate()` call there | [router-demo-app.md](router-demo-app.md) |
| `taskManager.run/cancel/setMaxConcurrent`, priority, alerting, or `FlashTheaterTaskManager`'s core surface | [task-manager-core.md](task-manager-core.md) |
| `taskManager.onAlertChanged` — task-manager alerting callback sugar | [task-manager-alerting.md](task-manager-alerting.md) |
| `taskManager.onResult(...)` — design history, local-registration fix, `m`-rebinding bug | [task-manager-onresult.md](task-manager-onresult.md) |
| `taskManager.onRequestSent`/`onResponseReceived` global HTTP interceptors | [task-manager-request-interceptors.md](task-manager-request-interceptors.md) |
| `apps/task-manager-demo`'s chapter/router conversion (split out of `apps/async-demo`, the last of the 3-way split), its `/on-result`/`/interceptors` chapters, or that app's own coverage audit | [task-manager-demo-app.md](task-manager-demo-app.md) |
| `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` — Timer node lifecycle sugar, callback registry, ms→s conversion | [timer-statements.md](timer-statements.md) |
| The general component-unmount hook (`ft_unmount`) — why it's unconditional, RouterOutlet/`{#if:destroy}` call sites, the `{#each}` gap | [component-unmount-hook.md](component-unmount-hook.md) |
| `apps/timers-demo`'s chapter/router conversion (split out of `apps/async-demo`), its `startDemo()`→`setup()` renaming per file, or that app's own coverage audit | [timers-demo-app.md](timers-demo-app.md) |
| `request Http { ... }` config/codegen, or `runtime-assets/Http/FlashTheaterHttp.brs`'s generated fields | [requests-config.md](requests-config.md) |
| `request Http { ... }` transport, hook-invocation safety, or live-device platform gotchas | [requests-runtime.md](requests-runtime.md) |
| `request Http { ... }`'s `cache: { ttlSeconds }` / `cachefs:/` response caching | [requests-caching.md](requests-caching.md) |
| `apps/requests-demo`'s chapter/router conversion, its split off `apps/async-demo`, or that app's own coverage audit | [requests-demo-app.md](requests-demo-app.md) |
| `scale` compile-time design — config, grammar interception, XML default override, runtime dispatch | [scale-config-and-codegen.md](scale-config-and-codegen.md) |
| `scale` live-device lessons — `ui_resolutions` tiers, `designResolution` choice, partial-scale focus breakage | [scale-device-verification.md](scale-device-verification.md) |
| `src/`/`out/` project layout, `project-layout.ts`, `flash-theater.config.json`'s `srcDir`/`outDir`/`exclude`, or the CLI's compile/clean-rebuild behavior | [build-layout.md](build-layout.md) |
| `env.*`, `environments/<name>.config.json`, `--env`/`FLASH_THEATER_ENV`, `out-<env>/`, local overrides (`*.local.config.json`), or `manifestOverrides` | [environments.md](environments.md) |
| Raw BrightScript passthrough (`' flash-theater:raw` / `' flash-theater:end-raw`), marker-comment boundary detection, or why `.flsh` has no top-level form | [raw-brightscript-passthrough.md](raw-brightscript-passthrough.md) |
| `apps/statements-demo`'s chapters (conditionals/ternary, crash-safe comparison/relational/NOT, chain safety + loops, anonymous functions + raw passthrough), or the inline-`if`-doesn't-dispatch-`state` gotcha | [statements-demo-app.md](statements-demo-app.md) |
| `apps/environments-demo`'s chapters (`env.*` reads, live `roAppInfo`/`ReadAsciiFile` proofs of `manifestOverrides`/include-exclude), or why its own `package.json` needs `scripts/with-env.mjs` unlike every other chapter app | [environments-demo-app.md](environments-demo-app.md) |
| The demo-app convention (every `apps/*-demo` app uses `router`+`scale`, one chapter app per mechanic, default+customized coverage), or which topics still need a dedicated app | [demo-app-conventions.md](demo-app-conventions.md) |
| `.github/workflows/` — CI, GitHub Pages deploy, or the npm release workflows for `flash-parser`/`packages/compiler` (the `"files"` packaging trap, the `runtime-assets/` shipping requirement, npm Trusted Publisher setup) | [release-and-ci.md](release-and-ci.md) |

Locating code is a different question — use [MAP.md](../MAP.md).

## Writing rules

1. **Update the reference file in place.** Replace what your finding supersedes; do not append a
   dated entry describing the change. If the file now contradicts itself, you appended.
2. **No dates in reference files**, except a live-verification marker (device model, firmware,
   capture date) — that is evidence, not history.
3. **Keep the *why*.** One clause is enough, but it must survive. A rule with no reason gets
   "cleaned up" by the next person who finds it inconvenient.
4. **Mark unverified claims ⚠️.** A doc-derived shape is a hypothesis, not a fact.
5. **Split past ~250 lines** rather than letting one file become a dumping ground.

## Compression style

Reference files are read on nearly every task, so density is a feature:

- **Answer first.** Do not restate the problem before the finding.
- **Tables over prose** for anything enumerable.
- **Imperative mood** — "Use X. Never Y." not "It was found that using X…".
- **Do not inflate bold.** When everything is emphasized, nothing is.
- **This does not apply to `docs/`, `GRAMMAR.md`, or `site/`.** Those are read by humans
  evaluating the compiler. Terseness there is a downgrade, not a saving.
