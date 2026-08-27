# Compiler architecture — codegen conventions

How `codegen/brs-emitter.ts` prints BrightScript from flash-parser's structured AST rather than
text-splicing it, the flattening `else`/`else if` needs on the way out, the shared
`codegen/statement-printer.ts` engine both `brs-emitter.ts` and `class-emitter.ts` call into, why
there's no `void` type, and how unused parameters/locals get elided. See
[compiler-architecture.md](compiler-architecture.md) for the pitfall checklist, naming conventions,
and module-reorganization history this file assumes as background. For the parser/AST layer these
printers consume, see [compiler-parser-architecture.md](compiler-parser-architecture.md).

## `codegen/brs-emitter.ts` prints from a structured AST — it doesn't text-splice `if` anymore

`emitFunction` used to call `codegen/if-statement-rewrite.ts`, a recursive text-splice transform
operating on `FunctionDecl.body` (raw source text) that swapped `{`/`}` for `then`/`end if` while
preserving the *original* .thr whitespace exactly. Now that `FunctionDecl.block` carries
flash-parser's already-structured `Block`/`IfStatement`/`StatementRegion` AST, `brs-emitter.ts`
prints BrightScript directly by walking it (`printBlockStatements`/`printStatement`), emitting a
fixed 2-space indent per nesting depth instead of preserving source formatting. This is a real
behavior change in principle (canonical re-indentation vs. verbatim-preserved original
formatting) but produces **byte-identical** output for every current fixture, verified via
`test/codegen/golden.test.ts`'s exact-string comparison — both `ScheduleDateMenuItem.thr` and
`visibility-fixture` already use consistent 2-space indentation, so there was nothing to
normalize. If a future `.thr` file is authored with inconsistent indentation, the generated
`.brs` will now come out consistently indented regardless — a deliberate improvement, not a
compatibility hazard, but worth knowing if a golden-file diff ever looks like a "no-op"
reformat.

## `else`/`else if`: nested `IfStatement` in the AST, but flat `if`/`else if`/`end if` in `.brs`

`flash-parser`'s `IfStatement.elseClause` (an `ElseClause` node) represents `else if` as a
**nested** `IfStatement` (`elseClause.elseIf`) — the simplest shape for the recursive-descent
parser, since `parseOptionalElseClause` just calls `parseIfStatement()` again when it sees `else
if`. BrightScript's own `if`/`else if`/`end if`, though, is **flat**: one `end if` closes the
whole chain, not one per nesting level. `codegen/statement-printer.ts`'s `printIfElseChain` (shared
with `.flsh` class bodies, see this file's own "shared statement-printing engine" entry below)
walks the nested AST with a `while` loop (not recursion) specifically to flatten it back — printing `if`
for the first condition and `else if` for every subsequent one, and emitting exactly one `end if`
at the end regardless of chain length. Don't print an else-if chain by recursing into
`printStatement` for the nested `IfStatement` the way a plain nested `if` (one that's a genuine
statement inside a block, not an `else if`) is printed — that would nest an `end if` per level,
which parses as valid BrightScript but is semantically wrong (an extra `end if` per `else if`
that doesn't correspond to the DSL author's intent) and doesn't match how a human would write the
equivalent BrightScript by hand.

Both branches of `if`/`else if`/`else` can independently be DSL block-form (`{ }`) or inline
(single statement) — `printBranchBody` takes both possible AST shapes (`Block | null`,
`StatementRegion | null`) and always prints a canonical multi-line body under `then`, even for a
branch that was written inline in the DSL source. This means whenever an `if` has *any*
`else`/`else if`, the generated `.brs` always uses the full `then ... end if` block form for every
branch, never the single-line `if (x) then stmt` form the plain no-else case still uses — avoids
having to determine whether BrightScript's single-line if/then/else (no `end if`) is even valid,
which was never verified.

## `codegen/statement-printer.ts` — the shared statement-printing engine both `brs-emitter.ts` and `class-emitter.ts` call into

A repo audit found `class-emitter.ts` had grown ~400–500 lines of near-duplicate copies of
`brs-emitter.ts`'s own `for`/`for each`/`while`/`try`/`if`/`else if`/`else`/ternary/anonymous-function
printers (`printClassForStatement` vs `printForStatement`, and so on) — a fix to how any of these
prints once would previously have needed the exact same fix applied a second time in the other
file, with two of the eleven pairs (`printIfElseChain`/`printBranchBody`) not even doc-commented as
counterparts despite being byte-for-byte identical. `codegen/statement-printer.ts` now owns every
one of those printers once; both `brs-emitter.ts`'s `printStatement` and `class-emitter.ts`'s
`printClassStatement` are thin dispatchers that either delegate to the shared engine or handle a
statement kind that's genuinely one-sided (`state`/`store`/`focus`/`scale state` — a `.thr`
component handles these for real, a class body hard-`CompileError`s on all of them, since it has no
reactive lifecycle at all).

