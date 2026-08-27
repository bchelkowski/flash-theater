# task-manager — `apps/task-manager-demo` chapter/router conversion

The chapter/router conversion notes and coverage audit for `apps/task-manager-demo` — the third
of `apps/async-demo`'s 3-way split, after `apps/timers-demo` and `apps/requests-demo` (see
[demo-app-conventions.md](demo-app-conventions.md)'s "Roadmap"). For the underlying `taskManager`
platform design/bugs this app exists to demonstrate, see
[task-manager-core.md](task-manager-core.md), [task-manager-alerting.md](task-manager-alerting.md),
[task-manager-onresult.md](task-manager-onresult.md), and
[task-manager-request-interceptors.md](task-manager-request-interceptors.md).

## The conversion

`MainScene` is router-mounted (`router.setRouting`, `<FlashTheaterRouterOutlet>`,
REWIND/FAST-FORWARD chapter advance — same skeleton as `apps/animation-demo`/`apps/focus-demo`),
4 chapters: `/run-cancel`, `/alerting`, `/on-result`, `/interceptors`. `PriorityQueueDemo.thr`/
`AlertingDemo.thr` migrated from `apps/async-demo` as `RunCancelDemo.thr`/
`AlertingChapterDemo.thr` — renamed to match their chapter's own path, not kept verbatim, since
this app doesn't need to preserve the old flat-screen naming. Each migrated screen's own
`startDemo()` (previously `callFunc`'d explicitly by `apps/async-demo`'s router-less `MainScene`)
became a real `public function setup()`, since a router-mounted screen gets that call
automatically — no forwarding logic needed anywhere in this app's `MainScene.thr`, unlike
`apps/async-demo`'s own ~70-line `startActiveDemoIfNeeded()`/`unregisterCurrentDemoFocus()`/
`claimActiveDemoFocus()` trio, all of which the router supersedes outright.

**The `onRequestSent`/`onResponseReceived` interceptor readout moved here from
`apps/async-demo`'s `MainScene.thr`**, not to `apps/requests-demo` — the doc-nav routing table
(`site/src/data/docsNav.ts`/CLAUDE.md's own routing table) files
`taskManager.onRequestSent`/`onResponseReceived` under the `task-manager` topic (they're
`taskManager.*` API surface, not `request Http {}` grammar), so this is where the topic-per-app
convention puts it. It's registered exactly once, in `MainScene.thr`'s own `setup()`, and the
readout (`requestReadout`/`responseReadout` labels) is persistent — visible across every chapter
switch, the same "app-wide, register-once" proof `apps/async-demo`'s own version gave, just now
demonstrated from a router-mounted app instead of a router-free one.

## Chapters

- **`/run-cancel`** — `RunCancelDemo.thr`. Default: "Run burst" (5 `SlowTask` instances, Low/
  Normal/High/Normal/Low, `setMaxConcurrent(1)`) + "Cancel most recent". **Customized addition**
  (new, not in the original `PriorityQueueDemo.thr`): "Same burst at maxConcurrent=3" — the exact
  same 5-task burst, but raising the concurrency limit first, directly contrasting which tasks get
  an IMMEDIATE slot (governed only by submission order + available slots) against which ones only
  ever affect QUEUE drain order (priority) — a distinction the original single-concurrency demo
  couldn't show on its own.
- **`/alerting`** — `AlertingChapterDemo.thr`. Default: "Flood queue" (8 tasks, warning=3/
  critical=6) — proves the hysteresis-gated `onAlertChanged` fires exactly twice for one flood
  (`none→warning`, `warning→critical`), never once per queue mutation. **Customized addition**
  (new): "Flood tight" (4 tasks, warning=1/critical=2, shorter task duration) completes a full
  flood-AND-drain cycle in well under 10 seconds, demonstrating the DOWNWARD half of hysteresis the
  original demo's timescale never showed on its own (`critical→warning`, `warning→none` as the
  queue drains, still never one log entry per mutation).
