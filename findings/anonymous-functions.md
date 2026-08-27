# Anonymous function expressions (`function (...) { }`)

Design rationale and real bugs for the DSL's anonymous function expression feature, shipped in two
tiers: Tier 1 (the whole right-hand side of a `state`/plain assignment, `AnonymousFunctionExpression`
+ `AnonymousFunctionAssignmentStatement`) and Tier 2 (nested inside an arbitrary expression — a call
argument, an `if`/`for`/`while` header, a ternary branch — as a real primary-expression production
in `brightscript-parser.ts`'s own grammar). See `packages/compiler/GRAMMAR.md`'s "Anonymous
functions" section for the precise grammar and current scope (`.thr` function bodies and `.flsh`
class method/constructor bodies, not yet template-attribute/`bind:`/`on:key` binding expressions or
a class's own `super(...)` call argument). This file is the *why* and the real scanner bugs Tier 2
exposed in the DSL-shell-level statement scanners that decide where an opaque region begins and
ends, before any embedded re-parse ever runs. For the core pipeline this sits on top of
(flash-parser's CST/AST, see `findings/compiler-parser-architecture.md`; `analysis/scope-resolution.ts`'s
identifier resolution — including why an anonymous function does not close over its enclosing
function's own locals — see `findings/compiler-identifier-resolution.md`). For the `.flsh`-class codegen mirror
(`class-emitter.ts`'s `lowerClassAnonymousFunctionsInText`), see `findings/class-pipeline.md`.

## Anonymous function expressions, Tier 2 (nested inside an arbitrary expression) — a token-remap, not a re-lex, plus two real scanner bugs Tier 2 exposed

Tier 2 makes `AnonymousFunctionExpression` a real primary-expression production inside
`brightscript-parser.ts`'s own grammar (the same tier `BsComparisonExpression` occupies), reachable
from a call argument, an `if`/`for`/`while` header, a ternary branch, etc. — not just the two Tier-1
whole-RHS host positions. Three non-obvious things this required, and two real bugs it exposed that
had nothing to do with the new grammar production itself:

**1. Token-kind remap instead of a second lex pass.** `brightscript-lexer.ts` deliberately
de-keywords `state`/`store`/`focus`/... to plain `Identifier` (`DSL_ONLY_KEYWORD_KINDS`) so ordinary
BrightScript text like `store.count` isn't misread as DSL syntax. A Tier-2 anonymous function's own
body is genuine DSL syntax though, so those tokens need their real kind back before being handed to
`token-stream-parser.ts`'s block grammar. Rather than re-slicing to text and re-lexing with
`lexer.ts` (a second lex pass, and the more "obvious" fix), `anonymous-function-lookahead.ts`'s
`remapDslKeywordTokens` walks the *already-lexed* token span and re-derives each `Identifier`
token's true kind via a plain `KEYWORD_MAP` lookup, in place — every `pos`/`end`/`line`/`column`/
`text`/`leadingTrivia` stays untouched, only `kind` changes. Diagnostic positions inside a Tier-2
body land correctly in the original `.thr` source for free, with no coordinate-translation step —
confirmed by a dedicated test (`brightscript-parser.test.ts`'s "diagnostic inside a Tier-2 body
still reports the correct position").

**2. Hoist to `ft_anon_N`, never inline the printed function literal.** `codegen/brs-emitter.ts`'s
`lowerAnonymousFunctionsInText` (and its class-emitter mirror) finds every *outermost* Tier-2 anon
function in a plain `ExpressionRegion`/`StatementRegion`'s text, recursively prints it (already
fully resolved against its own independent scope), and hoists it to a `ft_anon_N = <printed
literal>` line immediately before the statement — splicing only the bare temp name back into the
surrounding text, which is *then* rewritten once. Splicing the printed literal inline and
re-rewriting the whole result would be wrong: a second `rewriteExpression`/`rewriteStatement` pass
would try to re-resolve identifiers belonging to the anon function's own scope (its own
parameters/locals) against the *outer* scope instead. Exactly the same reason ternary hoists to a
temp var rather than inlining an `if`/`else` block — `ft_anon_N` resolves via the same `ft_`-prefix
short-circuit in `resolveIdentifier` that `ft_ternary_N` already uses. `findAnonymousFunctionExpressions`
(flash-parser's `embedded.ts`) filters to outermost-only for the same reason
`findComparisonExpressions`'s callers do: a nested anon-in-anon is handled for free when the OUTER
one is recursively printed, so surfacing the inner one too would double-hoist it.

**3. `brightscript-scope.ts` needs its own case for the DSL's `AnonymousFunctionExpression` kind.**
`scope-resolution.ts`'s `buildFunctionScope` reconstructs the *enclosing* function as real-BrightScript-shaped
text and re-parses it via `parseBrightScript` purely for `hasLocal`/`isUnused` queries (the
`_x`-unused-parameter-prefix feature). Once Tier 2 shipped, that reconstructed text can genuinely
contain a Tier-2 anon function's own literal source (a plain `ExpressionRegion`'s reconstruction
fallback is just its original text, DSL sugar included), so the resulting tree now legitimately
mixes the DSL's own bare `AnonymousFunctionExpression`/`Block` kinds into an otherwise all-`Bs`-prefixed
tree. `brightscript-scope.ts`'s `collectFromNode` needed a dedicated case opening an independent
child scope for it (reading `SyntaxKind.ParameterList`/`Parameter`, not `BsParameterList`/`BsParameter`)
— without it, the anon function's own parameter names silently leaked into the enclosing scope.

**Bug found #1 — `parseBlockContent`'s opaque-region scanner had no bracket-depth tracking.**
Before Tier 2, a DSL keyword (`if`/`state`/`store`/...) could never legitimately appear *nested*
inside an expression — the only way to get DSL sugar into an expression-shaped position was a
Tier-1 anonymous function, always caught structurally by its own dedicated lookahead *before*
reaching the generic opaque-`StatementRegion` accumulation loop. Tier 2 breaks that invariant: a
`function (...) { if (...) { ... } }` can now appear buried inside an ordinary call argument
(`filterList(items, function (x) { if (x) { ... } })`), whose *outer* assignment doesn't match the
Tier-1 lookahead shape at all (`results = filterList(...)`, not `results = function (...)`) and so falls into
the generic scanner. That scanner had zero paren/brace/bracket depth tracking — it just stopped
accumulating the moment it saw a raw `TokenKind.If`/`State`/etc., regardless of nesting, splitting
the region right before the anon function's own nested `if` and leaving its header with no matching
closing brace at all. Confirmed live via a failing compile (`statement/parse-error`: "No closing
"}" found for anonymous function.") before `parseBlockContent`'s inner loop gained bracket-depth
tracking (`token-stream-parser.ts`) — the DSL-keyword stop conditions (and the line-break
ternary/anon-assignment-lookahead check) now only fire at depth 0.

**Bug found #2 — every "same physical line" RHS scan in `token-stream-parser.ts` had the identical
gap**, for a different reason: `state <name> = <expr>`, `store(<key>) = <expr>`, a
ternary-assignment RHS, and an inline `if (...) then <stmt>`/`else <stmt>` body were all bounded by
"tokens on the same source line as the `=`/`else`/`)`" — correct before Tier 2, since nothing that
could appear there ever needed more than one line. A Tier-2 anon function's own body is inherently
multi-line, so `state x = filterList(items, function (y) {\n ... \n})` truncated the RHS scan at the end
of line 1, mid-header. Fixed with one shared helper, `scanSameLogicalLine` — same "same line" rule,
but bracket-depth-tracked: once an unclosed `(`/`{`/`[` is open, line breaks don't end the scan
until it closes, then the line boundary is enforced again. Replaces five near-identical
hand-rolled `while` loops (`looksLikeTernaryAssignmentAt`, `tryParseTernaryAssignment`,
`parseStateAssignment`, `parseStoreWriteStatement`, `parseIfStatement`'s/`parseOptionalElseClause`'s
inline forms) with one call each — a net simplification, not just a bug fix, and incidentally makes
a multi-line AA/array literal in any of those RHS positions correct too (previously equally broken,
just never exercised).

**Both bugs were found by trying to compile a real fixture** (`state total = ...` inside a Tier-2
body nested inside another `state`/plain-assignment write) — neither surfaced from parsing alone
(`brightscript-parser.ts`'s own grammar, tested directly via `parseBrightScript`, was correct from
the start); they were both in the *outer*, DSL-shell-level statement scanners that decide where an
opaque region begins and ends before any embedded re-parse ever runs. Worth remembering next time:
a clean isolated-parser test is not proof the full `.thr`-pipeline path works — the DSL shell's own
boundary-detection has its own, separate set of assumptions that a new nestable construct can break.

**Scope, currently**: fully nestable inside a `.thr` function body and a `.flsh` class
method/constructor body (mirrored in `class-emitter.ts`'s `lowerClassAnonymousFunctionsInText`).
**Not yet wired**: a template attribute/`bind:`/`on:key`/`{#if}`/`{#each}` binding expression (no
statement list to hoist a `ft_anon_N =` line into — a genuinely different shape, not merely
unfinished), and a class's own `super(...)` call argument (same "no statement list to hoist into"
reason, narrower blast radius, not expected to come up in practice).

**`ifArray` has no `Filter`/`Map`/`ForEach` — every worked example (GRAMMAR.md, docs/features.md,
`apps/sample-app`'s `ScheduleList.thr`, the golden fixtures) uses a hand-written helper instead.**
An early pass of this feature used `list.Map(function (x) { ... })`/`items.Filter(...)` as the
illustrative "real Roku pattern" everywhere, including in a compiled-and-`build:roku`'d sample-app
component with a comment calling it "real, live proof." It was never real: Roku's own `ifArray`
interface (verified against developer.roku.com) only has `Push`/`Pop`/`Peek`/`Shift`/`Unshift`/
`Delete`/`Count`/`Clear`/`Append` — no functional/callback methods at all, on any firmware.
**`build:roku` + `validateGeneratedBrs` only prove the generated text is syntactically valid
BrightScript — a call to a method that doesn't exist parses fine and only fails at runtime,
un-caught by anything this repo's tooling checks without a real device.** The actual fix needed no
new capability: BrightScript's `Function` type is genuinely first-class (documented at
developer.roku.com's "Expressions, Variables, and Types" — assignable to a variable, storable,
callable via `predicate(x)`), so a plain hand-written `filterList(list, predicate)` (a `for` loop
calling `predicate(list[i])` directly) is both correct and sufficient to demonstrate the feature.
Lesson: a claim about a specific Roku/BrightScript API surface needs checking against
developer.roku.com (or this repo's own prior verified usage) before it goes in a "real, live"
example — general model knowledge about platform APIs is exactly the kind of thing that's
plausible-sounding and wrong.

## Anonymous function expressions (`function (...) { }`) — Tier 1 only, and why it can't close over outer locals

Shipped as `AnonymousFunctionExpression` (an expression, parsed via `parseParameterList` reused
directly from named-function parsing) plus `AnonymousFunctionAssignmentStatement` (a new statement
kind for the plain-assignment case, mirroring `TernaryAssignmentStatement`'s own "bare assignment
target is always a real local" shape — kept as a **separate** node rather than widening
`TernaryAssignmentStatement` itself, since conflating "ternary-bearing" and "anonymous-function"
detection into one node would have broken that node's own documented invariant that a ternary-free
plain assignment never becomes one). `StateAssignment.rhs` was widened to include
`AnonymousFunctionExpression` as a fourth variant *alongside*, not *through*, `wrapTernaryChild` —
deliberately not routed through the shared ternary machinery, since `lowerTernaryRhs`/
`reconstructTernaryText ` have no branch for it and would have silently mishandled it (produced
`undefined` or thrown) had it been folded into that shared path instead of checked explicitly first.

**Tier 1** (the whole right-hand side of a `state`/plain assignment) is what `token-stream-parser.ts`
detects via its own dedicated statement-position lookahead — this is still how those two host
positions are recognized today. Nesting inside a larger expression or as one argument among several
in a call (`filterList(items, function (x) { ... })`) is Tier 2 — see the section above this one for how that
shipped and the two scanner bugs it exposed.

**No closure over the enclosing function's own locals — confirmed, not assumed.** Real BrightScript
anonymous `function`/`sub` literals do not close over an enclosing function's local variables (only
`m` is implicitly shared, and `m`-binding itself follows *call* syntax, not lexical closure) — this
is well-established, widely-documented Roku behavior (frequently the first surprise for a JS
developer's first Roku callback). `buildAnonymousFunctionScope` therefore builds a **fully
independent** `FunctionScope` (via `buildFunctionScope({ name: 'ft_anon', params: fn.parameters,
block: fn.block })`, no parent threaded in) rather than chaining to the enclosing scope — a name
inside the anonymous body that would've resolved to an *outer local* correctly comes back
`unresolved` (compile error), not silently treated as available. Verified with a real golden test
(`packages/compiler/test/codegen/golden.test.ts`'s "does not close over the enclosing function's own
locals" case) rather than left as an assumption.

**`field`/`derived`/`state`/`read`/`watch`/function references still resolve normally inside the
body** — those go through `ctx.scriptBindings`/`ctx.classBindings` (shared, unaffected by which
`FunctionScope` is active), not through the closure mechanism at all. `m` itself is also available
inside an anonymous function's body when it's invoked as a plain (non-dot) local call — every
top-level function/sub in a `.thr` component's generated `.brs` already shares one `m` bound to the
component instance, and a plain call doesn't rebind it, so an anonymous callback assigned to a local
and called directly correctly still sees the enclosing component's own `m`. For a `.flsh` class body,
the anonymous function's own `m.<name>`/`self.<name>` rewriting reuses `ctx.selfExpr` inherited from
the enclosing method/constructor for the same reason.

**Multi-line function-literal text as an assignment's RHS is valid BrightScript** — `m.onDone =
function(x as object) as boolean\n  ...\nend function` is ordinary, syntactically legal BrightScript
(no restriction against an expression spanning multiple lines), so `printAnonymousFunctionExpression`
can return multi-line text directly as `LoweredExpression.rewrittenText` with no new splicing
mechanism — the same "just print a multi-line string" trick every other multi-statement body print
function already uses.

