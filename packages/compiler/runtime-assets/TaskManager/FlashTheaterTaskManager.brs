' flash-theater:runtime — hand-authored, not generated from a .thr file. Auto-copied by the CLI
' into an app's output whenever any component uses taskManager.* (see cli.ts). Do not edit
' per-app; change this file in packages/compiler/runtime-assets/TaskManager instead.
'
' Global Task-node concurrency manager — throttles how many roSGNode Task children run at once
' across the whole app, queueing any run() call issued once the limit is reached, and
' auto-starting the next queued node whenever a running one's own `state` field leaves "run". The
' DSL author owns construction: taskManager never CreateObject()'s a Task itself, only throttles
' and starts/stops one the author already built. See GRAMMAR.md's "Task manager" section and
' findings/task-manager-core.md/findings/task-manager-alerting.md/findings/task-manager-request-callbacks.md
' for the full design rationale.
'
' `m.active`/`m.queueHigh`/`m.queueNormal`/`m.queueLow` hold `{id, node}` pairs, keyed by a task id
' — never by node reference. Every external caller (this component's own `<interface>`, i.e. the
' DSL's `taskManager.*` surface) only ever deals in that id string, returned by runTask() and passed
' back into cancel(). The one place a raw node reference is still compared via IsSameNode() is
' resolveTaskId()'s own collision guard.
'
' `m.active` is the concurrency GATE — a task is added to it synchronously, at commit time (the
' moment this manager decides to actually set control = "RUN"), never only once the observer
' confirms state == "run". This is deliberate, not an oversight: SceneGraph delivers a Task's own
' state-change notifications ACROSS THREADS (a Task runs on its own thread once control = "RUN"),
' so they are never delivered synchronously, and — just as importantly — BrightScript never
' delivers ANY queued field-change notification in the middle of the currently-executing script
' call, only between top-level invocations. A caller that calls runTask() on several nodes
' back-to-back in one loop would see every single call observe the SAME stale count if the gate
' depended on the observer having already fired — none of those calls' own observers can possibly
' fire until the whole loop (and its enclosing handler) returns control to SceneGraph's own message
' loop. A synchronously-updated gate is therefore not an optimization, it is the only way this
' feature actually throttles anything for the realistic "create several tasks at once" case.
'
' `m.top.runningCount` mirrors `m.active.Count()` for exactly this reason too — it is the count of
' tasks this manager has COMMITTED to run, not a strict count of nodes independently confirmed to
' have reached state == "run" (those two would only ever differ for the brief window between
' control = "RUN" and the Task's own thread actually starting, which nothing external can usefully
' observe anyway).
'
' PRIORITY: three separate FIFO arrays (m.queueHigh/m.queueNormal/m.queueLow), not one array with an
' embedded priority field sorted on insert/removal — dequeuing (drainQueue/dequeueNext) always drains
' high before normal before low, and within one tier, arrival order is preserved for free by ordinary
' Push()/Shift(). No sort ever runs.
'
' ALERTING: `m.top.alertLevel` ("none"/"warning"/"critical") is a real SG field, hysteresis-gated —
' it's only ever WRITTEN when the computed level actually changes (setQueuedCount/
' reevaluateAlertLevel), never on every queue mutation, so a subscriber (see onTaskStateChange... no,
' see setup()'s own on_taskManagerAlertChange convention in an app's generated component code) is
' only notified on real threshold crossings, not spammed on every queue-depth change. This is the
' one field in this component meant to be observed directly by app code — see taskManager.
' onAlertChanged(...) in GRAMMAR.md, which generates exactly that ObserveFieldScoped registration.
'
' REQUEST/RESPONSE INTERCEPTORS: `m.top.lastRequestSent`/`m.top.lastResponseReceived` are two more
' fields meant to be observed directly — but UNLIKE `alertLevel`, never hysteresis-gated, since
' every single request/response is meant to be reported (a reporting hook that silently drops a
' second identical-looking request would defeat the point). Both are written exactly once per
' `request Http {}`-generated task — `lastRequestSent` synchronously, from startNode() itself (see
' its own doc comment for why NOT runTask()); `lastResponseReceived` from the new
' on_ft_taskManagerRawResponse() trampoline below, itself attached (also from startNode()) directly
' onto each request task's own `rawResponse` field. Registration deliberately never puts a Function
' value on THIS node's own `m` — see findings/task-manager-request-callbacks.md's `taskManager.onResult` postmortem
' for why that's unsafe across a `callFunc` boundary. Each `taskManager.onRequestSent(cb)`/
' `onResponseReceived(cb)` call instead expands entirely on the REGISTERING component's own script,
' exactly like `onAlertChanged` — that component stores `cb` in its own `m` and attaches its own
' `ObserveFieldScoped` directly onto these two fields, so this manager itself never needs to touch,
' store, or invoke a callback belonging to another node at all.

sub init()
  m.active = []       ' array of { id: string, node: object }
  m.queueHigh = []    ' array of { id: string, node: object }
  m.queueNormal = []  ' array of { id: string, node: object }
  m.queueLow = []     ' array of { id: string, node: object }
  m.maxConcurrent = 50
  m.nextId = 0
  m.warningThreshold = 30
  m.criticalThreshold = 50
  m.alertLevel = "none"
  m.top.runningCount = 0
  m.top.queuedCount = 0
  m.top.alertLevel = "none"
end sub

' Registers `node` to run at the given `priority` ("high"/"normal"/"low" — any other value,
' including omission at the DSL call site, is treated as "normal" by the generated call site itself,
' not here) and returns its task id (assigning one onto node.id first if it doesn't already have
' one — see resolveTaskId). The DSL author has already CreateObject()'d it and set any of its own
' Task input fields; this function's only job is throttling + starting it + naming it. Idempotent by
' id: calling runTask() again with a node whose id is already tracked (active OR queued, at ANY
' priority) just returns that same id without re-queueing/re-starting it — even if called again with
' a different priority than its first registration (first call wins; re-prioritizing an
' already-queued task is not supported).
'
' Named `runTask`, not `run` — BrightScript's own `Run` statement (running another compiled file at
' runtime) is a reserved word, so a function literally named `run` fails to parse. The DSL-facing
' spelling stays `taskManager.run(node, [priority])`; only this runtime function name and the string
' passed to `callFunc(...)` differ — see `analysis/global-bindings.ts`'s
' `TASK_MANAGER_RUNTIME_METHOD_NAMES`.
function runTask(node as object, priority as string) as string
  if node = invalid then return ""

  taskId = resolveTaskId(node)
  if indexOfActiveById(taskId) >= 0 then return taskId
  if isQueuedById(taskId) then return taskId

  if m.active.Count() < m.maxConcurrent then
    startNode(taskId, node)
  else
    enqueue(taskId, node, priority)
  end if

  return taskId
end function

' Pushes onto the tier matching `priority`, defaulting to the normal tier for anything that isn't
' exactly "high" or "low" — a typo'd or unexpected priority value degrades to ordinary FIFO
' scheduling rather than being silently dropped or erroring.
sub enqueue(taskId as string, node as object, priority as string)
  entry = { id: taskId, node: node }
  if priority = "high" then
    m.queueHigh.Push(entry)
  else if priority = "low" then
    m.queueLow.Push(entry)
  else
    m.queueNormal.Push(entry)
  end if
  setQueuedCount(totalQueuedCount())
end sub

function totalQueuedCount() as integer
  return m.queueHigh.Count() + m.queueNormal.Count() + m.queueLow.Count()
end function

' Removes and returns the next task to run — high tier first, then normal, then low; FIFO within
' whichever tier is chosen. Returns invalid when every tier is empty.
function dequeueNext() as object
  if m.queueHigh.Count() > 0 then return m.queueHigh.Shift()
  if m.queueNormal.Count() > 0 then return m.queueNormal.Shift()
  if m.queueLow.Count() > 0 then return m.queueLow.Shift()
  return invalid
end function

function isQueuedById(taskId as string) as boolean
  return queueIndexOf(m.queueHigh, taskId) >= 0 or queueIndexOf(m.queueNormal, taskId) >= 0 or queueIndexOf(m.queueLow, taskId) >= 0
end function

function queueIndexOf(queue as object, taskId as string) as integer
  for i = 0 to queue.Count() - 1
    if queue[i].id = taskId then return i
  end for
  return -1
end function

' Reuses node.id if it's already a non-empty string the manager doesn't already know about under a
' DIFFERENT node (an accidental collision between two distinct Task nodes an author happened to
' give the same explicit id) — otherwise mints and assigns a fresh one. This is the only place a raw
' node reference is ever compared via IsSameNode() in this file; every other lookup is id-keyed.
function resolveTaskId(node as object) as string
  candidate = node.id
  if candidate <> invalid and candidate <> "" then
    existingNode = trackedNodeById(candidate)
    if existingNode = invalid or existingNode.IsSameNode(node) then return candidate
  end if

  m.nextId = m.nextId + 1
  generatedId = "ft_task_" + m.nextId.ToStr()
  node.id = generatedId
  return generatedId
end function

function trackedNodeById(taskId as string) as object
  idx = indexOfActiveById(taskId)
  if idx >= 0 then return m.active[idx].node
  idx = queueIndexOf(m.queueHigh, taskId)
  if idx >= 0 then return m.queueHigh[idx].node
  idx = queueIndexOf(m.queueNormal, taskId)
  if idx >= 0 then return m.queueNormal[idx].node
  idx = queueIndexOf(m.queueLow, taskId)
  if idx >= 0 then return m.queueLow[idx].node
  return invalid
end function

' The one and only place control is ever set to "RUN". Attaches the state observer BEFORE flipping
' control — a Task's own thread can begin executing (and its `state` field can already be
' mid-transition) the instant control is set, so attaching first is the only way to guarantee the
' eventual "left running" notification is never missed, no matter how quickly the task's own thread
' gets there. Always ObserveFieldScoped, never the unscoped form.
'
' Also the commit point for the two global request/response interceptor hooks
' (taskManager.onRequestSent/onResponseReceived, see GRAMMAR.md's "Task manager" section) — NOT
' runTask(), which only gets here conditionally (a saturated concurrency budget instead enqueues
' and calls startNode() later, from drainQueue(), once a slot frees). Firing here means a queued
' request still fires onRequestSent exactly once, at the moment it actually starts, not at the
' moment run() was originally called.
'
' Gated on `node.ft_isRequestComponent` (a boolean field only `request Http {}`-generated
' components declare — reading an undeclared field on a real roSGNode safely returns `invalid`,
' the same fact resolveTaskId()'s own collision guard already relies on) rather than doing this
' unconditionally for every task: an ordinary hand-written Task (SlowTask.thr, etc.) has no
' `resolvedOptions`/`rawResponse` fields at all, and this avoids ever needing to find out whether
' ObserveFieldScoped on a field that doesn't exist on the target node is a safe no-op.
sub startNode(taskId as string, node as object)
  node.ObserveFieldScoped("state", "onTaskStateChange")

  if node.ft_isRequestComponent = true then
    m.top.lastRequestSent = node.resolvedOptions
    node.ObserveFieldScoped("rawResponse", "on_ft_taskManagerRawResponse")
  end if

  m.active.Push({ id: taskId, node: node })
  m.top.runningCount = m.active.Count()
  node.control = "RUN"
end sub

' Fires once per `request Http {}`-generated task, the moment its generated ft_runRequest() (see
' request-emitter.ts) writes its own `rawResponse` field — a consistent, RAW ft_httpFetch response
' shape (isSuccess/httpStatusCode/data/headers/rawBody/fromCache, plus parseSucceeded/
' parseErrorMessage — see request-emitter.ts's own doc comment), deliberately NOT the app-author's
' own parseResponse/parseError-transformed `result`/`error` fields (those vary per component, wrong
' for a generic reporting hook). Runs in THIS manager's own render-thread context (a plain Node,
' never a Task) since it's this manager, not the calling component, that attached the observer —
' unobserves itself first (fire-once "settle" semantics, mirrors the onResult trampolines' own
' unobserve-before-invoke discipline), then flips `lastResponseReceived` — the one field every
' onResponseReceived(...) subscriber (in ANY component, registered via its own local
' ObserveFieldScoped in its own init()) actually observes.
sub on_ft_taskManagerRawResponse(event as object)
  node = event.GetRoSGNode()
  node.UnobserveFieldScoped("rawResponse")
  m.top.lastResponseReceived = event.GetData()
end sub

' Fires on every change to a tracked node's own `state` field. `state == "run"` needs no action here
' — the task was already counted as active at commit time (startNode() above); this callback's
' entire job is detecting the OPPOSITE transition — state leaving "run" (to "stop" or "done", the
' only two terminal values a real Task ever reaches) — the one transition nothing synchronous can
' know about in advance.
sub onTaskStateChange(event as object)
  node = event.GetRoSGNode()
  newState = event.GetData()

  if newState = "run" then return

  releaseSlotById(node.id)
end sub

' Frees a task's slot, stops watching it, and gives the freed slot to the next queued task (if any).
' The SINGLE place m.active is ever shrunk — reached both from a naturally finished/stopped task
' (onTaskStateChange, above) and from cancel()'s running-task branch (below), so decrement/drain
' logic exists in exactly one place, never duplicated.
sub releaseSlotById(taskId as string)
  idx = indexOfActiveById(taskId)
  if idx = -1 then return
  entry = m.active[idx]
  entry.node.UnobserveFieldScoped("state")
  m.active.Delete(idx)
  m.top.runningCount = m.active.Count()
  drainQueue()
end sub

' Starts as many queued tasks as there is room for, highest priority first — called after any slot
' frees (releaseSlotById) and after raising the concurrent limit (setMaxConcurrent), since either
' can free up room immediately.
sub drainQueue()
  while m.active.Count() < m.maxConcurrent
    entry = dequeueNext()
    if entry = invalid then return
    setQueuedCount(totalQueuedCount())
    startNode(entry.id, entry.node)
  end while
end sub

' Cancels the task identified by `taskId` (the id runTask() returned) — whichever of the two tracked
' states it's currently in:
'   - still queued (never started, any priority tier): removed directly from the queue, no observer
'     involvement at all (nothing was ever attached to it).
'   - already running: sets control = "STOP" and does nothing else — the resulting state change (to
'     "stop") is picked up by onTaskStateChange -> releaseSlotById exactly like a naturally finished
'     task, so the decrement/queue-drain logic exists in exactly one place, never duplicated here.
' An unknown, already-finished, or already-cancelled id is a no-op.
sub cancel(taskId as string)
  if removeFromQueueById(taskId) then
    setQueuedCount(totalQueuedCount())
    return
  end if

  activeIdx = indexOfActiveById(taskId)
  if activeIdx = -1 then return
  m.active[activeIdx].node.control = "STOP"
end sub

function removeFromQueueById(taskId as string) as boolean
  idx = queueIndexOf(m.queueHigh, taskId)
  if idx >= 0 then
    m.queueHigh.Delete(idx)
    return true
  end if
  idx = queueIndexOf(m.queueNormal, taskId)
  if idx >= 0 then
    m.queueNormal.Delete(idx)
    return true
  end if
  idx = queueIndexOf(m.queueLow, taskId)
  if idx >= 0 then
    m.queueLow.Delete(idx)
    return true
  end if
  return false
end function

' Updates the concurrent-task budget in either direction. Raising it immediately drains the queue —
' any already-queued task was waiting ONLY because of the old, lower limit, so leaving it queued
' until some unrelated task happens to finish would make the new, higher limit silently do nothing
' until then. Lowering it never forcibly stops an already-running task (this manager only ever
' throttles NEW starts, never reaches into work already in flight) — future runTask()/drainQueue()
' calls simply respect the new, tighter ceiling from here on.
sub setMaxConcurrent(n as integer)
  m.maxConcurrent = n
  drainQueue()
end sub

' Sets `m.top.queuedCount` and re-evaluates the alert level against it — the ONE place queuedCount
' is ever written (enqueue/drainQueue/cancel's queued branch all funnel through this), so the
' hysteresis check in reevaluateAlertLevel() never gets skipped by a call site that forgot it.
sub setQueuedCount(n as integer)
  m.top.queuedCount = n
  reevaluateAlertLevel()
