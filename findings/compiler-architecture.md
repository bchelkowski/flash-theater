# Compiler architecture notes

## ⛔ Never do this

- Never write `$$` as a generated identifier prefix — BrightScript's lexer rejects `$` at the
  start of an identifier (see below). Never use a bare `_` prefix either — that's reserved
  ecosystem-wide for intentionally-unused variables. Private visibility uses `private_`.
- Never hand-roll parsing for anything that is actual BrightScript syntax (an expression, a
  statement, a function body) or XML, and never recognize a construct by sniffing comment
  *content* instead of real tokens. **The one deliberate, documented exception**: raw BrightScript
  passthrough (`' flash-theater:raw` / `' flash-theater:end-raw`) is recognized purely from
  `Trivia` comment text, not a token — see `findings/raw-brightscript-passthrough.md` for the full
  rationale (the feature's whole point is pasting real BrightScript verbatim, so a token/keyword
  grammar would force the author to think about brace-balance inside their own snippet). **Stale as
  of the flash-parser migration** — `packages/flash-parser` no longer delegates this to
  `kopytko-brightscript-parser` at parse time; it owns a full, vendored+extended BrightScript
  grammar outright (`brightscript-parser.ts`/`brightscript-lexer.ts`/`brightscript-ast.ts`), used
  for every embedded expression/statement region and for scope analysis
  (`brightscript-scope.ts`). `kopytko-brightscript-parser` survives in this repo for two narrow
  roles, never for parsing DSL source: (1) validating the compiler's own *generated* `.brs` output
  post-codegen (`packages/compiler/src/validate-generated-brs.ts`), and (2) supplying Roku's own
  builtin-function name catalog (`builtinNames`) consulted by `analysis/scope-resolution.ts` during
  DSL identifier resolution — a static platform-documentation list, not grammar/parsing. The rule
  itself still holds — never hand-roll BrightScript/XML parsing outside flash-parser's own owned
  grammar — just not via that specific package anymore. flash-parser owns the DSL-specific surface
  grammar too (`field`/`derived`/`state`/`private|public function`, the JS-shaped
  `if`/`for`/`for each`/`while`/`try`-`catch`, anonymous function expressions, the `state`/`store`
  write statements, the template's static/`{expr}` attribute convention), captures everything else
  (ordinary BrightScript expressions/statements, the template's XML tokenizing) as an opaque region
  parsed by its own grammar — see [compiler-parser-architecture.md](compiler-parser-architecture.md)'s
  "flash-parser: a real CST/AST for the DSL layer" entry.
  **Never add a new statement/expression construct to `packages/compiler` — it goes in
  `packages/flash-parser`**, which is the single place DSL grammar is now defined.
- Never assume `kopytko-brightscript-parser` can print/generate source from an AST — it can't
  (see [compiler-parser-architecture.md](compiler-parser-architecture.md)). Don't go looking for a
  `createNode`/`print()` API; it doesn't exist. This is also why `codegen/brs-emitter.ts` *prints*
  BrightScript from flash-parser's structured `Block`/`IfStatement` AST by hand (see
  [compiler-codegen-conventions.md](compiler-codegen-conventions.md)) rather than expecting either
  parser to do it.
- Never use `.toLowerCase()`/case-insensitive comparison anywhere in DSL identifier resolution —
  the DSL is deliberately case-sensitive even though compiled BrightScript is not, see
  `packages/compiler/GRAMMAR.md`.
- Never write `m.top.<newName> = value` for a name that isn't a real, declared `<field>` in that
  component's own XML — confirmed live (see "runtime-asset internal state" below): it's not a hard
  error, just a silent warning ("Tried to set nonexistent field") followed by the value never
  actually landing, so the FIRST read of it later crashes with a much more confusing "Interface not
  a member of BrightScript Component" error far from the real cause. A hand-authored runtime
  asset's (or any generated code's) own internal, non-interface state belongs on plain `m.<name>`
  (the component's own BrightScript scope), never `m.top.<name>` — `m.top` is the real `roSGNode`,
  whose fields must already exist (`<field>` in XML, or `AddFields()`) before assignment.
- Never call `.ObserveField(...)` (unscoped) anywhere in generated or hand-authored runtime-asset
  code — always `.ObserveFieldScoped(...)`. Store/theme reactivity and every `bind:`/`onChange`
  registration already use `ObserveFieldScoped` exclusively (`brs-emitter.ts`'s
  `emitFieldChangeHandler`/external-field-binding codegen); a hand-authored runtime asset (e.g.
  `FlashTheaterFocusManager`'s hold-to-repeat `Timer`) must match that, not fall back to the
  unscoped form, even for an internal node it owns and never explicitly `Unobserve`s. **Nothing in
  this codebase actually calls bare `ObserveField` anywhere** — this is a preventive rule, not a
  cleanup of an existing usage.
  Both `ObserveField` and `ObserveFieldScoped` have a function-callback form AND a message-port
  form (confirmed directly against Roku's own `ifSGNodeField` docs, 2026-08-19) — "uses a message
  port" is NOT what distinguishes them, an earlier version of this note claimed that and was wrong.
  The one concrete, docs-quotable distinction: `ObserveFieldScoped`'s function form "sets up a
  connection between the observed node's field and the current component from which this call is
  made," and its callback "will be on the thread that owns the observed node" — i.e. it's tied to
  the OBSERVING component's own scope, which bare `ObserveField`'s function form is not. Empirically
  (not from docs — from this file's own `_cancelInFlightTransition` reentrancy crash, see
  `findings/router-transitions.md`), `ObserveFieldScoped` callbacks fire SYNCHRONOUSLY, in the same
  call stack as the field write that triggered them — confirmed live via a debugger backtrace showing
  the whole call chain nested in one frame. Whether bare `ObserveField`'s function form behaves the
  same way is NOT verified either way; don't assume it does or doesn't without checking.
  **Pair every `Unobserve` call with its matching variant too**: use `UnobserveFieldScoped(...)`
  wherever the registration was `ObserveFieldScoped(...)`, never plain `UnobserveField(...)`, even
  though Roku's own `ifSGNodeField` docs say `UnobserveField()` "undoes both forms of `observeField()`
  and thus undoes both forms of `observeFieldScoped()`" (i.e. either technically works — confirmed
  live, nothing was broken calling `UnobserveField` on a scoped registration). The matching-pair
  form is enforced anyway, everywhere in this codebase (`FlashTheaterRouterOutlet.brs`,
  `FlashTheaterTaskManager.brs`, `brs-emitter.ts`'s `emitTaskManagerResultTrampolines`,
  `conditional-block-emitter.ts`'s `bind:` unobserve lines), purely so every Observe/Unobserve pair
  is symmetric and auditable at a glance, rather than relying on a correct-but-easy-to-forget
  cross-compatibility guarantee. See `findings/router-transitions.md`'s own writeup of the
  `_cancelInFlightTransition` reentrancy bug for the unrelated, ACTUAL bug this area of the code
  had (an ordering bug — stopping an animation before unobserving it — not a scoped/unscoped
  mismatch).
- Never generate (or hand-write, in a runtime asset) a function with a parameter that isn't used in
  its body without the `_` prefix — same rule generated-code unused-parameter handling already
  follows (`analysis/scope-resolution.ts`), applied consistently everywhere, not just to compiler
  output. A callback signature required by a Roku interface (e.g. `ObserveFieldScoped`'s
  `sub(event as object)`, `onKeyEvent(key as string, press as boolean)`) still needs every unused
  parameter prefixed even though the parameter itself can't be removed.
- Never hang a fresh field off SceneGraph's `m.global` node with a bare, unprefixed name (a plain
  `store`/`theme`/`focus`/`router` field key). An app's own code can write an ordinary same-named
  field onto the same shared global node and silently shadow/overwrite a built-in runtime global —
  reported live as a real concern, not a hypothetical one. Every built-in global field is
  `ft_`-prefixed (`ft_store`, `ft_theme`, `ft_focus`, `ft_router`), sourced from one place,
  `packages/compiler/src/codegen/global-fields.ts`'s `GLOBAL_FIELD_NAMES`/`globalFieldRef()` — every
  codegen emission site (registration calls, the cascade-registration loop, `read`/`watch`/
  `store(...)` rewriting, the bare-`theme`/`router` resolver branches, router action-call rewriting,
  `FlashTheaterGlobals.brs`'s own generator) reads the name from there, never from a fresh string
  literal. **Any future built-in global singleton (an analytics primitive, ...) must add its field
  name to `GLOBAL_FIELD_NAMES` and go through `globalFieldRef()` too** — this is a standing rule,
  not a one-off rename; see `findings/focus-system.md`'s `focus(<expr>)` entry and
  `findings/router.md` for the two features that already followed it. This only affects the
  internal `m.global.<field>` name, never the DSL-facing keyword an author actually types
  (`store(...)`, `theme.a.b`, `focus(...)`, `router.navigate(...)` all stay exactly as they are).

## Parser/AST, identifier resolution, codegen, and pipeline/build — see the split-out files

This file used to also cover flash-parser's CST/AST design, identifier resolution, codegen
printing conventions, and pipeline/build concerns — split out once it grew too large for one file:
[compiler-parser-architecture.md](compiler-parser-architecture.md) (flash-parser's CST/AST,
`kopytko-brightscript-parser`'s text-splice identifier-rewrite, template-markup-as-XML parsing),
[compiler-identifier-resolution.md](compiler-identifier-resolution.md) (`scope-resolution.ts`'s
one-resolver-per-identifier design, the private-function-survives-a-second-rewrite-pass bug),
[compiler-codegen-conventions.md](compiler-codegen-conventions.md) (`brs-emitter.ts`'s
AST-printing, `else`/`else if` flattening, the shared `statement-printer.ts` engine, the no-`void`-type
design, unused param/local elision), and
[compiler-pipeline-and-build.md](compiler-pipeline-and-build.md) (generated-file collision
detection, why `compile.ts` has no `fs` access, `CompileThrOptions`, the site-playground
grammar-change trap, flash-parser's local-build requirement). Update the relevant one of those in
place; this file keeps only the general pitfall checklist, naming conventions, and the
module-reorganization history below.

## Focus/`on:key` system — see `findings/focus-system.md`

Compile-time module responsibilities and real-device runtime findings for `focusable`, `on:key`,
and `FlashTheaterFocusManager` (destroyed-focused-node recovery, the `IsInFocusChain()`/
`BoundingRect()`/`IsSameNode()` real-device spike, the `m.top.<name>` silent-failure trap, and the
`{#each}`-reposition-clears-focus fix) now live in their own file — moved out once this section
grew past a reasonable size for this one. Update `findings/focus-system.md` in place for anything
new about this feature; this file keeps only the general-purpose traps that feed it (e.g. the
`m.top.<name>` rule is also in this file's "Never do this" list at the top, since it's not
focus-specific).

## Naming: `private_` prefix for visibility, `ft_` (no leading underscore) for compiler-synthesized identifiers, `$$ft_` bracket-syntax for `m`-scope compiler bookkeeping

This DSL's own original design draft assumed a `$$`-prefix for `private` visibility. **BrightScript's
lexer rejects `$` at the start of an identifier** — `$`/`%`/`!`/`#` are only valid as a
type-designator *suffix* at the end (e.g. `name$` = string variable), never a prefix. Confirmed
by generating `$$foo` and round-tripping it through `kopytko-brightscript-parser`'s own
`parse()`, which reported `Unexpected token "$"`. A bare `_foo` prefix (the first fix attempted)
was also wrong — `_` is an established ~3-year-old Roku/BrightScript ecosystem convention for
*intentionally unused variables* (mirroring this repo's own `argsIgnorePattern: '^_'` in
`eslint.config.cjs`), so reusing it for "private" would collide with that meaning.
`codegen/naming.ts` uses `private_foo` for visibility — no cross-component collision risk either
way, since every SceneGraph component has its own isolated BrightScript script context. `_` is
now enforced by the compiler for unused function arguments — see
[compiler-codegen-conventions.md](compiler-codegen-conventions.md).

**`RESERVED_IDENTIFIER_PREFIX` (every other compiler-synthesized identifier — local temp vars,
block-wrapper ids, sub names before stripping) is `ft_`, not `__ft_`.** A leading underscore of
*any* length was ruled out for this prefix too — not for the "intentionally unused" collision
reason above (that only applies to a bare `_`), but as a deliberate house-style call: nothing
compiler-generated should visually read as unused or private-by-convention. This was a rename from
an original `__ft_` scheme; the rename is purely cosmetic (`stripReservedPrefix`,
`isReservedIdentifier`, and every id-generating function in `naming.ts` still work exactly the
same way, just against a shorter prefix string) — no functional change, no new collision risk
(`analysis/binding-collisions.ts`'s `dsl/reserved-identifier-prefix` check still rejects any
DSL-authored name starting with it).

**The `$$`-prefix idea from the planning doc wasn't entirely wasted** — it's reused, bracket-syntax
only, for a value stored on the component's own `m` scope that belongs to the compiler rather than
the DSL author: a `{#if}`/`{#if:destroy}`/`{#each}` block's own wrapper-node reference, or an
each-block's `_keys`/`_nodes` reconcile-bookkeeping dict. `m["$$ft_if_1"]` is a plain
string-keyed associative-array lookup, not a dot-accessed identifier, so the `$`-as-first-character
lexer restriction above doesn't apply to it — the restriction is specifically about identifier
*syntax*, and a bracket string key isn't parsed as one. `codegen/naming.ts`'s `mFieldAccess(id,
suffix?)` is the single call site for this: it returns the `$$`-bracket form for a
compiler-synthesized id (`isReservedIdentifier(id)` true) and an ordinary `m.<id>` dot form
otherwise, so a DSL-author's own field/state/derived name (which can never collide with the
reserved prefix) is untouched. This convention applies **only** to fields stored directly on `m`
— it does not extend to anything stored on a dynamically-created child/item node (there is nothing
stored on those at all anymore, see the `{#each}` per-item-state section below for why).

**This is exactly the kind of gap an early design-validation pass is meant to catch** — a syntax
assumption from the planning discussion that doesn't survive contact with the real BrightScript
grammar or the real ecosystem's own conventions. If you find another one, fix it the same way:
verify against `kopytko-brightscript-parser`'s `parse()` and real-world convention, not intuition.

## `.flsh` class codegen pipeline — see `findings/class-pipeline.md`

Design rationale and real bugs for the `.flsh` class compilation pipeline (why it's a separate
pipeline from `compile.ts`, `GetGlobalAA()` aliasing `m.global` for class-body access to global
singletons, and why a class method's `m` is the class instance, never a SceneGraph node) now live
in their own file — moved out once this section grew past a reasonable size for this one. Update
`findings/class-pipeline.md` in place for anything new about class codegen.

## Incremental statement/expression grammar features — see `findings/statement-grammar-features.md`, `findings/operators-ternary.md`, `findings/operators-comparison.md`, `findings/operators-safe-not.md`, `findings/operators-optional-chaining.md`, `findings/anonymous-functions.md`, `findings/raw-brightscript-passthrough.md`

The running log of statement/expression grammar features added on top of this core pipeline grew
past a reasonable size for this one file and is now split by topic:
`findings/statement-grammar-features.md` (function/parameter declaration syntax, the `public
function` interface-declaration bug, the reserved `ft_` prefix, `Scene` one-time-setup ordering, the `init`/`onKeyEvent`
reserved-name gap, `for`/`for each`/`while`/`try`-`catch`, string-literal escaping),
`findings/operators-ternary.md` (Ternary), `findings/operators-comparison.md`
(Comparison/`ft_equals`, Relational/`ft_relationalGuard`), `findings/operators-safe-not.md`
(Safe NOT/`ft_not`), `findings/operators-optional-chaining.md` (codegen-only `?.`/`?[`/`?(`
insertion, no runtime helper), `findings/anonymous-functions.md` (both anonymous-function
tiers), and `findings/raw-brightscript-passthrough.md` (`' flash-theater:raw` / `' flash-theater:
end-raw` — the one deliberate exception to this file's own "never sniff comment content" rule).
Update the relevant one of those in place for the next incremental grammar feature; this
file keeps only the core pipeline/parsing architecture these features all sit on top of.

## Architecture cleanup pass — module moves, and why `each-block-emitter.ts` was left alone

Once enough features (store, theme, `bind:`, `.flsh` classes, focus/`on:key`) had each bolted on
their own small piece, a dedicated cleanup pass fixed several places where responsibility had
drifted from where CLAUDE.md's own pipeline table says it belongs:

- **`analyzeTemplateBlocks`/`analyzeConditionalBlocks`/`collectStaticallyPresentIds`** moved from
  `codegen/conditional-block-emitter.ts` into a new `analysis/conditional-blocks.ts` — pure
  template-shape analysis, no codegen, matching the existing `analysis/dependency-graph.ts`
  pattern. `codegen/conditional-block-emitter.ts` now only *emits* create/destroy subs from that
  analysis's output. `brsStringLiteral` moved into `codegen/naming.ts` alongside its other
  string-formatting primitives.
- **A new `analysis/template-walk.ts`** (`walkTemplate(node, { onElement, recurseIntoEach })`)
  replaced 8 of the ~10 hand-rolled recursive template collectors that shared the exact same
  "visit every element, optionally stop at an `{#each}` boundary" shape (`bind-targets.ts`,
  `key-bindings.ts`, `focusable-elements.ts`, `template-bindings.ts`'s `collectBindings`/
  `collectElementIds`, `conditional-block-emitter.ts`'s `collectNestedBindAttributes`/
  `collectNestedFocusableIds`, `each-block-emitter.ts`'s `collectEachItemFocusableIds`) — verified
  byte-identical output via the full golden-test suite after each conversion. The remaining ~2
  (`conditional-block-emitter.ts`'s closure-scoped `collectNestedIds`/`collectAllNestedEachIds`
  inside `analyzeTemplateBlocks` itself, and `template-bindings.ts`'s `collectEachBodyExpressions`)
  were deliberately left as bespoke walks — they return multi-value tuples or branch on an `{#if}`
  node's own condition/`{#each}`'s own collection expression, not just element attributes, so
  forcing them into the same one-callback shape would need extra parameters that stop being a
  genuine shared abstraction.
- **A new `codegen/shared-emit.ts`** holds `focusRegisterCall`/`focusUnregisterCall`/
  `emitDynamicFocusableAssignment`/`staticFocusableRegisterLine` — small BrightScript snippets
  shared across sibling emitters that can't import each other (`brs-emitter.ts` already imports
  `conditional-block-emitter.ts`), moved out of `naming.ts` since they return full code shapes, not
  just names.
- **`packages/flash-parser/src/parser.ts` split from 2165 lines** into `template-classify.ts`
  (markup/attribute classification, `{#if}`/`{#each}` marker scanning), `token-stream-parser.ts`
  (the shared `TokenStreamParser` base + `FIELD_TYPES`), `script-parser.ts`, `theme-parser.ts`,
  `class-parser.ts` — `parser.ts` itself now only holds the whole-file root-tag dispatch
  (`<script>`/`<store>`/`<theme-template>`/`<theme>`). Pure mechanical extraction, zero logic
  change — verified via the full test suite (flash-parser + compiler, all golden fixtures
  byte-identical) and a real `npm run build:roku` against `apps/sample-app` producing unchanged
  generated output. `ast.ts`'s import of `classifyTemplateElement` was repointed at
  `template-classify.ts` directly (`parser.ts` never re-exported it — it was never part of the
  package's own public `index.ts` surface either, so no external consumer needed updating).

**`codegen/each-block-emitter.ts` was deliberately left unsplit** (815 lines after the above) —
assessed, not skipped. Its size is one genuinely cohesive concern (the `{#each}` codegen pipeline:
reconcile sub → create/update-item subs → item construct/update → the inline nested-each diff),
tightly bound together by mutual recursion (`emitItemConstruct`/`emitItemUpdate` call
`emitInlineEachDiff`, which calls back into both) and one shared `ItemEmitContext` type. A
construct/update-vs-reconcile split (the shape a prior audit tentatively suggested) would need
`ItemEmitContext`, `uniqueIdExpr`, `itemKeyExpr`, and `collectEachItemFocusableIds` all exported
across a new file boundary with no reduction in actual coupling — real churn for a cosmetic win, on
this codebase's single most complex codegen module after the parser itself. Revisit only if a
future feature adds a genuinely separable concern to this file, not on line-count grounds alone.
