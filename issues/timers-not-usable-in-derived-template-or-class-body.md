# Timer statements can't appear in `derived`/template/`{#if}`/`{#each}` expressions or a class body

**Type:** Gap
**Area:** timers
**Status:** Open

## Problem

`setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` may only appear as a bare statement, or the
whole RHS of a plain local assignment — never nested inside a larger expression, a `derived`
expression, a dynamic template `{expr}`, an `{#if}`/`{#each}` condition/collection/key expression, or
inside a `.flsh` class body. The class-body restriction shares its root cause with `taskManager`'s
own callback-registration family (`onAlertChanged`/`onResult`/`onRequestSent`/`onResponseReceived`)
— **not** with `theme`/`router`/`taskManager` access generally, which are now fully supported from a
class body via `GetGlobalAA()` (see `findings/class-pipeline-global-singleton-access.md`). Timers
need a real per-instance callback slot the same way those four `taskManager` methods do, which a
class instance's shared, app-wide `GetGlobalAA()` table can't safely provide.

## Impact

Timer usage is confined to statement-list contexts inside `.thr` component script bodies. An author
wanting to trigger a timer as part of a computed/reactive expression, or from reusable class logic,
has to route it through a component method instead — usually not a real blocker, but a sharp edge
worth knowing before attempting it.

## Where

- `GRAMMAR.md` timer-statements section — the statement-only restriction and the reserved-name list.
- `findings/timer-statements.md` — Timer node lifecycle/callback-registry design.
- `findings/class-pipeline-global-singleton-access.md` — confirms `theme`/`router`/most
  `taskManager` methods now work from a class body, and documents exactly why the
  callback-registration family (which timers share the restriction with) still can't.

## Suggested fix

The class-body restriction is the same fundamental gap as
[classes-no-reactive-lifecycle.md](classes-no-reactive-lifecycle.md) — timers need a real node to
attach the underlying `Timer` SceneGraph node to, which a class instance doesn't have. The
expression-nesting restriction is a separate, more tractable question: timer statements produce a
Timer-node side effect, not a value, so nesting them inside an expression doesn't have an obvious
target value to plug in anyway — likely intentional-by-design rather than a real gap worth closing.

## Related

- `findings/timer-statements.md`
- [classes-no-reactive-lifecycle.md](classes-no-reactive-lifecycle.md)
