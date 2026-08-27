# Timer statements — `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`

Compile-time design rationale for the Timer feature. See `packages/compiler/GRAMMAR.md`'s "Timer
statements" section for the grammar/API itself; see [component-unmount-hook.md](component-unmount-hook.md)
for the general unmount-hook infrastructure this feature introduced and depends on.

## Bare global functions, not namespaced — no new flash-parser grammar

Unlike `taskManager`/`router`/`theme` (`analysis/identifier-rewrite.ts`'s `GLOBAL_ROOT_NAMES`,
matched as a dot-chain root), `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` are bare,
unqualified calls — deliberately JS-shaped. This needed a genuinely new recognition mechanism:
`packages/flash-parser/src/embedded.ts`'s `findGlobalFunctionCalls`, the un-dotted sibling of
`findGlobalPathAccesses`. No new lexer keyword, no new `SyntaxKind` — `setTimeout(fn, 1000)` is
already an ordinary call expression, and anonymous-function-as-call-argument was already general
grammar before this feature existed.

**Reserved-name enforcement needed to be stricter than the `theme`/`router`/`taskManager`
precedent**, which has no equivalent check at all — `GLOBAL_ROOT_NAMES` only ever matches a dot-chain
root, so a bare `field theme: string` never collides with anything syntactically. These four are
matched as bare calls, so a same-named local/function-parameter genuinely would collide (shadow the
sugar). `analysis/binding-collisions.ts`'s `checkReservedGlobalFunctionNames` closes this — including
function *parameters*, invisible to every other name-collision check in that file.

## Gotcha: `BsCallExpression.args` silently drops an anonymous-function argument