- **`/on-result`** — `OnResultDemo.thr`, entirely new (no `apps/async-demo` equivalent — that
  app only ever demonstrated `taskManager.onResult(...)` incidentally, against a `request Http {}`
  Task in `apps/sample-app`'s `RequestDemoScreen.thr`). Demonstrates `onResult` against a plain
  hand-authored Task instead, proving the mechanism works against ANY Task writing its own
  `result`/`error` fields, not just a request-generated one. `SlowTask.thr` gained `result`/
  `error`/`shouldFail` fields for exactly this purpose (`apps/async-demo`'s own `SlowTask.thr`
  never needed them). Default: "Run task (succeeds)" — `onSuccess` fires. Customized: "Run task
  (fails)" — same `onResult(task, onSuccess, onError)` call shape, only `task.shouldFail = true`
  differs, `onError` fires instead.
- **`/interceptors`** — `InterceptorsDemo.thr`, entirely new as its own dedicated deep-dive
  (`apps/async-demo` demonstrated this only implicitly, via whatever its two requests-safety demo
  screens happened to trigger). Deliberately narrow: fires ONE real HTTP request (`GetPost.thr`, a
  minimal `request Http {}` component — not a requests-safety showcase, that's
  `apps/requests-demo`'s job) purely as a trigger. The actual point — register-once, fires
  app-wide — is proven by `MainScene.thr`'s own persistent readout, not by anything local to this
  chapter: press "Fetch a post" here, switch chapters, and the readout at the bottom keeps
  reflecting this chapter's last request/response since the subscription lives in `MainScene`, not
  this chapter's own script.

## Live-device-confirmed — all 4 chapters, one real bug found and fixed

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`) via `npm run build:roku` +
`installChannel` + ECP driving. All 4 chapters walked, default AND customized examples.

**Real bug found and fixed: every `SlowTask` instantiation in this app was missing
`task.functionName = "doWork"`.** `RunCancelDemo.thr`'s `startLabeled()`,
`AlertingChapterDemo.thr`'s `floodQueue()`/`floodQueueTight()`, and `OnResultDemo.thr`'s
`loadSuccessful()`/`loadFailing()` all did `CreateObject("roSGNode", "SlowTask")` then set
`label`/`durationSeconds` and called `taskManager.run(...)` — but never set `functionName`. Unlike
`apps/sample-app`'s own `TaskDemoScreen.thr` (the original this was migrated from, which DOES set
`task.functionName = "doWork"`), this line was silently dropped somewhere in the migration. See
`SlowTask.thr`'s own top comment: this compiler has zero Task-specific codegen — Roku's own Task
lifecycle only ever spawns whichever sub `functionName` names, so with it unset, `control = "RUN"`
transitions the Task straight to a terminal state with `doWork()` never invoked at all, no error
raised. Symptom: `Sleep(durationSeconds * 1000)` never ran, so every "started"/"stopped" pair in
`RunCancelDemo`'s log landed within single-digit milliseconds of each other instead of ~2 real
seconds apart — indistinguishable from a real concurrency-gating bug from the UI/`queryAppUi` alone
(`runningCount`/`queuedCount` both read 0 almost immediately either way). **Diagnosed by adding a
`roTimespan`-based millisecond-precision log directly in the `.thr` source** (ECP polling alone
can't disambiguate "genuinely fast" from "query arrived late" — ISO-second timestamps weren't
precise enough either, since all 5 tasks landed inside the same one-second window either way) —
this is the reliable pattern for a "is X actually taking real time or not" question on this device;
don't trust `queryAppUi` timing deltas alone. Fixed by adding `task.functionName = "doWork"` right
after `CreateObject(...)` at all 5 call sites; re-verified live afterward (see below). This was a
pure app-source bug — the compiler, `flash-parser`, and the `FlashTheaterTaskManager.brs` runtime
asset were all already correct (confirmed by temporarily instrumenting the runtime asset with debug
fields during diagnosis, then reverting — `runTask()`'s own `active.Count() < maxConcurrent` gate
was deciding correctly the whole time).

- **`/run-cancel`**: default burst (maxConcurrent=1) now drains one task at a time over ~10s in the
  documented priority order (Low-1 immediate, then High-1/Normal-1/Normal-2/Low-2 by tier) —
  `runningReadout`/`queuedReadout` tracked 1/4 → 1/3 → 1/2 → 0/0 across the drain. Customized burst
  (maxConcurrent=3) confirmed Running:3/Queued:2 immediately, with the first 3 in SUBMISSION order
  (Low-1, Normal-1, High-1) regardless of priority, and the remaining 2 draining by priority — the
  exact contrast this chapter exists to show. "Cancel most recent" confirmed removing a still-queued
  task (log shows `cancelled: <id>`, queued count drops).
- **`/alerting`**: both the default flood (8 tasks, warning=3/critical=6) and the tight flood (4
  tasks, warning=1/critical=2) confirmed exactly 2 log entries on the way up
  (`none -> warning -> critical`) and, for the tight flood, exactly 2 more on the way down as the
  queue naturally drained (`critical -> warning -> none`) — hysteresis gating holds in both
  directions, never one entry per queue mutation despite the queue depth changing 7 times.
- **`/on-result`**: both examples confirmed AFTER the `functionName` fix — "Run task (succeeds)"
  shows `onSuccess: onResult-ok finished after 1s`; "Run task (fails)" shows
  `onError: SlowTask onResult-error simulated failure`. Before the fix neither could have worked
  (`doWork()` never ran, so `result`/`error` were never written for `onResult` to observe).
- **`/interceptors`**: "Fetch a post" fires a real `GetPost` request against
  `jsonplaceholder.typicode.com` — confirmed HTTP 200, `resultReadout` shows the loaded title, AND
  `MainScene`'s persistent `requestReadout`/`responseReadout` update simultaneously. Confirmed the
  persistent readout survives 3 chapter switches (REWIND x3, `/interceptors` → `/run-cancel`) with
  the same request/response text still showing — the register-once/app-wide design holds.
