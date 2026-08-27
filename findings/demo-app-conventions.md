# Demo app conventions — router + scale everywhere, one chapter app per mechanic

Cross-cutting convention for every `apps/*-demo` app (not `apps/sample-app`, which has its own,
different job — see below). Established converting `apps/animation-demo`; see
[animation-demo-app.md](animation-demo-app.md)'s "Chapter/router conversion" entry for that
conversion's own specifics. `apps/focus-demo` was converted next — see
[focus-demo-app.md](focus-demo-app.md).

## The rule

1. **Every demo app uses `router` and `scale` — no exceptions, no "this app deliberately has no
   router."** The router is core to the language; its own mechanics (transitions, focus
   restoration, loading gates) deserve the same dogfooding as everything else, and a demo app
   without `scale` doesn't prove anything about how the language actually gets used (every real
   app needs to render correctly across `ui_resolutions` tiers).
2. **One dedicated chapter app per doc-nav topic** (`site/src/data/docsNav.ts`'s own topic list) is
   the target end-state — not one giant app, not several unrelated mechanics crammed into one app.
   See "Roadmap" below for the topics still missing one.
3. **A chapter app organizes its one topic as router-declared chapters** — one route per specific
   mechanism/sub-feature of that topic — instead of ad-hoc `{#if:destroy}`/manual-focus-claim
   toggling between flat screens. `router.navigate()`'s own default-focus proposal+claim and
   per-navigation vacuum supersede whatever hand-rolled focus bookkeeping a flat-screen app used to
   need (see `animation-demo-app.md`'s conversion entry for a concrete before/after). Chapter-to-
   chapter navigation reuses whatever remote-key convention already reads naturally for that app
   (REWIND/FAST-FORWARD, on-screen buttons, etc.) — that's a per-app choice, not part of this rule.
4. **Each chapter must show its mechanism BOTH with default/no-customization usage AND with enough
   customized variants to cover the real option surface** described in that mechanic's
   `GRAMMAR.md`/`site/` page. A chapter that only shows one shape isn't done. Concretely: extend an
   existing chapter component in place with a second, clearly-labeled example rather than leaving
   the option surface undemonstrated — see `BounceButtonDemo.thr`/`TogglePresetDemo.thr`/
   `AnimateAttrDemo.thr` in `apps/animation-demo` for the pattern (each got one new,
   deliberately-different animation/attribute-override triggered by its own key, alongside the
   original default).
5. **`apps/sample-app` is exempt from rule 4** — it shows one example of *everything* (a broad
   tour), not every option of *one* thing. Don't add exhaustive customization variants there; that's
   what the chapter apps are for.
6. **A chapter app is the reference + regression surface for its topic** — the site page for that
   topic should point to it (mirroring how `router.astro` already cites `DirectionalFocusDemo.thr`),
   and a future change to that mechanic should be tested against the same app, re-verified with
   `npm run build:roku` (+ sideload when a device is reachable), the same way `apps/sample-app` is
   already treated for grammar-wide changes (CLAUDE.md's Definition-of-done item 6).

## Why (in one paragraph)

Before this, 3 of the 4 demo apps (`apps/focus-demo`, `apps/animation-demo`, `apps/async-demo`)
were deliberately router-free — each one's own `MainScene.thr` had to hand-roll the exact
bookkeeping (default-focus claiming, per-switch focus vacuum, cross-owner unregister on teardown)
that `router.navigate()` already does automatically for every router-mounted app. That bookkeeping
wasn't just extra code — it was a second, parallel implementation of focus-transition correctness
that the actual language feature (the router) already solved, sitting there unexercised. Since the
router is meant to be the normal way real apps are built, a demo app that avoids it demonstrates
the wrong thing by omission, even when everything else about it works.

## Roadmap — recorded here so a future session doesn't re-derive it

Checklist for whoever picks this up next — `apps/animation-demo` and `apps/focus-demo` are both
fully converted (see their own `*-demo-app.md` findings files), and **`apps/async-demo`'s 3-way
split is complete and it has been retired**: `apps/task-manager-demo` (4 chapters —
`/run-cancel`, `/alerting`, `/on-result`, `/interceptors`; see
[task-manager-demo-app.md](task-manager-demo-app.md)), `apps/requests-demo` (4 chapters —
`/declare-call`, `/caching`, `/build-safety`, `/parse-safety`; see
[requests-demo-app.md](requests-demo-app.md)), and `apps/timers-demo` (3 chapters —
`/basic-lifecycle`, `/nested-and-list`, `/focus-teardown-ordering`; see
[timers-demo-app.md](timers-demo-app.md)) between them cover everything `apps/async-demo` used to,
each on its own dedicated doc-nav topic. **`apps/statements-demo`, a genuinely new chapter app (no
predecessor to split), is also done** (4 chapters — `/conditionals`, `/safe-operators`,
`/chain-safety-and-loops`, `/anonymous-functions-and-raw`; see
[statements-demo-app.md](statements-demo-app.md)). Remaining:

- **New chapter apps for topics with none today**: none — this list is now empty.
  `environments` was the last item removed from it: see `apps/environments-demo` and
  [environments-demo-app.md](environments-demo-app.md) (2 chapters — smaller than most, since the
  topic is inherently build-time/config-shaped rather than something a running app can toggle
  interactively). (`reactive-state` is done — see `apps/reactive-state-demo` and
  [reactive-state-demo-app.md](reactive-state-demo-app.md). `template-and-binding` is done — see
  `apps/template-and-binding-demo` and
  [template-and-binding-demo-app.md](template-and-binding-demo-app.md). `router` — itself,
  previously only shown embedded in `apps/sample-app` — is done too: see `apps/router-demo` and
  [router-demo-app.md](router-demo-app.md). `streams` is done too — see `apps/streams-demo` and
  [streams-demo-app.md](streams-demo-app.md). `theme` is done too — see `apps/theme-demo` and
  [theme-demo-app.md](theme-demo-app.md). `classes` is done too — see `apps/classes-demo` and
  [classes-demo-app.md](classes-demo-app.md).) The greenfield chapter-apps checklist (every
  doc-nav topic with no dedicated app) is now complete — a future new topic added to
  `site/src/data/docsNav.ts` should get its own chapter app at the same time it's added, not join
  a backlog here.
- **`apps/sample-app`**: no structural change expected — confirm it keeps using `scale` throughout
  as new components are added, and cross-link to chapter apps as they're built (rule 5 exempts it
  from the customization-coverage requirement, not from `scale`/`router`, which it already uses).

## A concrete before/after, for the next conversion

`apps/animation-demo`'s `MainScene.thr` used to be ~90 lines: `state activeDemo`, 7
`{#if:destroy activeDemo = N}` blocks, and three private functions
(`unregisterCurrentDemoFocus`/`claimActiveDemoFocus`/`setup()`'s manual `claimFocusIfVacant`) whose
entire job was hand-simulating what `router.navigate()` gives for free. After conversion:
`router.setRouting([...])` (one entry per chapter), a single `<FlashTheaterRouterOutlet>`, and two
short key handlers that just call `router.navigate("/" + chapterPaths[index])`. Net: fewer lines,
zero hand-rolled focus bookkeeping, and the outlet's own `navigate-out:`/`navigate-in:`/`back-out:`/
`back-in:` transitions became a free extra chapter (a mechanic that otherwise only appeared in
`apps/sample-app`'s `Shell.thr`, with no dedicated deep-dive anywhere). Expect a similar shape for
`apps/focus-demo`/`apps/async-demo`'s own conversions — the router replaces bookkeeping, it doesn't
add it.
