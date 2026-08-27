# Router (`router.*`, `FlashTheaterRouter`/`FlashTheaterRouterOutlet`, `default-focus`)

Compile-time module responsibilities and design rationale for the router feature's namespace and
codegen mechanics (nested routing, back-journey history, `default-focus`). See
`packages/compiler/GRAMMAR.md`'s "Router" section and "Focus system" section's `default-focus`
entry for the grammar itself — this file is the *why*. For outlet runtime behavior (history,
nested route matching, reactivity, `params` equality, subtree teardown, back-key fallthrough), see
[router-outlet-runtime.md](router-outlet-runtime.md). For router/focus integration bugs, see
[router-focus-integration.md](router-focus-integration.md). For the `setup()` lifecycle gotcha
pair, see [router-setup-lifecycle.md](router-setup-lifecycle.md). For router-outlet transitions
(`navigate-out:`/`navigate-in:`/`back-out:`/`back-in:`, `loadingComponent`, `router.markReady()`),
see [router-transitions.md](router-transitions.md).

## `router.*` is a namespace, not a reserved-keyword statement

`router.navigate(...)`/`router.back()`/etc. are ordinary BrightScript dot-chain calls, resolved
entirely in `packages/compiler` through the same generic `theme`-style dot-chain scanner
(`GLOBAL_ROOT_NAMES` in `analysis/identifier-rewrite.ts`/`analysis/expression-region.ts`,
`findGlobalPathAccesses` in flash-parser) `theme.a.b` already used — no flash-parser grammar needed
at all, only teaching that scanner to accept **calls** on a matched root, not just member reads.
`router.params.x`/`router.path` (data reads) and `router.navigate(...)`/`router.back()`/etc.
(actions) share one namespace deliberately, not split into separate root names — a DSL author has
no reason to think of "reading route state" and "changing route state" as different concepts.
`router.markReady()` is the one exception to "every action calls into the router singleton" — see
[router-transitions.md](router-transitions.md) for why it's a plain field assignment on the CALLING
component's own top instead. This
replaced an earlier design that added `navigate(<path>)`/`back()` as brand-new reserved keywords,
mirroring `focus(<expr>)`; reverted on the direct feedback that a bare global name reads worse than
one namespacing both.

**Lesson for the next global-singleton feature**: if it needs both data reads and method-style
actions, prefer one unified namespace over splitting them into separate root names.

**`router.*` used to silently miscompile inside a `.flsh` class method** — confirmed live:
`router.navigate("/home")` in a class method compiled to `m.global.ft_router.navigate("/home")`,
wrong on two levels (a class method's own `m` is BrightScript-auto-bound to the class instance, never
a SceneGraph node, so `m.global` reads a nonexistent key; and the real argument-repacking/
focus-handoff codegen never ran at all in a class body, only the generic bare-root-token splice did).
Fixed alongside the same gap for `taskManager` — see `findings/class-pipeline-global-singleton-access.md`'s
`GetGlobalAA()` entry. `router.*` (every action and data read, including `navigate`/`back`'s
mandatory focus hand-off) now works correctly from a class body, rooted at `GetGlobalAA().global`
(confirmed live to alias the same content node `m.global` points at) instead of `m.global`.

## Module responsibilities

| Question | Module |
|---|---|
| "Is this a known `router.<method>(...)` action, or a schemaless `router.<path>` data read?" | `analysis/global-bindings.ts`'s `resolveRouterPath` (`ROUTER_ACTION_METHODS` — `setRouting`/`navigate`/`back`/`resetHistory`/`appendBackJourneyData`/`updateBackJourneyData`) |
| "Does this splice a validated `router.*`/`theme.*` access into its final generated text?" | `analysis/identifier-rewrite.ts`'s `validateAndRewriteGlobalPaths` + `buildRouterActionReplacement` |
| "Does this decide whether a component needs the router runtime wired in at all?" | `compile.ts`'s `usesRouterAnywhere` (re-parses every raw text surface — function bodies incl. nested `if`/`else`, `derived` expressions, template bindings, `{#if}`/`{#each}` condition/collection/key expressions — since, unlike `focus(...)`, there's no dedicated AST statement kind to walk) |
| "Does this decide whether `default-focus="true"` is valid on this element, and thread it to registration codegen?" | `analysis/focusable-elements.ts` — see `findings/focus-system.md` |
| "Does this emit the automatic back-key fallthrough?" | `codegen/brs-emitter.ts`'s `emitOnKeyEventFunction`, gated on `template.extends === 'Scene'` — see [router-outlet-runtime.md](router-outlet-runtime.md) |
| "Does this emit the shallow focus hand-off after a route change, and reject a route change that isn't a standalone statement?" | `analysis/identifier-rewrite.ts`'s `withRouterFocusHandoff` / `checkRouterActionIsStandaloneStatement` (both consumed by `codegen/brs-emitter.ts`) — see [router-focus-integration.md](router-focus-integration.md) |
| "Does this decide where focus lands after a navigation, and whether it may be taken at all?" | `runtime-assets/FocusManager`'s `proposeFocusTarget`/`requestFocusTarget`/`applyPendingFocus` — the vacuum rule; see `findings/focus-system.md` |
| "What does the router/outlet actually do at runtime?" | `packages/compiler/runtime-assets/Router/FlashTheaterRouter.brs`, `runtime-assets/RouterOutlet/FlashTheaterRouterOutlet.brs` — both hand-authored |
| "Does this resolve a `<FlashTheaterRouterOutlet>`'s own `navigate-out:`/`navigate-in:`/`back-out:`/`back-in:` attributes?" | `analysis/router-transitions.ts`'s `resolveOutletTransitions` — see [router-transitions.md](router-transitions.md) |
| "Does this wire a resolved outlet-transition animation node onto the outlet's own field, or add `ft_routeReady`/`router.markReady()`'s field-assignment special case?" | `codegen/brs-emitter.ts`'s `emitInitFunction` (wiring) / `codegen/naming.ts`'s `ROUTE_READY_FIELD_NAME`/`routerOutletAnimFieldName` / `analysis/identifier-rewrite.ts`'s `buildRouterActionReplacement`'s `markReady` branch — see [router-transitions.md](router-transitions.md) |