`brightscript-ast.ts`'s `BsArgumentList.args` maps each raw argument node through
`wrapBrightScriptNode`, then `.filter((n) => n !== null)` — and `wrapBrightScriptNode` has no case
for an `AnonymousFunctionExpression` node (that's this DSL's own statement-grammar kind, not one of
`brightscript-ast.ts`'s wrapped catalog), so it returns `null`, silently dropped. A naive
`findGlobalFunctionCalls` built on `call.args` therefore reported `setTimeout(function() {...}, 1000)`
as having **one** argument, not two — found via a real compile-time crash
(`expression/invalid-set-timeout-arguments`) during initial smoke testing, not a golden-test diff.

**Fix**: `findGlobalFunctionCalls` walks the raw `BsArgumentList` syntax node's own `childNodes`
directly (`call.syntax.findChild(BsSyntaxKind.BsArgumentList)?.childNodes`), computing each arg's
span from its own first/last token — never through `wrapBrightScriptNode`, since only span
boundaries are needed here, not a semantic wrapper. **Lesson for the next span-finding helper that
walks `.args`**: `call.args`/`argumentList.args` is safe only when every possible argument kind has a
`brightscript-ast.ts` wrapper class; an anonymous function (and potentially other DSL-only expression
kinds) doesn't. Reach for the raw `childNodes` walk instead whenever an argument could plausibly be a
DSL-only construct.

## The registry entry stores the node itself, not just the callback

`m["$$ft_timerCallbacks"][id] = { node: <the Timer node>, callback: <Function>, repeat: <boolean> }`
— storing `node` (not just `{callback, repeat}`) is what keeps an orphan Timer node alive when the
DSL author discards the returned handle (`setTimeout(fn, 1000)` as a bare statement, handle never
captured). Every hand-wired Timer example this feature replaced (`SplashScreen.thr`,
`TaskDemoScreen.thr`, ...) kept its node on `m` for the component's whole lifetime specifically to
avoid this. It's also what `codegen/brs-emitter.ts`'s `emitUnmountFunction` iterates to force-stop
every still-pending timer on component unmount (see component-unmount-hook.md) — the registry is the
single source of truth for "every Timer node this component has ever created and not yet settled/
cleared."

## `nextTimerTempName`'s counter must be whole-component, not per-function

Unlike `nextTernaryTempName`/`nextAnonFunctionTempName` (reset per `emitFunction` call — safe, since
each only needs uniqueness within one BrightScript local scope), the timer temp name doubles as the
created Timer node's own `.id`, which is the registry's lookup key. If the counter reset per
function, two *different* functions in the same component could each mint `ft_timer_1`
independently; if both timers were alive concurrently, whichever registered second would silently
clobber the first's registry entry. `codegen/brs-emitter.ts`'s `emitBrs` creates one counter and
threads it, by reference, through every `emitFunction` call for that component.

## Callback-invocation lessons reused verbatim from `taskManager.onResult`

`codegen/brs-emitter.ts`'s `emitTimerFireTrampoline` copies two live-verified rules from
[task-manager-onresult.md](task-manager-onresult.md) rather than re-discovering them:
- **`cb = entry.callback : if cb <> invalid then cb()`, never `entry.callback()` directly** — calling
  a Function value stored as an AA member through dot-call syntax rebinds `m`, inside the called
  function, to the AA itself, not the callback's real closure `m`.
- **Delete the one-shot registry entry BEFORE invoking the callback** — closes the same
  stale-event-after-cancel race `onResult`'s own fix documents: `clearTimeout`/`clearInterval` also
  delete-before-stop, so a `fire` event already in flight when cancellation runs finds no registry
  entry and no-ops.

## ms→seconds conversion — the exact mistake `animation {}` already made once

`findings/animation.md` documents `animation {}`'s `duration:`/`delay:` fields being silently in
seconds (Roku-native), fooling early device testing because the JS instinct assumes milliseconds (a
"400ms" bounce was actually 6m40s). This feature deliberately chose real milliseconds for JS parity
with `setTimeout`, which makes the conversion mandatory, not optional: `codegen/statement-printer.ts`'s
`msToSecondsBrsExpr` folds a literal duration at compile time (`1000` → `1.0`) and divides an
arbitrary expression at runtime (`(<expr>) / 1000.0`). `test/golden/` asserts the exact converted
value (`.duration = 1.0`, not just "compiles") specifically because this mistake has already happened
once in this codebase.

## `derived`/reactive-expression rejection needed its own check, separate from the function-body one

The function-body position restriction (`checkTimerStartCallPosition`,
`codegen/statement-printer.ts`) is enforced by `lowerTimerStartCallsInText`, reachable only through
the shared statement-printing engine (`emitFunction`/`printBlockStatements`) — i.e. only from
*inside a function body*. A `derived x = setTimeout(...)` never reaches that code path at all:
`derived` RHS text is rewritten via `analysis/identifier-rewrite.ts`'s `rewriteExpression` directly,
a completely separate call site. Without a matching check there, a `derived`-position `setTimeout`
fell through to ordinary bare-identifier resolution and failed with a generic
`expression/unresolved-identifier` — technically still rejected, but the wrong diagnostic, caught by
a golden-test assertion expecting the specific code. **Fix**: `checkNoTimerStartCallInExpression` in
`identifier-rewrite.ts`, wired into `rewriteExpression` itself — this one check then also covers every
other `rewriteExpression` call site uniformly (dynamic template bindings, `{#if}`/`{#each}`
condition/collection/key expressions), which is broader than the original per-context plan.
**Lesson**: a new bare-call-shaped construct that needs "reject me in ANY reactive-expression
position" can't rely on being detected once inside the shared function-body print engine — `derived`/
binding/block-condition text never runs through it at all; the check belongs in
`rewriteExpression`/`rewriteStatement` (identifier-rewrite.ts) directly for full coverage.

## Bug: a bare, handle-discarded `setTimeout(...)`/`setInterval(...)` left an invalid stray temp-name line whenever another statement shared its `StatementRegion`

`codegen/statement-printer.ts`'s `lowerTimerStartCallsInText` elides a bare, handle-discarded timer
call (`setTimeout(fn, 500)` as its own statement, nothing capturing the return value) down to
nothing — the hoisted `CreateObject`/`.duration`/registry/`ObserveFieldScoped`/`.control = "start"`
lines are emitted, and the original call site (which, after splicing the temp name back in, would
otherwise print as a pointless `ft_timer_1` "evaluate and discard" statement) is dropped entirely.

The ORIGINAL check: `matches.length === 1 && spliced.trim() === tempNames[0]` — elide only when the
ENTIRE region's spliced text reduces to exactly the bare temp name. This assumes a
`StatementRegion`'s `text` always holds exactly one real statement — wrong. `analysis/unused-locals.ts`'s
`elideUnusedLocalAssignments` already documents and handles the actual reality: flash-parser's own
opaque-scan statement splitter (`token-stream-parser.ts`'s `parseBlockContent`) only stops
accumulating a region at specific keywords (`if`/`state`/`store`/`scale`/`focus`/`for`/`while`/`try`/
`catch`) or a ternary/anon-function assignment starting on its own new line — an ORDINARY bare call
statement (another function call, `router.markReady()`, a second `setTimeout(...)`, ...) is none of
those, so it gets silently bundled into the SAME region as whatever timer call precedes or follows
it. Once bundled, the splice-then-compare check could never match (the region's text was never just
the timer call to begin with), so the code fell through to the "print the whole spliced blob"
branch — which included the bare, now-meaningless `ft_timer_1` line, verbatim, followed by the
region's real second statement.

**Live-caught** (Roku Ultra, 2026-08-19) as a genuine `Install Failure: Compilation Failed` on
`apps/sample-app`'s `LoadingDemoScreen.thr`, the moment its own solo `setTimeout(...)` in `setup()`
got a second statement (`router.markReady()`) next to it — see
[router-transitions.md](router-transitions.md)'s own writeup of that screen's workaround-then-fix
history. This project's own `validateGeneratedBrs` (a deliberately lenient vendored parser) did NOT
catch the bare `ft_timer_1` line as invalid — only Roku's real device compiler rejected it, a real
gap in this repo's own generated-code safety net worth remembering next time a codegen bug seems to
have "passed validation."

**Root cause is broader than the original report** — reproduced with `router.markReady()` swapped
for an arbitrary bare private-function call, and even with TWO bare `setTimeout(...)` calls sharing
one region with nothing else at all (`matches.length > 1` already skipped the elision check
entirely, pre-fix, so that shape was equally broken and just never got noticed).

**Fix**: elide line-by-line instead of whole-blob, mirroring `elideUnusedLocalAssignments`'s own
already-correct pattern — after splicing, split the result on `\n` and drop any line that trims to
EXACTLY one of this call's own temp names, keeping every other line (including a real second
statement, before or after) untouched. Generalizes correctly to any number of timer calls sharing a
region, in either order, mixed with any number of other statements. Four new golden tests cover the
shapes that were broken: second statement after, second statement before, two bare timer calls with
nothing else, and the exact live-reproduced `setTimeout` + `router.markReady()` shape (also
reverified live post-fix: `LoadingDemoScreen.thr` now calls `router.markReady()` again, installs and
runs cleanly).

## No shared runtime asset — fully inline, mirroring `onResult`

No `runtime-assets/Timer/` directory: `Timer` is a native Roku SceneGraph node type (no XML component
to author or copy, unlike `taskManager`/`Http`/`Store`/`Stream`); no `m.global` singleton wiring
needed (`codegen/global-fields.ts`'s `GLOBAL_FIELD_NAMES` has no `timer` entry — each call creates
its own independent node in a per-*component* registry, never an app-wide table); the registry/
trampoline shape is exactly `taskManager.onResult`'s own local-AA-plus-trampoline shape, which itself
needed no shared asset.

## The force-stop-on-unmount guarantee is live-confirmed — Roku Ultra, firmware 15.3.4

Driven live via ECP against `apps/sample-app`'s `TaskDemoScreen` (router-mounted) and
`apps/async-demo`'s `PriorityQueueDemo`/`AlertingDemo` (plain `{#if:destroy}` children) and
`TimerDemoScreen`: each screen's `setInterval` ticked at its declared cadence while visible, then
produced **zero** further ticks for several seconds immediately after navigating/switching away —
confirmed by a temporary `print` marker inside the callback, read over the live debug console. A
second pass (`NestedAndListTimerDemo`/`MiddleWrapper`/`TimerLeafWidget`, also in `apps/async-demo`)
confirmed the same for a genuinely two-component-level-deep nested cascade and for `{#each}` item
removal specifically. `apps/async-demo` has since been split into router-mounted chapter apps —
`PriorityQueueDemo`/`AlertingDemo` are now `apps/task-manager-demo`'s `RunCancelDemo.thr`/
`AlertingChapterDemo.thr`, and `TimerDemoScreen`/`NestedAndListTimerDemo`/`MiddleWrapper`/
`TimerLeafWidget` are now `apps/timers-demo`'s (same names) — migrated as-is in spirit, not
re-verified live against the new router-mounted shape (see `findings/demo-app-conventions.md` and
each successor app's own `*-demo-app.md` findings file). See
[component-unmount-hook.md](component-unmount-hook.md)'s own
live-verification section for the full readings. This is real evidence the whole chain works end to
end, not just that it compiles: `ft_unmount`'s `for each` loop genuinely runs and `.control = "stop"`
genuinely halts a live, ticking Timer node before it can fire again.

**Open question, still not tested**: whether ordinary BrightScript reference-counting alone (without
the explicit `.control = "stop"` this feature actually relies on) would ALSO have been sufficient —
i.e. whether an active, unparented `Timer` node keeps ticking even after its last reference
disappears, the way Roku's `Task` node is documented to keep its thread running until explicitly
stopped. Moot for this feature's own correctness (the explicit force-stop loop is what's actually
relied on, and it's now confirmed live), but worth knowing for its own sake if a future change ever
considers relying on refcounting alone to stop a Timer.
