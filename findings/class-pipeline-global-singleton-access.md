# `.flsh` class codegen — global singleton access (`GetGlobalAA()`, class-method `m`)

How a `.flsh` class method reaches app-wide global singletons (`store`/`theme`/`router`/
`taskManager`) — the `GetGlobalAA()`-aliases-`m.global` design, the real bugs found building it
(a hoisting fix confirmed via real-device bisection), and why a class method's own `m` is the
instance itself, never a SceneGraph node, which used to make `theme`/`router`/`taskManager` silently
miscompile there. See [class-pipeline.md](class-pipeline.md) for the separate-codegen-pipeline
rationale this sits on top of (visibility/override checking, `ClassShape.allMembers`, cross-file
import/extends resolution) and that file's own `derived`-reading-a-class-instance
crash-on-first-mount note. For the core pipeline both of these sit on top of, see
`findings/compiler-parser-architecture.md` (flash-parser's CST/AST),
`findings/compiler-identifier-resolution.md` (the identifier-rewrite/scope-resolution machinery),
and `findings/compiler-architecture.md` (naming conventions).

## `GetGlobalAA()` aliases `m.global` — a `.flsh` class method reaches every global singleton through it, confirmed live

**Confirmed on a real device** (not intuition — a prior draft of this file's own history made an
unverified claim here that turned out wrong, see the correction below): `GetGlobalAA()` is a real
BrightScript builtin returning one `roAssociativeArray` shared app-wide. SceneGraph automatically
populates a `"global"` key in it pointing at the exact same content node `m.global` resolves to —
with zero manual wiring, reachable identically from a `.thr` component's generated code AND a
`.flsh` class method (verified via a temporary probe class calling `GetGlobalAA().global`, sideloaded
and read back via `queryAppUi`: `type=roSGNode`, `HasField("ft_taskManager")=true`,
`IsSameNode(m.global)=true` — from *both* contexts). This is what `class-identifier-rewrite.ts`'s
`CLASS_GLOBAL_ACCESS_ROOT` now rests on, and why the original blanket class-body rejection (below)
was replaced with real support: `theme`/`router`/`taskManager` all compile from a class body exactly
like they do from a `.thr` component, just rooted at `GetGlobalAA().global` instead of `m.global` —
see `codegen/global-fields.ts`'s `GlobalAccessRoot`/`globalFieldRef`, whose `accessRoot` parameter
is the single chokepoint every splice site in `identifier-rewrite.ts`/`scope-resolution.ts` reads.
(The literal generated text is actually `ft_globalAA.global...`, a hoisted local, not an inline
`GetGlobalAA()` call — see the bare-statement bug entry below for why.)

**The one exception**: `taskManager.onAlertChanged(...)` stays rejected from a class body
(`class/task-manager-on-alert-changed-not-supported`) — deliberately, not a gap. Whether
`ObserveFieldScoped`'s callback-scoping semantics even work when the *call site* is a class method
(a plain closure, no SceneGraph node of its own) is genuinely unverified — and separately,
`GetGlobalAA()` being one table shared by the *whole app* means a callbacks array stored there needs
a per-subscribing-instance-unique key, which a class instance has no stable identity or destroy hook
to safely provide (unlike a `.thr` component's own already-correctly-per-instance `m` scope — see
`taskManagerAlertCallbacksFieldAccess`'s own doc comment in `codegen/naming.ts`). Neither problem was
worth guessing through.

**A real bug this design change surfaced, caught by its own test**: `identifier-rewrite.ts`'s
`withRouterFocusHandoff` matches an already-emitted `router.navigate`/`back` call via a regex built
from `globalFieldRef('router', accessRoot)`. The original code only escaped `.` before embedding it
in the pattern — harmless for `'m.global.ft_router'`, but `'GetGlobalAA().global.ft_router'`'s `(`/`)`
are regex metacharacters: an unescaped `()` is an empty capture group, so the pattern silently
required *zero* characters between `GetGlobalAA` and `.global` instead of matching the literal two
parens — the focus hand-off line was never inserted for a class-triggered `router.navigate(...)`, no
compile error, just a silently missing line. Fixed with a proper full-string `escapeRegExp` helper.
**Lesson**: any regex built from a `GlobalAccessRoot`-derived string must escape the *whole* string,
not just the character that happened to need escaping before `GetGlobalAA()` existed as a root option.

**A second, subtler hazard found and fixed while wiring this**: a router/taskManager action's own
call-argument text (e.g. `router.navigate(path, {from: m.someField})`) needs to be recursively
rewritten through the *class* pipeline (so `m.someField` resolves via class member-access rewriting,
not left untouched) — but recursing through the FULL `rewriteClassExpression` a second time would
re-run `rewriteClassMemberAccesses` on already-rewritten text (`m.someField` → `m.private_someField`
from the outer pass, which scans the *whole* text including nested call arguments before global-path
scanning even starts), and `rewriteClassMemberAccesses` has no idempotency — a second pass would look
up `"private_someField"` in `classShape.allMembers` (which only knows the source-level name) and
hard-fail `class/unresolved-member`. This is the exact same class of bug as the `.thr`-side
"bare `private_<name>` survives a second identifier-rewrite pass" fix below, but for class member
access instead of top-level private functions. Fixed by splitting the recursion: the argument-rewrite
callback threaded into `validateAndRewriteGlobalPaths` (a new, injectable `rewriteArg` parameter —
`.thr` call sites keep their old `rewriteExpression`-based default unchanged) calls a reduced
`rewriteClassGlobalPathsAndIdentifiers` helper that does global-paths + bare-identifier resolution
only, never member-access rewriting a second time. `rewriteClassComparisons`'s own doc comment
already documented this exact non-idempotency hazard for a different reason (nested `==`/`!=`
operands) — same root cause, same fix shape.

**The most important bug this design change surfaced — confirmed live via real-device bisection,
not code review.** A bare (return-value-discarded) statement chained directly off `GetGlobalAA()`'s
own call result fails to install on a real Roku device (`Install Failure: Compilation Failed`,
package accepted but the .brs never compiles) — `GetGlobalAA().global.ft_taskManager.callFunc
("setMaxConcurrent", 5)` used as a plain statement, nothing capturing its return, simply does not
compile. The IDENTICAL call chained off a local variable holding `GetGlobalAA()`'s result
(`aa = GetGlobalAA()` then `aa.global.ft_taskManager.callFunc(...)`) compiles and runs fine — and
capturing the *whole* chained call's own return value into a variable also works fine
(`x = GetGlobalAA().global.ft_taskManager.callFunc(...)`), so the bug is specifically about a bare
statement whose receiver expression starts with a raw function CALL rather than a variable/`m`.
`kopytko-brightscript-parser` (used for this repo's own `validateGeneratedBrs`/golden tests) does
NOT catch this — the generated `.brs` parses as perfectly valid BrightScript syntax; only Roku's own
real compiler rejects it. `.thr`-side `m.global`-rooted bare statements are completely unaffected —
this app already had several (`m.global.ft_focus.callFunc("register", ...)` in every component's
own `init()`) that work fine and always have.

**Found via bisection, not guesswork** — matches this session's own working method throughout:
building the `.flsh` fixture (`GlobalAccessDemo.flsh`) with all three singleton calls, sideloading,
hitting "Compilation Failed", then removing one call at a time and re-sideloading (theme-only:
installed fine; theme+taskManager.run: installed fine; theme+taskManager.run+router.navigate: FAILED)
narrowed it to `router.navigate`'s codegen specifically — then a further bisection (a bare
`taskManager.setMaxConcurrent(5)` alone, unrelated to router, ALSO failed; the same call captured
into a discarded local `x = ...` succeeded) proved the real, general shape of the bug: not
router-specific at all, but "bare statement chained off a raw `GetGlobalAA()` call."

**Fix**: `codegen/naming.ts`'s `CLASS_GLOBAL_AA_LOCAL_NAME` (`'ft_globalAA'`) plus
`codegen/class-emitter.ts`'s `hoistGlobalAAIfNeeded` — every method/constructor/anonymous-function
body that references the class-context access root gets a `ft_globalAA = GetGlobalAA()` line
prepended (checked via a plain substring scan for `ft_globalAA.` in the already-printed body text;
since `ft_globalAA` carries `RESERVED_IDENTIFIER_PREFIX`, no DSL-authored name can ever collide with
it, so the scan is unambiguous). `CLASS_GLOBAL_ACCESS_ROOT` itself changed from the literal
`'GetGlobalAA().global'` to `` `${CLASS_GLOBAL_AA_LOCAL_NAME}.global` `` (i.e. `'ft_globalAA.global'`)
so every existing splice site picks this up automatically with no per-call-site change needed.
Hoists unconditionally whenever ANY class-context global access appears — even a captured-return
case where the bug doesn't apply — rather than trying to detect bare-vs-captured precisely, since
`ft_globalAA.global.X.callFunc(...)` compiles fine either way; the unconditional hoist is exactly as
correct and much simpler. Each generated `sub`/`function` gets its OWN hoist, never shared with an
enclosing scope — this codebase's own generated anonymous functions do not close over an enclosing
function's own locals (see `codegen/brs-emitter.ts`'s equivalent note), so a hoist in an outer method
would not be visible inside a nested callback anyway.

**Live-verified end to end** (not just re-compiling): cold-booted `apps/sample-app`, navigated to
`TaskDemoScreen`, pressed a button wired to a class method that calls `taskManager.run(...)` and
reads `theme.colors.text` — readout showed `task=ft_task_1 theme.colors.text=0xFFFFFFFF`, confirming
both actually reached the real runtime singletons. Pressed a second button wired to a class method
that calls `router.navigate("/browse")` — the app genuinely left `TaskDemoScreen` and mounted
`HomeScreen`. Critically, then pressed `Select` on `HomeScreen`'s own `on:key[OK]`-bound element
(unrelated to anything this session touched) and confirmed it genuinely fired
(`ScheduleScreen` mounted) — proving the mandatory focus hand-off after a class-triggered
`router.navigate(...)` establishes REAL key-event routing, not just `queryAppUi` reporting
`focused="true"` while input is actually dead (the exact false-positive `findings/router.md` already
warns about for this same follow-up mechanism).

**Lesson for anything else that ever emits code rooted at a raw function-call expression (not a
variable) intended to be used as a bare statement**: verify on a real device before assuming
`kopytko-brightscript-parser` accepting it means Roku's own compiler will too — this is now the
THIRD platform behavior in this codebase's history (alongside `node` not being a valid `as`-clause
type, and `default-focus` as a literal XML attribute) that parses cleanly but fails to actually
install, each found only by sideloading, never by static analysis.

