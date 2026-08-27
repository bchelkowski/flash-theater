# Outlet transitions/`loadingComponent` are outlet-wide, not per-route

**Type:** Gap
**Area:** router
**Status:** Open

## Problem

`navigate-in:`/`navigate-out:`/`back-in:`/`back-out:` transitions and `loadingComponent` are
configured once on a `FlashTheaterRouterOutlet` and apply uniformly to every route it mounts. There's
no way to give one specific route a different transition/loading treatment than its siblings under
the same outlet.

## Impact

An app wanting one route to feel different on entry (e.g. a modal-style route that should fade rather
than slide like the rest) has to either accept the outlet-wide transition or split that route onto a
second, separately-configured outlet — a heavier structural workaround than a per-route override
would require.

## Where

- `findings/router-transitions.md` — outlet transition config (`navigate-in:`/etc., `loadingComponent`).
- `GRAMMAR.md` router-outlet section.

## Suggested fix

Add an optional per-route override in the route config (e.g. `transition: { navigateIn: ..., ... }`
alongside `component:`) that the outlet's transition-selection logic checks before falling back to
its own outlet-level default. `findings/router-transitions.md` documents the outlet's current
transition-selection codegen — this would extend that selection to consult the matched route's own
config first.

## Related

- `findings/router-transitions.md`
- `apps/router-demo`'s `/outlet-transitions` chapter