end sub

' Recomputes the alert level from the CURRENT queuedCount and thresholds, and writes m.alertLevel/
' m.top.alertLevel ONLY if it actually changed — this is the hysteresis: a subscriber observing
' alertLevel (see taskManager.onAlertChanged(...) in GRAMMAR.md) is notified exactly once per real
' threshold crossing, in either direction, never once per queue mutation. Called both from
' setQueuedCount (the queue itself changed) and setAlertThresholds (the thresholds changed under a
' queue depth that may now classify differently).
sub reevaluateAlertLevel()
  newLevel = computeAlertLevel(m.top.queuedCount)
  if newLevel = m.alertLevel then return
  m.alertLevel = newLevel
  m.top.alertLevel = newLevel
end sub

function computeAlertLevel(queued as integer) as string
  if queued >= m.criticalThreshold then return "critical"
  if queued >= m.warningThreshold then return "warning"
  return "none"
end function

' Reconfigures the warning/critical queue-depth thresholds (`config` = `{warning: <n>, critical:
' <n>}`) and immediately re-evaluates the current alert level against them — a queue that was
' already, say, 35 deep and classified "warning" under the default thresholds becomes "none" the
' instant a caller raises the warning threshold above 35, without waiting for the next queue
' mutation to notice.
sub setAlertThresholds(config as object)
  m.warningThreshold = config.warning
  m.criticalThreshold = config.critical
  reevaluateAlertLevel()
end sub

function indexOfActiveById(taskId as string) as integer
  for i = 0 to m.active.Count() - 1
    if m.active[i].id = taskId then return i
  end for
  return -1
end function

' `taskManager.onResult(<task>, <onSuccess>, [<onError>])` (see GRAMMAR.md's "Task manager"
' section) is deliberately NOT implemented here — confirmed live that registering the callback
' pair on this manager (via callFunc, keyed by task id) cannot work at all: a Function value placed
' in a callFunc AA argument arrives as `invalid` on the other side of a cross-node callFunc call.
' The DSL-level sugar instead expands entirely on the CALLING component's own script — see
' `identifier-rewrite.ts`'s `buildTaskManagerOnResultReplacement` and `codegen/naming.ts`'s
' `taskManagerResultCallbacksFieldAccess`/`TASK_MANAGER_RESULT_TRAMPOLINE_SUB_NAME` — this
' singleton's only role in that feature is the `run()`/`cancel()` throttling it already does.