## A `.flsh` class method's `m` is the class instance, never a SceneGraph node — `theme`/`router`/`taskManager` used to silently miscompile there

Confirmed as a real, previously-unnoticed bug (not hypothetical, and not new to any one feature —
it affected `router` and `taskManager` symmetrically, `theme` only accidentally differently): every
built-in global singleton (`store`, `theme`, `focus`, `router`, `taskManager`) is reached through
`m.global.ft_<name>...`, but a class **method** is compiled as a plain AA-member closure
(`prototype.<name> = sub()/function()... end sub/function`, invoked as `instance.method()`) —
BrightScript auto-binds `m` to the instance's own plain associative array there, never any
SceneGraph node (see [class-pipeline.md](class-pipeline.md)'s ".flsh classes are a separate codegen
pipeline" section, and GRAMMAR.md's "Classes" section). `m.global` inside a class method therefore
reads a nonexistent `"global"` key off that plain AA, evaluating to `invalid` — any `.callFunc(...)`/
`.ObserveFieldScoped(...)` chained onto it crashes at runtime.

**`store`/`focus` were already correctly blocked**, but only because they're each backed by a
dedicated flash-parser AST node (`StoreWriteStatement`/`FocusStatement`) that
`codegen/class-emitter.ts`'s `printClassGenericStatement` explicitly instanceof-checks and rejects
with `class/state-store-not-supported` before either ever reaches identifier rewriting.
`theme`/`router`/`taskManager` are NOT dedicated AST nodes — they're ordinary dot-chain/call
expressions found the generic way (`GLOBAL_ROOT_NAMES` + `findGlobalPathAccesses`, see the
`resolveIdentifier` entry in `findings/compiler-identifier-resolution.md`'s
`analysis/scope-resolution.ts` section), so they never hit that guard at all. `theme` happened to still
fail — but only as an accidental side effect of `analysis/class-identifier-rewrite.ts`'s
`rewriteClassExpression`/`rewriteClassStatement` never threading a real `GlobalBindingsContext`
through to `applyIdentifierRewrite` (it silently defaults to `{ theme: null }`, and
`resolveIdentifier`'s `theme` branch is gated on that being truthy) — producing a generic, unhelpful
`expression/unresolved-identifier`, not a real explanation. **`router`/`taskManager` had no such
accidental gate at all** (`resolveIdentifier`'s branches for both are unconditional — `theme` is the
only one of the three ever gated by `GlobalBindingsContext`, since `GlobalBindingsContext` itself
only even has a `theme` field) — confirmed live by actually compiling a synthetic `.flsh` fixture:
`router.navigate("/home")` inside a class method compiled cleanly to
`m.global.ft_router.navigate("/home")`, and `taskManager.onAlertChanged(cb)` to
`m.global.ft_taskManager.onAlertChanged(cb)` — both wrong on a SECOND level even setting the `m`
mismatch aside, since neither ever goes through the real `validateAndRewriteGlobalPaths`/
`buildRouterActionReplacement`/`buildTaskManagerOnAlertChangedReplacement` pipeline in a class body
(that pipeline is `.thr`-only) — only the generic bare-root-token splice runs, so `router.navigate`
never gets its argument repacked into the real `{path, params, skipInHistory}` AA shape or its
mandatory focus-handoff follow-up statement, and `taskManager.onAlertChanged` never gets its
two-statement callback-registration expansion at all — it stays a literal (non-existent)
`.onAlertChanged(cb)` method call.

**Original fix (superseded)**: a first pass added `class-identifier-rewrite.ts`'s
`checkNoGlobalSingletonReference`, hard-rejecting any `theme`/`router`/`taskManager` reference from a
class body with `class/global-singleton-not-supported` — safe (no more silent miscompilation), but a
blanket ban wider than necessary. Once `GetGlobalAA().global` was confirmed live to alias `m.global`
(this file's own entry above), that rejection was replaced with real support — see that entry for the
current design (`accessRoot` parameterization, the injectable `rewriteArg` callback, and why
`onAlertChanged` alone stays excluded). `store`/`focus` needed no equivalent change either way — their
existing dedicated-AST-node rejection already covers them correctly, for an unrelated reason (no
reactive lifecycle in a class, not an `m`-vs-context gap).

**Lesson for the next global singleton** (an analytics primitive, whatever): `GLOBAL_FIELD_NAMES`/
`globalFieldRef()`/`GLOBAL_ROOT_NAMES` (`codegen/global-fields.ts`'s own standing rule, see this
file's "Never do this" list) is necessary but not sufficient — also decide, explicitly, whether it's
safe for a class body to reach it via `GetGlobalAA().global` (stateless actions/reads: yes, following
the pattern above) or whether it needs the same careful exclusion `onAlertChanged` got (anything
needing per-subscriber-instance storage) — don't let it silently miscompile OR silently stay
blanket-rejected once it would actually work.
