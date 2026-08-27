# `derived` declared-type enforcement — static inference and its boundary

Design rationale for `analysis/derived-type-check.ts`: `derived <name>: <Type> = <expression>`'s
declared `<Type>` was required in the grammar from day one but never checked against anything until
this module existed (see `packages/compiler/GRAMMAR.md`'s "`derived`" section for the precise
grammar and worked examples — this file is the *why* and the design forks). For the sibling
`field`/`state` array/assocarray literal-default validation (a different, structurally-simpler
check), see [reactivity-field-state-literals.md](reactivity-field-state-literals.md). For the core
reactive-data-flow design `derived` itself sits inside, see
[reactivity-state.md](reactivity-state.md).

## "Full inference" still needed a permanent `unknown` escape hatch — real `derived` expressions are dominated by opaque calls

Before writing the inferencer, a grep across `apps/sample-app/src/**/*.thr` showed real `derived`
expressions are mostly: simple field/state/derived refs and dot-chains, string concatenation,
comparisons, array/tuple literals with arithmetic — and, dominantly, **calls** (to user functions,
to `.ToStr()`/other BrightScript builtin methods, to a `.flsh` class instance constructed inline).
A type-checker that only understood literals and arithmetic would flag almost nothing useful.
"Full inference" therefore means: infer everything the DSL's OWN grammar gives a statically-knowable
type for (field/state/derived's own declared type; a same-script function's declared return type;
a `ClassName(...).methodName(...)` chain's declared method return type) — but a BrightScript
builtin call, a member/dot access off anything, an array/AA literal's own element types, and a class
instance held in a local variable are permanent `unknown`, never flagged. This boundary isn't a gap
to fill later — this compiler doesn't model BrightScript's stdlib signatures anywhere else either
(see `findings/compiler-identifier-resolution.md`'s note on `scope-resolution.ts`'s `builtinNames` catalog
being consulted only for identifier-EXISTENCE checks, never signatures), and resolving a local
variable's own type would require genuine dataflow analysis this module doesn't attempt.

**Confirmed against the real test suite, not just synthetic cases**: after wiring `checkDerivedTypes`
into `compile.ts`, the full existing test suite (1047 tests, including
`packages/compiler/test/dsl-parser/dsl-parser.test.ts`'s real parse of
`ScheduleDateMenuItem.thr`'s seven `derived` declarations) passed with **zero new failures** on the
first attempt — no real fixture anywhere in the repo tripped a false positive. `npm run build:roku`
then compiled the whole real app, including `FavoriteCounter.thr`'s `derived milestoneLabel: string
= LabeledCounter(favoriteCount, "Favorites so far").describe()` — the exact
`ClassName(...).method()` shape this feature's cross-file class-method resolution exists for,
resolved correctly against `LabeledCounter.flsh`'s real `describe(): string` declaration, with no
manufactured test needed to prove the cross-file wiring works end to end.

## `classShapesByName` is built ONCE, app-wide, in `app-compiler.ts` — not rebuilt per component, and a name collision is excluded, never arbitrarily resolved

`app-compiler.ts`'s `compileFlshClasses` already built a `Map<string, ClassShape>` internally
(keyed by each `.flsh` file's own resolved absolute path — the map key every `import` resolves
against) before this feature existed. The first version of this feature threaded that path-keyed
map straight through to every `compileThrSource(...)` call and had `checkDerivedTypes` rebuild its
own name-keyed `classShapesByName` from it, from scratch, on every single component that had at
least one `derived` — an independent code-review pass (three separate finder angles converged on
this) flagged it as genuine O(components × classes) waste where O(classes) suffices, since the
by-path→by-name reshape is invariant across the whole app compile. **Fixed by building
`classShapesByName` exactly once**, in `compileFlshClasses` itself, right after the class-import
topological loop finishes — `compileThrSource`'s own `classShapesByName` parameter (and
`checkDerivedTypes`'s) is now genuinely name-keyed already, no per-call reshape needed.

**That same review pass also surfaced a real correctness gap the rebuild's "last one wins" behavior
was hiding**: this DSL has never enforced globally-unique `.flsh` class names (only that a file's
own basename matches its own declared class name, and that an import's target actually declares the
expected name) — nothing stops two unrelated `.flsh` files in different directories from both
declaring `class Formatter`. The old per-component rebuild resolved a name collision by whichever
class happened to be inserted last while iterating `classShapes.values()` (an order tied to
class-import topological compile order, unrelated to which class a given component actually
imports) — silently misresolving a `derived`'s `ClassName(...).method()` call against the WRONG
class's shape in that case, either a false `derived/type-mismatch` on correct code or a
silently-accepted genuine mismatch. **Fixed alongside the single-build change**: `classShapesByName`
now excludes a colliding name entirely (both classes removed from the map, not one arbitrarily
kept) — a name collision falls back to this module's own existing `unknown`/unresolved path, the
same safe fallback an unresolvable call already gets, rather than ever guessing which class won.
Regression-tested in `packages/compiler/test/app-compiler.test.ts` ("two UNRELATED .flsh files
declaring the same class name never get silently conflated") — two `Formatter` classes with
DIFFERENT (incompatible) return types on the same method name, and the compile must never throw
either way.

`ClassMemberInfo` (`analysis/class-shape.ts`) gained a `returnType: string | null` field to make
this possible — `null` for every field member (a class field's value type isn't declared anywhere
in this DSL) and for a method with no return-type clause (compiles to a `sub`, see "no-value" below)
`ClassMethodDecl.returnType` was already threaded through the AST from the very first `.flsh` class
implementation; it simply had nowhere to go until this feature needed it.

## `derived/no-value-call` deliberately does NOT propagate through nested operands — and needed zero extra code to enforce that boundary

Calling a function/method with no return-type clause (compiles to a BrightScript `sub`, which has no
value) as a `derived`'s WHOLE expression is a distinct, always-wrong shape from a genuine type
mismatch — worth its own diagnostic (`derived/no-value-call`) rather than folding into
`derived/type-mismatch`'s "inferred vs. declared" framing (there's no meaningful "inferred type" for
a value that doesn't exist). It's deliberately scoped to the expression's own ROOT call only, not
propagated through a larger expression's nested operands (`derived x: T = 1 + someSub()` is NOT
flagged) — and this boundary fell out of the dispatcher's own structure for free: `inferExpressionType`
is written as a chain of `instanceof`/`if` checks, each pattern-matching only `{kind: 'named', ...}`
operands before doing its own compound-specific logic (arithmetic, string concat, ...), so a
`{kind: 'no-value', ...}` operand simply never matches any of those checks and falls through to the
same terminal `unknown` result an operand of genuinely unknown type would — no explicit
`'no-value'`-handling code needed in any compound branch. `checkDerivedTypes` only ever observes
`'no-value'` when `inferExpressionType` returns it for the expression's own root node directly.

## `AND`/`OR`/`Not` are NOT unconditionally boolean — a real false-positive bug caught by independent review, not by any test written during initial implementation

The first version of the dispatcher treated `AND`/`OR` (in the `BsBinaryExpression` branch) and
`NOT` (in the `BsUnaryExpression` branch) exactly like `==`/`!=`/`<`/`>`/`<=`/`>=`/`!` — always
`boolean`, regardless of operand types. That's correct for this DSL's OWN crash-safe sugar (those
seven always produce a real Boolean, no other meaning exists), but `AND`/`OR`/`Not` are different:
they're real, deliberately-unguarded BrightScript keywords (GRAMMAR.md never gives them DSL sugar)
with a genuine DUAL meaning on Roku — a Boolean logical op, but ALSO a bitwise op on `Integer`
operands (`flagsA AND flagsB`, `NOT mask` — checking odd/even via `count AND 1` is a real, common
idiom). Forcing `boolean` unconditionally meant `derived parityBit: integer = favoriteCount AND 1`
— entirely valid BrightScript — was rejected with a false `derived/type-mismatch`. Caught by an
independent multi-angle code review after the feature's own test suite (23 tests) and a full
`npm run build:roku` against every real app had ALREADY passed clean — none of those tests happened
to declare a `derived` using `AND`/`OR`/`Not` on non-boolean operands, so the bug was invisible to
every verification step actually run before review.

**Fix**: `AND`/`OR`/`Not` now infer `boolean` only when EVERY operand is CONFIRMED boolean; anything
else (a confirmed-numeric operand, or anything not confidently boolean) infers `unknown` rather than
guessing the bitwise result's exact numeric subtype — unlike `inferArithmeticResult` (which the
module IS confident about, since arithmetic's result-type rule is simple and universal), there's no
single documented "bitwise AND/OR/NOT always produces exactly this Integer subtype" rule to lean on,
so `unknown` (never flagged) is the honest answer here, matching this module's own "don't guess"
discipline everywhere else. Regression-tested directly (`packages/compiler/test/analysis/
derived-type-check.test.ts`) AND demonstrated in a real, compiled `.thr` fixture
(`apps/sample-app/src/components/FavoriteCounter/FavoriteCounter.thr`'s `derived
favoriteCountParityBit: integer = favoriteCount AND 1`) — a test-only regression wouldn't have
caught the ORIGINAL bug (it was already found by real fixtures compiling clean, just none of them
happened to use `AND`/`OR`/`Not` on integers), so this feature's own lesson from the section above
("confirmed against the real test suite... zero new failures on the first attempt") needed a caveat:
a clean run against every EXISTING fixture only proves no regression on code that already exists —
it says nothing about a rule that's simply too permissive in a direction no existing fixture
happened to exercise. Independent review (or a next fixture that happens to use the missed shape) is
still worth running even after "the whole app compiles clean."

## Compatibility rule: numeric-family leniency and `object`/`dynamic` as escape hatches, not exact-match-only

`typesCompatible` treats `integer`/`float`/`double`/`longinteger` as mutually compatible regardless
of exact match (mirroring `ft_equals`'s own `ft_isNumberType` leniency — see
[operators-comparison.md](operators-comparison.md) — `3`/`3.0` isn't a type mismatch there either,
so it shouldn't be one here). `object`/`dynamic` as the DECLARED side always accept anything —
verified necessary, not just convenient, against a real fixture:
`apps/sample-app/src/components/HomeScreen/HomeScreen.thr` declares `derived itemTranslation:
object = [(880-300)/2, 60]`, an array/tuple literal — `derived` was deliberately never given
`field`'s closed `array`/`assocarray` type set (see GRAMMAR.md's "`derived`" section), so forcing
exact-shape checking on an array/AA literal's own declared type would have broken real, correct,
pre-existing code the very first time this feature ran against the whole app.
