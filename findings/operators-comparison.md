# Comparison and relational operators (`==`/`!=`/`<`/`>`/`<=`/`>=`)

Design rationale and real bugs for the DSL's crash-safe comparison/relational sugar — six operators
sharing one flash-parser node (`BsComparisonExpression`), lowered to `ft_equals(...)`/
`ft_relationalGuard(...)`. Detected structurally via `findComparisonExpressions`, never by
reimplementing BrightScript operator precedence. See `packages/compiler/GRAMMAR.md`'s "Comparison
and relational operators" section for the precise grammar and worked examples; this file is the
*why*. For the core pipeline this sits on top of (identifier resolution, the `ft_`-prefix reserved-
identifier convention), see `findings/compiler-architecture.md`. For the ternary operator (a sibling
value-producing operator, same detection/lowering shape, built first), see
[operators-ternary.md](operators-ternary.md). For safe NOT (`!`, built directly on top of this
file's own comparison-operator precedent), see [operators-safe-not.md](operators-safe-not.md).

## `==`/`!=` and `<`/`>`/`<=`/`>=` share one AST node — widening was a token-set change, not a new node type

Relational operators were added to the DSL's existing `BsComparisonExpression` node (flash-parser)
rather than a parallel `BsRelationalExpression` — `.operator` was already a generic
`operatorToken?.text` getter (not `==`/`!=`-specific), so widening was just: move `Less`/`Greater`/
`LessEqual`/`GreaterEqual` from `COMPARISON_OPS` into `COMPARISON_SUGAR_OPS`
(`brightscript-parser.ts`), and widen the token-kind set `operatorToken` matches against
(`brightscript-ast.ts`). `isNegated` (`=== BangEquals`) needed no change — it already means exactly
"is this `!=`," unaffected by the wider operator set. `=`/`<>` deliberately stay in `COMPARISON_OPS`
(real, unguarded BrightScript) — every OTHER operator at that precedence tier is now guarded, unlike
`==` which merely coexists with still-raw `=`.

**One shared rewrite pass, not two — nesting correctness depends on it.** `.thr`'s
`rewriteComparisons`/`.flsh`'s `rewriteClassComparisons` each call `findComparisonExpressions` ONCE
and branch per-node on `access.operator` (`==`/`!=` → `ft_equals(...)`/`Not ft_equals(...)`;
`<`/`>`/`<=`/`>=` → `ft_relationalGuard(left, right, "<op>")`) rather than two separate rewrite
functions. This isn't just less code — `dropNestedComparisons` (drops a comparison nested inside
another comparison's own operand, e.g. `(a == b) == c`) needs to see EVERY comparison/relational
node in one pass to compute nesting correctly; splitting into two functions filtering by operator
subset would each compute nesting against only their own subset, silently mishandling mixed nesting
like `(a < b) == c` (the `<` would no longer be recognized as "nested inside" the `==`, since the
equality-only pass never sees it).

## `ft_relationalGuard` throws on a mismatch — there's no safe fallback *value* for "is X greater than Y?"

`ft_equals` has an obviously-correct fallback for a genuine type mismatch: `false` ("are these
equal" is always answerable). An *ordering* comparison has no such answer — "is an array greater
than a node?" isn't meaningfully `true` or `false`, so guessing either would be worse than crashing
predictably. `ft_relationalGuard(left, right, operator)` (`runtime-assets/SafeRelational/
FlashTheaterSafeRelational.brs`) instead **throws** a plain associative array (`{code:
"relational/type-mismatch", message: "..."}`) when both operands aren't confirmed orderable (both
numeric — any subtype — or both `roString`) — real BrightScript `throw` already accepts an
arbitrary value (`BsThrowStatement` existed in flash-parser before this feature, unrelated to it),
and this DSL already has `try`/`catch`, so a thrown error is idiomatically catchable rather than a
crash the app author has no recourse against. `code` (not just `message`) is a deliberate design
choice — a `catch (e)` block can branch on `e.code` instead of parsing `e.message`'s prose.

Kept as its own runtime asset (`SafeRelational/`, not folded into `SafeCompare/`) for the same
"a component using only `<` shouldn't have to ship `ft_equals` too" reasoning `SafeNot/` already
established — own `<script uri="...">`, own `usesRelationalHelper` flag threaded through
`compile.ts`/`app-compiler.ts`/`cli.ts` mirroring `usesComparisonHelper` at every call site.

## Real fallout from widening `<`/`>`/`<=`/`>=` was almost entirely in test STRING LITERALS, not `expected.brs` files

Every golden fixture using a relational operator needed its `expected.brs` regenerated (mechanical —
a small Node script recompiling each fixture and overwriting the file), but several golden test
files ALSO assert against **inline string literals** embedded in `.to.include(...)` calls (e.g.
`golden.test.ts`'s "prints a while loop" test asserting `'while i > 0\n ...'` verbatim) — these are
NOT derived from `expected.brs` and don't get caught by regenerating it; each had to be hand-updated
to the new `ft_relationalGuard(...)` form. Lesson for the next operator-widening change: grep the
test file for the OLD raw-operator string shape specifically, not just diff `expected.brs`.

**`ClassMemberInfo` test literals across the suite silently drifted out of type, uncaught by `npm
test`/`npm run lint`.** Adding a required `returnType` field to `ClassMemberInfo` (for the `derived`
type-enforcement feature below) broke the *type* of every `{ name, kind, visibility }` object
literal built directly in test files (23 in `class-identifier-rewrite.test.ts` alone) — but tests
run via `tsx` (transpile-only, no type-check: `packages/compiler/tsconfig.json` excludes `test/`),
so this was invisible to both gates. Fixed with a bulk regex pass
(`visibility: '(public|private|protected)' }` → `..., returnType: null }`), but the general lesson
holds: a test fixture's *shape* silently drifting from its source interface is a real, unflagged
risk in this codebase whenever a shared interface gains a required field — worth an occasional
`tsc --noEmit` sweep over `test/` even though it's not a CI gate.

## `==`/`!=` — the class-body rewrite CANNOT reuse `.thr`'s "recurse through the full pipeline" trick

Both `.thr` (`analysis/identifier-rewrite.ts`'s `rewriteComparisons`) and `.flsh` class bodies
(`analysis/class-identifier-rewrite.ts`'s `rewriteClassComparisons`) lower a top-level
`BsComparisonExpression` (found via `flash-parser`'s `findComparisonExpressions`) into
`ft_equals(<left>, <right>)`/`Not ft_equals(<left>, <right>)` BEFORE the rest of that file's own
identifier-rewrite pipeline runs, so a comparison operand is fully resolved (locals, `theme.*`,
`m.<name>` member access, ...) by the time the outer pass sees the assembled text. The two sides
needed genuinely different recursion strategies for each operand, though, and copying `.thr`'s
approach onto the class side broke a real test
(`class-identifier-rewrite.test.ts`'s "lowers == / != to ft_equals(...), resolving a private member
operand through the normal m./self. path") before this was noticed:

- **`.thr`'s `rewriteComparisons` recurses through the FULL `rewriteExpression` pipeline** on each
  operand (comparisons + `validateAndRewriteGlobalPaths` (theme/store) + bare-identifier rewrite),
  and it's safe for the OUTER `rewriteExpression` to then run `validateAndRewriteGlobalPaths`/
  `applyIdentifierRewrite` a SECOND time over the whole assembled text, because both of those passes
  are naturally idempotent on already-rewritten text: a rewritten `theme.*`/global-path access no
  longer looks like a bare global path, and `applyIdentifierRewrite`'s `findTopLevelIdentifiers` only
  ever flags genuinely bare identifiers — a name that already got rewritten into `m.<name>` dot-chain
  form is a `DotExpression` member on the second pass, not a bare identifier, so it's silently
  skipped. The one exception (`ft_equals`/`ft_relationalGuard` themselves, the literal call names
  spliced in) is covered by `resolveIdentifier`'s existing `ft_`-prefix reserved-identifier
  short-circuit — the same mechanism `ft_ternary_N` already relies on (see operators-ternary.md).
- **`.flsh`'s `rewriteClassComparisons` CANNOT do the same thing**, because
  `rewriteClassMemberAccesses` has no equivalent idempotency: it works by
  `findMemberAccesses(parsed, 'm', text)`, which matches ANY `m.<name>` dot-chain in the text
  regardless of whether it's original source or already-compiler-rewritten output, then looks
  `<name>` up in `classShape.allMembers` — a map keyed by the DSL-AUTHORED name (`"count"`), never
  the generated private-member name (`"private_count"`). Recursing an operand through the full
  `rewriteClassExpression` pipeline (as `.thr`'s version does) rewrites `m.count` → `m.private_count`
  during the FIRST (recursive, per-operand) pass; the OUTER `rewriteClassExpression`'s own,
  SECOND `rewriteClassMemberAccesses` call over the assembled `ft_equals(m.private_count, 5)` text
  then re-matches `m.private_count` and throws `class/unresolved-member` — `"private_count"` was
  never a declared field/method name. Fixed by making `rewriteClassComparisons` recurse into
  ITSELF only (handling nested comparisons like `(a == b) == c`, nothing else) rather than the full
  pipeline — operand text stays UN-rewritten (`m.count`, not `m.private_count`) until the single
  outer `rewriteClassMemberAccesses`/`applyIdentifierRewrite` pass in `rewriteClassExpression`/
  `rewriteClassStatement` sees the fully-assembled `ft_equals(...)`/`ft_relationalGuard(...)` text
  exactly once.
- **General lesson**: before reusing a "recurse through the full rewrite pipeline on each
  sub-fragment" pattern from one context in another, check whether every pass in that pipeline is
  actually idempotent on its own already-rewritten output — `.thr`'s bare-identifier/global-path
  passes happen to be (by construction: a rewritten reference no longer parses as the shape the pass
  is looking for), but a lookup keyed by the pre-rewrite name against a table that only knows
  pre-rewrite names (`rewriteClassMemberAccesses` against `classShape.allMembers`) is not, and fails
  loudly instead of silently — good, but only once caught by a test that actually exercises a
  *private* member operand (a public member's name is unchanged by the rewrite, so `m.x == 5` with a
  public `x` would have passed even with the bug).

## `ft_equals`'s runtime semantics — numeric cross-subtype equality, and why `roUtils.isNumber()` was rejected in favor of a fixed type-name list

The first version of `runtime-assets/SafeCompare/FlashTheaterSafeCompare.brs` did a strict
`Type(Box(left), 3) <> Type(Box(right), 3)` mismatch check before falling through to a real `=` —
which made `3 == 3.0` **false**, since `Integer` and `Float` box to different component type names
(`roInt` vs `roFloat`). That's wrong for an operator meant to behave like JavaScript's `==`: two
numeric values of different BrightScript subtypes with the same value should compare equal, not be
treated as a "type mismatch" the way `Integer` vs `Invalid` genuinely is. (`ft_relationalGuard`'s
own `ft_relIsNumberType` reuses the same four-subtype list, kept as its own copy rather than a
cross-file call so a component using only relational operators never needs to also ship
`SafeCompare`'s file.)

**Fixed by carving out three special-cased comparison strategies ahead of the generic
same-type-then-`=` fallback**, all confirmed against Roku's own developer docs before
implementation (this is a crash-safety helper — guessing at undocumented runtime behavior here
defeats the whole point):

- **Numeric** (`roInt`/`roFloat`/`roDouble`/`roLongInteger`, `ft_isNumberType`): once BOTH operands
  are confirmed numeric (of any of the four subtypes, not necessarily the same one), fall through to
  a real `left = right` directly — BrightScript promotes numeric operands of differing subtypes
  before comparing, so this is both safe (never crashes) and correct (compares by value).
- **`roArray`/`roAssociativeArray`**: `CreateObject("roUtils").isSameObject(left, right)` — reference
  identity, not deep content equality (matches JavaScript's own `==`/`===` on arrays/objects; two
  separately-built arrays with identical contents are still not `==`). **`ft_relationalGuard` has no
  equivalent** — ordering an array/AA has no meaning at all, unlike equality where identity is a
  sensible fallback, so any array/AA operand there simply fails the "orderable" check and throws.
- **`roSGNode`**: `left.subtype() <> right.subtype()` pre-check, then `left.isSameNode(right)`
  (`ifSGNodeDict`) — the node-specific identity check, not `isSameObject`, since a generic identity
  check is not documented as safe for SceneGraph nodes the way it is for a plain array/AA.

**`roUtils.isNumber()`/`isFloatingPoint()` were deliberately NOT used, despite being the more direct
API for "is this a number" — confirmed via Roku's own release notes that they require Roku OS
15.3, which was still in limited/beta rollout at the time this was written.** Using them would have
made `ft_equals` (and therefore EVERY component using `==`/`!=`) require that OS version on the
device — a much bigger compatibility jump than this DSL has ever required for a single feature (the
next-newest runtime dependency, optional chaining in generated output, only needs Roku OS 11.0+).
`roUtils` itself (`isSameObject`, used for array/AA identity) requires OS 15.0 — also newer than
11.0, but explicitly requested by the user for its reference-identity semantics, and a real (not
beta) release. Confirmed with the user before implementation, given the direct trade-off between API
simplicity and how many real devices in the field could run the compiled output.

**`Type(Box(x), 3)` (the "flag 3" form) was dropped entirely, not just for numerics.** The original
comment claimed flag `3` was "the only `Type()` form that also gives the real component name for an
`roSGNode`," but this could not be confirmed against Roku's official docs (the exact string format
flag `3`/`"v3"` produces for a node subtype is not clearly documented, and getting this wrong in a
crash-safety helper is exactly the failure mode this whole feature exists to prevent). Replaced with
the well-documented, dedicated `ifSGNodeDict.subtype()` method for the one case that actually needed
subtype differentiation (nodes) — plain unflagged `Type(Box(x))` (a long-standing, unambiguous
BrightScript idiom) is enough for every other type, including telling `roSGNode` apart from
`roArray`/`roAssociativeArray`/the four numeric subtypes in the first place.
