# Requests — runtime & platform gotchas (transport, callback naming, threading, live-device facts)

Compile-time-adjacent and runtime design rationale for the `request Http {}` DSL declaration's
generated *behavior* — transport, hook-invocation safety, and BrightScript/Roku platform facts
that cost real debugging time to confirm, several only catchable on a real device. See
`packages/compiler/GRAMMAR.md`'s "Requests" section for the grammar/API itself. For the config
surface and generated fields/functions, see [requests-config.md](requests-config.md). For HTTP
response caching, see [requests-caching.md](requests-caching.md).

## `parseResponse`/`parseError` exceptions are caught — `try`/`catch`

Shipped alongside the interceptor feature, per explicit user requirement: a bug in either hook body
(arbitrary app-author code) used to crash the whole Task with no recovery. `request-emitter.ts`'s
`emitRequestGeneratedFunctions` now wraps each hook's invocation in `try`/`catch` (only when that
hook is declared — a component with neither hook gets no `try`/`catch` at all, since nothing there
can throw), synthesizing a fallback error (`{message, parseFailed: true, httpStatusCode, raw}`,
written to `m.top.error`) on a caught exception, and recording `parseSucceeded`/`parseErrorMessage`
onto `rawResponse` — see `findings/task-manager-request-interceptors.md`'s own interceptor section for why this
signal is orthogonal to `rawResponse.isSuccess`.

BrightScript `try`/`catch` syntax needed no new verification here — this repo's own
`test/golden/control-flow-basic` fixture already round-trips it, and confirms the caught
exception's `.number` field works. `.message` (used by the fallback-error message text above) had
no prior in-repo precedent — **live-verified 2026-08-14** (same Roku Ultra): deliberately broke
`GetPost.thr`'s own `parseResponse` (`response.data.nonexistentField.title` — a `.Dot` operator on
`invalid`), sideloaded, and drove it via `EcpClient`. `interceptorStatusReadout` correctly showed
`onResponseReceived: HTTP 200 (parse error: 'Dot' Operator attempted with invalid BrightScript
Component or interface reference.)` and `cachedErrorReadout` showed the matching `parseResponse
threw: ...` fallback text — `e.message` is a real, populated, usable string on-device, not just a
docs claim. Reverted the fixture and resideloaded the correct build afterward.

## `buildRequest` exceptions are also caught — `try`/`catch` inside `prepareRequest()`, no rendezvous concern

