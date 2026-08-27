# Compiler architecture — parser & AST design

How `packages/flash-parser` builds a real CST/AST for the `.thr` DSL layer instead of hand-rolled
text-scanning, why `kopytko-brightscript-parser` still needs text-splice (not AST-reconstruction)
rewriting for identifiers, and how the template markup parses as real XML. See
[compiler-architecture.md](compiler-architecture.md) for the pitfall checklist, naming conventions,
and module-reorganization history this file assumes as background. For identifier *resolution* (as
opposed to parsing/splicing), see
[compiler-identifier-resolution.md](compiler-identifier-resolution.md); for codegen/printing
conventions, see [compiler-codegen-conventions.md](compiler-codegen-conventions.md); for
pipeline/build concerns, see [compiler-pipeline-and-build.md](compiler-pipeline-and-build.md).

## `flash-parser`: a real CST/AST for the DSL layer, not another hand-rolled scanner

`packages/flash-parser` is the flash-theater counterpart to `kopytko-brightscript-parser`: a
lossless CST (`getText()` round-trips the entire `.thr` source byte-for-byte) plus a typed AST,
covering the *whole* file — the `<script>`/template split, `field`/`derived`/`state`/`private|public
function`, the JS-shaped `if`/`else`, the `state` write statement, and the template markup — in one
`parse()` call. It replaced what
used to be three separate hand-rolled compiler modules
(`split/splitThrFile.ts`, `dsl-parser/dsl-parser.ts`'s regex scanner, and
`template-parser/template-parser.ts`) plus a fourth (`codegen/if-statement-rewrite.ts`, a
recursive text-splice transform) — all of that logic now lives in
`packages/flash-parser/src/parser.ts`, and `packages/compiler`'s `dsl-parser/dsl-parser.ts`
is a thin adapter (`adaptScriptSection`/`adaptTemplateSection`) from flash-parser's AST into this
package's `ThrScriptAst`/`ThrTemplateAst` shapes — not a parser.

**Why a real tokenizer instead of another text-scan pass:** the old design (regex per
declaration, `matchesWordAt`/`findMatchingDelimiter` raw-text scanning) meant every new syntax
rule was another regex or another hand-written recursive scanner, spread across multiple files,
each redoing its own string/comment-safety. A real lexer that tokenizes strings/comments
correctly gives every later "find the matching `)`/`}`" step that safety **for free**, via simple
`LParen`/`RParen`/`LBrace`/`RBrace` token depth-counting instead of raw-text delimiter matching —
see `parser.ts`'s `findMatchingBrace`/`findMatchingParen`. This is why
`packages/flash-parser/src/text-scan.ts` ended up much smaller than the compiler's original
`text-scan.ts` it replaced: `findMatchingDelimiter`/`matchesWordAt`/`startsWithWord` are simply
unnecessary once real tokens exist — only `skipStringLiteral` (used by the lexer for string
tokens) and a `findLiteralOutsideStringsAndComments` helper (used once, for the top-level
`<script>`/`</script>` split, which necessarily happens *before* any tokens exist) survived the
move. If you're about to add a raw-text scanning helper to flash-parser, first check whether
depth-counting over the token stream already gets you there — it usually does.

**The embedded-region boundary:** flash-parser's parser structurally parses only what's DSL-only
syntax. Everything that's actual BrightScript — a `derived` expression, an `if` condition, any
non-`if` statement in a function body — becomes an `ExpressionRegion`/`StatementRegion` CST node:
a raw text span **plus** an eagerly-computed nested `kopytko-brightscript-parser` parse (the same
wrap-in-a-synthetic-`sub` trick `analysis/expression-region.ts` used to do lazily, now done once
at flash-parser's own parse time and cached — see `embedded.ts`'s `parseEmbeddedExpression`/
`parseEmbeddedStatements`, both memoized by exact text). The template markup similarly becomes a
`TemplateSection` node wrapping a nested `parseXml()` result. Diagnostics from these nested
parses are translated into the outer `.thr` source's coordinates and folded into flash-parser's
own diagnostics list — a caller sees ONE list, not two parser systems. `analysis/expression-region.ts`
in `packages/compiler` now just calls flash-parser's memoized `parseEmbeddedExpression` instead of
doing its own wrap-and-parse — the same expression text is typically parsed once eagerly by
flash-parser and then looked at again by `dependency-graph.ts` and `brs-emitter.ts`; the shared
cache means only the first call actually invokes `kopytko-brightscript-parser`.

