# Streams (`stream`, `ft_createStream()`)

Compile-time module responsibilities and runtime design rationale for the `stream` primitive. See
`packages/compiler/GRAMMAR.md`'s "`stream`" section for the grammar/semantics themselves — this
file is the *why*. Architecturally distinct from everything in `reactivity-state.md`: `store`/
`theme`/`read`/`watch`/`state` are ALL `ObserveFieldScoped`-based (a real SceneGraph field
observer); a stream has none of that machinery.

## Why a plain AA, not a Node — the same wall `taskManager.onAlertChanged` hits, sidestepped entirely

A `.flsh` class instance is a plain BrightScript associative array with no SceneGraph identity at
all (`codegen/class-emitter.ts`'s own doc comment: "no template, no XML `<interface>`, nothing
SceneGraph-shaped about it at all"). `taskManager.onAlertChanged(...)` is excluded from class
bodies (`class/task-manager-on-alert-changed-not-supported`, see `task-manager-alerting.md`) specifically
because `ObserveFieldScoped` needs a real node and a real top-level trampoline sub name — neither
exists for a class instance. Streams don't try to solve that problem; they avoid it by construction.
`ft_createStream()` (`runtime-assets/Stream/FlashTheaterStream.brs`) is a plain associative array
with function-valued members (`.emit`/`.subscribe`), the exact same "prototype object" idiom
`class-emitter.ts` already generates for a class instance — `m` auto-binds correctly whether the
stream object is called as `someStream.emit(x)` from a `.thr` component's script or from a class
method, since it's ordinary BrightScript closure-as-method semantics, not a SceneGraph mechanism at
all. This is why a `stream` field needs **zero** class-support carve-out, unlike `onAlertChanged`.

## BehaviorSubject replay is synchronous, inside `.subscribe` itself, before it returns

`.subscribe(callback)` checks `m.hasValue` and calls `callback(m.value)` **before** pushing
`callback` onto `m.subscribers` — a subscriber that arrives after at least one `.emit()` sees the
current value immediately, with no separate "read the current value" API needed. This was a
deliberate user choice (confirmed over the alternative "pure pipe, no memory" design) — the
tradeoff is that `.subscribe(...)` is no longer side-effect-free at call time; calling it from
somewhere that runs more than once (a `derived` expression, a template binding) would replay AND
grow the subscriber list on every recompute. That risk is exactly what
`expression/stream-call-in-reactive-expression` exists to close off — see next entry.

## Dependency-graph exclusion is structural (a disjoint `Set`), not a runtime guard

`analysis/scope-resolution.ts`'s `ScriptBindings.streamNames` is a genuinely separate set from
`reactiveSourceNames`/`derivedNames`/`watchNames` — `analysis/dependency-graph.ts` needed **zero**
code changes to exclude streams from the `derived`/`watch` cascade graph, because it only ever reads
those three sets and `streamNames` was never merged into any of them. This is more robust than a
special-case check would have been: there's no `if (name is a stream) skip` branch anywhere in
`dependency-graph.ts` that a future refactor could accidentally delete. Verified by a direct test
(`test/analysis/dependency-graph.test.ts`) proving `derived x: T = someStream.value` produces no
entry in `directDependencies`/`dependentsOfSource` for `someStream` at all — reading `.value` there
is a plain snapshot, structurally identical to reading any other object's member field.

## `expression/stream-call-in-reactive-expression` is a plain text scan, not a structural AST check — and deliberately narrower than `resolveIdentifier`

Unlike `taskManager`/`router`/`theme` (global-singleton dot-chains, structurally recognized by
`findGlobalPathAccesses` against a fixed `GLOBAL_ROOT_NAMES` list), a stream is an ordinary
per-component `m.<name>` binding — nothing distinguishes `someStream.subscribe(...)` from any other
member-call syntactically until you already know `someStream` is a declared stream name.
`analysis/expression-region.ts`'s `checkNoStreamCallsInReactiveExpression` is therefore a regex scan
(`\b<name>\s*\.\s*(subscribe|emit)\s*\(`) against `bindings.streamNames`, called explicitly from the
two genuinely reactive-recompute sites: `dependency-graph.ts`'s `derived` expression loop, and
`template-bindings.ts`'s `sourcesReferencedByExpression` (every dynamic attribute + `{#each}`
collection/body expression). **Deliberately NOT wired into `identifier-rewrite.ts`'s
`rewriteExpression`** — that function is also used for a plain function-body `if` condition, which
only evaluates when that code path actually runs, not on every dependency change, so a stream call
there is legitimate and must stay allowed. Mirrors `checkTaskManagerOnAlertChangedNotInReactiveExpression`'s
own reasoning (`identifier-rewrite.ts`) but is a separate, smaller mechanism — piggybacking on the
global-path scanner wasn't possible since streams aren't global-singleton dot-chains at all.

