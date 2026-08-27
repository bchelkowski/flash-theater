# Task manager — `onRequestSent`/`onResponseReceived` global HTTP interceptors

Compile-time module responsibilities and runtime design rationale for the global, app-wide HTTP
request/response interceptors, `taskManager.onRequestSent(<callback>)`/
`taskManager.onResponseReceived(<callback>)`. See `packages/compiler/GRAMMAR.md`'s "Task manager"
section for the grammar/API itself — this file is the *why*. For the manager's core surface
(`run`/`cancel`/`setMaxConcurrent`, priority queues, alerting hysteresis, namespace/gating design),
see [task-manager-core.md](task-manager-core.md). For the alerting callback (`onAlertChanged`),
whose shape this feature reuses directly, see [task-manager-alerting.md](task-manager-alerting.md).
For the sibling per-task `onResult` sugar — whose first, broken design this feature's own plan was
redesigned to avoid repeating — see [task-manager-onresult.md](task-manager-onresult.md).

Global, app-wide, register-once reporting/telemetry hooks for `request Http {}`'s own HTTP traffic
— see GRAMMAR.md's "Task manager" section for the DSL-facing API and `findings/requests-config.md`
for the sibling design notes on `resolvedOptions`/`rawResponse`/`ft_isRequestComponent`, and
`findings/requests-runtime.md` for `parseResponse`/`parseError`'s new `try`/`catch` protection,
both shipped in the same round as this feature.

## The original plan's design was already known-broken before implementation started

The original approved implementation plan for the whole `request {}` feature (phase 4 of 5) had
this shaped exactly like the FIRST, broken draft of `onResult` (see
[task-manager-onresult.md](task-manager-onresult.md)): register the callback pair directly on the
manager via `callFunc("registerRequestInterceptor", cb)`/`callFunc("registerResponseInterceptor",
cb)`. By the time this phase was actually implemented, `onResult`'s own postmortem had already
proven that shape doesn't work at all — a Function value packed into a `callFunc` AA argument
arrives as `invalid` on the other side of a cross-node `callFunc` call. This was caught and
redesigned during planning, not discovered live a second time.

## The shipped design — `onAlertChanged`'s shape, not `onResult`'s

Global interceptors are a genuinely different shape than `onResult`: `onResult` is per-task (one
registration per task node, keyed by task id, fired once and torn down); interceptors are global
and register-once (any number of independent subscribers, anywhere in the app, each firing on
EVERY request/response regardless of who created it). This maps onto `onAlertChanged`'s own proven
pattern (see [task-manager-alerting.md](task-manager-alerting.md)), not `onResult`'s — reused
exactly:

- Two new manager-owned fields, `lastRequestSent`/`lastResponseReceived` (`assocarray`), written by
  the manager itself, never by a foreign node.
- Each registering component, in its own `init()` (gated on `usesTaskManagerRequestSentCallback`/
  `usesTaskManagerResponseReceivedCallback`), initializes its OWN local callback array
  (`m["$$ft_taskManagerRequestSentCallbacks"]`/`...ResponseReceivedCallbacks`) and attaches its OWN
  `ObserveFieldScoped` to the matching manager field, exactly once. Each `onRequestSent(cb)`/
  `onResponseReceived(cb)` call site just `.Push()`es.
- The manager never stores or invokes a Function value belonging to another component at all — it
  only ever flips its own plain-data field. This is what makes the design safe against the
  `callFunc`/Function-value-marshaling bug by construction, not by luck.

## Firing point: `startNode()`, not `runTask()` — caught in design review, not live

`runTask()` either starts a node immediately (`startNode()`) or enqueues it for later — a request
issued while the concurrency budget is saturated is queued, and `startNode()` is called later,
independently, from `drainQueue()` once a slot frees. A first draft of this design considered
firing `onRequestSent` from inside `runTask()` itself — wrong, because `runTask()` runs once per
`run()` call, including the enqueue branch, so a queued request would either double-fire or fire
before it actually started. `startNode()` is the correct, single commit point — it's also already
where the `state` observer is attached (`node.ObserveFieldScoped("state", "onTaskStateChange")`),
so the interceptor logic sits right alongside it, gated on the same `node.ft_isRequestComponent`
check, before `node.control = "RUN"`.

## `ft_isRequestComponent` — sidesteps the original plan's biggest open risk entirely

The original plan's own "Open risks" section flagged: *"Is `ObserveFieldScoped` on a field name
that doesn't exist on the target node a safe no-op or a crash?"* — a real, unverified platform
question, since the plan proposed unconditionally observing `result`/`error` on literally every
`taskManager.run()`'d node, including ordinary hand-written Tasks (`SlowTask.thr`) that declare
neither field.

The shipped design never needs to answer that question. Every new manager behavior (firing
`onRequestSent`, attaching the `rawResponse` observer) is gated behind `node.ft_isRequestComponent`
— a boolean field only `request Http {}`-generated components declare, defaulted `true` via their
own XML. Reading an undeclared field on a real `roSGNode` is already a confirmed-safe BrightScript
fact this codebase relies on elsewhere (`resolveTaskId()`'s own `node.id` collision-guard read, see
[task-manager-core.md](task-manager-core.md)) — reading a field is a fundamentally different, much
more mundane operation than *observing* one that doesn't exist, so gating on the read sidesteps the
riskier, unverified behavior entirely rather than resolving it.

## `onResponseReceived`'s payload is `rawResponse`, never `result`/`error`

