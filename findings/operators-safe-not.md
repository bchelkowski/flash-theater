# Safe NOT (`!`) operator

Design rationale for the DSL's third value-producing sugar operator, `!<operand>` (lowered to
`ft_not(<operand>)`), added directly on top of the established `==`/`!=` → `ft_equals(...)`
pattern documented in [operators-comparison.md](operators-comparison.md) — read
that file first; this one only records what's genuinely different or new. See
`packages/compiler/GRAMMAR.md`'s "Safe NOT (`!`)" section for the precise grammar and worked
examples.

## Distinct `BsSafeNotExpression` node, never sharing `BsUnaryExpression` with real `Not`/unary `-`/`+`

`packages/flash-parser/src/brightscript-parser.ts`'s `parseNotExpression` already parses real
BrightScript `Not` into `SyntaxKind.BsUnaryExpression` (the same node kind unary `-`/`+` also
produce, one precedence tier lower). A bare `!` is recognized in the exact same function, at the
exact same precedence tier and right-recursive shape as `Not` (so `!a and b` parses the identical
tree shape as `Not a and b`) — but produces a separate `SyntaxKind.BsSafeNotExpression` node, not
another `BsUnaryExpression`. This mirrors `BsComparisonExpression` existing separately from
`BsBinaryExpression` for `==`/`!=`, and for the identical reason: the compiler's lowering
(`analysis/identifier-rewrite.ts`'s `rewriteSafeNots`) needs to find `!` specifically, without
risking a false-positive match on a real, deliberately-unguarded `Not`/unary `-`/`+` node that
some other pass might reasonably assume is plain passthrough BrightScript. Distinguishing purely
by `operatorToken.kind` on a shared node (the way `BsComparisonExpression.isNegated` tells `==`
apart from `!=`) was considered and rejected for the same reason the comparison operator's own
doc comment gives: a shared node kind means every consumer of `BsUnaryExpression` would need to
remember to re-check the operator token, an easy thing to forget once and get subtly wrong.

## Lexer: `!` was already reserved as invalid-standalone, not a new token space

Unlike `==`/`!=` (both had to be carved out of `TokenKind.Equals`'s single-`=` dispatch), a bare
`!` was *already* structurally set aside before this feature existed —
`brightscript-lexer.ts`'s `!` case only ever recognized `!=` (`BangEquals`); anything else fell
through to `TokenKind.Unknown`, since real BrightScript has no operator spelled `!` at all (its
NOT keyword is the word `Not`). Adding `TokenKind.Bang` for the bare case was a pure win-more
change with zero risk of colliding with any previously-valid BrightScript meaning — nothing in
this codebase, or the vendored BrightScript grammar it's based on, ever depended on a bare `!`
lexing to `Unknown`.

## `.flsh` class-body rewrite inherited `rewriteClassComparisons`'s self-recursion fix directly — no new bug needed to discover it

`analysis/class-identifier-rewrite.ts`'s `rewriteClassSafeNots` was written to recurse each
operand into *itself only* (handling nested `!!x`) rather than the full `rewriteClassExpression`
pipeline, from the very first version — copying `rewriteClassComparisons`'s already-hard-won fix
(see operators-comparison.md's "the class-body rewrite CANNOT reuse `.thr`'s 'recurse
through the full pipeline' trick" entry) instead of re-deriving it the hard way a second time.
The hazard is identical: `rewriteClassMemberAccesses` matches `m.<name>` by the DSL-authored name
(`classShape.allMembers` is keyed by e.g. `"isReady"`, never `"private_isReady"`), and isn't
idempotent on its own already-rewritten output. Recursing a `!`-operand through the full pipeline
would rewrite `m.isReady` → `m.private_isReady` on the inner (per-operand) pass, and the single
outer `rewriteClassMemberAccesses` call over the assembled `ft_not(m.private_isReady)` text would
then fail to resolve `"private_isReady"` as a declared member. Test coverage mirrors the
comparison feature's own lesson directly: `class-identifier-rewrite.test.ts`'s safe-NOT tests use
a **private** member operand specifically (`!m.isReady`), since a public member's name survives
rewriting unchanged and would pass even with the self-recursion fix missing.

## `ft_not`'s runtime semantics — boolean-only, no cross-subtype fallback (unlike `ft_equals`)

`runtime-assets/SafeNot/FlashTheaterSafeNot.brs`'s `ft_not(value)` checks `Type(Box(value)) =
"roBoolean"` before negating; anything else returns `false`. This is deliberately simpler than
`ft_equals`'s three special-cased comparison strategies (numeric cross-subtype, array/AA
identity, node identity) — Boolean has exactly one boxed component type (`roBoolean`), so there's
no equivalent of `3 == 3.0`'s "different subtype, same value" case to reconcile. Real BrightScript
`Not` also performs bitwise complement on an Integer operand (`Not 5` = `-6`) — `ft_not`
deliberately does NOT special-case integers the way `ft_equals` special-cases numeric types: `!`
is scoped to logical negation only (matching the feature's own JS-`!`-inspired framing), so a
numeric operand is always a type mismatch here, always `false`. Widening `ft_not` to also support
bitwise-complement-on-Integer would be a real, separate design decision (not yet requested), not
an oversight.

## Dedicated `SafeNot` runtime asset, never folded into `SafeCompare`'s own file

`ft_not` lives in its own `runtime-assets/SafeNot/FlashTheaterSafeNot.brs`, with its own
`usesSafeNotHelper` tally and `<script uri="...">` wiring (`app-compiler.ts`'s
`FLASH_THEATER_SAFE_NOT_DIR_NAME`/`FLASH_THEATER_SAFE_NOT_FILE_BASE_NAME`, mirroring
`FLASH_THEATER_SAFE_COMPARE_*` exactly) rather than being appended to `FlashTheaterSafeCompare.brs`
under the existing `usesComparisonHelper` tally. Deliberate: the two operators are unrelated
BrightScript-crash-safety helpers that happen to have shipped in the same session, not two facets
of one feature — a component using only `!` (never `==`/`!=`) should never need a
`<script uri="...">` pointing at the equality helper's file, and vice versa. Same reasoning
`usesStreamHelper`/`usesHttpRequestHelper`/`usesScaleHelper` already follow: one Pattern-B runtime
asset per independently-triggered `ft_`-prefixed helper, never bundled by convenience.
