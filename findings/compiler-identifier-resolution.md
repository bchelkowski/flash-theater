# Compiler architecture — identifier resolution

How `analysis/scope-resolution.ts` decides what a bare identifier *means* (as opposed to how it's
parsed or spliced into generated text), and a real bug found in that area: a bare/called
private-function reference surviving a second identifier-rewrite pass. See
[compiler-architecture.md](compiler-architecture.md) for the pitfall checklist, naming conventions,
and module-reorganization history this file assumes as background. For the parser/AST and
text-splicing machinery this resolution logic sits on top of, see
[compiler-parser-architecture.md](compiler-parser-architecture.md).

## `analysis/scope-resolution.ts`: one resolver for every identifier, real BrightScript locals, hard errors on the rest

Every bare identifier anywhere in the DSL — a `derived` expression, a template `{expr}`, a function
body — goes through exactly one function, `resolveIdentifier(name, bindings, functionScope)`, in
priority order: a real BrightScript local (parameter, plain assignment, `for`/`for each` variable,
`catch` variable) always shadows a DSL binding; then a declared `field`/`derived`/`state`/function
name; then `m`/a BrightScript builtin; anything left is `unresolved`. `identifier-rewrite.ts`'s
`applyIdentifierRewrite` throws a `CompileError` (`expression/unresolved-identifier`) on
`unresolved` — there's no silent pass-through of "probably a builtin" left in this codebase; if a
name isn't one of the things above, it's treated as a typo. This replaced an earlier, narrower
version of this same idea (`createIdentifierResolver(script, localNames)`, where `localNames` was
only ever a function's own *parameters*, built by hand in `emitFunction`) — the older version had
no way to recognize a genuine local variable assigned inside the function body itself (`total =
score` then `return total`), which would have been *wrongly* hard-errored (or worse, wrongly
rewritten) once unresolved names became an error instead of a silent no-op.

**Real local variables are tracked via `flash-parser`'s own vendored scope analysis, not a
hand-rolled tracker** — this repo's "never reimplement BrightScript" rule (see
[compiler-architecture.md](compiler-architecture.md)'s "Never do this" list) applies to
scope/binding analysis just as much as to parsing. `packages/compiler/src/
analysis/scope-resolution.ts` imports `parseBrightScript`, `buildBrightScriptScopes` (aliased
`buildScopes`), and `resolveBrightScriptName` from `'flash-parser'` (its own vendored
`brightscript-scope.ts` module) — not from the npm `kopytko-brightscript-parser` package.
`builtinNames` (see below) is the one remaining live `kopytko-brightscript-parser` import in this
file. `buildFunctionScope` builds one `FunctionScope` per function (once, in `emitFunction`,
reused for every statement inside — not rebuilt per identifier) by:
1. Reconstructing a BrightScript-*shaped* (not this DSL's JS-shaped) rendering of the function
   body from the already-parsed `Block` AST — the same `if`/`else if`/`else` → `then`/`end if`
   flattening `brs-emitter.ts` uses for real codegen (see
   [compiler-codegen-conventions.md](compiler-codegen-conventions.md)), but with every identifier left
   exactly as written. This reconstruction is *only* for scope analysis, never emitted — the DSL's
   own `if (x) { }` isn't valid BrightScript syntax on its own, so a clean parse needs the
   `then`/`end if` shape first.
2. Parsing that reconstruction with `flash-parser`'s `parseBrightScript()`, then running
   `buildBrightScriptScopes`/`resolveBrightScriptName` on the result — flash-parser's own vendored
   scope machinery, not something delegated to `kopytko-brightscript-parser` at analysis time.

**One trap avoided: a `state x = expr` write must never look like a plain assignment to the
reconstruction**, or `buildScopes` would register `x` itself as a new local declaration (per
BrightScript's own rule that "variables assigned with `=` are local to their function scope") —
which would then wrongly shadow every *later read* of that same state name for the rest of the
function. `reconstructStatementForScope` sidesteps this by reconstructing a `StateAssignment` as
`ft_discard = <the RHS expression, untouched>` — a throwaway assignment target that keeps the
RHS's own identifiers (which may reference real locals) in the reconstructed tree without ever
declaring the state name itself as one.

**Builtins are matched via `kopytko-brightscript-parser`'s own catalog** (`builtinNames`,
case-insensitively — BrightScript itself is case-insensitive there, unlike this DSL's own names),
not a hand-maintained list — it's kept in sync with the extension's and formatter's own builtins
lists already, so this repo doesn't need a fourth copy. `m` is a separate, explicit special case
(`analysis/scope-resolution.ts`'s `SPECIAL_NAMES`): it's SceneGraph's component-scope variable, not
a "function", so it isn't in the builtins catalog at all, but it's always valid.

**Extending this further** (the next binding kind, whatever it is) means adding one bucket to
`ScriptBindings`/`buildScriptBindings` and one branch in `resolveDsl` — every caller (rewriting,
`dependency-graph.ts`, `template-bindings.ts`, `codegen/*`) picks it up automatically through this
one module; nothing else needs to change.

## A bare/called private-function reference can survive a second `applyIdentifierRewrite` pass — needed a `resolveDsl` fallback, not just field/derived/state's own `m.`-prefix trick

Confirmed as a real, reproducible bug (not hypothetical) while building the task manager's
`onAlertChanged(<callback>)` feature — see `findings/task-manager-alerting.md` — but the root cause is
general, in `identifier-rewrite.ts`/`scope-resolution.ts`, not specific to that feature. A plain
`router.navigate(getPath())`, where `getPath` is a `private function`, threw
`expression/unresolved-identifier` on `"private_getPath"` even on the shipped, pre-existing router
codepath, once actually exercised.

**Why**: `buildRouterActionReplacement`/`buildTaskManagerOnAlertChangedReplacement` (and any future
builder shaped the same way) pre-rewrite each of a call's own arguments via a *nested*
`rewriteExpression` call — including that argument's own `applyIdentifierRewrite` pass — then splice
the fully-rewritten result into a larger composed replacement string (`m.global.ft_router.callFunc
("navigate", {path: private_getPath(), ...})`). That composed string becomes the return value of
`validateAndRewriteGlobalPaths`, which the OUTER caller (`rewriteExpression`/`rewriteStatement`) then
runs its OWN, second `applyIdentifierRewrite` pass over — since `applyIdentifierRewrite` always runs
last, over whatever `validateAndRewriteGlobalPaths` returns, with no way to know part of that text
was already resolved once. `findTopLevelIdentifiers` deliberately walks every `BsIdentifierExpression`
with zero regard for call-argument nesting depth (see `flash-parser`'s own doc comment on it), so the
already-rewritten `private_getPath` gets found again, unchanged from any other bare identifier's
point of view.

**Why a `field`/`derived`/`state` reference never had this problem**: its resolved form is always
`m.<name>`/`m.top.<name>` — a `DotExpression`, whose `.member` half `findTopLevelIdentifiers`
*deliberately* skips (see
[compiler-parser-architecture.md](compiler-parser-architecture.md)'s "The embedded-region boundary"
and the `theme`-access finding in `findings/reactivity-theme-parsing.md`). Only the bare `m`
re-surfaces on a second scan, and `m` resolves as `special` unconditionally — harmless. A **private
function**'s resolved form (`private_<name>`, from `naming.ts`'s `privateFunctionName`) is a bare
top-level identifier by construction (BrightScript functions are referenced/called by their own
plain name, never through `m.`), so it has no equivalent free pass.

**Fix, in `scope-resolution.ts`'s `resolveDsl`**: after the existing exact-name checks, a fallback
recognizes `private_<x>` as already-resolved (`replacement: null`, i.e. "leave exactly as printed")
whenever `<x>` (the name with the `private_` prefix stripped) is itself a declared private function
— checked strictly *after* the exact-name match, so a component that happens to declare a private
function literally named `private_<x>` still resolves to its own real `private_private_<x>` first;
the fallback only ever fires when `private_<x>` isn't itself a declared name, which can only happen
as the resolved form of some other function. No `public function` equivalent is needed — a public
function's replacement is its own unchanged name, so a second scan just re-resolves it to the exact
same thing via the ordinary `publicFunctionNames.has(name)` branch, no special-casing required.

**Lesson for the next builder shaped like `buildRouterActionReplacement`**: any replacement text
assembled from pre-rewritten fragments (not just simple `m.`-prefixed reads) needs to be checked
against a second `applyIdentifierRewrite` pass before shipping — don't assume "it worked for the one
test case I wrote" generalizes, since this exact gap sat unnoticed in the router feature until a
different feature's own test happened to pass a bare private-function value through the same shape
of code path.