## `router.navigate(...)`'s argument shape doesn't match the runtime `callFunc` shape 1:1

`router.navigate(<path>)` / `(<path>, <params>)` / `(<path>, <params>, <skipInHistory>)` (1-3
positional DSL arguments, `params` default `{}`, `skipInHistory` default `false`) packs into the
runtime's single-AA-argument `navigate(routeData as object)` —
`{path: ..., params: ..., skipInHistory: ...}`, always all three keys, even when the DSL call
omitted the trailing ones. Every other action's arguments pass straight through positionally
(`back()` zero args, `resetHistory([rootPath])` 0-1, `setRouting`/`appendBackJourneyData`/
`updateBackJourneyData` exactly 1) — `navigate` is the one case needing real repacking, handled in
`identifier-rewrite.ts`'s `buildRouterActionReplacement`.

## A `router.<action>(...)` call's own arguments can nest another `router.*`/`theme.*` access

`router.navigate(x, {from: router.path})` — flash-parser's `findGlobalPathAccesses` always
continues into a matched call's own arguments, so the inner `router.path` is found *twice*: once by
`buildRouterActionReplacement` recursively re-running the full rewrite pipeline over each argument
span, and once independently by the outer scan. Two overlapping `{start, end}` replacement spans for
the same text have no well-defined splice order. **Fix**: `identifier-rewrite.ts`'s
`dropNestedAccesses` filters out any access whose span sits strictly inside another `isCallTarget`
access's own span before replacements are built — `theme` never needed this (a theme access is
never a call target, so two theme accesses can never overlap).

## Deferred

| Deferred | Why |
|---|---|
| Middlewares/guards (`canActivate`, redirects) | Async guard sequencing has no analog in this compiler's synchronous codegen yet |
| Forward navigation | Explicitly excluded by design — `back()` pops a plain stack, nothing more |
| URL/query-string composition | `path`/`params` stay separate values, never joined into a parseable string — this is *why* `params` equality needed `FormatJson()` instead of a cheap string compare (see [router-outlet-runtime.md](router-outlet-runtime.md)) |
| Dynamic `default-focus="{expr}"` | Currently static-literal only, mirroring `focusable`'s own static/dynamic split but starting narrower |
| Reactive `router.*` data reads | `router.path`/`router.params.x` are plain, non-reactive snapshots (mirroring `store`'s `read`, not `watch`) — the router's actual reactivity mechanism is a fresh outlet-driven remount, not a live-bound expression. Does *not* apply to focus: `isFocused`/`isInFocusChain` are fully reactive in a component that survives navigations (see `findings/focus-system.md`), which covers the common "persistent chrome reacting to where the user is" case |
| Restoring focus on a route you navigate back to that isn't behind a loading gate | **Implemented for a gated back-navigation** (a real `loadingComponent`/`router.markReady()` gate — see `findings/router-focus-integration-route-memory-bugs.md`'s "Deferred focus restoration on a back-navigation loading gate"): focus stays vacant while loading, then restores the element (or nearest surviving ancestor) last focused in that same route, matched by id even across a brand-new component instance. An already-ready back-navigation (no gate engaged) still lands on its own `default-focus`/first registrant only, unchanged — restoration depends on the remembered element carrying a non-empty `id` |
