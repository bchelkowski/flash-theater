# Task manager — core (`taskManager.run/cancel/setMaxConcurrent`, priority, alerting)

Compile-time module responsibilities and runtime design rationale for the Task-node concurrency
manager's core surface: run/cancel/priority/alerting and the manager's own namespace/gating
design. See `packages/compiler/GRAMMAR.md`'s "Task manager" section for the grammar/API itself —
this file is the *why*. For the alerting callback (`onAlertChanged`), see
[task-manager-alerting.md](task-manager-alerting.md). For the request-flow callback sugar, see
[task-manager-onresult.md](task-manager-onresult.md) (`onResult`) and
[task-manager-request-interceptors.md](task-manager-request-interceptors.md)
(`onRequestSent`/`onResponseReceived`).

## `taskManager` reuses `router`'s "one namespace, no new keyword" precedent

`findings/router.md` already states the lesson this feature follows: *"if it needs both data reads
and method-style actions, prefer one unified namespace over splitting them into separate root
names."* `taskManager.run/cancel/setMaxConcurrent(...)` (actions) and
`taskManager.runningCount`/`taskManager.queuedCount` (data reads) share one root, reached through
the exact same generic dot-chain scanner `theme.a.b`/`router.*` already use (`GLOBAL_ROOT_NAMES` in
`analysis/identifier-rewrite.ts`/`analysis/expression-region.ts`) — no new flash-parser grammar was
needed at all. The one deliberate departure from `router`'s own precedent: `router`'s data reads are
fully schemaless past the root (there's no way to know a route's `params` shape at compile time),
but `taskManager`'s data surface is small and fixed (`runningCount`/`queuedCount` only), so
`analysis/global-bindings.ts`'s `resolveTaskManagerPath` validates both the action and data sides
against closed lists — closer to `resolveThemePath`'s discipline than `resolveRouterPath`'s
"anything past segment 1 passes" laxness.

## `run` cannot be a real BrightScript function name — confirmed via `parseBrightScript`, not assumed

The obvious runtime function name for `taskManager.run(node)`'s target is `run` — this fails to
parse. BrightScript has its own `Run` statement (running another compiled file at runtime), a
reserved word, so a top-level `function run(...)`/`sub run(...)` declaration is a syntax error
(`Unexpected token "function"`, confirmed by feeding a minimal repro through flash-parser's
`parseBrightScript`). `cancel`/`setMaxConcurrent` are not reserved and parse fine.

**Fix, not a workaround**: the DSL-facing spelling stays `taskManager.run(node)` (unaffected — it's
just a string key in a lookup table, not a real identifier) — only the *runtime* function is
renamed to `runTask`, and `analysis/global-bindings.ts`'s `TASK_MANAGER_RUNTIME_METHOD_NAMES` maps
the DSL action name to the actual `callFunc(...)` target string
(`identifier-rewrite.ts`'s `buildTaskManagerActionReplacement` reads through this map instead of
using `method` directly). `cancel`/`setMaxConcurrent` map to themselves. **Lesson for the next
DSL-facing action name that becomes a runtime function**: never assume an obvious English verb is a
safe BrightScript identifier — check it against `parseBrightScript` first (this is exactly the same
"verify against the real grammar, not intuition" discipline `compiler-architecture.md`'s `$$`-prefix
finding already documents for a different case).

## `taskManager.run(node)` never sets `functionName` — the DSL author must, every time

