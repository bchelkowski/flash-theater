# Router-free scenes never auto-claim a static `default-focus`

**Type:** Bug
**Area:** focus-system
**Status:** Open

## Problem

`FlashTheaterFocusManager`'s `register()` only *proposes* a `default-focus="true"` element as a
focus candidate — it never actually applies focus on its own. In a router-mounted app this is
invisible because the router's own mount sequence calls the focus claim explicitly. In a router-free
app (no `FlashTheaterRouterOutlet` anywhere), nothing ever makes that call, so a statically-marked
`default-focus="true"` element sits registered but unfocused forever unless the app's own hand-written
boot code claims focus itself.

## Impact

Any router-free `.thr` app (or any Scene that mounts content outside the router) that relies on
`default-focus="true"` silently gets no initial focus — the remote's D-pad does nothing until some
other explicit `SetFocus()`/`claimFocusIfVacant` call happens to fire. There's no compiler diagnostic
warning that a router-free tree's `default-focus` won't self-activate.

## Where

- `findings/focus-router-free-and-nested-gaps.md` — documents this as gap #1.
- `findings/focus-runtime-registry.md` — `register()`'s propose-only contract and the "vacuum rule."
- The router's own mount-time focus claim (see `findings/router-focus-integration.md`) is the thing
  a router-free app is missing.

## Suggested fix

Either (a) add a compiler diagnostic when `default-focus="true"` appears in a `.thr` file that isn't
reachable through any router outlet, pointing authors at the manual `claimFocusIfVacant` call they
need; or (b) make `FlashTheaterFocusManager` itself apply a proposed default focus once per app-boot
vacuum window instead of requiring an external caller (bigger change — needs care not to steal focus
from a router-mounted scene that already claims it explicitly). Option (a) is the safer, smaller fix.

## Related

- `findings/focus-router-free-and-nested-gaps.md`
- `site/src/pages/docs/focus-and-navigation.astro` (already documents the workaround for authors)
