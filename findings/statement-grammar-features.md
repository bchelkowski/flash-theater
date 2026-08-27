# Statement grammar and declaration features

A running log of statement-level DSL grammar features added incrementally on top of the core
`packages/flash-parser`/`packages/compiler` pipeline: DSL function/parameter declaration syntax,
the `public function` `<interface>` wiring bug, the reserved `ft_` identifier prefix, a
`Scene`-rooted component's one-time-setup ordering hazard, the unguarded `init`/`onKeyEvent`
reserved-name collision, `for`/`for each`/`while`/`try`-`catch`, and BrightScript string-literal
passthrough/escaping. See `packages/compiler/GRAMMAR.md` for the precise current grammar of each
and `docs/features.md` for feature status — this file is the *why* each one was built the way it
was and the real bugs each one surfaced. For the core pipeline these all sit on top of
flash-parser's CST/AST (`findings/compiler-parser-architecture.md`), `codegen/brs-emitter.ts`'s
AST-printing (`findings/compiler-codegen-conventions.md`), `analysis/scope-resolution.ts`'s
identifier resolution (`findings/compiler-identifier-resolution.md`), and naming conventions
(`findings/compiler-architecture.md`). For the
ternary operator, see `findings/operators-ternary.md`. For `==`/`!=`/`<`/`>`/`<=`/`>=` comparison/
relational operators, see `findings/operators-comparison.md`. For
anonymous function expressions, see `findings/anonymous-functions.md`. For raw BrightScript
passthrough (`' flash-theater:raw` / `' flash-theater:end-raw`), see
`findings/raw-brightscript-passthrough.md`. For the `.flsh`-class
pipeline these same statement features also work inside (a class method or constructor body), see
`findings/class-pipeline.md`.

## DSL function/parameter syntax is `name: Type`, `if (cond) { }`/`{ }`-braced function bodies — not BrightScript's `name as Type`/`end function`/`then`

Easy mistake when hand-writing a `.thr` fixture from memory (made while building the `ScheduleList`
sample component): this DSL's own declaration grammar uses `:` for a function parameter/return type
(`private function makeDay(idNum: integer, title: string): object { ... }`) and `{ }` to delimit a
function body — not BrightScript's own `as`/`end function`/`end sub` shape, even though the
function *body*'s individual statements (assignments, `for`/`end for` loops, calls) **are** plain,
unmodified BrightScript passed straight through as `StatementRegion`s. The two syntaxes are easy to
conflate because they're interleaved in the same file: the DSL's own declaration shell (`field`/
`derived`/`state`/`function` headers, the JS-shaped `if`) uses the DSL's own convention;
everything *inside* a function body that isn't one of those forms is real BrightScript, unchanged.
Compiling with the wrong shape fails fast and clearly (`dsl/invalid-param`, or a JS-shaped-`if`
parse error), so this is a fast, obvious mistake to catch — not a silent-wrong-behavior trap — but
worth noting since the two grammars sit right next to each other in the same source file.

## A `public function` must get a `<interface><function>` XML declaration for `CallFunc` to find it from outside — confirmed wrong on a real device, `compile.ts` now wires it

An earlier version of this entry claimed `roSGNode.CallFunc()` resolves against any
non-underscore-prefixed top-level `sub`/`function` in the target's `.brs`, interface declaration
or not, based on `MainScene.brs` appearing to call `m.counterA.callFunc("addFavorite")` fine
before `ScheduleList` existed. That claim was never actually verified on hardware and turned out
to be **wrong**: sideloading `apps/sample-app` and driving it via real ECP keypresses (not just a
compile-time check) showed `right`/`info`/`rev`/`fwd`/`play` all silently no-op — `onKeyEvent`
fires and calls e.g. `m.counterA.callFunc("addFavorite")`, but `addFavorite()` is never entered
(confirmed by a temporary `print` at its first line never firing). Meanwhile `left`
(`m.global.theme.callFunc("switchTheme", ...)`) worked. The one difference: `switchTheme` and the
Store's `set` are declared in their component's `<interface>` (`<function name="switchTheme" />`,
`<function name="set" />` — both hand-authored runtime-asset XML), while `FavoriteCounter.xml`/
`ScheduleList.xml` (compiler-generated) had empty `<interface>` blocks — `codegen/xml-emitter.ts`'s
`interfaceFunctions` option existed and worked when passed explicitly, but `compile.ts` never
populated it from `script.functions` for an ordinary `.thr` component.

