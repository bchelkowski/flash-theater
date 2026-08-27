# requests — `apps/requests-demo` chapter/router conversion (split off `apps/async-demo`)

The build notes for `apps/requests-demo` — the third app converted to
`findings/demo-app-conventions.md`'s pattern, and the first built as a **split**, not a
conversion-in-place: `apps/async-demo` covered `taskManager`/`request Http {}`/Timer statements
all at once, one app per doc-nav topic (rule 2), so it's being split into three dedicated chapter
apps — `apps/requests-demo` (this one), `apps/task-manager-demo`, `apps/timers-demo`. See
[demo-app-conventions.md](demo-app-conventions.md)'s Roadmap. For the underlying `request Http {}`
platform facts this app exists to demonstrate, see [requests-config.md](requests-config.md),
[requests-runtime.md](requests-runtime.md), and [requests-caching.md](requests-caching.md).

## The split

`apps/async-demo` itself is untouched by this work — a separate step retires it once all three
split-off apps (this one plus `task-manager-demo`/`timers-demo`, built in parallel by separate
sessions) are confirmed working. `apps/requests-demo` is a new app, not a rename: new `manifest`/
`package.json`/`flash-theater.config.json` (`designResolution: "fhd"`, `ui_resolutions=fhd,hd`,
matching every other converted demo app), copied channel-poster/splash-screen images, and a fresh
router-mounted `MainScene.thr` built from `apps/animation-demo`'s/`apps/focus-demo`'s own skeleton
(`router.setRouting([...])`, one `<FlashTheaterRouterOutlet>`, REWIND/FAST-FORWARD chapter advance)
— not `apps/async-demo`'s old flat `{#if:destroy}`-switched shape, which this app never carries
over. None of this app's chapters declare a `startDemo()` (unlike the timer/task-manager screens
`apps/async-demo`'s old `MainScene.thr` had to dispatch to) — every button is purely
key-triggered, so `MainScene.thr` needed zero forwarding logic beyond the router skeleton itself,
unlike even `apps/animation-demo`'s own conversion (which at least kept its own outlet
transitions). This app's outlet carries no custom transition either — plain, matching
`apps/focus-demo`'s own (unlike `apps/animation-demo`, which does).

