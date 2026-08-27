# Optional chaining (`?.`/`?[`/`?(`/`?@`) inserted into generated `.brs`

Codegen-only feature: every member/index/call access in generated output gets `?` inserted before
its operator, so a chain never crashes on an intermediate `invalid`. No DSL grammar work — see
`packages/compiler/GRAMMAR.md`'s "Chain safety" section for the user-facing rules (uniform scope,
the three excluded positions, hand-writing `?.` in source is a compile error).

**Ship discipline lesson: local test coverage (`kopytko-brightscript-parser`'s
`validateGeneratedBrs`) is not the same guarantee as a real Roku compile.** This feature's initial
implementation passed all 1700+ local tests, `npm run lint`, and `npm run build:roku` cleanly —
and still failed to install on a real device with "Install Failure: Compilation Failed." See
"Roku rejects `?(` on a bare global/built-in function name" below for the bug and the live-device
bisection that found it. Sideload-verify a codegen change that touches syntax this broadly, not
just the local validator, before calling it done.

## Grammar/lexer already existed — this was prep, not the feature

`BsOptionalChainingExpression` (`packages/flash-parser/src/brightscript-ast.ts`),
`QuestionDot`/`QuestionBracket`/`QuestionParen`/`QuestionAt` tokens
(`brightscript-lexer.ts`/`tokenKind.ts`), and the parser's `parseOptionalChaining`
(`brightscript-parser.ts`) were all added in an earlier session, ahead of this feature, purely so
the grammar could recognize `?.`/`?[`/`?(`/`?@` in *input* — nothing consumed them for codegen
until this feature. `tokenKind.ts` even had a dangling comment pointing at a GRAMMAR.md "Chain
safety" section that didn't exist until this feature shipped it.

## `findChainAccesses` (`packages/flash-parser/src/embedded.ts`) — the spine-vs-subtree split

Walks every `BsDotExpression`/`BsIndexExpression`/`BsCallExpression` node in a parsed
expression/statement (not just top-level — `findAll`'s own `walk()` already recurses into call
arguments and index subscripts). Before recording an operator position, it pre-computes an
excluded set by walking the **spine** (`.object`/`.callee` links only) of:
- Every `BsAssignmentStatement.target`.
- Every increment/decrement `BsExpressionStatement` (`x++`/`obj.count--`) — detected via
  `findToken(PlusPlus)`/`findToken(MinusMinus)` on the statement itself, not the operand.
- Every bare-void-call `BsExpressionStatement` whose `.expression` is itself a `BsCallExpression`.

**The exclusion is the whole spine, not just the final segment** — deliberately. Roku rejects
`?.`/`?[`/`?(` at these positions ([docs](https://developer.roku.com/dev/docs/expressions-variables-types),
"Optional chaining operators": can't be an assignment target, can't be a fully standalone call
statement), but a *partial* rewrite (`obj?.foo.bar = 5`) wouldn't add real safety anyway — if
`obj?.foo` already short-circuited to `invalid`, the plain `.bar = 5` on it still crashes.

**Only the `.object`/`.callee` link is excluded, never `.indices`/`.args`.** A subscript or call
argument is an independent read sub-expression, not part of the write/void-call spine:
`arr[getIndex().value] = x` → `arr[getIndex?()?.value] = x` (target `arr[...]`'s own `[` stays
plain, but `getIndex().value` inside it is fully chained); `obj.foo.bar(x.y.z())` as a bare
statement → `obj.foo.bar(x?.y?.z?())` (outer spine plain, argument chained).

`BsCallExpression`'s `(` token lives on the nested `BsArgumentList` node, not the call node itself
— `call.argumentList.syntax.findToken(TokenKind.LParen)`, not `call.syntax.findToken(...)`.

**Third exclusion, found only via live-device sideload, not any local check: a call whose callee
is a bare identifier never gets `?(`, in ANY context — not just the spine-exclusion contexts
above.** `someFunction(a, b)` stays `someFunction(a, b)` even as a read (an assignment RHS, a
`derived` default, a call argument) — `?(` is only emitted when the callee is itself a chain
(`obj.method()` → `obj?.method?()`). See "Roku rejects `?(` on a bare global/built-in function
name" below for why and how this was found. Implemented as a `continue` guard in the call-recording
loop (`node.callee?.syntax.kind === BsSyntaxKind.BsIdentifierExpression`), not as another
spine-exclusion source — it's a fundamentally different rule (applies to reads too, not just
writes/void-statements) and needed its own dedicated flash-parser tests
(`findChainAccesses`'s own test suite, `packages/flash-parser/test/embedded/embedded.test.ts`) to
pin down precisely: a bare call's own arguments are still fully chained, and a later hop off a
bare call's *result* still gets its own `?.`/`?[` (`someFunction(a).result` →
`someFunction(a)?.result`) — only the bare call's own `(` is excluded.

