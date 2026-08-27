# router — `apps/router-demo` chapter/router deep-dive

`apps/router-demo` is a NEW chapter app (not a conversion of an existing router-free one — every
prior chapter app already used the router for its own chapter-to-chapter navigation, see
[demo-app-conventions.md](demo-app-conventions.md)'s Roadmap). What makes this one different: every
OTHER chapter app treats the router as invisible plumbing for its own chapter advance — none of them
showcase the router's OWN deep option surface as their actual subject matter.
`apps/sample-app` already demonstrates real router usage (`Shell.thr`/`HomeScreen.thr`/
`ScheduleScreen.thr`/`DirectionalFocusDemo.thr`/`RouterTransitionDemo.thr`), but as one broad app
proving many unrelated features, not a focused deep-dive with every router option shown. This app is
that deep-dive — see [router.md](router.md) for the namespace/codegen mechanics core,
[router-outlet-runtime.md](router-outlet-runtime.md) for the runtime matching/history design, and
[router-transitions.md](router-transitions.md) for the transition/loading-gate mechanics this app's
chapters 3–4 exercise.

## MainScene.thr — the skeleton, copied exactly, with one deliberate difference

`router.setRouting([...])`, a single top-level `<FlashTheaterRouterOutlet>`, REWIND/FAST-FORWARD
chapter advance via `router.navigate()` — the exact same proven skeleton every other chapter app uses
(`apps/animation-demo`'s `MainScene.thr` is the copied reference). **REWIND stays a
`router.navigate()` call, never `router.back()`** — a deliberate choice, not an oversight: chapter 1
(`/navigate-and-params`) has its OWN nested list/detail round trip that already pushes/pops onto the
SAME global back-journey history stack the router keeps (there is only one stack app-wide, not one
per outlet — see `router-outlet-runtime.md`). If `MainScene`'s own REWIND handler also called
`router.back()`, popping the shared stack from two independent places (MainScene's own chapter
bookkeeping AND chapter 1's own internal list<->detail navigation) would desync `state
activeChapterIndex` from the real history depth as soon as a user visited chapter 1's detail screen
and then pressed REWIND — a real, easy-to-hit correctness trap for a "meta" router-focused app
specifically, since this app is far more likely than any other chapter app to have nested router
activity happening underneath the top-level chapter switcher. Keeping REWIND as `navigate()` sidesteps
this entirely; the genuine `router.back()` walk is reserved for the physical Back key only, which
chapter 3 narrates explicitly.

`loadingComponent`/`loadingMinDuration`/`loadingTimeout` are configured on THIS top-level outlet
(`RouterDemoLoadingSpinner` as the indicator), even though only chapter 4 actually demonstrates the
gate — router-outlet transitions/loading gates have no per-route override (GRAMMAR.md's "Known
limitations"), so every chapter mounted through this outlet is technically gated. Every OTHER
chapter's own `setup()` calls `router.markReady()` synchronously specifically to keep this invisible
(GRAMMAR.md: a synchronous `setup()`-time call reveals immediately, before the gate ever arms a
wait) — chapter 4 is the only one that deliberately defers or skips it.

## Chapters

- **`/navigate-and-params`** (`NavigateAndParamsDemo.thr`, plus nested children
  `ParamsListScreen.thr`/`ParamsDetailScreen.thr`) — the ONE chapter in this app needing real router
  nesting: a flat "list" screen has nowhere genuine to navigate to, so this route declares its own
  `children: [...]` in `MainScene.thr`'s `setRouting()` (a `""` default child and a `"detail"`
  child), exactly like `apps/sample-app`'s `Shell.thr` -> `HomeScreen.thr`/`ScheduleScreen.thr`
  pattern. `NavigateAndParamsDemo.thr` itself is a deliberately thin wrapper — no focusable content,
  just the nested outlet — mirroring `Shell.thr`'s own "persistent chrome has no default-focus of its
  own; the mounted child's does" precedent; `ParamsListScreen.thr`'s own `default-focus="true"` is
  what the vacuum rule actually lands on the first time this chapter is entered. Default: plain
  `router.navigate(path, params)` — OK on either of two items (Alpha id:1, Beta id:2) navigates to
  `/navigate-and-params/detail` with a real params AA, read back via `router.params.*`. Customized
  (the more subtle mechanic this chapter exists to show): `router.updateBackJourneyData(...)` +
  `router.back()` together on the detail screen's own "back" press, and `ParamsListScreen.thr`'s own
  `welcomeText` reading `router.backJourneyData.lastVisitedTitle` back once it re-mounts — `invalid`
  on first entry, the last-visited item's title after a genuine destroy-and-recreate round trip
  through router history.
- **`/directional-focus`** (`DirectionalFocusChapterDemo.thr` + sibling
  `DirectionalFocusChapterDemoDetail.thr`, NOT nested under the first — a top-level sibling route
  like `apps/sample-app`'s own `directional-focus`/`directional-focus-detail` pair) —
  `router.isBackJourney` combined with an explicit `focus(<id>)` call in `setup()`. Adapted closely
  from `apps/sample-app`'s `DirectionalFocusDemo.thr`/`DirectionalFocusDemoDetail.thr`; the mechanic
  and the live-verified round trip (forward entry focuses A, a back journey focuses B) are unchanged,
  just re-framed as this app's own chapter. No separate "customized" example — per
  `demo-app-conventions.md`'s rule 4, forward-vs-back IS the two-variant contrast this chapter exists
  to show.
- **`/outlet-transitions`** (`OutletTransitionsChapterDemo.thr`) — a narrated chapter, same pattern
  as `apps/animation-demo`'s own `OutletTransitionsDemo.thr`: since transitions have no per-route
  override, nothing this chapter's own template can trigger that every other chapter switch hasn't
  already shown. Its one genuinely new content: explicitly explaining that `MainScene.thr`'s own
  REWIND/FAST-FORWARD BOTH call `router.navigate()` (see the MainScene section above), so both play
  the SAME `navigate-out:`/`navigate-in:` pair — the physical Back key is the ONLY thing in the whole
  app that ever plays `back-out:`/`back-in:`, and the on-screen card prompts the user to press it to
  see the visible contrast.
- **`/loading-gate`** (`LoadingGateDemo.thr`) — a single flat screen (no nested outlet, unlike
  chapter 1), gated by `MainScene.thr`'s own top-level outlet. Two variants selected by
  `router.params.mode`, re-entered via `router.navigate("/loading-gate", {...})` to the SAME path
  with different params — confirmed this still forces a genuine destroy-and-recreate remount (see
  "A same-path, params-only `navigate()` still remounts a flat leaf route" below), not just an
  in-place update. Default (`mode <> "timeout"`): defers `router.markReady()` behind a 1.5s
  `setTimeout`, so `RouterDemoLoadingSpinner` genuinely shows for that whole delay. Customized
  (`mode = "timeout"`): never calls `router.markReady()` at all, relying purely on `loadingTimeout`
  (4s, configured on the outlet) to force the reveal — the live demonstration of GRAMMAR.md's "opt-in,
  never a way to accidentally strand a screen behind a spinner forever" guarantee.

## A same-path, params-only `navigate()` still remounts a flat leaf route — confirmed against `router-outlet-runtime.md`, not assumed

Chapter 4's own two-variant toggle depends on `router.navigate("/loading-gate", { mode: "timeout" })`
(same path, different params) genuinely tearing down and rebuilding `LoadingGateDemo` so its
`setup()` re-runs with the new `mode` value — not just leaving the existing instance mounted with
stale reactive state. `router-outlet-runtime.md`'s own "Nested route matching" section already
documents the exact rule this relies on: "only the leaf outlet for the current navigation cares about
`params` changes" — since `/loading-gate` has no children, `MainScene`'s own top-level outlet IS the
leaf for this navigation, so a `params`-only change is exactly the case that rule says forces a
rebuild. No compiler change needed; this is an existing, already-correct mechanic this chapter simply
exercises in a way no other app's own chapters happen to.

## No new compiler gotchas beyond the ones already known this session

Nothing here required a compiler fix — every mechanic (`derived idParam: integer = router.params.id`
with an unresolvable schemaless RHS, `router.markReady()` inside a `setTimeout` anonymous-function
callback, `router.navigate()`/`router.back()` as standalone statements, `derived <name>: dynamic`
accepting any RHS) matched GRAMMAR.md exactly and compiled clean on the first `npm run build:roku`
pass. The one thing worth recording for a future chapter app: **`derived <name>: dynamic = <expr>`
is a valid declared type** (GRAMMAR.md's `derived` type-inference section: "`object`/`dynamic` as the
declared type also always accepts anything") — useful for reading a schemaless value (like
`router.params.<key>`) without committing to a concrete type when the value's own shape genuinely
varies by caller, though this app ended up preferring concrete types (`integer`/`string`) per param
for a more informative `derived` declaration instead.

## Live-device-confirmed — all 4 chapters, one real bug found and fixed

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`).

- **`/navigate-and-params`**: forward navigation with real params confirmed (`router.params.id`/
  `.title` read back correctly for both Alpha and Beta). **Real bug found and fixed**:
  `router.backJourneyData.lastVisitedTitle` never showed up on the list screen after a back trip —
  `welcomeText` stayed on its default text no matter how many round trips were made.
  `updateBackJourneyData(...)` attaches data to the **current** route at call time (GRAMMAR.md) —
  `ParamsDetailScreen.thr`'s original `goBack()` called it on ITSELF (the detail route) right before
  `router.back()` popped that exact entry off the stack, so the data was discarded with the entry it
  was attached to, never read by anything. The already-working reference pattern
  (`apps/sample-app`'s `HomeScreen.thr`/`ScheduleScreen.thr`) writes onto the route being left BEHIND
  on the stack (list, before navigating forward) — not the route about to be popped (detail, right
  before going back). Fixed by moving the `updateBackJourneyData({ lastVisitedTitle: ... })` call
  into `ParamsListScreen.thr`'s own `goToAlpha()`/`goToBeta()` (writing onto itself before
  navigating forward) and simplifying `ParamsDetailScreen.thr`'s `goBack()` to a plain
  `router.back()`. Re-verified live: after visiting Alpha then Beta (each via its own round trip),
  `welcomeText` correctly read `"Welcome back from Alpha..."` then `"Welcome back from Beta..."`.
- **`/directional-focus`**: forward entry confirmed focusing `buttonA`; navigating to the detail
  screen and pressing physical back confirmed focusing `buttonB` instead (`router.isBackJourney`
  branch) — the full round trip works exactly as designed.
- **`/outlet-transitions`**: narrated chapter, renders correctly; its claim (every chapter switch
  already exercises this mechanism) is covered by extension — every `Fwd`/back navigation performed
  throughout this whole device pass already exercised `navigate-out:`/`navigate-in:`/`back-out:`/
  `back-in:`.
- **`/loading-gate`**: both variants confirmed. Default: the loading spinner is visible immediately
  after `Fwd`, and the content genuinely reveals (`status` text flips to "Ready! router.markReady()
  called from the setTimeout callback above") only after the 1.5s deferred `markReady()` fires — not
  before. Never-ready (`mode: "timeout"`): spinner shows and holds well past 1.5s, content reveals
  automatically once the 4s `loadingTimeout` elapses despite `markReady()` never being called —
  confirming the same-path, params-only `router.navigate(...)` genuinely remounts the leaf route
  (fresh `setup()` run, not a stale in-place update) exactly as `router-outlet-runtime.md` predicts.

Root `npm test`/`npm run lint`/`npm run build:roku` re-confirmed green after the fix (app-source
only — no `packages/*` change this time). The REWIND-stays-`navigate()` design decision itself
remains reasoned-but-not-directly-observed (the failure mode it avoids was never separately built to
compare against) — no reason to doubt it given how cleanly this whole app's own chapter-index
bookkeeping behaved throughout.