**`taskManager.onRequestSent`/`onResponseReceived` were deliberately NOT replicated here.**
`apps/async-demo`'s old `MainScene.thr` registered both globally with a persistent cross-screen
readout — that's `taskManager`'s own doc-nav topic, not `request`'s, and belongs in
`apps/task-manager-demo` instead (a parallel session's job). Every chapter below reads
`buildRequest`/`parseResponse`/`parseError` safety signals **locally** (`task.resolvedOptions`
directly, or a scoped `observeFieldScoped`) — the exact same underlying signals, just without the
cross-component interceptor story this app isn't about.

## Chapters

| # | Path | Component | Default | Customized |
|---|---|---|---|---|
| 1 | `/declare-call` | `DeclareCallDemo` | Top button: plain `GetPostOk.thr` task (no `buildRequest`), consumed via `taskManager.onResult(...)` only | Bottom button: a second `GetPostOk` task consumed via BOTH styles at once — `onResult` AND `observeFieldScoped("result"/"error", ...)`, two independent registrations on the same fields, both firing off one real request |
| 2 | `/caching` | `CachingDemo` | Top button: no `cache` key — follows the server's own `Cache-Control` | Two more buttons, not one — `cache: false` (forced off) and `cache: { ttlSeconds: 300 }` (forced lifetime); see "Why 3 buttons, not 2" below |
| 3 | `/build-safety` | `BuildRequestSafetyDemo` (unchanged shape from `apps/async-demo`) | Top button: `buildRequest` succeeds | Bottom button: `buildRequest` throws, request still proceeds with the static base config |
| 4 | `/parse-safety` | `ParseSafetyDemo` (unchanged shape from `apps/async-demo`) | Top button: `GetPostOk` (shared with chapter 1) — `parseResponse` succeeds | Bottom button: `GetPostParseBroken` — `parseError` itself throws, degrades to a synthesized fallback error |

**Why 3 buttons, not 2, on `/caching`** — rule 4 asks for "default AND customized," but the
`cache` override surface genuinely has three distinct shapes (no key / `false` / `{ ttlSeconds }`),
each behaviorally different, not one "customized" variant of the other. Showing only two would
leave a real option undemonstrated (the same reasoning `BounceButtonDemo.thr`'s own single
`customized` animation avoided by folding several overrides into one declaration — here the three
values are mutually exclusive per-endpoint config, not combinable, so they're three buttons instead
of one bundling all three).

**All chapters use `on:key[OK]` on every button, not distinct trigger keys** (unlike
`apps/animation-demo`'s Replay/Backspace convention) — every button here is an independently
focusable `Rectangle`, so `on:key[OK]` only ever fires for whichever one currently holds focus;
Up/Down (LRUD) moves focus between them. This matches `apps/async-demo`'s own original
`BuildRequestSafetyDemo.thr`/`ParseSafetyDemo.thr` shape exactly — migrated as-is, not redesigned.

**`GetPostOk.thr` is shared across two chapters** (1 and 4) rather than duplicated — same shape,
same file, two different screens `CreateObject`-ing their own fresh instance per press (Task nodes
are one-shot, never reused across presses).

## A real compiler gotcha hit while writing `/caching`'s readout text

**No `\"` escape for an embedded quote inside a DSL string literal** — BrightScript string literals
don't support backslash-escapes at all; this compiler passes a DSL string literal through to
generated BrightScript verbatim, so `"...no \"cache\" key..."` compiles with **zero diagnostic**
but is a live authoring trap (see `apps/sample-app`'s `RequestDemoScreen.thr` for the same gotcha
already documented, including the runtime crash it produces: `\` becomes a stray operator, "Type
Mismatch"). Caught here at the writing stage, before ever compiling — rewrote every readout string
to avoid embedded quotes entirely (`cache: ttlSeconds 300` instead of quoting `"cache"`) rather
than reaching for `Chr(34)` concatenation, since these are plain narration strings with no real
need for a literal quote mark. The fix that *would* have been needed — `Chr(34) + "..." + Chr(34)`
— is the same one `RequestDemoScreen.thr` already uses.

**A literal `{`/`}` inside a static template attribute value was avoided on the same
precautionary basis** — `CachingDemo.thr`'s TTL button label was drafted as `"Send (cache:
{ttlSeconds: 300})"` and rewritten to `"Send (cache: ttlSeconds 300)"` before ever compiling,
since `{`/`}` inside an XML attribute value is this DSL's own dynamic-binding marker syntax
(GRAMMAR.md's Template section) — not independently confirmed broken for a fully-static value with
no surrounding `{expr}` wrapper, just never risked. Worth a follow-up if a future chapter genuinely
needs a literal brace in visible text.

## Response caching — live-device-confirmed, all three `fromCache` outcomes

`/caching`'s three requests hit three different URLs (`posts/1`/`posts/2`/`posts/3`) so each gets
its own independent `cachefs:/` entry — a shared URL across differently-configured requests would
make the cache key collide and muddy which config's own behavior a given `fromCache` result
actually reflects. Each `parseResponse` surfaces `response.fromCache` directly in its own parsed
result (a plain field read, no interceptor needed — see GRAMMAR.md's "Requests" → "HTTP response
caching": `fromCache` is available on every `parseResponse`/`parseError` response, not just
`rawResponse`). The readout text states both the real `fromCache` value AND what to expect for that
config, in plain language pulled from GRAMMAR.md's own wording.

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`), pressing each of the 3 buttons
twice in a row: default (no `cache` key) read `fromCache=true` on BOTH press #1 and press #2 —
`jsonplaceholder.typicode.com`'s own `Cache-Control` header apparently already permits caching this
URL from the very first fetch, not just a repeat; `cache: false` read `fromCache=false` on both
presses, confirming it's genuinely never cached; `cache: { ttlSeconds: 300 }` read `fromCache=false`
on press #1 then `fromCache=true` on press #2 — the one case that visibly demonstrates the forced
TTL actually taking effect within its own window, distinct from the default button's own
already-true behavior. All three outcomes match what the readout text predicts.

## Live-device-confirmed — all 4 chapters, one real bug found and fixed

**⚠️ Live-verified**, all 4 chapters walked via REWIND/FAST-FORWARD, default AND customized
examples for each.

- **`/declare-call`**: default button's `onResult`-only readout confirmed. Customized button
  confirmed BOTH readouts (`onResult` promise-style AND the raw `observeFieldScoped` style) update
  from the SAME one press — neither observer silently wins.
- **`/caching`**: see above — all three `fromCache` outcomes confirmed live.
- **`/build-safety`**: default button confirms `buildRequest: OK` + 10 posts loaded (filtered by
  `userId`). **Real bug found and fixed on the "throws" button**: `SafeBuildRequest.thr`'s
  `buildRequest` hook simulated a crash via `requestData.brokenConfig.userId` (dot-chaining into an
  undeclared AA key) — but this compiler auto-inserts optional chaining into every generated member
  access (see `findings/operators-optional-chaining.md`), so the generated
  `requestData?.brokenConfig?.userId` never actually threw at all. Symptom: `buildStatusReadout`
  read "buildRequest: OK" on BOTH buttons — the "throws" button's own catch path was never
  exercised, even though the request itself still degraded correctly underneath (100 posts, no
  filter, matching what a failed override SHOULD produce) — a demo-narrative bug, not a
  runtime-safety bug; the underlying try/catch mechanism was never actually broken, just never
  actually triggered. **Fixed** by replacing the dot-chain with a raw `Throw "simulated
  buildRequest failure"` (`' flash-theater:raw`/`end-raw` — optional chaining only touches member/
  index/call expressions, never a raw statement). Re-verified live: "throws" button now reads
  `buildRequest: FAILED - simulated buildRequest failure`, request still degrades to 100 posts, no
  crash. See `findings/operators-optional-chaining.md`'s own new entry for the general lesson.
- **`/parse-safety`**: default button confirms `parse: OK (isSuccess=true)` + the loaded title.
  Broken button (`GetPostParseBroken`) confirms `parse: FAILED - Syntax Error.` and
  `error.message = parseError threw: Syntax Error.` — genuinely throws (a real syntax error in the
  parse hook itself, not a chain-safety-defeated dot access like the build-safety case above), and
  degrades to the synthesized fallback with no crash.

Root `npm test`/`npm run lint`/`npm run build:roku` re-confirmed green after the fix (app-source
only — no `packages/*` change).
