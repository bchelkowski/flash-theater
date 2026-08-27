# Ternary (`? :`) operator

Design rationale and real bugs for the ternary operator (`cond ? a : b`) — one of the
value-producing operators this DSL adds on top of plain BrightScript passthrough. Detected
structurally in `packages/flash-parser` (depth-counting, never BrightScript operator-precedence
knowledge) and lowered in `codegen/brs-emitter.ts`/`codegen/class-emitter.ts`. See
`packages/compiler/GRAMMAR.md`'s "Ternary" section for the precise grammar and worked examples;
this file is the *why*. For the core pipeline this sits on top of (identifier resolution, scope
reconstruction, the `ft_`-prefix reserved-identifier convention), see
`findings/compiler-architecture.md`. For `==`/`!=`/`<`/`>`/`<=`/`>=` comparison/relational
operators (a sibling value-producing operator, same detection/lowering shape), see
[operators-comparison.md](operators-comparison.md). For safe NOT (`!`, built directly on top of
that file's own comparison-operator precedent), see [operators-safe-not.md](operators-safe-not.md).

## Detected by depth-counting, never by reimplementing BrightScript precedence

BrightScript has no ternary operator, and `?` is never valid BrightScript expression syntax on its
own (`kopytko-brightscript-parser` only recognizes a leading `?` as a statement-level print
shorthand). This means `packages/flash-parser/src/ternary.ts` can safely tokenize `?` as its own
`TokenKind.Question` and find a ternary's `condition`/`whenTrue`/`whenFalse` boundaries with pure
**bracket-depth + a separate "ternary-depth" counter** — no BrightScript operator-precedence
knowledge needed, matching this repo's "never reimplement BrightScript parsing" rule:
`findTopLevelTernarySplit` tracks bracket depth (paren/brace/bracket — `TokenKind.LBracket`/
`RBracket` were added specifically for this, since `[`/`]` previously lexed as inert `Unknown`
tokens nothing inspected) and, only at bracket-depth 0, a ternary-depth counter incremented by `?`
and decremented by `:`; the `:` that brings the counter back to 0 is the match for the *first* `?`.
This single rule resolves both an unparenthesized chain in the false branch (`c1 ? a : c2 ? b : c`)
and unparenthesized nesting in the true branch (`c1 ? c2 ? a : b : c`) correctly, with zero
precedence-climbing logic.

**Only fires when a ternary is actually present — the "zero blast radius" property is load-bearing,
not incidental.** `buildTernaryCapableExpression` degrades to byte-identical `ExpressionRegion`
output whenever `containsTernaryAnywhere` finds nothing, and `token-stream-parser.ts`'s
`tryParseTernaryAssignment` is a non-consuming lookahead — a ternary-free plain assignment or
`state` write is never touched, never becomes the new `TernaryAssignmentStatement` node. This was a
deliberate scoping decision (not "parse every assignment structurally"), confirmed with the user
before implementation, specifically to keep the diff's risk surface small.

**Comma-separated contexts (call arguments, array/AA literal elements) needed their own split step —
found by a real failing test, not by inspection.** A naive `buildTernaryCapableExpression` call over
a whole bracket's inner content breaks on `foo(a, cond ? b : c, d)`: without comma-awareness, the
ternary-depth scan's first `?`/matching `:` pair spans `cond ? b : c, d`, silently absorbing the
next sibling argument `d` into the false branch. Fixed by `buildCommaSeparatedTernaryChildren`,
which splits a bracket's inner tokens on top-level (bracket-depth-0 relative to that span) commas
*before* running ternary detection on each segment independently — call args and array/AA literal
elements are, as far as this depth-counting approach is concerned, just "a comma-separated list of
otherwise-independent expression slots." **Known, accepted limitation**: this does NOT special-case
an AA literal's `key:` prefix — `{a: cond ? 1 : 2}` works (no top-level comma to mis-split on), but
a colon immediately preceding a ternary's own condition inside a multi-key AA literal segment could
misattribute the boundary; disambiguating that would require understanding AA-literal grammar,
which this module deliberately does not.

**`TernaryOperand`'s raw segments need the same boundary-trim `ExpressionRegion.text`/
`StatementRegion.text` already do — found via a real double-space bug in generated `.brs`, not by
inspection.** A token's leading trivia (all inter-token whitespace attaches as *leading* trivia of
the *next* token, never trailing — see trivia.ts) means the very first token of a sliced span (e.g.
`whenTrueTokens` starting right after a `?`) carries the original single space that sat before it in
source. Left unfixed, reassembling `TernaryOperand.segments` for codegen produced `ft_ternary_2
=  (ft_ternary_1)` (double space) — one space from the `${target} = ` print template, one preserved
verbatim from the source's own `? (`. Fixed by trimming only the outermost boundary of `.segments`'
output (`trimStart` the first string segment, `trimEnd` the last), never touching whitespace between
segments — the same convention `ExpressionRegion.text`/`StatementRegion.text` already apply via
`.trim()` on their own single combined string.

