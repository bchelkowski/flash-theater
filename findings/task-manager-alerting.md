# Task manager — alerting callback (`taskManager.onAlertChanged`)

Compile-time module responsibilities and runtime design rationale for
`taskManager.onAlertChanged(<callback>)`. See `packages/compiler/GRAMMAR.md`'s "Task manager"
section for the grammar/API itself — this file is the *why*. For the manager's core surface
(`run`/`cancel`/`setMaxConcurrent`, priority queues, alerting hysteresis, namespace/gating design),
see [task-manager-core.md](task-manager-core.md). For the request-flow callback sugar, see
[task-manager-onresult.md](task-manager-onresult.md) (`onResult`) and
[task-manager-request-interceptors.md](task-manager-request-interceptors.md)
(`onRequestSent`/`onResponseReceived`).

## `taskManager.onAlertChanged(<callback>)` — sugar over ONE per-component `ObserveFieldScoped`, `m`-scoped (not `GetGlobalAA()`), supporting N independent subscribers

The user's own original request specified storing the passed callback via `GetGlobalAA()`
(BrightScript's single, truly-global associative array, shared across every component's script
context and every Task's own thread) — implemented instead as a reserved `m`-scope bookkeeping
field (`naming.ts`'s `taskManagerAlertCallbacksFieldAccess()`, `m["$$ft_taskManagerAlertCallbacks"]`),
and this deviation is deliberate, not an oversight. `GetGlobalAA()` is **one single table shared by
the whole app** — a fixed key in it (however named) would let a second subscribing component, or a
second instance of the same component, silently overwrite the first subscriber's own stored
callback, so only the most-recently-registered subscriber's callback would ever actually run,
app-wide. `m`, by contrast, is already correctly scoped per-component-**instance** for free — it's
also the exact scope the generated trampoline sub (`on_taskManagerAlertChange`) already runs in when
SceneGraph invokes it via `ObserveFieldScoped`, so no extra plumbing was needed to make it work, only
to make it *safe against more than one subscriber*.

**A second, real bug — caught by a direct follow-up question, not by testing — in the first version
of this feature: a single overwritable slot plus per-call-site `ObserveFieldScoped` registration
silently broke a component that called `onAlertChanged(...)` more than once.** The very first
implementation stored ONE callback reference (not an array), and registered
`ObserveFieldScoped("alertLevel", "on_taskManagerAlertChange")` at every `onAlertChanged(...)` call
site (via a `withRouterFocusHandoff`-style print-time follow-up insertion). Two independent problems
stacked: (1) a second `onAlertChanged(cb2)` call **overwrote** the first callback's stored reference
— `cb1` was silently orphaned, never called again; (2) Roku registers each `ObserveFieldScoped` call
as an **independent observation**, even for the identical (node, field, funcName) triple — so two
calls meant the trampoline sub fired **twice** per real alert change, both times invoking whatever
callback happened to still be in the single slot (`cb2`, twice). Two completely legitimate,
independent subscribers in one component would have silently degraded to "the second one's callback,
called redundantly" — a real correctness bug that no test happened to exercise (every test, and the
sample-app demo, only ever called `onAlertChanged` once).

**Fix — mirrors exactly how `store`/`theme`'s own field observers already register, in `init()`, not
per call site.** `emitInitFunction`'s existing store/theme `ObserveFieldScoped` registration loop
already established the right pattern; `taskManager.onAlertChanged` just hadn't followed it the
first time around. Now:
- `emitInitFunction` (gated on `compile.ts`'s `usesTaskManagerAlertCallback` — true iff this
  component calls `onAlertChanged(...)` **anywhere**, regardless of how many times) initializes
  `m["$$ft_taskManagerAlertCallbacks"] = []` and registers `ObserveFieldScoped("alertLevel",
  "on_taskManagerAlertChange")` **exactly once**, unconditionally, before any user code (including
  `setup()`) ever runs.
- Each `onAlertChanged(callback)` call site (`identifier-rewrite.ts`'s
  `buildTaskManagerOnAlertChangedReplacement`) now expands to a single, self-contained
  `<callbacks>.Push(<callback>)` — no follow-up line needed anymore, so the whole
  `withRouterFocusHandoff`-style print-time-insertion machinery this feature originally borrowed
  (`withTaskManagerAlertSubscription`) was removed entirely, along with the "must be a statement of
  its own" restriction it existed to support. The only remaining restriction
  (`checkTaskManagerOnAlertChangedNotInReactiveExpression`, `expression/task-manager-on-alert-
  changed-in-reactive-expression`) is a genuinely different, semantic one: `onAlertChanged(...)` still
  can't be called from a `derived`/template-binding expression, since those recompute repeatedly and
  would resubscribe (grow the array) on every recompute — but it's no longer restricted to sitting on
  its own line; it can be embedded in a larger statement-mode expression (e.g. an assignment RHS)
  without issue, since there's no second line to lose room for anymore.
- The trampoline sub (`emitTaskManagerAlertTrampoline`) iterates the whole array
  (`for each cb in <callbacks> ... cb(level) ... end for`), so every registered subscriber runs on
  every real change, and exactly once — no double-firing, no orphaned callbacks, regardless of how
  many `onAlertChanged(...)` calls the component has.

**`m`-scoped storage is only meaningful for a `.thr` component's own `taskManager.onAlertChanged(...)`
call — `onAlertChanged` specifically stays unreachable from a `.flsh` class body, even though every
other `theme`/`router`/`taskManager` action/read now works there.** A separate follow-up review
raised exactly the scenario the `GetGlobalAA()`-vs-`m` choice above needs to survive: what if
`onAlertChanged` (or any `taskManager.*`/`router.*`/`theme.*` access) is called from inside a class
METHOD, where `m` is BrightScript-auto-bound to the class instance's own plain AA, never any
SceneGraph node? Confirmed live (compiling a synthetic `.flsh` fixture) that this used to silently
miscompile for `router`/`taskManager` — see `findings/class-pipeline-global-singleton-access.md`'s `GetGlobalAA()`
entry for the full writeup. That entry's fix made `theme.*`/`router.*`/`taskManager.run/cancel/
setMaxConcurrent/setAlertThresholds`/data-reads all work correctly from a class body, rooted at
`GetGlobalAA().global` (confirmed live to alias the same content node `m.global` points at) instead
of `m`. `onAlertChanged` is the ONE exception, kept excluded (`class/task-manager-on-alert-changed-
not-supported`) for three reasons, none safe to resolve by guessing:
1. Whether `ObserveFieldScoped`'s scoping even works when the call site is a class method at all
   (unverified).
2. `ObserveFieldScoped`'s second argument must name a real *top-level* `sub`/`function` — never an
   AA-member method the way every other class method is. A class-side trampoline would need its own
   top-level declaration in the class's own `.brs` file, and — unlike `function ClassName(...)`
   (already unique per file, enforced by the file-name-must-match-class-name rule) — a fixed generic
   name mirroring `.thr`'s own `on_taskManagerAlertChange` would collide the instant a SECOND class
   needing the same trampoline is imported into the same component (every `.brs` a component pulls
   in via `<script>` shares one combined top-level scope — confirmed via a real multi-class-import
   fixture, `apps/sample-app/src/components/FavoriteCounter`). This is the exact scenario the "class
   method/constructor naming — not a real bug" audit elsewhere in this file does NOT cover: that
   audit holds only because methods are AA members and `private_constructor` is a local var, i.e.
   no class emits a top-level declaration today at all. `onAlertChanged` would be the first thing to
   need one, and it would need to be class-name-qualified to stay safe.
3. Even with (1) and (2) solved, `GetGlobalAA()` being one table shared by the whole app means a
   callbacks array stored there would need a genuinely unique key per subscribing class instance,
   and a class instance has no stable identity or destroy hook to safely provide one (an owning
   component could be destroyed while nothing ever unregisters the subscription — a permanent leak).

`m` remains the right, and now the ONLY, choice for the *legal* case (a `.thr` component's own
function body), where it's already correctly instance-scoped.

**A third, real, pre-existing bug surfaced (and fixed) while wiring the very first version of this
feature — not new to it, already reproducible via plain `router.navigate(getPath())`.** See
`findings/compiler-identifier-resolution.md`'s "A bare/called private-function reference surviving a second
identifier-rewrite pass" entry for the full writeup — the short version: any replacement text built
by pre-rewriting a call's own arguments (via a nested `rewriteExpression` call) and then splicing
the result into a larger composed replacement is vulnerable to being **re-scanned** by the outer
`applyIdentifierRewrite` pass, and a private function's rewritten form (`private_<name>`, a bare
top-level identifier, unlike a field/derived/state's always-`m.`-prefixed form) doesn't survive that
re-scan. `taskManager.onAlertChanged(myPrivateHandler)` was the first code path in this repo to
actually exercise "a bare, uncalled private-function reference passed as an argument" — which is
what surfaced it — but the fix (`scope-resolution.ts`'s `resolveDsl` recognizing an already-rewritten
`private_<name>` as itself already-resolved) is general, not task-manager-specific, and also fixes
the pre-existing `router.navigate(<a call to a private function>)` case.

**Lesson across all three bugs**: every one of them was found by a direct, specific follow-up
question ("what if it's called from a class?", "are the generated function names unique — what
happens with several observers?") rather than by the original test suite, even though the test
suite was reasonably thorough for the *single-subscriber, `.thr`-component-only* case. Worth
remembering for the next feature in this shape: a callback-registration mechanism's test coverage
should specifically include (a) calling it more than once in the same scope, and (b) calling it from
every context the language allows a function body to exist in, not just the one the demo happens to
exercise.