**Diagnostic codes are shared, not translated:** flash-parser's `ParseDiagnostic.code` uses the
exact same strings as the compiler's `CompileError` codes (`dsl/*`, `thr/*`, `template/*`,
`statement/*`, `expression/*`) — since flash-parser now owns the grammar those codes describe.
`compile.ts` just does `throw new CompileError(parseResult.diagnostics[0])` — the compiler's
"first-diagnostic-wins" policy (see GRAMMAR.md) is a **compiler-pipeline decision layered on top**
of flash-parser's own diagnostics list, not something baked into the parser itself. flash-parser's
parser doesn't literally accumulate unlimited diagnostics either, though — see "The compiler still
stops at the first structural error" below.

**The compiler still stops at the first structural error, but the parser never throws:** unlike the old
scanners (which threw a JS exception on the first bad token), `packages/flash-parser`'s parser
always returns a tree (with an `ErrorNode` marking where it gave up) plus a diagnostics array —
internally, `ScriptParser`'s declaration loop and block-content loop both check
`if (this.diagnostics.length > 0) break` at the top of each iteration, so in practice at most one
structural diagnostic is ever produced per parse (matching today's single-error policy) while
still being "tree-always-returned" tolerant, which is what a future linter/formatter needs even if
nothing uses multi-diagnostic recovery yet.

**A discovered-not-designed property: `statement/unterminated-if-block` (and, by the identical
argument, `statement/unterminated-else-block`) is unreachable via the real pipeline.** Since an
`if`'s (or `else`'s) own `{`/`}` are found via brace-depth-counting *within* the already-
brace-balanced range of its enclosing function body, and any `{` inside a balanced range provably
has its matching `}` also inside that range, an unclosed block can only occur when the enclosing
function's own braces are *also* unbalanced — which raises `dsl/unterminated-function` first
(checked earlier, before the parser ever descends into the block). The diagnostic codes and checks
are kept as defense-in-depth (and match `GRAMMAR.md`'s documented error codes), but don't expect to
construct a real `.thr` file that hits either — `packages/flash-parser/test/`'s suite doesn't try
to. This was true of the *old* architecture too (the two brace-matching passes were just less
obviously connected), not a regression introduced by the rewrite, and it held again unchanged when
`else`/`else if` were added: `parseOptionalElseClause`'s own `findMatchingBrace` call for `else {`
has the exact same property as the `if`-block one it mirrors.

## `kopytko-brightscript-parser` has no codegen — text-splice rewriting for identifiers

The parser package is parse-only: lossless CST, typed AST, `walk`/`findAll`, but no
AST-to-source printer. `analysis/identifier-rewrite.ts` works around this with **wrap-and-parse
text-splicing**, not AST reconstruction:

1. `analysis/expression-region.ts` (now delegating to flash-parser's `parseEmbeddedExpression`/
   `findTopLevelIdentifiers`, see above) collects every top-level identifier's **token** position
   relative to the unwrapped expression text.
2. `identifier-rewrite.ts` splices replacement text into the *original* (unwrapped) string at
   those exact offsets, **from the end of the string backward**, so earlier offsets stay valid
   after each replacement.

This only works because we resolve identifiers by exact name against a known binding table
(`field`/`derived`/function names) — there's no need to understand full expression semantics,
just where each identifier token starts and ends. This is genuinely different from how
`codegen/brs-emitter.ts` handles `if` statements (see below): identifier-rewrite is a flat
offset-splice against a binding table; printing `if` is walking a real structured AST and
re-emitting BrightScript syntax by hand, because there's a shape change (`{ }` → `then`/`end if`),
not just a name substitution.

**Identifier-rewrite runs on function bodies too**, not just `derived`/template expressions.
`codegen/brs-emitter.ts`'s `printStatement` calls `rewriteExpression`/`rewriteStatement` (the
latter a thin wrapper over flash-parser's `parseEmbeddedStatements` + the same
`findTopLevelIdentifiers`/`applyIdentifierRewrite` machinery `rewriteExpression` already used) on
every `if` condition and every `StatementRegion`/`StateAssignment` leaf in a function's `Block`.
`parseStatements` (a statement-text sibling of `parseExpression` in `analysis/expression-region.ts`)
exists separately from `parseExpression` because `parseEmbeddedExpression` wraps text as an
assignment RHS (parses one expression) while `parseEmbeddedStatements` wraps it as a sub body
(parses a sequence of statements) — same underlying `findTopLevelIdentifiers` either way,
including that an assignment's own LHS target (`x` in `x = score`) and the object side of a member
access (`m` in `m.count`) are both real `IdentifierExpression` nodes found like any other
identifier, not special-cased. All of that *resolution* logic (what a name means, not the
text-splicing) now lives in `analysis/scope-resolution.ts` — see
[compiler-identifier-resolution.md](compiler-identifier-resolution.md).