## No runtime asset — pure syntactic transform

Unlike `==`/`!=`/`!` (see [operators-comparison.md](operators-comparison.md)/
[operators-safe-not.md](operators-safe-not.md)), this needs no `ft_`-prefixed helper function, no
`runtime-assets/` directory, no `<script uri="...">` wiring, no per-component opt-in tally. `?.`
etc. are BrightScript's own built-in operators (OS 11.0+) — the compiler just inserts characters.

## Must run as the literal LAST splice pass, in `identifier-rewrite.ts`'s `rewriteOptionalChains`

Every other pass in the pipeline (`validateAndRewriteGlobalPaths`, `rewriteComparisons`,
`rewriteSafeNots`, `rewriteAnimationControlCalls`, `rewriteStreamSubscribeBoundReferences`,
`applyIdentifierRewrite`) pattern-matches the *plain* `BsDotExpression`/`BsCallExpression`/
`BsIndexExpression` shapes; `?.`/`?[`/`?(` parse into the distinct `BsOptionalChainingExpression`
node none of them recognize. Running chain-optionalization any earlier would silently break every
one of those finders the moment a chain they depend on had already been partially rewritten.
Running it last also means it protects member/index chains the *compiler itself* assembles during
earlier passes (`m.global.ft_theme.colors.primary`, `m.top.<field>`) — the intended uniform scope,
not just literal source characters. (Compiler-assembled runtime-helper CALLS specifically —
`ft_equals(left, right)`, `ft_relationalGuard(...)`, `ft_not(...)` — are the one exception: their
own callee is a bare identifier, so per the third exclusion below their own `(` never gets `?`,
even though their *arguments* do.)