**Parametrized via closures bound once per top-level function/method/constructor being printed
(`SharedPrintContext`), not a class hierarchy.** Both `FunctionPrintContext` (brs-emitter.ts) and
`ClassPrintContext` (class-emitter.ts) satisfy `SharedPrintContext` structurally — `emitFunction`
(brs-emitter.ts) and `buildClassPrintClosures`+its two call sites, `emitMethod`/
`printConstructorStatement` (class-emitter.ts), build a handful of closures once: `rewriteText`
(closes over each side's own `ScriptBindings`+`GlobalBindingsContext`, or `ClassShape`+
`ScriptBindings`+`SelfExpr`+`ThemeShape`, calling `rewriteExpression`/`rewriteStatement` vs
`rewriteClassExpression`/`rewriteClassStatement`), `resolveAssignmentTarget` (the side-specific
`CompileError` wording — "field/derived/state/function" vs "field/method"), `describeContext` (the
cosmetic `"function "` label prefix only the `.thr` side needs), and `printStatement` — a **plain
function reference** to the caller's own top-level dispatcher (`printStatement`/`printClassStatement`
themselves, not a wrapping closure), so a nested call always runs against whichever `ctx` is passed
at the call site rather than one captured stale at construction time. `functionScope` is threaded as
an explicit argument to `rewriteText`/`resolveAssignmentTarget` rather than closed over, since it's
the one piece of context that legitimately changes when descending into a nested anonymous
function's own scope (a plain `{ ...ctx, functionScope }` object spread, see
`printAnonymousFunctionExpression`) — every other closed-over value (bindings, `selfExpr`,
`globalBindings`/`themeShape`) is fixed for the whole top-level function/method/constructor being
printed.

**Two things a third consumer of this engine needs to know before assuming everything is
poolable:** (1) `ctx.globalAccessRoot` (`'m.global'` for `.thr`, `CLASS_GLOBAL_ACCESS_ROOT`/
`ft_globalAA.global` for a class — see `findings/class-pipeline.md`'s `GetGlobalAA()` entry) is a
real semantic knob threaded through every `withRouterFocusHandoff`/`ft_scale(...)` call the shared
engine emits, not a cosmetic difference; (2) `lowerAnonymousFunctionsInText`'s optional
`ctx.collectExtraHoistedLines` hook is the one genuine non-duplicate between the two sides — only
`.thr`'s closure hoists a Layer 1 `animation {}` `.start()` call's `fieldToInterp` refresh lines
(`collectAnimationFieldRefreshLines`); a class body can't reference an `animation {}` declaration by
construction, so its own closure simply omits the hook. Everything else moved into the shared
module verbatim — verified byte-identical against every pre-existing golden fixture (`979` tests
unchanged) plus two new class-side fixtures added in the same pass (`class-else-if-chain`,
`class-ternary-basic` — the class side previously had no dedicated else-if-chain/ternary golden
coverage, only incidental exercise via `constructor-control-flow`'s one nested `if`).

## No `void` type — a function's return-type clause is optional, and decides `sub` vs `function`

There is no `void` type anywhere in this DSL (return type, parameter type, `state`/`derived`
type) — `: void` is a parse-time error (`dsl/void-not-a-type`, `packages/flash-parser/src/parser.ts`'s
`rejectVoidType`). A function that returns nothing simply omits its `: <Type>` clause entirely;
`FunctionDeclaration.returnType` (`flash-parser/src/ast.ts`) is `null` in that case, found by
scanning the node's own direct `childTokens` for a `Colon` rather than a fixed index (the clause is
optional, so a fixed index would silently misalign once present). `codegen/brs-emitter.ts`'s
`emitFunction` uses that `null` to choose the header/closer shape: `sub <name>(<params>) ... end sub`
when there's no return type, `function <name>(<params>) as <Type> ... end function` when there is —
mirroring BrightScript's own real `sub`/`function` distinction instead of inventing a `void`
pseudo-type on top of it. The compiler does **not** validate that a no-return-type function's body
never does `return <expr>` (invalid inside a real `sub`) — consistent with this DSL's existing
policy of passing function-body statement text through unvalidated (see the `if`-statement/
`StatementRegion` split above); a bad `return <expr>` inside a generated `sub` only surfaces when
the `.brs` is itself parsed/run, not at `.thr` compile time.

## Unused parameters/locals: reference-counting reuses `kopytko-brightscript-parser`'s `Scope.references`, no new parsing needed

`analysis/scope-resolution.ts`'s `FunctionScope.isUnused(name)` answers "is this a declared
parameter/local in this function with zero non-write reads anywhere in it" by reusing data
`buildFunctionScope` was already computing for `hasLocal` — `kopytko-brightscript-parser`
`v1.4.0`'s `Scope.references: Reference[]` carries an `isWrite` flag (`true` only for a *pure* `=`
assignment target; `false` for reads **and** compound assignments like `+=`, since those also
read). `countNonWriteReferences` sums matches across `scope` and every `scope.children`
recursively (not just this function's own direct references) — a name only read inside a nested
closure (an inline anonymous function literal in the passthrough text) must not be flagged
unused; recursing into child scopes is what protects that case, at the cost of being slightly
more conservative than strictly necessary for the common case.

**Unused parameter → codegen-only rename, not a DSL-source change.** `codegen/brs-emitter.ts`'s
`emitParamName` prefixes the *generated signature's* parameter name with `_` when
`functionScope.isUnused(name)` — the DSL source itself is never touched, and an already-`_`-prefixed
name is left alone (no `__x`). Since an unused parameter has no references to rewrite elsewhere in
the body by definition, only the signature needs the rename.

**Unused local → the assignment statement is dropped from generated output — but only when its
right-hand side has no function call anywhere in it.** This is the one real correctness trap in
this feature: dropping a statement also drops evaluation of its right-hand side, and the DSL has
no purity annotations to lean on. `analysis/unused-locals.ts`'s
`elideUnusedLocalAssignments` operates **line by line** on a `StatementRegion`'s raw text (a
region can bundle several physical lines between `if`/`state` boundaries — see flash-parser's
`ast.ts`), re-parsing each line standalone via flash-parser's own memoized `parseEmbeddedStatements`
and walking the parsed `AssignmentStatement`'s `.value` subtree via `kopytko-brightscript-parser`'s
`walk()` for any `CallExpression`. A pure dead store (`total = 0`, `x = a + b`) is elided; a
dead-store call (`total = SomeCall()`) is left in place even though `total` is never read,
because the call might matter. Multiple dead writes to the same never-read name are each elided
independently — the variable really is entirely unneeded, not just its first assignment.