Fixed in `compile.ts`: `interfaceFunctions: script.functions.filter(f => f.visibility ===
'public').map(f => f.name)`, threaded into `emitXml`'s existing option — `xml-emitter.ts` itself
needed no change, the render loop was already there and already correct, just never fed real data.
A `public function` now gets a `<function name="<name>" />` entry (after the `<field>` entries), a
`private function` gets none, matching `GRAMMAR.md`'s `private`/`public` section. Seven golden
fixtures with a `public function` needed their `expected.xml` updated
(`visibility-fixture`, `function-body-identifier-rewrite`, `else-if-chain`, `state-reactive`,
`void-sub-fixture`, `conditional-destroy`, `conditional-destroy-siblings`); fixtures with only
`private function` (`else-if-chain`'s `classify`, `state-reactive`'s `describe`,
`visibility-fixture`'s `describePrivate`) correctly stay absent from `<interface>`.

Lesson for this file specifically: "confirmed while wiring X" is not the same as "verified on a
real device" — the original version of this entry was written from source-reading plus an
assumption that a *compile-time-only* observation (`MainScene.brs` typechecks/compiles calling
`callFunc` on an unexposed function) meant the call would actually *work* at runtime. BrightScript
has no compile-time check that a `callFunc` target exists at all, so a silent no-op and a working
call look identical until something on-device actually observes the effect.

## Reserved `ft_` prefix was never actually enforced until this feature needed it

This repo already relied on `ft_`-prefixed names (`ft_tmp`, `ft_result`, `ft_discard`, the
embedded-expression wrapper's own scaffolding) being collision-free with DSL source as an
*unenforced* convention — the DSL lexer accepts a leading `_` in any identifier, and
`binding-collisions.ts`'s checks never looked for this prefix. `{#if:destroy}` multiplies how many
`ft_`-prefixed names get generated (block ids, synthesized parent ids, construction/teardown sub
names) enough that this was worth closing for real:
`binding-collisions.ts`'s `checkReservedIdentifierPrefix` (`dsl/reserved-identifier-prefix`) rejects
any user-authored `id`/`field`/`derived`/`state`/`read`/`watch`/function name starting with
`ft_`, retroactively hardening the pre-existing synthetic names too, not just this feature's new
ones. One side benefit: this made a *separate* collision check for generated
`<componentName>__create_<id>`/`<componentName>__destroy_<id>` sub names unnecessary — once the
prefix itself is reserved, a user-authored function can never collide with one, so there's no
bespoke function-name collision check to maintain alongside it.

(`RESERVED_IDENTIFIER_PREFIX` was originally `__ft_` — a double-underscore prefix — and was renamed
to plain `ft_` afterward: nothing here should visually read as unused-by-convention or
private-by-convention, so a leading underscore was dropped from the reserved prefix entirely, not
just shortened. Purely cosmetic; every id-generating function in `naming.ts` and every collision
check here still work identically, just against the shorter string.)

## A `Scene`-rooted component's own one-time setup can't safely use static XML-declared children when construction order matters — confirmed converting `apps/sample-app/src/components/MainScene.thr`

Converting `MainScene` from hand-written BrightScript to `.thr` (using the new `extends="Scene"`
feature above) surfaced a real ordering hazard the original hand-written file's own comment already
anticipated but this repo hadn't previously documented as a general rule: `favoriteCount` must be
seeded in the global store **before** either `FavoriteCounter` child mounts, since a `FavoriteCounter`'s
own generated `init()` reads it eagerly (its `derived favoritesLabel` chain) and the store is
schemaless (`Invalid` until first written) — an unseeded read crashes with a Type Mismatch before
the scene ever renders. A statically-XML-declared child's own `init()` can run before, or
interleaved with, its parent's — Roku's child-construction order relative to the parent isn't
something a `.thr` template can control (no ordering primitive exists, and none should be
invented for this — see "Never reimplement BrightScript" rule). **The fix is structural, not a new
compiler feature: keep any child whose own mount-time behavior depends on parent-seeded state out
of the static template entirely, and `createChild()` it imperatively, in the needed order, from a
hand-called `public function`** (see `MainScene.thr`'s own `setup()`, called once via
`scene.callFunc("setup")` from `Main.brs` right after `CreateScene` — the same escape hatch
GRAMMAR.md's Focus-system "Known limitations" already documents for initial-focus overrides,
generalized here to "any one-time, order-sensitive setup a `Scene`-rooted component's own
compiler-generated `init()` can't express"). Every other child with no such dependency (`item`,
`scheduleList` in that same file) converts to an ordinary static template child with zero risk —
this hazard is specific to *this* store-seeding dependency, not a reason to avoid static children
in general.

## No reserved-name collision guard exists for `init`/`onKeyEvent` — a real, currently-unguarded footgun

A user-declared `.thr` function is emitted verbatim by name (`private_`-prefixed if `private`,
unchanged if `public` — `codegen/brs-emitter.ts`'s `emitFunction`) with **no check anywhere**
against the two names the compiler itself may also generate: `sub init()` (always emitted,
unconditionally — a user `.thr` function literally named `init` would always collide) and
`function onKeyEvent(...)` (emitted only when the template has its own `on:key[...]`/`focusable`
elements, or `<component>` itself declares `on:key[...]` — `emitOnKeyEventFunction` returns `null`
otherwise). This was a real, live risk for an earlier draft of `MainScene.thr`, which hand-declared
`public function onKeyEvent(...)` directly (needed verbatim-named at the time, since Roku's real
key-dispatch looks for that exact global-scope name, and there was no declarative way to get an
unconditional handler) — safe only because its own template had neither `on:key` nor `focusable`,
a fact that would have silently stopped being true the moment either was added, producing a
duplicate-`function`/invalid-BrightScript compile failure (caught by this repo's own "produces
`.brs` that parses as valid BrightScript with zero diagnostics" test convention, not silently at
runtime — see the Testing rules in `CLAUDE.md`). That specific risk is gone now that `<component>`
supports `on:key[...]` directly (see this file's own "synthetic multi-child wrapper" entry above,
and GRAMMAR.md's "`on:key` at the component level") — `MainScene.thr` no longer declares a function
literally named `onKeyEvent` at all, just an ordinary `private function handleKey(...)` bound
through the same declarative mechanism every other component already uses. **The general gap still
exists, though**: `binding-collisions.ts` has no `checkReservedFunctionNames`-shaped check
preventing a `.thr` author from declaring `init` (always collides) or `onKeyEvent` (collides
whenever the template would also generate one) by hand elsewhere. A real, scoped follow-up worth
doing — deliberately still out of scope here to keep this change's own diff focused.

## `for`/`for each`/`while`/`try`-`catch` — mirrors `if`'s bracket-mandatory pattern exactly, one new AST node per keyword

Same shape as `if`: a new `SyntaxKind`/AST class per keyword (`ForStatement`, `ForEachStatement`,
`WhileStatement`, `TryStatement`+`CatchClause`), dispatched from `token-stream-parser.ts`'s
`parseBlockContent` (and `class-parser.ts`'s `parseConstructorBlockContent`, separately — it's a
deliberately narrower statement grammar, see its own doc comment), each requiring `(`/`{` bracket
syntax with **no inline (braceless) form** (unlike `if`) and recursing into `parseBlockContent` for
the body so a nested DSL construct "just works" inside one. `for`/`each`/`in`/`to`/`step`/`while`/
`try`/`catch` were already distinct `TokenKind`s (shared with the full BrightScript grammar, same
"one kind space" convention `if`/`else` already use) — zero lexer/tokenKind changes needed.

**Numeric `for`'s header can't be one `ExpressionRegion`.** `<var> = <start> to <end> [step <n>]` is
for-statement-specific syntax, not a standalone BrightScript expression — `rewriteExpression` would
fail to reparse it. Decomposed into three independent `ExpressionRegion`s (`startExpr`/`endExpr`/
`stepExpr`, found by position among the node's own `ExpressionRegion` children) plus a raw,
never-rewritten loop-variable token — a new `TokenStreamParser.findTopLevelToken(start, end, kind)`
helper (bracket-depth-aware, same style as `findMatchingParen`/`findMatchingBrace`) locates the
header's own `to`/`step` without mistaking one nested inside a call's own arguments
(`for (i = f(1, 2) to 10)`).

**Breaking change, by construction, not by choice**: once `for`/`while`/`try` become DSL stop-tokens
requiring bracket syntax, raw BrightScript-shaped `for i = 0 to 10 ... end for`/`while ... end
while`/`try ... catch ... end try` stop parsing in `.thr`/`.flsh` source — exactly the same
consequence `if` already had (`if x then ... end if` was never usable either, since `parseIfStatement`
unconditionally requires `(` right after `if`). Two real fixtures used raw `for` before this feature
(`apps/sample-app/src/components/ScheduleList/ScheduleList.thr`,
`apps/focus-demo/src/components/ScrollFocusDemo/ScrollFocusDemo.thr`) and were migrated to the bracket
form in the same commit as the grammar change.

**This fixed a real, previously-silent bug**: a DSL `if`/`state`/`store`/`focus` nested inside a raw
`for`/`while`/`try` broke — the raw-accumulation stop-token scan stopped at the DSL keyword
mid-loop-body, structurally parsed just that piece, and orphaned the loop's own `end for` as an
unparseable leftover `StatementRegion`. Making `for`/`while`/`try` real structural nodes with
recursive body parsing fixes this as a side effect, with zero special-casing.

**Scope-resolution needed no new mechanism, only new reconstruction branches.**
`resolveIdentifier`'s priority list already treated a `for`/`for each` loop variable and a `catch`
variable as a real BrightScript local *before this feature shipped* — that groundwork existed for
hand-written raw passthrough text. The only wiring needed was teaching
`reconstructStatementForScope`/`reconstructConstructorStatementForScope` to reconstruct the four new
node kinds into real, unrewritten BrightScript text (`reconstructForForScope` et al.), so
`brightscript-scope.ts`'s existing analysis picks the loop/catch variable up automatically.

**`findMatchingBrace`/`findMatchingParen` scan unbounded to end-of-file, not bounded to any
enclosing scope** — a real gotcha hit writing tests for this feature. Both helpers count brace/paren
depth from a given open-token index all the way to `this.tokens.length`, with no awareness of an
enclosing function's own already-computed closing brace. In practice this is harmless for
well-formed programs (a nested `{`'s own true match is always found correctly, since generic
depth-counting is inherently correct for well-nested structures) — but it means an "unterminated
inner block" diagnostic (e.g. `statement/unterminated-for-block`, `dsl/unterminated-anonymous-
function-block`) can never be the FIRST reported diagnostic when the construct is nested inside an
enclosing function: if the inner brace is genuinely unclosed, the *enclosing* function's own
brace-matching (computed first, before `parseBlockContent` ever descends into the inner construct)
already fails and reports its own `dsl/unterminated-function` first (this repo's parser stops at the
first diagnostic). Every "unterminated X block" diagnostic added by this feature is therefore
untested in isolation via a nested-in-a-function case — only the paren-based "unterminated header/
condition" diagnostics (`statement/unterminated-for-header`, `-while-condition`, ...) are, since
parens and braces are counted independently and a missing paren doesn't compete with the enclosing
function's own brace count.

## String literals pass through to generated BrightScript verbatim — no backslash-escapes, use a doubled `""` or `Chr(34)` for an embedded quote

**A real bug, self-inflicted while writing a sample-app fixture, not caught by any test — flash-parser's own string-literal lexer accepts `\"` inside a `.thr`/`.flsh` string with zero diagnostic, and the compiler never re-validates or re-escapes literal text it didn't itself generate**, so the mistake only surfaced as a runtime crash on a real device: `state cachedResultText = "\"" + result.title + "\" (fromCache=" + ...`, written expecting JS/C-style backslash-escaping of an embedded quote, compiled cleanly but crashed with `Type Mismatch. Operator "\" can't be applied to "String" and "String"` the moment it actually ran — BrightScript has no backslash-escape syntax for string literals at all; `\` inside a string is just a literal backslash character, and this DSL's own string-literal tokens are spliced into generated `.brs` byte-for-byte (see this file's own architecture notes on how literal text generally flows through unmodified), so whatever quoting convention the author uses is whatever BrightScript itself has to parse.

**Fix, and the only two correct ways to embed a literal `"` inside a `.thr`/`.flsh` string**: a doubled double-quote (`""""` for a string containing exactly one `"`), or `Chr(34)` concatenated in (clearer, no quote-counting) — `apps/sample-app/src/components/RequestDemoScreen/RequestDemoScreen.thr`'s own `onPostLoaded` uses `Chr(34)` for this reason. Compare `codegen/request-emitter.ts`'s own `brsStringLiteral()` (`text.replace(/"/g, '""')`) — the compiler's own generated-string-literal helper already gets this right for compiler-synthesized text; the gap is only ever in DSL-author-written string literals, which the compiler has no reason to (and doesn't) re-escape.

**Lesson**: a `.thr` string literal is not a JS/TS string literal despite superficially similar `"..."` syntax — this DSL's own grammar borrows JS-shaped control flow (`if (cond) { }`, `while`, `try`/`catch` — see this file's own entries on those) but string-literal escaping was never one of the things reimplemented; it stays exactly BrightScript's own rules, silently, with no DSL-level guardrail.
