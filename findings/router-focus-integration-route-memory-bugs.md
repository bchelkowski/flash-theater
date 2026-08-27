# Router / focus integration — route-keyed focus memory for gated back navigation

Split out of [router-focus-integration.md](router-focus-integration.md) (that file covers the
foundational integration rules and the current directional-focus feature). This file covers the
route-keyed focus-memory design built for a back-navigation loading gate, and the live-caught
early-arming bug found while shipping it. See `findings/focus-system.md` for the vacuum rule and
LRUD registry this file assumes, and
[router-focus-integration-navigation-memory-redesign.md](router-focus-integration-navigation-memory-redesign.md)
for how this mechanism was later generalized from "back journeys only" to every journey, then
redesigned again.

## Deferred focus restoration on a back-navigation loading gate

Previously, `router.back()` into a still-loading route (a real `router.markReady()`/`loadingTimeout`
gate) applied focus **immediately**, before the destination's real content even existed — the
compiler-emitted `applyPendingFocus()` follow-up found nothing proposed yet (only `_revealMountedChild`
proposes, and it hadn't run) and fell into `recoverFocusFor()`, landing focus on some unrelated
fallback element (last-focused-elsewhere, or the Scene) the instant `router.back()` returned. This was
correct under an earlier, stricter "focus must always be somewhere" requirement, but wrong for a
gated back-navigation specifically: the requirement changed to "stay vacant while loading, then
restore what was focused in that same view last time" — even when that element is dynamically created
(an `{#each}` row).

**Route-keyed memory, not node-reference memory.** `m.lastFocusedByOwner` (per living component
instance) can't survive a router round-trip — a routed screen is always a brand-new instance on every
mount (`findings/router-outlet-runtime.md`'s "always rebuild fresh"), so the old node reference is
simply gone. `FlashTheaterFocusManager.brs`'s new `m.lastFocusedByRouteKey` is instead keyed by a
route's own resolved `path + "?" + paramsJson` string (`FlashTheaterRouterOutlet.brs`'s `_routeKey()`
— the same values `_update()` already uses for its own same-route/params-equality check), and stores
an **ordered chain of `id`s** from the focused leaf up to (not including) the route's own root, not a
node reference. Captured by `captureRouteFocusMemory()`, called from `_unregisterCurrentChildFocus()`
right before `unregisterSubtree()` (so `currentlyFocused()` still reflects the outgoing screen) — the
one call site both teardown paths (immediate and post-exit-animation) already funnel through.

**Re-identifying a dynamically-created element by id works** because an `{#each}` item's own author
`id` gets compiled to `"<id>_" + ft_key` on the constructed node (confirmed in the actual generated
output for `RouterTransitionDemo.thr`'s `postRow` — e.g. `postRow_1` for the post whose reconcile key
is `1`) — as long as the same key exists in the data on the next mount, the same id string reappears,
so `resolveRouteFocusTarget()` re-locates it via `root.FindNode(id)` (scoped to the freshly-mounted
route's own root, never the whole Scene — avoids cross-component id collisions). Walking the id chain
innermost-first and returning the first result that's also `indexOfNode(...) >= 0` (a live, registered
node, not merely any node sharing that id) is what makes "focus the parent, then its parent" fall out
for free if the exact remembered element no longer exists.

**Suppression must be armed in `_mountRoute()`, unconditionally for a back journey — arming it only
inside `_beginLoadingGate()` was a confirmed live bug.** First shipped with the arm call inside
`_beginLoadingGate()`, gated on `isBackJourney`, reasoning that the entire mount cascade — including
the loading-gate decision — completes synchronously before `router.navigate(...)`/`router.back()`
ever returns to its caller, so arming "just in time" would still be early enough. **That assumption
is only true when the outlet has no configured `out:` animation for this direction.**
`apps/sample-app/src/components/Shell.thr`'s own `childOutlet` — the actual, live configuration
this feature needs to work with, not a hypothetical — declares `back-out:slideOutRight` (and the
matching `navigate-out:`/`in:` pair). With an `out:` animation configured, `_mountRoute()` only
*arms* the animation (`outAnim.control = "start"`) and returns immediately; the real
`_mountRouteImmediate()` call — and therefore `_beginLoadingGate()` — does not run until
`_onOutAnimStopped()` fires, roughly `duration` seconds later (0.25s in Shell.thr's case). The
compiler-emitted `applyPendingFocus()` follow-up, by contrast, runs the moment
`router.navigate(...)`/`router.back()` returns — i.e. **before** the animation even starts playing.
So by the time `_beginLoadingGate()` would have armed the suppression, `applyPendingFocus()`'s own
`target = invalid` branch had already run, found `m.suppressedNavRouteKey = invalid`, and fallen
straight into `recoverFocusFor()` — landing focus on a fallback element during the slide-out
animation, the exact bug this feature exists to fix, just reached through a code path the original
design hadn't accounted for.

**Confirmed live** (2026-08-19, real Roku Ultra hardware, via a `ConsoleStream` on port 8085 while
driving the app with `EcpClient`): focused a dynamically-created `postRow_post10` inside
`RouterTransitionDemo`, left via forward navigation (through the menu, so the row's memory survived
untouched — `captureRouteFocusMemory()` only overwrites when the outgoing route *currently* holds
focus), entered content on a different screen, then pressed physical Back. The trace showed
`captureRouteFocusMemory`/`applyPendingFocus target=invalid, suppressedNavRouteKey=invalid`
firing at `+23.25s`/`+23.25s`, and `_beginLoadingGate isBackJourney=true` only arming the
suppression **~300ms later**, at `+23.55s` — after the exit animation had already played out. Focus
landed on `menuRequests` (confirmed via a follow-up `Select` press that genuinely re-navigated —
`queryAppUi`'s `focused="true"` attribute is not always trustworthy on its own, see
`findings/focus-system.md`) and stayed there even though `resolveRouteFocusTarget()` itself, once
finally reached, correctly resolved `postRow_post10` — the vacuum rule (correctly) refused to steal
focus away from `menuRequests` a second time.

**The fix**: arm `m.suppressedNavRouteKey` unconditionally for a back journey at the very top of
`_mountRoute()` — before either the animated or the immediate branch, using `fullPath + "?" +
paramsJson` directly (the incoming route's key, available immediately as plain parameters, not
`_routeKey()`, which still reads the *outgoing* route's stale `m._renderedFullPath` at this point).
This is safe even though it's now armed before it's known whether a gate will actually engage,
because of how it's consumed: `_revealMountedChild()` **unconditionally** calls
`resolveRouteFocusTarget()` on every reveal (not just gated ones) — which clears the flag as a side
effect the moment it's called with a matching routeKey, whether or not it finds a candidate. For a
fully synchronous mount (no `out:` animation, no gate), that clear — and a proposed target, found or
not — happens *before* the compiler-emitted `applyPendingFocus()` ever runs (still the same call
stack), so that call proceeds exactly as it always did. Only a genuinely delayed mount (`out:`
animation and/or loading gate) leaves the flag armed long enough to matter.

**The second `applyPendingFocus()` call is safe only because it's anchored to a genuinely later,
independent native dispatch — not because of call-stack depth.** `_revealMountedChild()` (renamed
parameter `cameFromAsyncBoundary`, was `cameFromGate`) calls `applyPendingFocus()` a second time
(beyond the compiler-emitted one) whenever reached via *any* native-callback boundary independent of
the original handler: a settled loading gate (`_settleLoadingGate()`/`_onMinDurationElapsed()`,
themselves reached from `_onChildRouteReady`/`_onLoadingTimeout`/a `Timer`'s own `"fire"` field
observer — always `true`, unconditionally), **or** an `out:` animation's own `"state"` observer
firing once it finishes (`_mountRouteImmediate`'s new `viaAsyncBoundary` parameter, `true` only when
called from `_onOutAnimStopped`, threaded straight through to the non-gated reveal branch instead of
a hardcoded `false`). The ordinary fully-synchronous reveal path (`_mountRoute`'s own direct branch,
`viaAsyncBoundary = false`) is still inside the *same* native key-event dispatch as the original
handler and must never call it — that's exactly why the compiler-emitted follow-up remains the only
thing allowed to move focus on that specific path. Calling `applyPendingFocus()` unconditionally from
`_revealMountedChild()` would silently reintroduce the "2+ nested callFunc hops from the
currently-executing native handler" focus-routing failure (`findings/focus-system.md`) on that one
path — the `cameFromAsyncBoundary` guard exists specifically to prevent that, and
`packages/compiler/test/runtime-assets.test.ts` has dedicated structural regression guards on both
the early-arm-in-`_mountRoute()` ordering and this guard, for exactly this reason.

**Re-verified live after the fix**, same device, same exact scenario (the device briefly dropped off
the LAN between the two runs — `checkDeviceAlive` false, a fresh `SsdpClient` scan finding nothing,
plain ICMP timing out — and came back on its own a short while later; re-confirmed reachable before
retrying, rather than assuming it was gone for good). This time: focus did **not** snap to
`menuRequests` after the physical Back press (the pre-fix run's exact failure) — it settled on
`postRow_post10` within ~0.5s of the press (the `out:` animation's 0.25s plus a fast — likely
cache-assisted, this was the third identical `GetPosts` fetch this session — settle) and stayed
there. A final `Select` press confirmed **real** key routing, not just a stale `queryAppUi`
`focused="true"` attribute (see `findings/focus-system.md` on why that attribute alone isn't
trustworthy): the app stayed on `RouterTransitionDemo` afterward — `selectPost()`'s own no-op body
ran, rather than a menu item's own navigation handler firing.

**Known residual limitation**: matching depends entirely on the remembered element (or a surviving
ancestor) carrying a non-empty `id` — a focusable node with no `id` at all can never be re-identified,
so it simply falls out of the chain (its ancestors are still tried). Re-resolution search scope
widened later the same session (see
[router-focus-integration-navigation-memory-redesign.md](router-focus-integration-navigation-memory-redesign.md)'s
"The general redesign") from one route's own subtree to the whole app — narrowing the collision
surface was never the point, generality was, but it does mean two *different* custom components
ANYWHERE in the app could in principle reuse the same static author-chosen id (the DSL's own
id-uniqueness check is per-component, not app-wide) — a narrow, pre-existing risk class also carried
by `{#each}`'s own item-update `findNode` pattern (`findings/template-each-reconcile.md`), not new here.