## `SyntaxNode.end` includes trailing trivia — use `lastToken(node).end` for a byte-exact splice boundary

Both flash-parser's own `SyntaxNode` and `kopytko-brightscript-parser`'s mirror the same convention:
`.end` is "just past the end of this node, **including trivia of the last child**" — so for an
embedded-expression parse like `theme.count` (wrapped as `sub ft_tmp()\n  ft_result =
theme.count\nend sub`), the `DotExpression` node's `.end` lands one character past the real `t`,
because the newline before `end sub` is attached as the `count` token's *trailing* trivia and gets
folded into the node's `.end`. `findGlobalPathAccesses` (`embedded.ts`) hit this directly: using
`dotNode.end - offset` as the chain's end offset produced a `chainEnd` one byte past
`originalText.length`, which silently discarded every top-level match (the "wrapper-only content"
guard treats an out-of-range end as *nothing to record*, not an error — see that function's bail
branch). Fixed by using `lastToken(dotNode).end` (both packages export `lastToken`) instead of
`dotNode.end` — a **token's** `.pos`/`.end` are the token's own text boundaries only, trivia is
tracked separately in `leadingTrivia`/`trailingTrivia` and never folded in. This is exactly why
`findTopLevelIdentifiers` already computed identifier offsets from `.nameToken.end`, not a node's
`.end` — same gotcha, already avoided there by construction. Any new code that needs a byte-exact
span for splicing (not just "does this node roughly cover this range") should default to the last
real token's `.end`, never a node's own `.end`, unless trailing trivia is deliberately wanted.

## Template markup is required to be valid XML — no bespoke markup parser

`{expr}` bindings only ever appear as the full value of a quoted attribute
(`width="{width}"`), never bare (`width={width}`). This means the entire `.thr` template region
parses with the *existing* `parseXml`/`XmlDocument`/`XmlElement` from
`kopytko-brightscript-parser` — `packages/flash-parser/src/parser.ts`'s
`classifyTemplateElement` just walks the resulting tree and regex-matches `^\{(.*)\}$` on each
attribute's value (moved here from the compiler's old `template-parser.ts`, same logic). There is
deliberately no separate markup tokenizer/parser in this codebase, and there should not be one
added for `{#if}`/`{#each}` either — extend the same convention (some valid-XML encoding) rather
than inventing new markup syntax.

**Three deliberate, narrow deviations from *real* XML exist within that convention** (not
contradicting the rule above — each still goes through the one real `parseXml`, just with a
relaxed/preprocessed grammar, never a second hand-rolled parser):

1. **`on:key[Key1,Key2,...]`** — `[`, `]`, `,` aren't legal XML `Name` characters at all, so this
   needed a dedicated pre-lexing transliteration pass (`onKeyPreprocess.ts`) swapping them for legal
   filler characters before the real tokenizer ever runs.
2. **Raw BrightScript passthrough** (`' flash-theater:raw`/`' flash-theater:end-raw`) — see the
   "Never hand-roll parsing" bullet in [compiler-architecture.md](compiler-architecture.md).
3. **A bare attribute with no `="value"` at all** (`xml-parser.ts`'s `parseAttribute()`) — means the
   same as `attr=""`. Added 2026-08-19, at explicit user request, specifically for
   `transition:`/`in:`/`out:`/`animate:`/router-outlet-transition attributes
   (`navigate-out:slideOutLeft` instead of `navigate-out:slideOutLeft=""`) — every one of those
   already treats an empty value as "no override, use the defaults"
   (`template-classify.ts`'s `classifyDoubleBraceOrEmptyValue`), so requiring `=""` just to spell
   "nothing" was pure ceremony. Deliberately the SMALLEST of the three deviations — no preprocessing
   pass needed, since a bare name is already a legal `Name` token on its own; only `parseAttribute()`'s
   one `else { this.error(...) }` branch needed removing. `xml-ast.ts`'s `XmlAttribute.value` was
   *already* falling back to `''` for a missing value token (defensive handling for a malformed
   `attr=` with nothing after the `=`), so every downstream consumer that already special-cases an
   empty value needed zero changes — the entire fix is contained to one parser function. General,
   not scoped to any particular attribute family: ANY attribute may be written bare (`id`, `color`,
   `bind:foo`, `on:key[OK]`, ...) — each one's own existing "value is empty" handling (whatever that
   already does today) applies uniformly, since the parser can't tell which DSL-level attribute
   family it's looking at. Was initially defended (by Claude, in conversation) as an unavoidable
   consequence of staying valid XML — WRONG: this parser is fully custom/vendored and had already
   made two prior deviations by the time that defense was made, so "not real XML" was never actually
   the constraint; it was simply a rule nobody had gotten around to relaxing yet.