This compiler has zero Task-specific codegen (see `reactivity-theme-parsing.md`'s root-tag dispatch
section: `<component extends="Task">` is handled exactly like any other `extends` value) —
`taskManager.run(node)` only
throttles/starts/stops a node the author already built, never sets which sub actually runs on it.
Roku's own Task lifecycle only spawns whatever `node.functionName` names, so a hand-authored Task
needs `task.functionName = "<subName>"` set explicitly, by the caller, before `taskManager.run(...)`
— exactly once per instantiation site, not something a `field` default on the Task component itself
can cover (see `raw-brightscript-passthrough.md`'s general pattern for what's plain BrightScript
setup vs. DSL sugar). **Omitting it produces no error at all** — `control = "RUN"` still gets set,
the Task's `state` still transitions, but `doWork()` (or whatever the intended function was) never
actually runs, so any `Sleep(...)`/work inside it never happens and `result`/`error` fields never
get written. Confirmed live: `apps/task-manager-demo` shipped with this line missing at all 5
`CreateObject("roSGNode", "SlowTask")` call sites across 3 chapters — every burst "completed" in
single-digit milliseconds instead of the intended multi-second `Sleep()`, and `/on-result` couldn't
possibly have fired `onSuccess`/`onError` (see `findings/task-manager-demo-app.md`'s device-pass
writeup for the full diagnosis and fix). **A future compiler feature worth considering**: warn (or
auto-generate) when a `.thr`-declared `<component extends="Task">` is `CreateObject()`'d and
`taskManager.run(...)`'d without a preceding `functionName` assignment in the same function — this
class of bug is silent and was only caught by millisecond-precision live-device timing, not by any
compile-time check, unit test, or naive `queryAppUi` polling (ECP round-trip latency alone can't
distinguish "task genuinely finished fast" from "query just arrived late" — see the demo-app
findings entry for the actual disambiguation technique, a `roTimespan`-based in-app log).

## Counting is commit-time, not purely observer-time

The obvious literal reading of "increment when `state` becomes `"run"`, decrement when it leaves" is
followed only for the **decrement** side. The **increment** happens synchronously, the instant
`run()`/`drainQueue()` decides to actually start a node (`control = "RUN"`) — never by waiting for
the `ObserveFieldScoped("state", ...)` callback to confirm it. Two real-Roku facts force this:

- A Task's own `state` field notifications are delivered **across threads** (a Task runs on its own
  thread once `control = "RUN"`), never synchronously with the call that set `control`.
- BrightScript never delivers a queued field-change notification **in the middle of the
  currently-executing script call** — only between top-level invocations.

