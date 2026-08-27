# flash-theater — Feature Overview

Canonical list of language and tooling features. **A feature is not "done" until it appears
here.** Status legend: ✅ Implemented · 🟡 Partial · ⬜ Planned.

> This page tracks feature status across the whole language, compiler, and tooling — it isn't
> split by release. The precise, current grammar is
> [`packages/compiler/GRAMMAR.md`](../packages/compiler/GRAMMAR.md) — this page tracks status and
> roadmap, GRAMMAR.md is the ground truth for what actually compiles right now.

---

## Language — bindings

| Feature | Status | Doc |
|---|---|---|
| `<component>` — the mandatory root tag wrapping every `.thr` file's template markup, replacing a bare root element; 1+ top-level siblings allowed directly, no forced wrapper node | ✅ | GRAMMAR.md — "`<component>` — the mandatory root tag" |
| `<component extends="...">` — declares the compiled component's SceneGraph base class (`Group` default, unchanged; `Scene`/`Task`/`Node`/any value pass through verbatim, unvalidated) | ✅ | GRAMMAR.md — "`<component>` — the mandatory root tag" |
| `<component on:key[...]="...">` — component-level, unconditional key handling (not gated by a descendant's focus state), replacing a hand-written `onKeyEvent` for a root component | ✅ | GRAMMAR.md — "`on:key` at the component level" |
| `field` declarations (public props / task input) — `string \| integer \| float \| boolean \| node \| array \| assocarray`, literal shape checked against the declared type | ✅ | GRAMMAR.md |
| `derived` declarations with a required type annotation and statically-inferred dependencies | ✅ (declared type is checked against a best-effort static inference of the expression — literals, field/state/derived refs, arithmetic/string-concat/comparison/relational/boolean operators, and calls to a same-script function or a `ClassName(...).method()`; a genuinely unresolvable operand, e.g. a builtin call or member access, infers `unknown` and is never flagged — see GRAMMAR.md's `derived` section) | GRAMMAR.md |
| `private function` / `public function` declarations | ✅ | GRAMMAR.md |
| Optional return type — omitted entirely compiles to a BrightScript `sub`, not `function`; there is no `void` type | ✅ | GRAMMAR.md |
| `state` (mutable, component-local reactive state) — unrestricted `<Type>`, literal default may be an array/assocarray | ✅ | GRAMMAR.md |
| Global `store` — a built-in runtime primitive (fixed `FlashTheaterStore` component), never declared in the DSL; schemaless, holds any value (scalar/AA/array/node) | ✅ | GRAMMAR.md — "Global store" |
| `read <name> = store(<path>)` — one-time, non-reactive store snapshot | ✅ | GRAMMAR.md — "`read` / `watch`" |
| `watch <name> = store(<path>)` — reactive store binding, recomputed like a `derived` | ✅ | GRAMMAR.md — "`read` / `watch`" |
| `store(<topLevelKey>) = <expr>` — the only store write; a single top-level key only, never a nested path | ✅ | GRAMMAR.md — "`store(...)` write" |
| `scale field`/`scale state`/`scale derived`/`scale watch`/`scale read` — scales the value at runtime by `(actual device display width) / (configured design-resolution width)`, computed once at app boot; requires a new `flash-theater.config.json` (`{ "designResolution": "hd" \| "fhd" }`) whenever used; works on `integer`/`float`, and element-wise/per-key on `array`/`assocarray` (one level deep) — `node` stays excluded (nothing numeric to scale) | ✅ | GRAMMAR.md — "`scale`" |
| `<theme-template>` — nested group/leaf shape + defaults, `default="name"` attribute | ✅ | GRAMMAR.md — "Theme" |
| `<theme name="...">` variants — partial override, validated against the template (kind + explicit type match) | ✅ | GRAMMAR.md — "Theme" |
| Bare `theme.a.b` access, no new keyword (a real BrightScript dot-expression) | ✅ | GRAMMAR.md — "Theme" |
| Runtime theme switching (`switchTheme(name)`, no-op + debug print on an unknown name) | ✅ | `packages/compiler/src/codegen/theme-emitter.ts` |
| Global `router` — a built-in runtime primitive (fixed `FlashTheaterRouter` component), never declared in the DSL; `router.navigate(path, [params], [skipInHistory])`, `router.back()`, `router.resetHistory([rootPath])`, `router.appendBackJourneyData(data)`/`router.updateBackJourneyData(data)`, `router.markReady()`, and schemaless `router.path`/`router.params.*`/`router.backJourneyData.*`/`router.isBackJourney` reads — one namespace for both actions and data, unlike `store`/`theme`'s separate treatments | ✅ | GRAMMAR.md — "Router" |
| Directional focus — `router.isBackJourney` combined with an explicit `focus(<id>)` call in `setup()`, letting the same route choose a different initial focus target for a forward visit vs. a back journey | ✅ | GRAMMAR.md — "Router" → schemaless data reads, `apps/sample-app`'s `DirectionalFocusDemo.thr`/`DirectionalFocusDemoDetail.thr` |
| `<FlashTheaterRouterOutlet>` — renders whichever route currently matches; any number may be mounted at once, nested arbitrarily, each independently deciding whether its own match changed (persistent chrome across a deeper navigation) | ✅ | GRAMMAR.md — "Router" |
| Automatic back-key (`onKeyEvent`) fallthrough on the Scene-rooted component — calls `router.back()`, falls through to Roku's own default app-exit behavior once history is empty | ✅ | GRAMMAR.md — "Router", `packages/compiler/src/codegen/brs-emitter.ts` |
| Deferred focus hand-off after a route change — the mount cascade only *records* a focus target (it runs too deep for Roku to establish real key routing from there); the compiler emits a shallow `applyPendingFocus()` sibling statement after every `router.navigate(...)`/`router.back()`, which requires those two to be standalone statements (`expression/router-action-must-be-statement`) | ✅ | GRAMMAR.md — "Router" → "Navigation and focus" |
| Automatic `setup()` call on every router-mounted component (mirrors the app's own hand-called `scene.callFunc("setup")`) | ✅ | GRAMMAR.md — "Router", `packages/compiler/runtime-assets/RouterOutlet/FlashTheaterRouterOutlet.brs` |
| Router-outlet transitions — `navigate-out:`/`navigate-in:`/`back-out:`/`back-in:` on `<FlashTheaterRouterOutlet>` (direction-aware slide/preset/custom animations, always targeting the outlet's own translation — a "teleport" model, not two co-mounted screens); `repeat: true` rejected on the `navigate-out:`/`back-out:` exit side | ✅ | GRAMMAR.md — "Router" → "Router-outlet transitions" |
| Router-outlet loading gate — `loadingComponent`/`loadingMinDuration`/`loadingTimeout`, held up until the mounted screen calls `router.markReady()` (a plain field flip on the calling component's own top, not a router-singleton `callFunc`) or the timeout elapses; only the innermost transitioning outlet shows its indicator when nested outlets gate simultaneously | ✅ | GRAMMAR.md — "Router" → "Router-outlet transitions" |
| Deferred focus restoration on any router navigation (forward or back, gated or immediate) — continuously remembers whatever was last genuinely focused anywhere inside a route's own mounted content (including inside a nested custom component, e.g. a list row), surviving the user stepping back to a persistent menu before triggering the navigation; stays unfocused until the destination actually mounts/settles, then restores that element (or nearest surviving ancestor, matched by `id`, searched app-wide) the next time the same route mounts, even across a brand-new component instance and even for a dynamically-created `{#each}` element; only ever observable when returning creates a genuine focus vacancy — never steals focus from something still legitimately held (the vacuum rule) | ✅ | GRAMMAR.md — "Router" → "Navigation and focus", `findings/router-focus-integration-navigation-memory-redesign.md` |
| Bare `env.<name>` access — reads a declared variable of the active environment (`--env`/`FLASH_THEATER_ENV`), resolved structurally like `theme.a.b` (not schemaless); a compile error with no active environment or an undeclared name, since the variable set is fully known from the environment's own config at compile time | ✅ | GRAMMAR.md — "Environments" |
| Live cross-component reactivity for `theme` reads and `watch` (generated `ObserveFieldScoped`) | ✅ | `packages/compiler/src/analysis/expression-region.ts`, `packages/compiler/src/analysis/dependency-graph.ts` |
| Identifier-rewrite inside function bodies (not just `derived`/template exprs) | ✅ | `findings/compiler-identifier-resolution.md` |
| Unused-parameter `_`-prefixing (generated code only) and unused-local statement elision (call-free right-hand sides only) | ✅ | `packages/compiler/src/analysis/scope-resolution.ts`, `packages/compiler/src/analysis/unused-locals.ts` |

`apps/environments-demo` is a full, router-mounted, `scale`d chapter tour of the `environments`
feature — 2 chapters (paths `/variable-reads` and `/overrides-and-manifest`), covering `env.<name>`
reads (a URL-shaped variable, a feature-flag-shaped variable, and a `fromEnv`-sourced one), local
overrides, `manifestOverrides` (verified live via `roAppInfo.GetTitle()`), and include/exclude glob
patterns (verified live via `ReadAsciiFile` against two environment-only placeholder assets).
Unlike every other chapter app, this one has no meaningful "plain" (no active environment) build —
every chapter reads `env.*` — so its own `package.json` defaults `FLASH_THEATER_ENV` via
`scripts/with-env.mjs` rather than compiling unconditionally. See
`findings/demo-app-conventions.md` for the app-structure convention this instantiates and
`findings/environments-demo-app.md` for what each chapter covers.

`apps/router-demo` is a full, router-mounted, `scale`d chapter tour of the router's OWN option
surface specifically — unlike every other chapter app (where the router is invisible plumbing for
that app's own chapter-to-chapter navigation), this one treats the router's own mechanics as the
subject matter being taught. 4 chapters (paths `/navigate-and-params` through `/loading-gate`), each
showing at least one default example and one deliberately-customized variant, reachable in the
compiled app via REWIND/FAST-FORWARD; `/navigate-and-params` additionally nests a real "list" ->
"detail" -> back round trip (the one chapter in this app needing router nesting) to give
`router.params.*`/`router.backJourneyData.*` somewhere real to travel between. See
`findings/demo-app-conventions.md` for the app-structure convention this instantiates and
`findings/router-demo-app.md` for what each chapter covers.

`apps/reactive-state-demo` is a full, router-mounted, `scale`d chapter tour of this whole feature —
4 chapters (paths `/field-and-derived` through `/array-and-assocarray-defaults`), each showing at
least one default example and one deliberately-customized variant, reachable in the compiled app
via REWIND/FAST-FORWARD. See `findings/demo-app-conventions.md` for the app-structure convention
this instantiates and `findings/reactive-state-demo-app.md` for what each chapter covers.

`apps/theme-demo` is a full, router-mounted, `scale`d chapter tour of the theme surface — 3
chapters (paths `/theme-template`, `/theme-access`, `/switch-theme`), each showing at least one
default example and one deliberately-customized variant, reachable in the compiled app via
REWIND/FAST-FORWARD. See `findings/demo-app-conventions.md` for the app-structure convention this
instantiates and `findings/theme-demo-app.md` for what each chapter covers.

## Language — statements (inside function bodies)

| Feature | Status | Doc |
|---|---|---|
| JS-shaped `if (cond) { }` / inline `if (cond) stmt` (never BrightScript's `then`/`end if`) | ✅ | GRAMMAR.md |
| `else` / `else if` | ✅ | GRAMMAR.md |
| Ternary `cond ? a : b` — as the whole RHS of a plain assignment or a `state` write, fully nestable (chained, nested-in-branch, or nested inside a larger expression); compiles to a hoisted temp var + `if`/`else` | ✅ | GRAMMAR.md — "Ternary (`? :`)" |
| Crash-safe equality (`==`/`!=`) — lowers to `ft_equals(left, right)`/`Not ft_equals(left, right)`, a shared runtime helper that returns `false` for a genuine type mismatch instead of crashing (real BrightScript `=`/`<>` remain available, unguarded). Numeric operands compare by value across subtypes (`3 == 3.0` is `true`, JS-`==`-like); array/associative-array/SceneGraph-node operands compare by reference identity (`roUtils.isSameObject`/`isSameNode`), never deep content equality | ✅ | GRAMMAR.md — "Comparison and relational operators" |
| Crash-safe relational operators (`<`/`>`/`<=`/`>=`) — lowers to `ft_relationalGuard(left, right, "<op>")`, a shared runtime helper that requires both operands to be numeric (any subtype) or both `String` before comparing; a genuine mismatch throws a structured `{code, message}` error (catchable via `try`/`catch`) instead of crashing opaquely or guessing a fallback value — there's no obviously-correct fallback *value* for an incompatible ordering comparison the way `false` is for equality | ✅ | GRAMMAR.md — "Comparison and relational operators" |
| Crash-safe unary NOT (`!`) — lowers to `ft_not(operand)`, a shared runtime helper that checks the operand is a real `Boolean` before negating, returning `false` for a genuine type mismatch instead of crashing (real BrightScript `Not` remains available, unguarded). Fully nestable (`!!x`, `!(a == b)`, ...); own dedicated runtime asset, never folded into `==`/`!=`'s SafeCompare helper | ✅ | GRAMMAR.md — "Safe NOT (`!`)" |
| Chain safety — every member/index/call access in generated `.brs` (`.foo`/`[3]`/`(...)`) is rewritten to BrightScript's own native optional-chaining operators (`?.`/`?[`/`?(`/`?@`, Roku OS 11.0+), so a chain never crashes just because an intermediate value is `invalid`. Codegen-only, no runtime helper; applies uniformly to every member/index access, even a lone non-chained one, including chains the compiler itself assembles. Three positions are left fully untouched, since Roku's compiler rejects the operators there: an assignment's target, a bare void-context call statement, and — live-verified on-device, since this one is a genuine install-time compile failure rather than an ordinary syntax error — any call whose callee is a bare identifier (a plain global/built-in function, never `?(` even in a read context; `obj.method()` still becomes `obj?.method?()` since its callee is itself a chain). Hand-writing `?.`/`?[`/`?(`/`?@` in `.thr`/`.flsh` source is a compile error | ✅ | GRAMMAR.md — "Chain safety" |
| `while (cond) { }` loop — JS-bracket syntax like `if`, no BrightScript `end while` surfaced, no inline (braceless) form | ✅ | GRAMMAR.md — "`while`" |
| `for (<var> = <start> to <end> [step <step>]) { }` numeric loop — JS-bracket syntax like `if`, no BrightScript `end for` surfaced, no inline form; raw BrightScript `for i = 0 to 10 ... end for` is no longer usable in `.thr`/`.flsh` source (breaking change, same as `if`'s own `then`/`end if`) | ✅ | GRAMMAR.md — "`for` / `for each`" |
| `for each (<item> in <collection>) { }` loop | ✅ | GRAMMAR.md — "`for` / `for each`" |
| `try { } catch (<name>) { }` — JS-bracket syntax, no `end try` surfaced; `catch`'s variable parens are mandatory (narrowing real BrightScript's own optional-paren form); no `finally`, no catch-less `try` | ✅ | GRAMMAR.md — "`try` / `catch`" |
| Anonymous function expressions `function (<param>: <Type>, ...) [: <Type>] { }` — fully nestable inside a `.thr` function body or a `.flsh` class method/constructor: a call argument to a hand-written function taking a `Function`-typed parameter (`filterList(items, function (x) { ... })` — BrightScript's own `ifArray` has no built-in `Map`/`Filter`/`ForEach`), an `if`/`for`/`while` header, a ternary branch, or (as before) the whole right-hand side of a plain assignment/`state` write. The body supports the full DSL statement grammar, hoisted to a `ft_anon_N` temp var when nested. Does **not** close over the enclosing function's own local variables (matches real BrightScript's own `m`-only-sharing semantics). Not yet supported inside a template attribute/`bind:`/`on:key`/`{#if}`/`{#each}` binding expression (no statement list to hoist into) | ✅ | GRAMMAR.md — "Anonymous function expressions" |
| `scale <name> = <expr>` / `scale state <name> = <expr>` — statement-level counterpart of the `scale` declaration modifier, scaling a local variable assignment or a `state` write at the point it runs | ✅ | GRAMMAR.md — "`scale` (statement form)" |
| Raw BrightScript passthrough (`' flash-theater:raw` ... `' flash-theater:end-raw`) — copies its content into generated `.brs` completely unrewritten (no identifier-rewrite, no elision, only re-indentation), compile-time validated as real BrightScript. Valid as a function/method/constructor-body statement, or as a `.thr`-only top-level `<script>` declaration (appended into `init()`, last). No `.flsh` top-level class-body form (no guaranteed lifecycle sub to land one in), no nesting, not valid as an inline `if`/`else`'s single statement or inside a template/binding expression | ✅ | GRAMMAR.md — "Raw BrightScript passthrough" |

`apps/statements-demo` is a full, router-mounted, `scale`d chapter tour of this whole section —
4 chapters (paths `/conditionals` through `/anonymous-functions-and-raw`), each showing at least
one default example and one deliberately-customized variant, reachable in the compiled app via
REWIND/FAST-FORWARD. See `findings/demo-app-conventions.md` for the app-structure convention this
instantiates and `findings/statements-demo-app.md` for what each chapter covers.

## Language — async & concurrency

| Feature | Status | Doc |
|---|---|---|
| `stream` primitive — a per-instance, BehaviorSubject-like pub-sub value (`stream <name>: <Type>`, `.emit(<value>)`/`.subscribe(<callback>)`), for imperative, reactive communication between different objects (especially `.flsh` class instances) living inside the SAME component/node — never for node-to-node communication, which stays field/binding. A plain BrightScript associative array (`ft_createStream()`), not a generated SceneGraph Node/observed field — a class instance has no SceneGraph identity to hang one off. Also declarable directly as a `.flsh` class field. Deliberately excluded from the `derived`/`watch` dependency graph; no unsubscribe in v1 | ✅ | GRAMMAR.md — "`stream`" |
| `setTimeout(<callback>, <ms>)`/`setInterval(<callback>, <ms>)`/`clearTimeout(<handle>)`/`clearInterval(<handle>)` — bare global functions (not namespaced), full BrightScript `Timer` node lifecycle (creation, field wiring, `ObserveField`, start/stop, cleanup) generated and hidden behind the call. Callback may be an anonymous function or a named function reference; duration is milliseconds, converted to Roku's native seconds. Every pending timer is also automatically stopped when its owning component unmounts (router navigation away, an ancestor `{#if:destroy}` tearing down, or an `{#each}` removing an item that contains it) — see the general component-unmount hook (`ft_unmount`) this feature introduced | ✅ | GRAMMAR.md — "Timer statements" |

`apps/streams-demo` is a full, router-mounted, `scale`d chapter tour of the `stream` primitive — 3
chapters (`/emit-subscribe`, `/class-stream`, `/bound-method-sugar`), each showing at least one
default example and one deliberately-customized variant, reachable in the compiled app via
REWIND/FAST-FORWARD. See `findings/demo-app-conventions.md` for the app-structure convention this
instantiates and `findings/streams-demo-app.md` for what each chapter covers.

`apps/timers-demo` is a full, router-mounted, `scale`d chapter tour of this whole feature —
3 chapters (paths `/basic-lifecycle` through `/focus-teardown-ordering`), each showing at least one
default example and one deliberately-customized variant, reachable in the compiled app via
REWIND/FAST-FORWARD. See `findings/demo-app-conventions.md` for the app-structure convention this
instantiates and `findings/timers-demo-app.md` for what each chapter covers.

## Language — template

| Feature | Status | Doc |
|---|---|---|
| Static attributes (literal, copied 1:1 to XML) | ✅ | GRAMMAR.md |
| Bare attribute (`attr`, no `="..."` at all) — means the same as `attr=""`, e.g. `in:bounce` instead of `in:bounce=""` | ✅ | GRAMMAR.md — "Template" |
| Dynamic `attr="{expr}"` bindings | ✅ | GRAMMAR.md |
| Automatic `id`-based node-ref caching (no `findNode` in authored code) | ✅ | GRAMMAR.md |
| Compile-time detection of a template `id` colliding with a `derived`/`state` name, or duplicated across elements | ✅ | GRAMMAR.md |
| `{#if}` / `{#if:destroy}` conditional rendering | ✅ | GRAMMAR.md — "Conditional rendering" |
| `{#each items as item (key)}` keyed list rendering — full nesting support in both directions (`{#each}` inside `{#if}`/`{#if:destroy}`; `{#if}`/`{#each}` inside `{#each}`, including loop-in-loop); the collection may be an array-like value or a SceneGraph node (iterated over its own children) | ✅ | GRAMMAR.md — "Keyed list rendering" |
| `bind:<field>={<state>}` binding — one-directional child field change → `state` (despite the "two-way" name), any child SceneGraph field | ✅ | GRAMMAR.md — "Two-way binding (`bind:`)" |

`apps/template-and-binding-demo` is a full, router-mounted, `scale`d chapter tour of the rows
above this line (static/dynamic attributes and automatic `id`-based node-ref caching, `{#if}` vs
`{#if:destroy}`, `{#each}` keyed reordering, and `bind:`'s one-directional-only contract) — 4
chapters (paths `/attributes` through `/bind`), each showing at least one default example and one
deliberately-customized variant, reachable in the compiled app via REWIND/FAST-FORWARD. See
`findings/demo-app-conventions.md` for the app-structure convention this instantiates and
`findings/template-and-binding-demo-app.md` for what each chapter covers. The `on:key`/focus rows
below this line have their own dedicated tour, `apps/focus-demo` (see below).

| Feature | Status | Doc |
|---|---|---|
| `on:key[Key1,Key2,...]={<call>}` event binding — bracket-list key names (Roku's own raw `onKeyEvent` strings), `*` wildcard, auto-injected `key`/`press` args, works inside a top-level `{#each}`'s items | ✅ | GRAMMAR.md — "`on:key` event binding" |
| `default-focus="true"` — declares a component's own explicit default focus target (static-only, requires a paired static `focusable="true"`, at most one per component); honored on every entry path (router mount, `focus(<id>)`, cross-component arrow-key entry, post-teardown recovery); falls back to first-registered focusable element when absent, or to the geometric winner on arrow-key entry | ✅ | GRAMMAR.md — "Focus system" |
| `isFocused` / `isInFocusChain` — reserved, reactive read-only fields synthesized **only** for a component that actually reads them (zero codegen otherwise); `isFocused` = this component owns the focused element, `isInFocusChain` = the focused element is anywhere in its subtree; single-writer guarantee makes two simultaneous `isFocused = true` impossible | ✅ | GRAMMAR.md — "Focus system", `packages/compiler/src/analysis/focus-state.ts`, `apps/sample-app`'s `Shell.thr` |
| The vacuum rule — an automatically chosen focus target is applied only when nothing currently holds focus, so a route change never steals focus from a persistent menu/overlay; an explicit `focus(<id>)` deliberately overrides it | ✅ | GRAMMAR.md — "Router" → "Navigation and focus" |
| `claimFocusIfVacant` — the explicit escape hatch for content that appears well after the ordinary mount cascade (a hand-wired `Timer` simulating an async load — `stream` now exists but doesn't itself model timed delay, so this stays the pattern until real timer statements ship, see "Language — async & concurrency" below); fills an existing vacuum, never steals held focus | ✅ | GRAMMAR.md — "Focus system" → "Known limitations", `apps/sample-app`'s `SplashScreen.thr`/`LoadingDemoScreen.thr` |
| Owner-scoped focus recovery (`recoverFocusFor`) — a teardown only recovers focus when *that* component was the one holding it, so a nested child's reconcile can't grab focus mid-construction of an unrelated component | ✅ | GRAMMAR.md — "Focus system", `packages/compiler/runtime-assets/FocusManager` |
| Focus diagnostics — `getFocusPathString()`/`getFocusPath()`/`focusedNode()` report the framework's own authoritative Scene-to-leaf focus path at any moment | ✅ | GRAMMAR.md — "Focus system" |
| `focusable="true"`/`"{expr}"` + automatic cross-component focus system — geometric (LRUD) grid navigation (cross-component search is scoped by the exiting component's own whole bounding box for a non-scrollable component, or its last-focused element for a scrollable one), automatic focus recovery on removal, reactive parent→child handoff, automatic scroll-into-view for a component declaring `scrollOffsetX`/`scrollOffsetY` fields | ✅ | GRAMMAR.md — "Focus system", `apps/sample-app`'s `RichCard.thr` (OK-to-enter/back-to-exit drill-down, parent→child handoff worked end to end) |
| `focus(<id>)` — reserved-keyword statement, usable anywhere in a function body, jumping focus into one of the CALLING component's own descendants (`m.top.findNode`-scoped, never scene-wide), honoring its own remembered last focus; reaching a sibling instead goes through a parent-mediated field+`bind:`/`ObserveFieldScoped` relay | ✅ | GRAMMAR.md — "Focus system", `apps/focus-demo`'s `FocusGroup.thr`/`SimpleFocusItem.thr`/`CrossSiblingRelayDemo.brs` |
| Hold-to-repeat directional navigation — a held up/down/left/right auto-repeats `navigate()` (delay, then accelerating repeats) instead of moving once per physical press, since Roku's own `onKeyEvent` does not auto-repeat while a button is held | ✅ | GRAMMAR.md — "Focus system", `packages/compiler/runtime-assets/FocusManager/FlashTheaterFocusManager.brs` |
| Fast-forward/rewind jump-by-N focus — `jumpFocus(<direction>, <count>, <press>)`, a reserved-keyword statement author-wired to an `on:key[...]` binding (never automatic — see GRAMMAR.md for why; the binding can live on a single leaf or once on a wrapping container, since `on:key` bubbles from wherever focus currently sits), repeating the same geometric single-hop search `navigate()` uses but confined to the SAME registry owner the jump started in (never crossing into a different component mid-jump, unlike a plain arrow-key press) up to `<count>` times, and reusing the exact same hold-to-repeat `Timer` machinery/timings as arrow-key repeat | ✅ | GRAMMAR.md — "Focus system" (`jumpFocus`), `FlashTheaterFocusManager.brs`'s `navigateBy`/`startRepeat`/`onRepeatTimerFire` |

`apps/focus-demo` is a full, router-mounted, `scale`d chapter tour of this whole feature —
7 chapters (paths `/focusable-basics` through `/jump-focus`), each showing at least one
default example and one deliberately-customized variant, reachable in the compiled app via
REWIND/FAST-FORWARD. See `findings/demo-app-conventions.md` for the app-structure convention this
instantiates and `findings/focus-demo-app.md` for what each chapter covers.

## Language — animation

Compiles to Roku's native `Animation`/`SequentialAnimation`/`ParallelAnimation` + `Float`/
`Vector2D`/`ColorFieldInterpolator` nodes throughout — no shared runtime helper library, unlike
`stream`/`scale`/`request Http {}`.

`apps/animation-demo` is a full, router-mounted, `scale`d chapter tour of this whole feature —
8 chapters (paths `/declared` through `/outlet-transitions`), each showing at least one default
example and one deliberately-customized variant, reachable in the compiled app via REWIND/
FAST-FORWARD. See `findings/demo-app-conventions.md` for the app-structure convention this
instantiates and `findings/animation-demo-app.md` for what each chapter covers.

| Feature | Status | Doc |
|---|---|---|
| `animation <name> { ... }` declarations — `target`/`duration`/`easeFunction`/`delay`/`repeat`, the five known field shorthands (`opacity`/`rotation`/`translation`/`scale`/`color`) with a `scale`-only uniform-broadcast shorthand and negative-number support, and a `field`/`as` escape hatch for an arbitrary Roku field | ✅ | GRAMMAR.md — "animation" |
| `scaled: true` on a `translation`/escape-hatch object-form field — runs `keyValue` through the app's `scale` factor at runtime instead of a static literal; `transition:fly`/`transition:slide`'s own offset is scaled by default, computed relative to the target's own static resting `translation` when it has one | ✅ | GRAMMAR.md — "animation" |
| `sequential: true` / `parallel: true` + `steps: [...]` composition, arbitrarily nestable | ✅ | GRAMMAR.md — "animation" → "Layer 1", `apps/animation-demo`'s `SequentialDemo.thr`/`ParallelDemo.thr` |
| `.start()` / `.stop()` / `.pause()` / `.resume()` / `.finish()` trigger sugar — mirrors `stream`'s `.subscribe()`/`.emit()` shape, 1:1 onto Roku's own `AnimationBase.control` values; standalone-statement only | ✅ | GRAMMAR.md — "animation" → "Trigger sugar", `apps/animation-demo`'s `BounceButtonDemo.thr` |
| `transition:<name>` / `in:<name>` / `out:<name>` on a direct child of `{#if}`/`{#if:destroy}` — built-in presets (`fade`/`fly`/`slide`/`scale`) and script-declared `animation` names resolved through one mechanism; deferred `visible=false`/`removeChild` until the exit animation actually finishes, with a stale-completion guard and retimed focus-safety (unregister/`recoverFocusFor` at exit-START, not completion) | ✅ | GRAMMAR.md — "animation" → "Layer 2", `apps/animation-demo`'s `TogglePresetDemo.thr`/`DestroyCustomDemo.thr` |
| `animate:<field>` — auto-animates a matching dynamic attribute's own reactive write instead of an instant snap; the one place in the feature where `keyValue` is computed at runtime, from the field's live current value | ✅ | GRAMMAR.md — "animation" → "Layer 3", `apps/animation-demo`'s `AnimateAttrDemo.thr` |
| `.onFinish(callback)` — animation-finished hook, fires every time (not fire-once) the animation reports `state = "stopped"`; standalone-statement only, rejected on a `repeat: true` animation | ✅ | GRAMMAR.md — "animation" → "`.onFinish(callback)`", `apps/animation-demo`'s `BounceButtonDemo.thr` |

## Language — classes (`.flsh` files)

| Feature | Status | Doc |
|---|---|---|
| `.flsh` file — imports + exactly one `class` declaration, no `<script>` wrapper, no template/XML | ✅ | GRAMMAR.md — "Classes" |
| `class <Name> [extends <Base>] { }` — fields, a constructor, methods | ✅ | GRAMMAR.md — "Classes" |
| Three visibility levels (`public`/`private`/`protected`) on fields and methods; `protected` compiles identically to `public` (no runtime enforcement) | ✅ | GRAMMAR.md — "Classes" |
| Constructor-body field-init shorthand (`private <name>: <Type> = <expr>` inside `constructor`) | ✅ | GRAMMAR.md — "Classes" |
| `extends` + `override constructor` + `super(...)`, structurally validated at parse time | ✅ | GRAMMAR.md — "Classes" |
| `override` method validated at compile time against the resolved base class shape | ✅ | `packages/compiler/src/analysis/class-analysis.ts` |
| `.flsh` import resolution — `./`/`../`-relative **or** app-root-relative imports, topological compile order, cycle detection | ✅ | `packages/compiler/src/app-compiler.ts` |
| A `.thr` component's own `import <Name> from "<path>.flsh"`, wired as deduped `<script uri="...">` tags including transitive imports | ✅ | `packages/compiler/src/app-compiler.ts` |
| Codegen: plain BrightScript prototype-object function, no XML — `private_constructor` invoked as a plain function call so `m` never auto-binds inside it | ✅ | `packages/compiler/src/codegen/class-emitter.ts` |

`apps/classes-demo` is a full, router-mounted, `scale`d chapter tour of this whole section —
3 chapters (`/fields-and-methods` through `/global-singletons-from-class`), each showing at least
one default example and one deliberately-customized variant, reachable in the compiled app via
REWIND/FAST-FORWARD. See `findings/demo-app-conventions.md` for the app-structure convention this
instantiates and `findings/classes-demo-app.md` for what each chapter covers.

## Compiler pipeline

| Feature | Status | Doc |
|---|---|---|
| `.thr` file → lossless CST/AST (`<script>`/template split, `field`/`derived`/`function`/`if`, template markup) | ✅ | `packages/flash-parser/` |
| BrightScript expression/statement parsing and XML tokenizing — flash-parser's own vendored grammar, adapted from `kopytko-brightscript-parser` but not delegated to it at parse time | ✅ | `findings/compiler-parser-architecture.md` |
| Identifier rewrite (`field`/`state`→`m.top.x`/`m.x`, `derived`→`m.x`, `private fn`→`private_x`), with real BrightScript locals shadowing and unresolved names as a hard error | ✅ | `findings/compiler-identifier-resolution.md` |
| Compile-time detection of a `field`/`derived`/`state` name declared more than once across the three kinds | ✅ | `packages/compiler/src/analysis/binding-collisions.ts` |
| `if`-statement printing (JS-shaped `Block`/`IfStatement` AST → BrightScript `then`/`end if`) | ✅ | `packages/compiler/src/codegen/brs-emitter.ts` |
| Dependency graph + compile-time cycle detection (`derived` on `field` **or** `state`) | ✅ | `packages/compiler/src/analysis/dependency-graph.ts` |
| XML emitter (static tree + `<interface>`) | ✅ | `packages/compiler/src/codegen/xml-emitter.ts` |
| `.brs` emitter (`init()` + per-field `onChange` handlers) | ✅ | `packages/compiler/src/codegen/brs-emitter.ts` |
| Whole-app compile (`compileApp`) — cross-file theme-variant validation, fail-fast before any component compiles; tallies whether any component uses the store/focus system/router/task manager | ✅ | `packages/compiler/src/app-compiler.ts` |

## Runtime services

| Feature | Status | Doc |
|---|---|---|
| Task-node concurrency manager — a generated runtime component tracks how many `Task` nodes are actively running app-wide, queues/delays new ones as RokuOS's soft (50) and hard (100) concurrent-task limits are approached, so app code never hand-rolls its own throttling | ✅ | GRAMMAR.md — "Task manager", `apps/task-manager-demo`'s `RunCancelDemo.thr` |
| HTTP requests (`request Http { method, url, headers, query, body }`) — a declarative Task-based request/endpoint component with `buildRequest`/`parseResponse`/`parseError` hooks (safe as `private function`) and generated `result`/`error` fields; a request declaring `buildRequest` also gets a `callFunc`-reachable `prepareRequest(requestData)` the caller invokes before `taskManager.run(task)`, resolving per-call options on the calling thread instead of inside the Task's own background thread (avoids a real Roku rendezvous) — consumed via the same `taskManager.run(task)` + `observeFieldScoped` idiom every other Task already uses | ✅ | GRAMMAR.md — "Requests", `apps/requests-demo`'s `BuildRequestSafetyDemo.thr`/`ParseSafetyDemo.thr` |
| HTTP response caching — GET-only, `cachefs:/`-backed, **on by default** (follows the server's own `Cache-Control` automatically, no `cache` key needed); `cache: false` forces it off, `cache: { ttlSeconds }` forces an exact lifetime overriding `Cache-Control` entirely; `response.fromCache` reports a hit | ✅ (known limitations: no `Expires` header parsing — only `Cache-Control: max-age` — and no ETag/conditional-GET revalidation; see GRAMMAR.md's Requests section, "Known limitations" subsection) | GRAMMAR.md — "Requests" (HTTP response caching), `apps/requests-demo`'s `CachingDemo.thr` |
| Promise-style request consumption — `taskManager.onResult(task, onSuccess, [onError])` (the task NODE, not its id), unified with `taskManager` rather than a new namespace; callbacks receive the already-unwrapped result/error value; not supported from a `.flsh` class body (same reason as `onAlertChanged`) | ✅ | GRAMMAR.md — "Task manager" (`taskManager.onResult`), `apps/task-manager-demo`'s `OnResultDemo.thr` |
| Global request/response interceptors — `taskManager.onRequestSent(cb)`/`onResponseReceived(cb)`, app-wide/register-once for reporting/telemetry, shaped like `onAlertChanged` (N independent subscribers, no per-task identity); `onRequestSent`'s payload is the resolved options AA plus `buildSucceeded`/`buildErrorMessage`, `onResponseReceived`'s is the RAW `ft_httpFetch` response (not each component's own `parseResponse`/`parseError`-transformed `result`/`error`) plus `parseSucceeded`/`parseErrorMessage` — `buildRequest`/`parseResponse`/`parseError` exceptions are all caught (never crash) and reported via these signals; not supported from a `.flsh` class body (same reason as `onAlertChanged`) | ✅ | GRAMMAR.md — "Task manager" (`taskManager.onRequestSent`/`onResponseReceived`), `apps/task-manager-demo`'s `MainScene.thr`/`InterceptorsDemo.thr` |

`apps/task-manager-demo` is a full, router-mounted, `scale`d chapter tour of the `taskManager`
half of this section — 4 chapters (paths `/run-cancel` through `/interceptors`), each showing at
least one default example and one deliberately-customized variant, reachable in the compiled app
via REWIND/FAST-FORWARD. See `findings/demo-app-conventions.md` for the app-structure convention
this instantiates and `findings/task-manager-demo-app.md` for what each chapter covers.

`apps/requests-demo` is a full, router-mounted, `scale`d chapter tour of this whole feature —
4 chapters (paths `/declare-call` through `/parse-safety`), each showing at least one default
example and one deliberately-customized variant, reachable in the compiled app via REWIND/
FAST-FORWARD. Split off `apps/async-demo` (see `findings/demo-app-conventions.md`'s Roadmap) —
`apps/async-demo`'s own `taskManager`/Timer chapters are covered by the separate
`apps/task-manager-demo`/`apps/timers-demo` apps instead. See `findings/demo-app-conventions.md`
for the app-structure convention this instantiates and `findings/requests-demo-app.md` for what
each chapter covers.

## Tooling

| Feature | Status | Doc |
|---|---|---|
| CLI: `flash-theater compile [--check] [--src-dir <dir>] [--out-dir <dir>] [--env <name>]` — convention-based, no pattern argument; always compiles the whole project | ✅ | `packages/compiler/src/cli.ts` |
| `src/`/`out/` project layout — `src/` is 100% hand-written, `out/` is 100% generated/copied and wiped-then-rebuilt on every compile; `flash-theater.config.json`'s `srcDir`/`outDir`/`exclude` override the defaults | ✅ | `packages/compiler/GRAMMAR.md` — "Project layout", `findings/build-layout.md` |
| CLI: `flash-theater zip [--out-dir <dir>] [--env <name>] [--app-name <name>]` — zips an already-compiled `out/`/`out-<env>/` into `dist/<appName>.zip` (or the env/version-suffixed name below), so every app consuming the compiler gets this for free instead of hand-rolling its own zip script/dependency | ✅ | `packages/compiler/GRAMMAR.md` — "Packaging", `packages/compiler/src/packaging.ts` |
| Environments (`--env <name>`/`FLASH_THEATER_ENV`) — `environments/<name>.config.json` declares build-time `variables` (baked as `env.<name>`), a `manifestOverrides` patch, and extra `exclude`/`include` glob patterns; writes to `out-<env>/` and `dist/<app>-<env>-<version>.zip` instead of the plain build's `out/`/`dist/<app>.zip`; an optional, git-ignored `environments/<name>.local.config.json` overrides any of it per developer machine | ✅ | `packages/compiler/GRAMMAR.md` — "Environments", `findings/environments.md` |
| Generated-file marker (informational only — no longer gates overwriting, since `out/` is wiped every run) | ✅ | `findings/build-layout.md` |
| Output mirrored under `out/` at the same relative path the `.thr`/`.flsh` source has under `src/` (regular components only — see the theme/store rows below for the exceptions); every other `src/` file (manifest, images, hand-written components) copied through verbatim | ✅ | `packages/compiler/src/cli.ts`, `packages/compiler/src/project-layout.ts` |
| `source/FlashTheater/FlashTheaterGlobals.brs` bootstrap generation (one hand-written `Main.brs` line still required) | ✅ | `packages/compiler/src/app-compiler.ts` |
| Auto-copied built-in runtime Store component (`components/FlashTheater/FlashTheaterStore/Store.xml`/`.brs`) whenever any component uses the store — zero manual wiring | ✅ | `packages/compiler/src/cli.ts`, `packages/compiler/runtime-assets/Store` |
| Auto-copied built-in runtime Router + RouterOutlet components (`components/FlashTheater/FlashTheaterRouter/`, `.../FlashTheaterRouterOutlet/`) whenever any component uses `router.*` — zero manual wiring, mirrors the Store's own auto-copy | ✅ | `packages/compiler/src/cli.ts`, `packages/compiler/runtime-assets/Router`, `.../RouterOutlet` |
| Compiled theme component always written as `components/FlashTheater/FlashTheaterTheme/FlashTheaterTheme.xml`/`.brs`, found structurally by its `<theme-template>` root tag — the source `.thr` file's own name/location don't matter | ✅ | `packages/compiler/src/cli.ts`, `packages/compiler/src/app-compiler.ts` |
| All compiler-owned, never-hand-authored output (copied Store, compiled theme, generated globals bootstrap) grouped under one `FlashTheater/` subfolder of `components/`/`source/`, distinct from the app's own components | ✅ | `packages/compiler/src/cli.ts` |
| `apps/sample-app` `build:roku` (`flash-theater compile && flash-theater zip`) | ✅ | `apps/sample-app/README.md` |
| Sideload to a real device via `kopytko-roku-device`'s own `kopytko-roku` CLI (`kopytko-roku installer install --zip <path>`) — `ROKU_HOST`/`ROKU_PASSWORD` are that CLI's own config-resolution env vars, not an app-level script | ✅ | `apps/sample-app/package.json`'s `sideload` script |

## Verification

| Feature | Status | Doc |
|---|---|---|
| Unit tests (DSL parser, template parser, dependency graph, identifier rewrite) | ✅ | `packages/compiler/test/` |
| Golden-file tests against the real `ScheduleDateMenuItem.thr` | ✅ | `packages/compiler/test/codegen/golden.test.ts` |
| Generated `.brs` smoke-parsed with `kopytko-brightscript-parser` (0 diagnostics) | ✅ | `packages/compiler/test/codegen/golden.test.ts` |
| End-to-end sideload + visual verification on a real device | ✅ | `findings/dev-environment.md` |