Originally shipped WITHOUT this protection (a documented, deliberate "Known limitations" gap) —
closed in the very next round, per explicit user follow-up ("buildRequest also should work without
crash if there is some issue during building requests... we should have a way to report this...
in some tool in the production"). Unlike `parseResponse`/`parseError`, `buildRequest` never runs on
the Task's own background thread at all (see this file's "buildRequest moved out of the Task thread
entirely" section) — it only ever runs inside `prepareRequest()`, on the CALLING thread, so wrapping
its call (plus the override-merge logic that reads its return value) in `try`/`catch` there carries
no rendezvous risk to reason about, unlike the `ft_runRequest()`-thread hooks.

**Design**: `buildBaseOptionsLiteral` (`request-emitter.ts`) now always appends `buildSucceeded:
true, buildErrorMessage: ""` as the literal's own last two keys — present unconditionally,
regardless of whether `buildRequest` is even declared, keeping `resolvedOptions`'s shape consistent
everywhere it's produced (the unconditional `init()` write, `ft_buildBaseRequestOptions()`, and
`prepareRequest()`'s own fallback). On a caught `buildRequest` exception, `prepareRequest()`
overwrites both keys (`options.buildSucceeded = false`, `options.buildErrorMessage = ft_e.message`)
and otherwise leaves `options` exactly as `ft_buildBaseRequestOptions()` produced it (none of the
override assignments ran, since the call that would have set them up is what threw) — the identical
graceful "use the static base options" degrade a forgotten `prepareRequest()` call already gets.
The request still proceeds with the static options rather than being abandoned.

**The reporting half was the more interesting design question, and it turned out to need zero new
plumbing.** `options` becomes `m.top.resolvedOptions`, and `resolvedOptions` IS the exact payload
`taskManager.onRequestSent(...)` fires with (`FlashTheaterTaskManager.brs`'s `startNode()`) — so a
registered interceptor sees `buildSucceeded: false`/`buildErrorMessage` automatically, the instant
it's registered, with no new hook, no new manager field, no new `taskManager.*` action. This is the
"way to report this in some tool in production" the user asked for: the SAME `onRequestSent`
interceptor a reporting integration would already register for telemetry now also surfaces
`buildRequest` failures, for free, as an orthogonal signal alongside the resolved options
themselves — exactly the same "reuse the existing signal, don't invent a new mechanism" shape
`rawResponse.parseSucceeded` already established for the response side.

## Async transport chosen for `ft_httpFetch` — async + `Wait()`, not synchronous `GetToString()`

`runtime-assets/Http/FlashTheaterHttp.brs` uses `roUrlTransfer`'s `AsyncGetToString()`/
`AsyncPostFromString()` + a message port + one blocking `Wait(0, port)`, not the synchronous
`GetToString()`/`PostFromString()` variants — deliberately, to get a real HTTP status code back via
`roUrlEvent.GetResponseCode()` afterward (the synchronous methods' status-code story is murkier and
wasn't worth risking on an unverified assumption). This still blocks the calling Task's own thread
end-to-end (no timeout, no cancellation in this phase) — safe specifically because `request Http {}`
requires `extends="Task"`, and a Task exists precisely so blocking work like this doesn't stall the
render thread.

**⚠️ Live-verified 2026-08-11, re-verified 2026-08-12** (same Roku Ultra) — `EcpClient`-driven
keypress + `queryAppUi`, not just a compile-time check. `AsyncGetToString()` + `Wait(0, port)`
returned a real `roUrlEvent` (`GetResponseCode()` → `200`, `GetString()` → 27520 bytes),
`ParseJson()` correctly produced an `roArray` for the JSON array body, and `RequestDemoScreen`'s
`resultReadout` showed "Loaded 100 posts" end to end — real network I/O, real JSON parsing, real
cross-thread field delivery, all confirmed on-device, not just "compiles." The 2026-08-12
re-verification (after the `requestData` rename, `query`/`body` config keys, `pkg:/`-absolute
`<script uri>`, private `parseResponse`/`parseError`, and the removed `<Node id="root" />`, all in
[requests-config.md](requests-config.md)) drove the exact same screen end to end again and
confirmed `resultReadout` now reads "Loaded 10 posts" — `GetPosts.thr`'s own `query: { userId: "1"
}` correctly narrowed the real server response, proving the new `ft_httpBuildUrl` query-string path,
the `pkg:/`-rooted `<script uri="pkg:/components/FlashTheater/Http/FlashTheaterHttp.brs">`
reference, and the `private_parseResponse`/`private_parseError` call sites all work together on a
real device, not just in golden-fixture text.

## `observeFieldScoped`'s callback-name string is never rewritten — the handler MUST be `public`

**A real bug, caught only by driving the device, not by any test in this repo.** The first version
of `RequestDemoScreen.thr` declared `private function onPostsLoaded(event: dynamic)` and called
`task.observeFieldScoped("result", "onPostsLoaded")`. This compiled cleanly, ran with zero crashes,
and `m.top.result` was confirmed (via temporary `print` instrumentation) to be set correctly inside
the Task — but the observer never fired, and the screen stayed stuck on "Not run yet" forever. Root
cause: `observeFieldScoped(...)` is an ordinary method call on a plain `roSGNode` variable, not
`taskManager.*`/`focus.*` reserved-keyword sugar this compiler specially rewrites — so its second
argument, a bare string literal, is passed through completely unchanged. `private function
onPostsLoaded` compiles to a real top-level sub named `private_onPostsLoaded` (the `private_`
prefix), which silently does **not** match the literal string `"onPostsLoaded"` still sitting in the
`observeFieldScoped` call — and Roku treats an `ObserveFieldScoped` target that doesn't resolve to a
real function as a **silent no-op**, not a compile or runtime error. Nothing in this repo's test
suite catches this class of bug: `validateGeneratedBrs`/the golden tests only confirm the `.brs`
*parses*, never that a string-literal callback name actually matches a real declared function.
**Fix**: any function referenced by its literal name in an `observeFieldScoped`/`ObserveField` call
(same as `functionName` — see `apps/sample-app/src/components/SlowTask/SlowTask.thr`'s own comment on
this exact class of gotcha) must be declared `public function`, never `private`, so its name survives
verbatim. **Lesson for the next feature that hands a bare string to a real BrightScript API call**:
this compiler has zero visibility into string-literal arguments — anything that must resolve to a
real declared name at runtime is the DSL author's own responsibility to get right, and a silent
no-op (not a crash) is the failure mode when they don't.

**This is specific to a bare string handed to a real BrightScript API — it does NOT apply to
`request {}`'s own `buildRequest`/`parseResponse`/`parseError` hooks**, a distinction a design
review after phase 1 shipped flagged as worth double-checking explicitly (the two look similar —
"a function this feature calls by name" — but resolve completely differently). Those three hooks
are looked up by `codegen/request-emitter.ts`'s `resolveHookCallName` against `script.functions` at
*compile* time and spliced into the generated call site by their real compiled name
(`private_parseResponse` when declared `private function`) — never a runtime string lookup. Before
this fix, `emitRequestWorkFunction` hard-coded the literal call `parseResponse(response)` regardless
of visibility, which had the exact same silent-no-op failure mode as the `observeFieldScoped` bug
above if the DSL author ever wrote `private function parseResponse` (the original
`GetPosts.thr`/golden fixture both used `public function` for this reason, without the underlying
bug ever being exercised or caught by a test). `apps/sample-app/src/components/GetPosts/GetPosts.thr`
and the `request-http-basic` golden fixture now deliberately use `private function` for
`parseResponse`/`parseError` specifically to lock in the fix.

## `buildRequest` moved out of the Task thread entirely — avoids a real Roku rendezvous

**A real architectural bug, caught by user review, not by any test or live run** — the failure
mode here (blocking cross-thread stalls, not a wrong *answer*) isn't something a functional
correctness check would ever surface; it needed someone who knew Roku's own threading model to
spot it. Phase 1's first version of `buildRequest(requestData)` ran entirely inside
`ft_runRequest()` — the generated Task-thread work function `functionName` points at, which only
starts executing once `taskManager.run()` sets `control="RUN"`. That means `buildRequest`'s own
body ran on the Task's **background thread**. If that body ever read anything living outside the
Task's own node — `store`/`theme`/`m.global.*`/another node's field, all realistic things a request
builder might legitimately want (an auth token from global state, a locale from `store`) — Roku
triggers a real **rendezvous**: the background thread blocks, synchronously waiting on the render
thread to service that foreign-node field access. This is a documented, real Roku performance
concern (visible in the `stats rendezvous` telnet/BrightScript Profiler output on a real device),
not a style nitpick — a chatty `buildRequest` reading global state on every request would add
real, avoidable latency and thread contention to something that has no need to touch the Task
thread at all before the actual `ft_httpFetch` call.

**Fix**: resolve the whole request BEFORE the Task's background thread ever exists. A Roku Task
node is an ordinary, single-threaded node right up until `control="RUN"` is actually set —
`CreateObject("roSGNode", ...)` and any field write/`callFunc` performed before that point execute
synchronously on whichever thread is doing them (the render thread, in the ordinary case), with no
Task thread involved at all yet; this is the same principle every Task-based Roku app already
relies on for the ordinary "set input fields, then `control="RUN"`" idiom. `request Http {}`
components that declare `buildRequest` now generate a `public`, `callFunc`-reachable
`prepareRequest(requestData)` function — the caller invokes it explicitly, via
`task.callFunc("prepareRequest", requestData)`, **before** `taskManager.run(task)`. It runs
`buildRequest` (and does the config merge) entirely on the calling thread, then stores the
fully-resolved options AA onto `m.top.resolvedOptions` — an ordinary field on the Task's own node,
written before `control="RUN"`. `ft_runRequest()` (now running on the Task's real background
thread) just reads that already-resolved field — never calls `buildRequest` itself, so there is
nothing left in the Task-thread code path that could ever rendezvous.

**Why not do this automatically from inside `taskManager.run()` itself** (so the caller wouldn't
need an extra `callFunc` step)? Considered, rejected: it would mean `taskManager.run()` — the ONE
shared entry point for starting literally any Task, `request {}`-generated or hand-written —
unconditionally calling `.callFunc("ft_someWellKnownName", ...)` on every node it's ever given,
relying on an unverified assumption about whether `callFunc` on an undeclared function name is a
safe, silent no-op for the many ordinary Task components (`SlowTask.thr` and any future
hand-written Task) that don't declare any such function. That's a change to the *shared*
`FlashTheaterTaskManager.brs` runtime, used by every Task in every app — a much bigger blast radius
and a much bigger unverified-platform-assumption risk than an explicit, opt-in `callFunc` the
caller only makes for a request that actually declares `buildRequest`. Keeping `taskManager.run()`
itself completely untouched also preserves the "one unified call site" decision
[requests-config.md](requests-config.md)'s own first section documents — `request {}`'s new
consumption step is additive (a `callFunc` before `run()`, only needed when `buildRequest` is
declared), not a change to the shared manager's own contract.

**Graceful fallback, not a crash, if the caller forgets to call `prepareRequest`**:
`ft_runRequest()` checks `m.top.resolvedOptions <> invalid` before falling back to rebuilding the
static config itself (via a small shared `ft_buildBaseRequestOptions()` helper, reused by both
`prepareRequest` and the fallback path, so the base-options literal is never duplicated in the
generated `.brs`) — a forgotten `prepareRequest` call silently loses `buildRequest`'s own override,
not the whole request.

**Live-verified 2026-08-12** (same Roku Ultra) — rebuilt `GetPosts.thr`/`RequestDemoScreen.thr`
around `task.callFunc("prepareRequest", { userId: nextUserId })` (replacing the old
`task.requestData = {...}` field write), confirmed via `EcpClient` two consecutive presses each
correctly returned "Loaded 10 posts for userId=1" then "...userId=2" — `callFunc` on a Task node
before `control="RUN"` behaves exactly as the Roku Task lifecycle docs describe (synchronous,
same-thread, ordinary function call), no crash, no behavior change from the caller's own point of
view versus the old field-write style, only the underlying thread-safety story improved.

## An unquoted AA-literal key inside `buildRequest`/a hook body is silently case-folded by BrightScript

**A real bug, caught only by driving the device with real console output, not by any test in this
repo or by reading the generated `.brs`.** While building a live demo of `buildRequest(requestData)`
parameterizing a query per-call (`GetPosts.thr` returning `{ query: { userId: requestData.userId } }`
from a `private function buildRequest`), the resulting request consistently returned all 100 posts
instead of the expected 10 filtered by `userId` — `ft_httpFetch`'s own query-building logic
(`ft_httpBuildUrl`, see [requests-config.md](requests-config.md)) looked correct, and `.brs` output
review showed nothing wrong either: `return { query: { userId: requestData.userId } }` reads
exactly like the equivalent static config key that already worked. Root cause, confirmed by adding
temporary `print` instrumentation to `ft_httpBuildUrl` and reading it back over `ConsoleStream`
(port 8085): the AA literal's own key arrived as `"userid"` (lowercase), not `"userId"` —
**BrightScript case-folds an unquoted/bareword associative-array literal key** (`{ userId: ... }`,
treated like an identifier, case-insensitive the same way BrightScript variable/function names are)
but **preserves a quoted string key exactly as written** (`{ "userId": ... }`).
jsonplaceholder's `?userId=` filter is case-sensitive at the HTTP layer, so `?userid=1` matched
nothing and the API silently returned the full unfiltered list — no error, no crash, just a wrong
answer that looked like the query string wasn't being sent at all (until the console output proved
otherwise).

**Why the static `request Http {}` config never hits this**: `analysis/request-config.ts`'s
`unquoteKey`/`codegen/request-emitter.ts`'s `printBrsLiteral` always round-trip every static
config key through `brsStringLiteral(key)` when re-emitting it into generated `.brs` — so
`request Http { query: { userId: "1" } }` (bareword in the DSL source) still prints as
`{ "userId": "1" }` in the generated `options` line, a quoted key, unaffected by the runtime
case-folding. **A hook body (`buildRequest`/`parseResponse`/`parseError`) is different** — its
object-literal return value is ordinary user-authored BrightScript-shaped code the compiler does
not rewrite the keys of, so whatever quoting the DSL author chooses flows straight through to a
real `roAssociativeArray` construction at runtime, where the case-folding rule applies exactly as
it would in hand-written BrightScript.

**Fix applied**: `GetPosts.thr`'s own `buildRequest` now quotes `"userId"` explicitly, with an
inline comment explaining why (not just a silent style choice). **Lesson for anyone writing a
`request {}` hook body (or any hand-written BrightScript building an AA meant to match a
case-sensitive external name — a header, a query param, a JSON field)**: quote the key. This is a
general BrightScript-language fact, not specific to `request {}` — worth remembering for any future
feature whose hook bodies build AAs consumed by something case-sensitive downstream.

## Cross-owner "Right" into a request-demo screen's button needs real geometric overlap

**Also only caught live**, not by any compile-time check. `RequestDemoScreen`'s `loadButton` was
first laid out at the same `y=100` every other demo screen's primary button uses — but `Shell`'s own
`menuRequests` sidebar item (the last of 7) sits at `y=616`, nowhere near `y=100`. Per
`findings/focus-system.md`'s own documented rule ("a candidate counts as being 'in' a direction only
if it genuinely overlaps the focused box on the perpendicular axis"), a "Right" press from
`menuRequests` found no valid candidate and did nothing — focus stayed on the menu, confirmed
reproducibly across repeated attempts and longer waits (this looked exactly like a timing race until
the geometry was actually checked). **Fix**: moved `loadButton` to `y=610`, overlapping
`menuRequests`'s own `y=616–676` span. **Lesson**: when adding a new item to `Shell`'s sidebar menu,
the corresponding screen's own primary focusable content needs a `y`-translation that vertically
overlaps that specific menu item's row — not just "near the top" the way every earlier screen (whose
menu item happened to sit near the top of the list) could get away with.