A purely observer-driven counter would let a tight loop of several `taskManager.run(...)` calls (the
realistic "create several tasks at once" case, exactly what the sample-app demo exercises) blow
straight past `maxConcurrent` before a single observer had fired — none of those calls' own
observers can possibly fire until the whole loop, and its enclosing handler, returns control to
SceneGraph's own message loop. `m.active` (the concurrency gate) is therefore mutated synchronously
at commit time; `m.top.runningCount` mirrors `m.active.Count()` — the count of tasks this manager
has **committed** to run, not a strict count of nodes independently confirmed to have reached
`state == "run"` (those two only ever differ for the brief window between `control = "RUN"` and the
Task's own thread actually starting, which nothing external can usefully observe anyway).

## Lookups are id-keyed, not node-reference-keyed — and why that needed a collision guard

`taskManager.run(node)` returns a task **id** (a string), not the node — `taskManager.cancel(taskId)`
only ever has that id to look the task back up by, so `m.active`/`m.queue` hold `{id, node}` pairs
searched by `.id`, never `IsSameNode()`. This is a deliberate deviation from every other node
registry in this codebase (`FlashTheaterFocusManager`'s registry, for instance, is looked up
exclusively by `IsSameNode()` — see `findings/focus-system.md`'s platform-facts section on why `=`
throws on `roSGNode`) — accepted here because an author-facing "cancel by id" API is a real design
requirement, not because node-identity comparison stopped being unsafe.

`resolveTaskId(node)` reuses `node.id` (every `roSGNode` already carries this native field) when
it's already non-empty — *unless* that exact string is already tracked under a **different** node, an
accidental collision between two distinct Task nodes an author happened to give the same explicit
`id`. That one check is the sole place this file still compares nodes via `IsSameNode()` — a fresh
id is minted instead of silently aliasing two unrelated tasks under one id. Worth knowing before
"simplifying" this away: without it, `cancel(taskId)` on a collided id could stop (or worse, look up
state for) the wrong task.

## No automatic cleanup when a tracked node's owning component is destroyed — fixed via ownership tracking in the manager itself, not call-argument dataflow analysis

Originally accepted as a permanent gap: unlike `focusable`/`bind:` (structural template attributes
`analysis/*` already walks, so `{#if:destroy}`/`{#each}` teardown codegen can automatically
`unregister()`/`UnobserveField` them), `taskManager.run(x)` is an opaque BrightScript function call
sitting inside a function body — nothing in this compiler's analysis layer tracks *which* node
references were ever passed to it, and teaching the compiler to notice would mean parsing/tracking
arbitrary call-argument dataflow, a much larger change than this feature's own "namespace call, not
new grammar" scope.

**The actual fix sidesteps that problem entirely** by not tracking call-argument dataflow at all —
instead, every `taskManager.run(node, priority)` call site (in an ordinary `.thr` component; see the
class-body carve-out below) is lowered with a THIRD argument, the calling component's own `m.top`
(`identifier-rewrite.ts`'s `buildTaskManagerActionReplacement`: `owner = accessRoot === 'm.global' ?
'm.top' : 'invalid'`). The compiler never needs to know *which* node argument was passed to `run(...)`
— it only needs to know *which component's own generated code* the call site lives in, which is
already trivially known at codegen time (it's the component currently being compiled). The runtime
manager (`FlashTheaterTaskManager.brs`) stores `owner` on every `{id, node, owner}` entry in
`m.active`/the three priority queues, and exposes `cancelOwnedBy(owner)` — snapshot every entry whose
`owner` `IsSameNode()`-matches the given owner, then `cancel(id)` each one via the EXISTING `cancel()`
sub (reusing its queued-removal/running-stop branching and `m.active` decrement bookkeeping, never
duplicating it). Every compiled component's own generated `ft_unmount()` gets exactly one new,
gated line — `taskManager.callFunc("cancelOwnedBy", m.top)` — emitted only when that component itself
has at least one `run(...)` call site (`compile.ts`'s `usesTaskManagerRunAnywhere`, narrower than
`usesTaskManagerAnywhere`: a component that only reads `runningCount` or subscribes via
`onAlertChanged` never registers anything under its own `m.top`, so it gets nothing extra). This is
the second real (not hypothetical) example of the `usesTimer`-shaped per-component boolean gate
`findings/component-unmount-hook.md`'s "How a feature opts in" section describes.

**Scope boundary, deliberate**: a `.flsh` class-body `run(...)` call passes `owner = invalid` instead
of a node — `ft_unmount` is a SceneGraph-node concept, and a class instance has no node of its own and
no destroy hook at all (the same boundary the four `onAlertChanged`/`onResult`/`onRequestSent`/
`onResponseReceived` hooks already draw against classes). `cancelOwnedBy`'s own `owner = invalid`
early-return, plus `matchingOwnerIds`'s `entry.owner <> invalid` guard before calling `IsSameNode()`,
mean an `invalid`-owned (class-started) task is simply never matched by any teardown cascade — the
app author still keeps the returned id and calls `taskManager.cancel(id)` itself for that case,
exactly as before this fix. See `issues/task-manager-no-auto-cancel-on-teardown.md` (now `Fixed`).

## Priority is three separate FIFO arrays, never a sort

`taskManager.run(node, priority)`'s three tiers (`m.queueHigh`/`m.queueNormal`/`m.queueLow`) are
plain, independent arrays — `enqueue` pushes onto exactly one of them, `dequeueNext`/`drainQueue`
always drain high before normal before low. No insertion-sort, no comparator, no re-sort on
`cancel()`. This was a deliberate choice over "one array with an embedded `priority` field, sorted
on read/write": three tiers make "arrival order preserved within a tier" free (plain `Push()`/
`Shift()`), whereas a single sorted array needs either a stable sort on every dequeue or careful
insertion-position logic to avoid reordering same-priority entries relative to each other. `cancel()`
and `resolveTaskId`'s collision guard (`trackedNodeById`) both had to widen from "check one array"
to "check all three, in the same fixed order" — `queueIndexOf(queue, taskId)` is a small shared
helper so that widening didn't triple the actual search logic.

**Re-prioritizing an already-queued task is deliberately unsupported** — `run()`'s idempotency check
(`isQueuedById`) returns the existing id without moving the entry between tiers even if called again
with a different `priority`. Moving a task between tiers on a repeat call was considered and
rejected: it would make `run()`'s priority argument mean two different things depending on whether
it's the first or a later call for the same node, a distinction easy to get wrong both to implement
and to reason about from the DSL side. First call's priority wins; call `cancel()` and re-`run()` if
a genuine change is needed.

## Alerting is hysteresis-gated by construction — `setQueuedCount`/`reevaluateAlertLevel` is the only path in

Every one of `queuedCount`'s three write sites (`enqueue`, `drainQueue`, `cancel`'s queued-removal
branch) goes through one shared `setQueuedCount(n)`, which both sets `m.top.queuedCount` and calls
`reevaluateAlertLevel()` — a single-entry-point design specifically so no future call site can
forget the alert re-check (confirmed by this file's own regression test: `runtime-assets.test.ts`
asserts `m.top.queuedCount = ` appears exactly once outside `init()`). `reevaluateAlertLevel()`
itself is the actual hysteresis: it recomputes the level from the current count and returns
immediately if unchanged, only writing `m.alertLevel`/`m.top.alertLevel` (the real SG field, which
is what an `ObserveFieldScoped` subscriber sees) on an actual transition. This is what makes the
whole alerting feature usable for a "notify a reporting/monitoring integration" use case — the user's
own stated requirement was explicitly to *not* spam an external alert channel, and hysteresis at the
source (never re-writing an unchanged value) is a simpler, more robust way to guarantee that than
asking every subscriber to de-duplicate on its own end.

`setAlertThresholds({warning, critical})` also calls `reevaluateAlertLevel()` immediately after
updating the thresholds — a queue that was already past the *old* warning threshold but under the
*new* one drops back to `"none"` the instant the new threshold is set, without waiting for the next
`queuedCount` mutation to notice. Skipping this re-check was considered (simpler: just apply the new
thresholds and let the next natural mutation catch up) and rejected as a real, easy-to-hit stale-state
window — an app could raise its warning threshold specifically to silence a false alarm, and a
re-check-less implementation would leave that exact alarm active until unrelated queue activity
happened to trigger a recompute.

## Confirmed live on a real device (Roku Ultra, via `apps/sample-app`'s `TaskDemoScreen`, `EcpClient`-driven keypress + `queryAppUi` — not just a compile-time check)

`taskManager.setMaxConcurrent(2)` + `taskManager.run(...)`'d five `SlowTask.thr` instances (each
`Sleep(3000)` in `doWork()`) behaved exactly as designed: `runningCount`/`queuedCount` held at
`2`/`3` for the first ~3.2s (the first two tasks' full sleep duration), then drained in waves as
slots freed (`2`/`1` once the first pair finished, `1`/`0` once the second pair finished), reaching
`0`/`0` once the fifth finished alone. `taskManager.cancel(...)` on the most-recently-queued task's
own returned id dropped `queuedCount` by exactly one, leaving `runningCount` untouched — confirming
the queued-removal branch never touches the running gate. One real navigation gotcha hit while
verifying this, worth remembering for any future live-device script: entering `TaskDemoScreen` via
`router.navigate(...)` from `Shell`'s sidebar does **not** move focus onto the screen's own
`default-focus` button — the vacuum rule (see `findings/router.md`) correctly leaves focus on the
still-alive `Shell` menu item that triggered the navigation, exactly like every other `Shell`-hosted
screen in this app. A `Right` keypress (crossing from the menu into the content pane) is required
before an ECP `Select` press actually reaches `startButton`'s `on:key[OK]` handler — mistaking "the
screen mounted" for "the screen's default action is now reachable" produced a misleading first
readout (`Running: 0 / Queued: 0`, because the `Select` press had re-triggered the menu's own
`showTaskDemo()` navigation instead of `startFive()`).

## `taskManager` cannot be gated the way `store`/`focus`/`router` implicitly are

Every other built-in global is auto-wired purely from `.thr`/`.flsh` DSL usage (`usesStore`/
`usesFocusSystem`/`usesRouter`, each an OR-fold of a per-component text scan). `usesTaskManager`
follows the exact same shape (`compile.ts`'s `usesTaskManagerAnywhere`, a mechanical mirror of
`usesRouterAnywhere` across the same four expression surfaces) — but this is only ever a **lower
bound** on real Task usage, since a hand-written `.brs` file (imported via `<script uri="...">`, or
code entirely outside this compiler's pipeline) can create and start a Task node directly, invisible
to any DSL-level scan. This is exactly why the default `maxConcurrent` (50) sits below RokuOS's real
hard limit (100) rather than at it — deliberate headroom for exactly this blind spot, not an
arbitrary safety margin. `taskManager.setMaxConcurrent(n)` exists specifically so an app that knows
it has significant untracked Task creation elsewhere can tighten the budget further.