`result`/`error` hold each component's own `parseResponse`/`parseError`-*transformed* output — an
app-author-defined shape that varies per component, wrong for a generic reporting hook that wants
consistent raw HTTP metadata. A new `rawResponse` field (see `findings/requests-config.md`) carries
the RAW `ft_httpFetch` response instead, written once at the end of the generated
`ft_runRequest()`. The manager's `startNode()` attaches
`node.ObserveFieldScoped("rawResponse", "on_ft_taskManagerRawResponse")` — a NEW manager-owned
trampoline (not generated per-component, hand-written in `FlashTheaterTaskManager.brs` itself,
since every request task's `rawResponse` field needs the exact same handling) — which unobserves
itself first (fire-once, mirrors `emitTaskManagerResultTrampolines`'s own unobserve-before-invoke
discipline, see [task-manager-onresult.md](task-manager-onresult.md)), then writes
`m.top.lastResponseReceived = event.GetData()`.

This trampoline runs in the MANAGER's own render-thread context (`FlashTheaterTaskManager` is a
plain `Node`, never a `Task`, so it has no background thread of its own) — safe, since it's the
manager (not the request Task) doing the observing, and the request Task's own write to its OWN
`rawResponse` field (from `ft_runRequest()`, on the Task's own background thread) is an ordinary,
already-established safe cross-thread field write, no different from the existing `result`/`error`
writes.

## Never hysteresis-gated, unlike `alertLevel`

`lastRequestSent`/`lastResponseReceived` are written unconditionally on every request/response —
deliberately NOT following `alertLevel`'s own hysteresis-gated "only write on an actual transition"
pattern (see [task-manager-core.md](task-manager-core.md)). A reporting/telemetry hook needs to see
every single request, including two structurally-identical ones back to back (e.g. the same GET
fired twice) — silently coalescing "no visible change" writes would defeat the whole point of a
reporting hook. This is flagged as an open, live-verification-needed risk (below), not an
assumption: nothing in this codebase had previously exercised "does `ObserveFieldScoped` fire on
every write to an `assocarray` field, even for a structurally-identical repeat," since `alertLevel`
deliberately avoids that case by design and `result`/`error`/`rawResponse` are each written at most
once per Task's own lifetime.

## `resolvedOptions` also carries `buildSucceeded`/`buildErrorMessage` — a `buildRequest` failure reaches `onRequestSent` for free

Added in a follow-up round, closing a gap this file originally shipped with deliberately (a
documented "Known limitations" bullet, not an oversight): `buildRequest` itself wasn't given
`try`/`catch` protection at first, on the reasoning that it runs pre-fetch with no response to
recover into. The user asked for it to be closed anyway, plus "a way to report this issue... in
some tool in production." See `findings/requests-runtime.md`'s "`buildRequest` exceptions are also
caught" section for the fix — the short version: `prepareRequest()`'s own `try`/`catch` around
`buildRequest` needed no new reporting mechanism at all, because `options` (mutated with
`buildSucceeded: false`/`buildErrorMessage` on a caught exception) IS `m.top.resolvedOptions`, and
`resolvedOptions` is already `onRequestSent`'s own payload. A registered interceptor sees a
`buildRequest` failure the instant it happens, via the exact same field it already reads for every
other request — the "production reporting tool" the user asked for already existed; it just needed
the payload widened, not a new mechanism bolted on.

## Open risks — live-verification status

**Live-verified 2026-08-14** (Roku Ultra, `RequestDemoScreen.thr` + `Shell.thr`'s new interceptor
readout, `EcpClient`-driven keypress + `queryAppUi`):

1. **`ObserveFieldScoped` firing on every `assocarray` write, even a structurally-identical
   repeat** — confirmed. `lastRequestSent`/`lastResponseReceived` both updated correctly on
   distinct presses of "Load posts" (`interceptorUrlReadout`/`interceptorStatusReadout` tracked
   each request/response in turn, never appeared to silently skip one).
2. **Cross-component registration** — confirmed. `Shell.thr` registered both interceptors once,
   from its own automatic router-mounted `setup()`; `RequestDemoScreen`'s own `GetPosts`/`GetPost`
   Tasks (a completely different component) fired them — `interceptorUrlReadout` updated to the
   real request URL the instant "Load posts" was pressed, `interceptorStatusReadout` updated to
   `HTTP 200` once the response landed, with `resultReadout` independently confirming the
   underlying request still succeeded (no regression from the try/catch wrapping).
3. **`e.message` on a caught BrightScript exception** — confirmed. Deliberately broke
   `GetPost.thr`'s own `parseResponse` to force a real exception; `interceptorStatusReadout` showed
   `onResponseReceived: HTTP 200 (parse error: 'Dot' Operator attempted with invalid BrightScript
   Component or interface reference.)` — a real, populated, usable message string, not `invalid` or
   an empty string. See `findings/requests-runtime.md` for the full writeup (same live pass also
   confirmed the `buildRequest` catch's fallback error object shape, since both hooks share the
   same `ft_e.message` mechanism).

**Still not stress-tested, not a known bug — just unverified under this specific condition:**

4. **Queued-task firing correctness** — whether a `taskManager.run(task)` issued while
   `maxConcurrent` is already saturated still fires `onRequestSent` once `drainQueue()` later calls
   `startNode()`, with the correct `resolvedOptions` payload. The live pass above never saturated
   the concurrency budget (default 50, one request at a time), so `startNode()` was only ever
   reached via the immediate-start path, never the delayed `drainQueue()` path. Low risk — it's the
   exact same `startNode()` code the immediate-start path already proved live — but genuinely
   untested, not confirmed-safe. Would need `taskManager.setMaxConcurrent(1)` plus two overlapping
   requests to exercise.