Elision only ever runs from `codegen/brs-emitter.ts`'s `printStatement`'s bare `StatementRegion`
catch-all branch — **never** from the inline single-statement forms (`if (c) then <stmt>`,
`else <stmt>`). An empty result in a block context just leaves that block's body empty (valid
BrightScript); the inline forms structurally require a statement immediately following
`then`/`else` on the same line, so eliding there would produce invalid syntax
(`if (c) then` with nothing after it). `printBlockStatements` filters out the resulting empty
strings so no stray blank line appears in the `.brs`.

**A compiler-*synthesized* `sub (event as object)` handler needs its own opt-in check — it never
goes through `emitParamName`/`buildFunctionScope` at all.** `emitParamName` only ever sees a real
DSL `Block` AST (a `.thr` function's own params, or a `.flsh` constructor/method's), since
`buildFunctionScope`/`buildConstructorScope` both require a `ScopedFunctionLike.block: Block` to
reconstruct and re-parse. `brs-emitter.ts`'s `emitFieldChangeHandler`/`emitExternalFieldChangeHandler`
build a `sub on_<x>Change(event as object)` whose entire body is `emitCascadeLines`'s own
already-known generated lines — not a DSL `Block` — so for a while they hardcoded `event as object`
unconditionally and never got the "_" prefix even when the cascade never referenced it (confirmed
live: every `on_<field>Change` handler in `apps/sample-app` had this gap). Fixed with a much
cheaper check than a fake `Block`: `isEventReferenced(bodyLines)` does a direct
`/(?<!\.)\bevent\b/i` text scan over the already-generated cascade lines (case-insensitive to match
BrightScript; the negative lookbehind for `.` excludes `m.event`/`m.top.event` member access, so a
DSL author's own `field`/`state` literally named `event` can't produce a false "used" match — see
the `field event: integer` test in `brs-emitter.test.ts`). `emitBindChangeHandler`'s `sub` is exempt
— its body always does `event.GetData()`, so it's never eligible for the prefix anyway. Same
"never build a fake AST just to answer one fixed-identifier question" principle applies if a future
synthesized handler ever needs this kind of check.