## No unsubscribe in v1 — same acceptance as `taskManager.onAlertChanged`, same caveat

`ft_createStream()`'s `.subscribers` array has no `.unsubscribe`/removal API, mirroring
`onAlertChanged`'s own "no unsubscribe" precedent (`task-manager.md`). A stream's subscriber list
lives on `m.<name>`/the owning prototype's own member, so it's garbage-collected together with
whatever owns it — bounded by that instance's lifetime, not literally unbounded. The caveat is the
same one `task-manager.md` already documents for its own callback array: a long-lived instance that
accumulates many transient subscribers over its own lifetime still leaks memory *within* that
lifetime, since nothing prunes a dead callback out of `.subscribers` before the owner itself is
collected.

## Two declaration sites, one runtime shape, near-zero shared codegen risk

`stream <name>: <Type>` (script-level, `flash-parser/src/script-parser.ts`'s
`parseStreamDeclaration`) and `[visibility] stream <name>: <Type>` (class-level,
`class-parser.ts`'s `parseClassStreamFieldDeclaration`) are two separate grammar productions
producing two separate `SyntaxKind`s (`StreamDeclaration`/`ClassStreamFieldDeclaration`) and two
separate `ThrScriptAst`/`ThrClassAst` arrays (`streams`/`streamFields`) — deliberately **not**
unified into one AST shape, mirroring how `ClassFieldDecl` stays separate from `FieldDecl` despite
looking similar. Both compile to the identical `m.<name>`/`prototype.<name> = ft_createStream()`
line, just at different init sites (`brs-emitter.ts`'s `emitInitFunction` for script-level,
`class-emitter.ts`'s `compileClass` field-emission loop for class-level) — the duplication is two
one-line codegen sites, not two parallel pipelines, so the risk of them drifting apart is low.
`class-shape.ts` needed exactly one added loop (stream fields register into `ownMembers` with
`kind: 'field'`, identical to an ordinary field) — no new `ClassMemberInfo` kind, since a stream
field resolves for `m.<name>`/`self.<name>` purposes exactly like any other field.

## A class-declared stream field is reachable from whoever holds the instance — verified, not assumed

`public stream onChanged: string` compiles to a plain `prototype.onChanged` member (the existing
public-visibility path in `memberName()`, no new codegen) — so `someInstance.onChanged.subscribe(...)`
from the *owning* `.thr` component's own script works with **zero** new mechanism: `someInstance` is
an ordinary local variable, never registered in `scope-resolution.ts`'s bindings, so
`identifier-rewrite.ts` never touches that dot-chain at all; it passes through as plain BrightScript,
identical to reading any other public field off a class instance. Confirmed live via
`apps/sample-app`'s `StreamDemo.thr`, which exercises both directions in the same file:
`m.publisher.onChanged.subscribe(...)` from the component's own `setup()` (component → class), and
`Subscriber.subscribeTo(publisher)` subscribing entirely from within `Subscriber`'s own method
(class → class), never surfacing the value to the component at all.

## A stored Function value's `m` binding does not survive detachment from a real SceneGraph node — confirmed live, three ways, all failing identically

**The actual, hard-won finding, superseding an earlier, INCORRECT hypothesis in this file** (which
claimed "define the callback in a method, not the constructor, and `m` capture works correctly" —
live-device testing proved this insufficient; a method-defined callback fails exactly like a
constructor-defined one). The real constraint: a Function value's own `m` binding reliably survives
storage-then-later-invocation ONLY when the `m` it closed over is a real, persistent SceneGraph node
(a `.thr` component instance). It does **not** survive for a plain associative-array "prototype
object" instance (a `.flsh` class has no SceneGraph identity at all) — confirmed on a real Roku
device with three independent, increasingly-careful attempts, each instrumented with `print`
statements to inspect `m` at both definition time and invocation time:

1. **Inline anonymous function inside a class method** (`function (value) { m.received = value }`,
   written inside `subscribeTo(publisher)`, a real method — not the constructor). `m.received`
   printed correctly as the constructor's own default ("none yet") when checked synchronously
   inside `subscribeTo` itself. But when `ft_createStream()`'s `.emit` later invoked the stored
   callback (`for each cb in m.subscribers : cb(newValue)`), `m.received` inside the callback body
   read `invalid` — not "none yet", not a stale value, but a field that doesn't exist at all — proving
   `m` inside the callback was a genuinely DIFFERENT object at invocation time (the write then
   silently landed on that wrong object, via ordinary AA field-assignment, which never fails/crashes).
2. **Bound method reference** (`boundFn = m.onPublisherChanged` — retrieving, not calling, an AA
   member holding a Function value — a real, generally-reliable BrightScript idiom for capturing a
   pre-bound method). Confirmed `Type(boundFn) = "roFunction"` at capture time. Failed identically to
   (1) once invoked later from `.emit`.
3. **Replacing `for each` iteration with direct indexed invocation** (`m.subscribers[i](newValue)`,
   ruling out "does the `for each` loop variable itself strip the binding"). Failed identically.
4. **Capturing `m` into an ordinary local variable before the closure** (`selfRef = m` in
   `subscribeTo`, referencing `selfRef` — not `m` — inside the nested anonymous sub). This one didn't
   just silently write to the wrong object — it **crashed** on-device: `'Dot' Operator attempted with
   invalid BrightScript Component or interface reference (runtime error &hec)`, confirming
   `analysis/scope-resolution.ts`'s existing `buildAnonymousFunctionScope` doc comment is correct as
   far as it goes (anonymous functions do not close over enclosing locals at all) — but also proving
   that claim was never sufficient on its own to explain why `m` itself doesn't work either for a
   plain AA.

**The fix that actually works, confirmed live**: never store a bare Function value across this
boundary at all when the subscriber is a `.flsh` class instance. Pass an explicit
`{ target: <instance>, action: "<methodName>" }` dispatch descriptor instead — an ordinary AA
literal, not a Function value, so there is no binding to lose (only DATA — an object reference and a
string — needs to survive the store/invoke boundary, which plain AA values do reliably).
`ft_createStream()`'s `ft_invokeStreamSubscriber(subscriber, value)` branches on `Type(subscriber)`:
a real Function/Sub is called directly (the `.thr`-component, node-`m` case, still fully reliable and
still the ergonomic default there); anything else is dispatched as `subscriber.target[subscriber.action]
(value)` — a genuine `instance.method()`-shaped call, freshly re-resolved at the actual invocation
site, which is the SAME reliable mechanism every other class method call in this codebase already
depends on (confirmed by `subscribeTo`/`lastReceived`'s own correct behavior throughout this entire
investigation — only the STORED-CALLBACK path was ever broken). `apps/sample-app`'s `Subscriber.flsh`
uses this pattern; see its own doc comment and `packages/compiler/GRAMMAR.md`'s "`stream`" section
for the DSL-facing writeup. The initial fix needed no compiler changes at all — `{ target: m, action:
"..." }` is an ordinary AA-literal expression, already fully supported wherever any other expression
is — DSL authors just had to write it out by hand. See the next entry for the sugar that replaced the
hand-written form.

**Lesson for the next class-instance-stateful-callback pattern in this codebase**: do not trust `m`
capture (inline anonymous function OR bound method reference) to survive a class instance's own
callback being stored and invoked later from a different call frame — verify on a real device before
assuming it works, exactly as `task-manager.md`'s own "lesson across all three bugs" entry already
recommends for a different callback-registration feature. A silently-wrong write (not a crash) is the
dangerous failure mode here, not the loud one — local test suites and `kopytko-brightscript-parser`'s
own syntax-level validation cannot catch it at all, since the generated code is syntactically and
structurally correct BrightScript; only the *runtime* `m` semantics differ from what this codebase
assumed.

## `.subscribe(<target>.<methodName>)` sugar — a pure syntactic lowering, deliberately untyped, deliberately generalized past `m`

The hand-written `{ target: m, action: "..." }` form above is real but verbose and, worse,
stringly-typed (a typo'd method name is a silent runtime failure, not a compile error) — the user
asked for sugar, specifically confirming it should generalize past `m` ("what if I use another
class instance and its method — people will do that"). `flash-parser/src/embedded.ts`'s
`findStreamSubscribeBoundReferences` recognizes the shape structurally (a `BsCallExpression` whose
callee is a `.subscribe` `BsDotExpression` and whose sole argument is itself an uncalled
`BsDotExpression`) and returns spans for the target sub-expression and the bare action name;
`analysis/identifier-rewrite.ts`/`analysis/class-identifier-rewrite.ts`'s
`rewriteStreamSubscribeBoundReferences`/`rewriteClassStreamSubscribeBoundReferences` splice in the
descriptor literal.

**Deliberately NOT type-checked against the receiver.** The compiler has no cross-object type
inference in this DSL at all — it cannot confirm `<receiver>` in `<receiver>.subscribe(...)` is
actually a `stream`-valued expression before lowering. This mirrors the DSL's own pre-existing
"trust the shape" stance toward `.emit`/`.subscribe` themselves (GRAMMAR.md: "ordinary method
calls, not special DSL grammar" — never type-checked either). Accepted risk, not an oversight: a
hand-rolled method literally named `subscribe` that expects a raw Function value positionally would
get silently mis-lowered. Judged low-probability (`subscribe` is stream-specific vocabulary this
feature introduced) and consistent with every other un-type-checked corner of this DSL, rather than
a gap worth a bigger design (e.g. requiring the receiver to be a statically-known declared `stream`
name — rejected, since it would refuse the equally-real chained-receiver case,
`publisher.onChanged.subscribe(...)`, where `onChanged` is a class field the compiler has no reason
to track as "specifically a stream").

**Scoped to `.subscribe(...)`'s own argument position, not a general "any bare `X.Y` anywhere"
transform.** A bare `X.Y` used as an ARGUMENT TO SOME OTHER FUNCTION almost always means "pass this
data field's current value" (e.g. `someFunc(obj.count)`), not "give me a bound method reference" —
blindly lowering every such occurrence would silently corrupt an ordinary field read into a
descriptor object. Restricting the pattern match to the literal callee name `subscribe` closes that
off, at the cost of the same untyped-receiver risk noted above.

**Class-side vs `.thr`-side target rewriting is genuinely asymmetric, and correctly so.** The
`.thr`-side version recursively re-runs the FULL `rewriteExpression` pipeline over the sliced target
text (same "slice, recurse, splice" shape `rewriteComparisons` already uses for its own operands) —
needed because a bare `m`/local/field reference there still has to go through ordinary
bare-identifier resolution. The class-side version does a PURE splice with no further rewriting at
all, and this is deliberately simpler, not an oversight: it runs AFTER
`rewriteClassMemberAccesses` in the pipeline, so a `m.<name>`-shaped target has ALREADY been
correctly rewritten to `m.private_<name>`/`self.private_<name>` by the time this pass sees it
(member-access rewriting only ever touches the FIRST hop after a bare `m`, so
`m.someHelper.methodName`'s second hop, `.methodName`, is untouched either way — exactly what's
wanted: `someHelper` resolved as a member access, `methodName` kept as the literal action string,
never looked up against `classShape` at all). A target that ISN'T a `m.<name>` chain (a local
variable holding another instance, an imported class name) was never touched by any class-body
rewriting pass to begin with and needs none here either — confirmed via
`Router2.wire(notifier, subscriber)`-shaped test cases: `subscriber.onNotifierChanged` lowers to
`{ target: subscriber, action: "onNotifierChanged" }` verbatim, no rewriting attempted or needed.

**The runtime dispatch mechanism (`ft_invokeStreamSubscriber`) needed zero changes for this sugar**
— it already branched on `Type(subscriber)` to support both a bare Function value and a `{ target,
action }` descriptor; the sugar only changes what DSL AUTHORS write, lowering to the exact same
descriptor shape the hand-written form already produced. Confirmed live (real Roku device,
`apps/sample-app`'s `Subscriber.flsh` rewritten to use `.subscribe(m.onPublisherChanged)`) that the
sugared and hand-written forms compile to byte-for-byte identical `.brs` output.