**Malformed-ternary diagnostics deliberately skip the doomed eager BrightScript parse, to avoid a
redundant second diagnostic.** `ExpressionRegion`/`StatementRegion` always eagerly attach a
`kopytko-brightscript-parser` parse (`attachBrightScriptParse`), and this module's own
`makeLeafExpressionRegion` does the same for a ternary-free leaf. But for the two malformed-ternary
fallback paths (`?` with no matching `:`; an empty condition/branch) the raw text is *already known*
to be invalid (it still contains a bare `?`) — attaching a parse there would just add a second,
redundant `expression/parse-error` on top of the `expression/unterminated-ternary` diagnostic
already pushed. Both fallbacks construct a bare `SyntaxNode(SyntaxKind.ExpressionRegion, tokens)`
directly instead, with no `.embedded` at all — confirmed by a failing test that originally expected
exactly one diagnostic and got two.

**`TernaryOperand` deliberately carries no eager BrightScript parse of its own combined text**
(unlike `ExpressionRegion`/`StatementRegion`/`TemplateSection`, which all eagerly attach one) — its
raw text may still contain `?`/`:`, not valid BrightScript on its own. Consequence: a malformed
*non-ternary* fragment sitting beside a valid ternary in the same expression (e.g.
`x = 1 +++ (cond ? a : b)`) is caught one layer later than every other malformed-expression case —
at codegen time, when `codegen/brs-emitter.ts`'s `lowerTernaryRhs` finally calls `rewriteExpression`
on the fully-reassembled text — rather than in flash-parser's own `diagnostics` array. Same
`expression/parse-error` code either way; accepted trade-off, not a defect (the alternative would
require flash-parser to understand enough BrightScript expression grammar to validate a
fragment-with-holes, which conflicts with the "never reimplement BrightScript parsing" rule).

