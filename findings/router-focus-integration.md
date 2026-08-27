# Router / focus integration bugs

Real-device bugs found at the boundary between the router and the focus system — persistent chrome
declaring its own focusable content, focus grabs reached through the outlet's own field-change
callback chain, and the current directional-focus feature. See [router.md](router.md) for the
namespace/codegen-mechanics core and [router-outlet-runtime.md](router-outlet-runtime.md) for outlet
runtime behavior. See `findings/focus-system.md` for the vacuum rule and LRUD registry this file
assumes.

For the route-keyed focus-memory design built for a back-navigation loading gate, and the
live-caught early-arming bug, see
[router-focus-integration-route-memory-bugs.md](router-focus-integration-route-memory-bugs.md). For
generalizing that suppression mechanism from "back journeys only" to every journey, and the full
redesign investigation that followed, see
[router-focus-integration-navigation-memory-redesign.md](router-focus-integration-navigation-memory-redesign.md).

## Persistent chrome may declare its own focusable content

Originally forbidden: an outlet's `_mountRoute()` used to call `focusComponent(m.currentChild)`
directly, so persistent chrome (`Shell`, wrapping a nested outlet) with its own focusable content
would have had focus stolen back from the nested outlet's own, already-more-specific decision. Fixed
by the deferred-focus/vacuum-rule redesign (see `findings/focus-system.md`): no outlet moves focus
directly any more, each only *proposes* a target, first-writer-wins, and nested outlets construct
inside-out — so the deepest outlet with genuinely focusable content always wins, and an enclosing
chrome component can no longer steal focus back. `apps/sample-app/src/components/Shell.thr` now declares
a real sidebar menu that keeps focus across every navigation within it — the canonical TV layout.

A routed screen that owns **no** focusable elements of its own — every focusable node lives one
level further down, inside child custom components it merely composes (`CardsScreen.thr`, whose
only content is a list of `RichCard.thr` instances, each its own owner) — resolves to no proposal at
all: `firstRegistrantOfOwner(CardsScreen's own m.top)` finds nothing, since `register()` always
attributes ownership to the currently-executing component's own `m.top`, never an ancestor's.
Confirmed live and harmless: menu-driven navigation into such a screen leaves whatever already held
focus (the menu) untouched — exactly the vacuum rule's own "don't steal" guarantee, not a bug — and
a plain arrow-key entry (RIGHT from the menu) still finds the nested child's own registered content
by ordinary cross-owner geometric search regardless of the extra nesting level.

## `focusComponent` reached from an outlet's `ObserveFieldScoped` callback did not route real key events

The outlet's own focus grab was 2+ `callFunc` hops from the author's executing handler (handler →
`callFunc("navigate")` → the outlet's `changeToken` observer → `callFunc("focusComponent")`) —
`queryAppUi` showed `focused="true"` all the way down the tree, but a real key press on the mounted
screen's `default-focus` element did nothing (confirmed via a temporary `print` in the handler that
never ran). See `findings/focus-system.md`'s platform-facts entry on this exact limitation, including
why observing a *native* field does not fix it either.

**Fix — the mount cascade no longer moves focus.** `_mountRoute()` only *proposes* a target (pure
bookkeeping, safe at any depth), and the compiler emits a shallow `applyPendingFocus()` call as a
**sibling statement** immediately after the author's own `router.navigate(...)`/`router.back()` —
one hop from the executing handler. This is also why those two actions must be standalone statements
(`expression/router-action-must-be-statement`): there is nowhere to put the follow-up otherwise.
`apps/sample-app`'s `MainScene.thr` `setup()` needs (and must not have) a trailing
`m.top.setFocus(true)` — that would leave the Scene itself holding focus, which only handles "back".

## `router.isBackJourney` + explicit `focus(<id>)` — directional focus, formalized and demoed

