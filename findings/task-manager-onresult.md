# Task manager — `taskManager.onResult(<task>, onSuccess, [onError])`

Compile-time module responsibilities and runtime design rationale for
`taskManager.onResult(<task>, onSuccess, [onError])` — the DSL's promise-style sugar for consuming
a `request Http {}`-generated Task's own `result`/`error` fields. See `packages/compiler/GRAMMAR.md`'s
"Task manager" section for the grammar/API itself — this file is the *why*. For the manager's core
surface (`run`/`cancel`/`setMaxConcurrent`, priority queues, alerting hysteresis, namespace/gating
design), see [task-manager-core.md](task-manager-core.md). For the alerting callback
(`onAlertChanged`), see [task-manager-alerting.md](task-manager-alerting.md) — this feature reuses
and repeatedly contrasts against its design. For the sibling global HTTP request/response
interceptors (`onRequestSent`/`onResponseReceived`), see
[task-manager-request-interceptors.md](task-manager-request-interceptors.md) — that feature's own
plan was redesigned specifically to avoid the first bug documented below.

Backs the DSL's promise-style consumption of a `request Http {}`-generated Task's own `result`/
`error` fields (see `findings/requests-config.md` and GRAMMAR.md's "Task manager" section) — an
alternative to the old field-observer style (`task.observeFieldScoped("result"/"error", ...)`
called by the DSL author directly), not a replacement; both stay available.

## The first design, and why it silently never worked

The original plan registered the callback pair ON THE MANAGER, keyed by the task **id**
`taskManager.run(...)` returns: `taskManager.onResult(taskId, onSuccess, onError)` expanded to
`m.global.ft_taskManager.callFunc("registerResultCallback", { taskId: ..., onSuccess: ...,
onError: ... })`, packing all three args into one AA specifically to sidestep an unverified
assumption about whether `callFunc` supports more than 2 real positional arguments (`run`'s own
2-arg `callFunc("runTask", node, priority)` was already confirmed live; a 3rd was never tested).
This compiled cleanly, produced zero-diagnostic `.brs`, and — critically — was even confirmed
structurally correct via a `.flsh`-class compile test (`ft_globalAA.global.ft_taskManager
.callFunc("registerResultCallback", {...})`, since the callback lives on the manager, keyed by an
already-globally-unique task id, apparently needing no per-instance storage the way
`onAlertChanged` does). None of that caught the actual bug, because none of it exercises the
runtime.

**Live-verified 2026-08-12** (Roku Ultra, `RequestDemoScreen.thr`'s own onResult button): pressed
it, and the result/error labels never updated — stuck on "Not run yet" forever, no crash, no
console error. Added temporary `print` instrumentation to `registerResultCallback`/the trampoline
sub and found the actual cause immediately: `config.onSuccess`/`config.onError` arrived as
`invalid` inside `registerResultCallback`, even though the call site clearly passed real Function
values (`private_onPostsResultSuccess`/`private_onPostsResultError`). **A Function value placed
into an AA and handed across a `callFunc()` boundary to a DIFFERENT SceneGraph node arrives as
`invalid` on the other side** — SceneGraph field/argument marshaling across a `callFunc` call does
not carry raw BrightScript Function values, only real SG-field-typed values (a bare function
reference is not one). This is a genuinely new platform fact this repo hadn't needed before:
`onAlertChanged`'s own callback storage (`<callbacks>.Push(<callback>)`) never crosses a node
boundary at all — it's a same-thread, same-node `m`-scope operation — so it never exercised this
limit. `run`'s own proven 2-arg `callFunc("runTask", node, priority)` passes a NODE and a STRING,
neither a Function value, so it never exercised it either. **Lesson**: "produces valid, zero-
diagnostic `.brs`, structurally correct at every layer this repo's tests can see" is not the same
claim as "works" the moment a design crosses a real `callFunc`/node boundary with a value type
that has never been sent across one before — this is exactly the class of gap live-device
verification exists to catch, and did.

## The fix — registration expands entirely on the CALLING component's own script

`taskManager.onResult(<task>, onSuccess, [onError])` now takes the **task node itself** (the same
value already passed to `run(...)`), not its id, and never touches the manager or `callFunc` at
all for registration — `ObserveFieldScoped` is attached directly on `<task>`, from the SAME script
that already holds a live reference to it (mirrors the old field-observer style's own safety
envelope: everything stays within one component/thread, no cross-node Function-value marshaling
ever happens). `identifier-rewrite.ts`'s `buildTaskManagerOnResultReplacement` expands the whole
call into four colon-chained statements at the original call site (confirmed to parse cleanly via
`kopytko-brightscript-parser` before committing to the approach, given the recent burn):

```
ft_task = <task> : m["$$ft_taskManagerResultCallbacks"][ft_task.id] = {onSuccess: ..., onError: ...} : ft_task.ObserveFieldScoped("result", "on_taskManagerResult") : ft_task.ObserveFieldScoped("error", "on_taskManagerResultError")
```

`<task>` is hoisted into a fixed, reserved `ft_task` local first so it's only ever evaluated once
regardless of how many times its value is referenced in the expansion. The callbacks AA
(`taskManagerResultCallbacksFieldAccess()`) lives on the CALLING component's own `m` (initialized
once in `init()`, mirroring `onAlertChanged`'s array), keyed by task id — an AA, not an array,
since (unlike `onAlertChanged`'s "every subscriber gets every event") each registration is for a
DIFFERENT task and needs its own distinct callback pair, looked up by which node's field actually
fired via `event.GetRoSGNode().id`. Fire-once "settle" semantics are unchanged in spirit from the
original design: the trampoline deletes the pending entry and unobserves both fields BEFORE
invoking anything, and a node with no pending entry (already settled, or a task this component
never actually registered) is a silent no-op.

**Now excluded from `.flsh` class bodies** (`class/task-manager-on-result-not-supported`) — the
earlier "works from a class body" claim was true only of the broken manager-`callFunc` design (its
storage was keyed by task id, needing no per-instance identity, so none of `onAlertChanged`'s own
three blockers applied). The FIX reintroduces exactly `onAlertChanged`'s first blocker: whether
`ObserveFieldScoped`'s callback-scoping semantics even work when the call site is a class method
is still unverified, and the two trampoline sub names are fixed, top-level, non-class-qualified —
would collide the moment a second class needing them is imported into the same component. Excluded
until both are verified, matching `onAlertChanged`'s own stance exactly.

**Lesson for the next feature that needs a foreign-node callback registration**: a Function value
cannot cross a `callFunc()` call to a different node — if a callback genuinely must be invoked
FROM a different node than the one that registered it, either (a) keep the callback storage local
to the registering node and have IT attach the observer directly (this fix's approach — works
whenever the registering component already holds a live node reference, which `onResult` always
does), or (b) pass a STRING function name + a node reference (both real SG-field-typed values) and
dispatch via `callFunc` on that node instead of invoking a stored Function value — reintroducing
the exact bare-string-name gotcha this whole feature exists to avoid, so only worth it when (a)
genuinely isn't available.

## A second, distinct live-discovered bug, in the very same verification pass — `entry.onSuccess(args)` rebinds `m`

Fixing the `callFunc` bug above (registering locally instead) was not the end of it — the FIRST
version of the local-registration trampoline still crashed live, on a completely different fact:

```
'    if entry.onSuccess <> invalid then entry.onSuccess(event.GetData())
```

Crashed with `"Interface not a member of BrightScript Component" (runtime error &hf3)`, inside the
CALLED callback itself, the moment it touched `m` (e.g. `m.lastUserId.ToStr()`). The debugger's own
`m` at that point showed `roAssociativeArray ... count:2` — a tiny AA, not the calling component's
real `m` (which has dozens of fields). **Calling a Function value stored as an AA member via
dot-call syntax (`someAA.someKey(args)`) rebinds `m`, inside the called function, to `someAA`
itself** — not the function's own original closure `m` a plain LOCAL VARIABLE call preserves.
`cb = entry.onSuccess : cb(args)` behaves completely differently from `entry.onSuccess(args)`, even
though both look like "just call the function I stored" — only the local-variable form actually
preserves the callback's own identity/closure.

**`onAlertChanged`'s own trampoline never hit this**, and it's worth being precise about why:
`for each cb in <callbacks> : cb(level)` — `cb` is a loop variable (already a plain local by the
time it's called), never `<callbacks>[i](level)`. It was never tested whether the ARRAY-INDEX form
has the same rebinding problem (plausible, given the AA-MEMBER form does), but it was moot — nobody
had written `<callbacks>[i](level)` in that codepath. `onResult`'s own first draft wrote the AA
form directly, DID hit it, and that's what surfaced this as a real, general BrightScript fact
rather than something specific to arrays.

**Fix**: `emitTaskManagerResultTrampolines` now always extracts into a local before calling —
`cb = entry.onSuccess : if cb <> invalid then cb(event.GetData())` — never `entry.onSuccess(...)`
directly. **Lesson for every future feature that stores and later invokes a Function value from an
AA/array**: always extract to a local variable first, call the local — never call directly through
dot-access or bracket-index syntax, regardless of how natural that reads. Two independent,
live-only-discoverable bugs in one feature, back to back, both around "how a stored Function value
survives being invoked later, from somewhere else" — worth treating as a standing rule for this
codebase's own future callback-registration features, not just this one's own postmortem.