**`analysis/scope-resolution.ts`'s `resolveIdentifier` needed a `ft_`-prefix short-circuit —
this is the first feature to splice a compiler-synthesized identifier into text that then goes
through a *second* identifier-rewrite pass.** Every other generated `ft_`-prefixed name in this
codebase (`ft_if_1`, `ft_each_1`, ...) is either never itself re-resolved as a DSL identifier, or
lives in bracket-string `m["$$..."]` form specifically to stay outside ordinary identifier
resolution (see `mFieldAccess`). A hoisted `ft_ternary_N` is different: once it's substituted into a
`TernaryOperand`'s reassembled text, that text is handed to `rewriteExpression` again, and
`findTopLevelIdentifiers` finds `ft_ternary_N` as an ordinary top-level identifier needing
resolution. Without a short-circuit, `resolveIdentifier` would report it `unresolved` (it never
appears in the DSL source `buildFunctionScope`'s reconstruction is built from, so `hasLocal` alone
can't recognize it) and throw `expression/unresolved-identifier` on the compiler's own generated
code. Fixed by checking `isReservedIdentifier(name)` first, before even consulting `functionScope` —
safe because a `ft_`-prefixed name can never be genuine DSL-authored source
(`analysis/binding-collisions.ts`'s `dsl/reserved-identifier-prefix` check already guarantees that).

**Scope reconstruction for a ternary-bearing statement reassembles one valid-looking BrightScript
expression rather than collecting leaf texts into an array literal** — a cleaner design than
originally planned, arrived at after noticing the array-literal approach would silently drop a real
local reference sitting in a *ternary-free* raw segment of a `TernaryOperand` (e.g. the `localVar`
in `x = (localVar + 1) + (cond ? a : b)`, which never becomes its own leaf `ExpressionRegion`).
flash-parser's `reconstructTernaryText` instead walks the tree keeping every raw segment verbatim
and replacing each ternary hole with a synthetic `ft_ternary_scope(<condition>, <whenTrue>,
<whenFalse>)` call (recursively, so a real local referenced *inside* the ternary survives too) —
producing one string that's always syntactically parseable by `kopytko-brightscript-parser`'s own
scope analysis, never emitted. Reused identically by three otherwise-unrelated scanning passes that
each just need "every real identifier/access reference in this expression, ternary or not":
`scope-resolution.ts`'s own `reconstructStatementForScope`, `focus-state.ts`'s
`collectUsedFocusStateNames` scan, and `compile.ts`'s `usesRouterAnywhere` scan. Degrades to a
plain `ExpressionRegion.text` unchanged when there's no ternary at all, so every call site can
invoke it unconditionally rather than branching on `.rhs`'s kind first.

**A `TernaryAssignmentStatement`'s own scope reconstruction is the first DSL statement form whose
reconstruction declares a REAL local for its own target, rather than a throwaway `ft_discard`.**
Every other statement kind with a reconstruction rule (`StateAssignment`, `StoreWriteStatement`,
`FocusStatement`, `ConstructorFieldInit`, `SuperCallStatement`) discards its own target/callee since
none of those names are ever real BrightScript locals — but a bare `x = cond ? a : b` follows the
DSL's existing "a plain bare assignment target is always a real local, even when it shadows a field
name" rule (see the "Assigning to a name that shadows a `field`" entry above) exactly like an
ordinary `x = expr` `StatementRegion` already does. `reconstructStatementForScope` reconstructs it
as `${target} = ${reconstructTernaryText(rhs)}` — a genuine declaring assignment — which is also why
`codegen/brs-emitter.ts`'s `printTernaryAssignment` can resolve `target` through the ordinary
`resolveIdentifier` call and expect it to always land on the `local`/no-replacement branch (kept as
an explicit check anyway, for defense-in-depth and consistency with "every identifier resolves via
`resolveIdentifier`," not because it's expected to ever hit `unresolved`).

**Branch evaluation is eager, never short-circuited — a deliberate, user-confirmed trade-off, not a
bug.** `codegen/brs-emitter.ts`'s `lowerTernaryRhs` lowers `condition`/`whenTrue`/`whenFalse`
unconditionally, in that order, *before* emitting the `if`/`else` that decides which value is
actually used — so a nested ternary sitting in the branch that turns out not to be taken is still
computed and its own `if`/`else` still runs. Implementing true short-circuit evaluation would
require every hoisted block to itself be conditionally guarded (nested `if`s wrapping each branch's
own hoisted lines) rather than a flat sequential list — a substantially larger transform, rejected
for a feature this DSL doesn't otherwise protect against either (an ordinary function call anywhere
in this codebase is never assumed side-effect-free). This was confirmed via the exact worked example
in GRAMMAR.md's own "Ternary" section before implementation began, not discovered after the fact.

**`.flsh` class methods get ternary support for free, structurally — but constructor bodies
don't, on purpose.** A `ClassMethodDeclaration.block` reuses flash-parser's own `Block`/
`parseBlockContent` unchanged (same as a `.thr` function body), so a class method can contain a
`TernaryAssignmentStatement` with zero additional parser work — `codegen/class-emitter.ts` gained
its own `lowerClassTernaryRhs`/`printClassTernaryAssignment` (routed through `rewriteClassExpression`
instead of `rewriteExpression`, otherwise an exact mirror of `brs-emitter.ts`'s versions). A
constructor body, by contrast, is deliberately its **own** grammar shape
(`SyntaxKind.ConstructorBody`, never a `Block` — see that kind's own doc comment above) precisely so
`SuperCallStatement`/`ConstructorFieldInit` stay structurally impossible to produce outside their
dedicated parse path; since it's never parsed via `parseBlockContent`, a constructor body can never
structurally contain a `TernaryAssignmentStatement` either, with no extra guard needed.