**A direct follow-up, same session, prompted by the natural next question**: given the vacuum-rule
limitation above (automatic restoration doesn't cover every case an author might want), how does an
author explicitly choose DIFFERENT initial focus depending on whether a route was entered via
forward navigation vs. a back journey — e.g. a multi-step flow that should focus its own "continue"
action on a fresh visit but its own "review" action when the user has come back to it?

**Investigated before building anything**: this was ALREADY mechanically possible with zero compiler
changes. `analysis/global-bindings.ts`'s `resolveRouterPath` treats *any* non-call `router.<path>`
read as unconditionally schemaless (no member whitelist, unlike `taskManager`'s fixed data-read
list) — so `router.isBackJourney` already spliced correctly to
`m.global.ft_router.activatedRoute.isBackJourney`, and the runtime `activatedRoute` AA genuinely
carries that field (`FlashTheaterRouter.brs`'s own `_emptyRoute()`/`navigate()`). It simply wasn't
*documented* as a supported read (`GRAMMAR.md` only listed `router.path`/`router.params.*`/
`router.backJourneyData.*`), and had no test or demo exercising it. Confirmed by actually compiling
a snippet using it (not just reading the source) before claiming it worked — the generated `.brs`
correctly read `if (m?.global?.ft_router?.activatedRoute?.isBackJourney) then ...`.

**This is exactly the shape `CLAUDE.md`'s own "Nothing ships unexplained" principle (added this
session, prompted directly by this exchange) exists to catch**: a capability that works purely by
accident of a general mechanism (the schemaless router-data path not restricting *which* field can
be read) is not the same as a capability that's been deliberately exposed, tested, and shown
working. Fixed by formalizing it as a real, documented, demoed feature rather than leaving it as an
undocumented side effect an author would have to discover by trial and error or reading compiler
source:
- `GRAMMAR.md`'s "schemaless data reads" section now lists `router.isBackJourney` alongside
  `router.path`/`router.params.*`/`router.backJourneyData.*`, with the `focus(<id>)` pairing shown
  as a worked example.
- `docs/features.md` gained two rows: the schemaless-reads row now names `router.isBackJourney`
  explicitly, plus a dedicated "Directional focus" row.
- `site/src/pages/docs/router.astro` gained a full "Directional focus" section with a real code
  panel, and its own stale "Not (yet) supported" bullet (claiming restoration only ever happens
  behind a `loadingComponent` gate — true before this session's fixes, false since) was corrected to
  describe the actual current limitation (vacuum-rule observability, `id`-based re-matching) instead.
- `apps/sample-app` gained a real, dedicated, live-verified demo: `DirectionalFocusDemo.thr`
  (`buttonA`/`buttonB`, branching on `router.isBackJourney`) and `DirectionalFocusDemoDetail.thr`
  (a plain "OK: back" step whose `router.back()` is what makes the return trip a genuine back
  journey), reachable from `HomeScreen.thr`'s own second prompt. Deliberately NOT added to `Shell.thr`'s
  own sidebar — that layout is already tightly packed (see the "Sidebar label overlap" entry in
  `findings/router-transitions.md`), and reshuffling all 8 existing menu-row translations to fit a
  9th would have risked a real visual regression across every existing sidebar-reachable screen for
  no real benefit; a second `HomeScreen` content button is just as discoverable and far lower risk.
- `identifier-rewrite.test.ts` gained a dedicated unit test pinning the `router.isBackJourney` →
  `m.global.ft_router.activatedRoute.isBackJourney` rewrite down explicitly, rather than leaving it
  implicitly covered by the same schemaless-path logic `router.params.day`'s own test already
  exercises.

**Verified live** (Roku Ultra, same device): from `HomeScreen`, pressed Down repeatedly to reach the
new prompt, OK into `DirectionalFocusDemo` — `buttonA` correctly focused (forward entry). OK on
`buttonA` → `DirectionalFocusDemoDetail`, `backPrompt` focused (its own plain `default-focus`). OK
on `backPrompt` → back to `DirectionalFocusDemo` — `buttonB` correctly focused this time (back
journey), confirmed via a screenshot and a follow-up OK press that genuinely re-navigated to the
detail screen again (real key routing, not a stale attribute). No crash, no layout regression on the
existing sidebar (untouched). `npm test --workspace packages/compiler`: 1222 passing, `npm run lint`
clean, `apps/sample-app`'s own `npm run build:roku` compiles both new components clean.