**Corollary, easy to get wrong: every internal recursive rewrite call must use
`rewriteExpressionWithoutChainOptionalization`, never the public `rewriteExpression`.**
`rewriteComparisons`/`rewriteSafeNots`/`rewriteStreamSubscribeBoundReferences`/
`rewriteAnimationOnFinishCalls`/`rewriteTimerClearCalls`/`validateAndRewriteGlobalPaths`'s default
`rewriteArg` all recurse into a *sub-span* of the text the outer call is still assembling. If any
of them called the public `rewriteExpression`, that sub-fragment would get `?`-inserted
immediately, before being spliced back into the outer text — and a *later* sibling pass in the
same outer call (e.g. `rewriteSafeNots` running after `rewriteComparisons`) would then parse text
that already contains compiler-inserted `?`. This actually surfaced as a real bug during
implementation: the reject-hand-written-`?.`-in-source guard (`checkNoHandWrittenOptionalChaining`,
called at the top of every `rewriteExpressionWithoutChainOptionalization`/`rewriteStatement`
invocation) can't distinguish "the author wrote this `?`" from "an earlier pass in this same
compile already inserted it" — so a premature insertion made the guard throw a false positive on
its own prior output (`!(count == 0)` → comparisons pass produces `!(ft_equals(m?.top?.count, 0))`
→ safe-NOT's own recursive call on that already-`?`-ized operand trips the guard). Fixed by
switching every one of those internal recursion points to the "without" variant, so `?` insertion
happens exactly once, at the true outermost call. `key-bindings.ts`'s `rewriteKeyHandlerCall` needs
the same "without" variant for its callee specifically — that callee becomes the spine of a
void-context call *assembled outside this module* (the `on:key` trampoline discards the result),
so `findChainAccesses`'s own AST-based void-call detection can never see it as part of a real
statement if it were rewritten through the full pipeline in isolation.

## Text-substring "is X referenced" checks must tolerate an inserted `?`

A second real bug, same root cause, different shape: `codegen/class-emitter.ts`'s
`hoistGlobalAAIfNeeded` decided whether to prepend the `ft_globalAA = GetGlobalAA()` hoist line by
checking `body.includes('ft_globalAA.')` — a literal substring with the dot immediately following.
Once the body could legitimately contain `ft_globalAA?.global` instead, that substring stopped
matching and the hoist silently vanished (confirmed via `git stash` bisection: passed on `main`,
failed after this feature). Fixed by also checking `` `${CLASS_GLOBAL_AA_LOCAL_NAME}?.` ``. The
identical class of bug already existed for the runtime-helper-usage tallies
(`compile.ts`/`class-emitter.ts`'s `usesComparisonHelper`/`usesSafeNotHelper`/etc., checking
`brs.includes('ft_equals(')`) — fixed once, centrally, via `codegen/naming.ts`'s
`usesRuntimeHelperCall(brs, name)` (checks both `name + '('` and `` name + '?(' ``). **Any future
`text.includes(identifier + '.'/'['/'(')`-style detection needs the same treatment** — grep for
`` .includes(`${...}` ``) patterns ending in an operator character when adding a new one.

## Roku rejects `?(` on a bare global/built-in function name — found only by sideloading a real device

**The most consequential bug this feature surfaced, and the reason to sideload-verify a
codegen change this broad rather than trusting `validateGeneratedBrs`.** The initial
implementation applied `?(` to *every* call uniformly (matching decision #1's "every access, even
a lone non-chained one"), including calls whose callee is a bare identifier — a `public`/`private
function` the DSL author declared, a compiler runtime helper (`ft_equals`, `CreateObject`, ...), or
any other plain global function reference. `kopytko-brightscript-parser` (the package
`validate-generated-brs.ts` uses) parses `?(` on a bare identifier without complaint, and every one
of ~1700 local tests plus `npm run build:roku` passed cleanly. **The real Roku compiler does not
accept it**: sideloading `apps/sample-app` to a live device failed with `Install Failure:
Compilation Failed.\nHomeScreen\n` — a genuine install-time error with no line number, only the
component name. Bisecting `HomeScreen.brs` found every `?(` occurrence had a bare-identifier callee
(`private_pickWelcomeText?(...)`, `private_buildItemContent?()`, `CreateObject?(...)`); Roku's own
docs independently confirm this ("the `?(` operator does not work on built-in or global
functions").

Fixed in `findChainAccesses` with a one-line guard: skip recording a call's `(` when
`node.callee?.syntax.kind === BsSyntaxKind.BsIdentifierExpression`. Confirmed by re-sideloading:
install succeeded, and querying the live SceneGraph node tree over ECP (`kopytko-roku ecp app-ui`)
showed the sample app's new chain-safety demo label (`FavoriteCounter.thr`'s `pendingBadgeDemo`,
reading a chain rooted in a field that's genuinely `invalid`) rendering its fallback text
correctly, with no crash, on real hardware.

**Practical fallout, worth knowing before touching this area again:**
- This fix required a SECOND full pass regenerating every golden fixture and re-fixing ~35 inline
  test assertions (the same mechanical `?`-insertion/removal churn as the first pass, just in the
  opposite direction for bare calls) — see "Golden-fixture blast radius" below.
- `class-emitter.ts`'s `super(...)` fix (see "Which codegen paths" below) had to be reverted — a
  base-class factory call is exactly a bare-identifier callee.
- `codegen/naming.ts`'s `usesRuntimeHelperCall` no longer needs to check both `name + '('` and
  `` name + '?(' `` — a runtime helper's own call can never legally gain a `?`, so the `?(` branch
  was dead code and has been removed; the doc comment there explains why the plain check is safe.
- A future extension to this feature (if the exclusion rule ever needs refining) should sideload a
  real Roku app *before* considering the change done — this bug was invisible to every automated
  check available in this repo.

## Which codegen paths are "through the pipeline" vs. plain string templates

Only genuinely DSL-authored expression/statement text flows through `rewriteExpression`/
`rewriteStatement` (and therefore gets `?`-ized). A surprising amount of adjacent codegen is a
plain TS template string built OUTSIDE that pipeline and stays completely untouched even when it
looks like it should qualify — useful to know before assuming a golden-fixture diff is wrong:
- `each-block-emitter.ts`'s `ft_collection = ft_collection.getChildren(-1, 0)` (node-collection
  conversion) — fixed compiler plumbing, never rewritten, regardless of mode.
- Animation's init-time field snap (`m["$$ft_anim_<name>"] = m.top.findNode("...")`) and the
  `ft_animate_from_<name> = m.<node>.<field>` capture line — plumbing; only the DSL-authored value
  spliced into the `keyValue` array literal is independently rewritten first.
- `focus(...)`'s `m.top.findNode(<arg>)` wrapper and `store(...)`'s `.callFunc("set", "<name>",
  <value>)` wrapper — only `<arg>`/`<value>` (the DSL-authored piece) is rewritten in isolation
  before being spliced into the fixed wrapper text; the wrapper's own calls never gain `?`.
- `class-emitter.ts`'s `emitPrototypeInit` (`${baseName}(${rewrittenArgs})` for `super(...)`) —
  its arguments *do* go through `rewriteClassExpression` first, but the wrapping call itself never
  re-enters the pipeline. Briefly hand-patched to `${baseName}?(${rewrittenArgs})` during initial
  implementation (reasoning the same way as the other bullets here) and then reverted — `baseName`
  is a bare class-factory identifier, exactly the case "Roku rejects `?(` on a bare global/built-in
  function name" above rules out; the live-device sideload that found that exclusion also proved
  this specific patch wrong.

## DSL-author gotcha: you can't simulate a "throws on missing key" bug with a plain dot-chain anymore

Every generated member access is chain-safe by design (that's the whole feature) — so DSL source
like `requestData.brokenConfig.userId`, written specifically to crash when `brokenConfig` is an
undeclared AA key, compiles to `requestData?.brokenConfig?.userId` and silently returns `invalid`
instead. **Live-device-caught**: `apps/requests-demo`'s `SafeBuildRequest.thr` was written to
demonstrate `buildRequest`'s own try/catch safety net by deliberately triggering exactly this kind
of crash — it never did, on real hardware, because chain safety caught it first, so the demo's own
"buildRequest: FAILED" readout never appeared even on the button explicitly labeled "buildRequest
throws" (see `findings/requests-demo-app.md`'s device-pass writeup). **Fix**: a raw
`' flash-theater:raw` / `Throw "..."` / `' flash-theater:end-raw` block — optional chaining only
ever touches a member/index/call *expression*, never a raw passthrough statement, so it's the one
reliable way left to genuinely simulate a throwing hook from DSL source.

## Golden-fixture blast radius

The "uniform / run-last" scope decision (confirmed with the user before implementing — the
alternative, narrower scope would have required teaching every structural finder above to
tolerate partially-optional-chained input, a much larger and riskier change) means nearly every
existing golden fixture's `expected.brs` needed regenerating twice — once for the initial
implementation, again after the bare-identifier-callee fix above reversed `?(` on every plain
function call. Neither regeneration is a sign of a bug on its own; both are expected mechanical
fallout of a scope decision, verified line-by-line against the design rules each time (see the
`hoistGlobalAAIfNeeded` and `super(...)` entries above for the two cases where a "just
mechanical" diff actually hid a real bug — always read the diff, don't rubber-stamp it).

`packages/compiler/test/golden/optional-chaining-basic/` demonstrates a multi-hop `derived` chain,
a template binding, a bare void-context call statement with its own argument still chained, and an
assignment to a multi-hop target left untouched — but its one bare-identifier call
(`private_logEvent(...)`) is *also* a void statement, so it doesn't distinctly exercise the
bare-callee exclusion from the void-statement exclusion (both rules independently produce the same
"leave it plain" outcome there). The distinct case — a bare call used in a genuine READ context,
where only the callee-is-bare-identifier rule (not the void-statement rule) explains why it stays
unwrapped — is covered instead by `findChainAccesses`'s own flash-parser unit tests (`someFunction(a,
b)` as a plain expression, not a statement) and, end-to-end, by `apps/sample-app`'s
`FavoriteCounter.thr`: `derived pendingBadgeLabel: string = describePendingBadge(pendingBadge)` —
`describePendingBadge(...)` is a `derived` RHS (unambiguously a read, no void-statement rule in
play) and still compiles to a bare, unwrapped call.
