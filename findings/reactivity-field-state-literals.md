# Reactivity — `field`/`state` array/assocarray literal defaults

Compile-time module responsibilities and design rationale for validating `field`/`state` array and
assocarray default-value literals. See `packages/compiler/GRAMMAR.md`'s `field`/`state` sections
for the grammar itself — this file is the *why*. See
[reactivity-state.md](reactivity-state.md) for the core `field`/`state`/`store` design this builds
on (and [reactivity-theme-parsing.md](reactivity-theme-parsing.md) for `theme`), and
[requests-config.md](requests-config.md) for the `request {}` config-block split
this reuses.

## `field`/`state` array/assocarray defaults reuse `request {}`'s "capture raw, validate downstream" split — not a new mechanism

Adding `array`/`assocarray` as real `field`/`state` types meant widening the declaration-literal
grammar beyond a single scalar token for the first time since `field`/`state` existed. Rather than
inventing new machinery, this reuses the exact split `request <Kind> { ... }` already established
for its own `{ ... }` config block:

- **flash-parser stays syntax-only.** `token-stream-parser.ts`'s new `expectFieldOrStateLiteral`
  (called only from `ScriptParser`'s `parseFieldDeclaration`/`parseStateDeclaration` — deliberately
  NOT folded into the shared `expectLiteral`, which `ClassParser`/`ThemeParser` still call unchanged,
  so class fields/theme leaves stay out of scope) does nothing but confirm a leading `[`/`{`'s
  brackets balance (`findMatchingBracket`, a new sibling to `findMatchingBrace`/`findMatchingParen`)
  and wrap the whole span as an `ExpressionRegion` — same shape `parseRequestDeclaration`'s own
  `{ ... }` capture already produces. It does NOT check the contents are pure literals, and does NOT
  cross-check the bracket kind against the declared `<Type>`.
- **The compiler does the semantic depth**, in a NEW module,
  `packages/compiler/src/analysis/field-state-literals.ts` (`checkFieldStateDefaultLiterals`, wired
  into `compile.ts` right after `adaptScriptSection`, mirroring where `parseRequestConfig` already
  runs right after it). It re-parses the captured text via `parseEmbeddedExpression` (cheap — flash-
  parser memoizes this, per `compiler-parser-architecture.md`'s "expression-region.ts" entry) and walks the
  resulting `BsArrayLiteral`/`BsAALiteral` tree, rejecting anything with a non-literal leaf
  (identifier, call, ...) — `derived` exists for a computed value, `field`/`state` defaults never
  are.
- **The walking logic itself was extracted, not duplicated**: `request-config.ts`'s own
  `walkConfigValue`/`literalTokenToValue`/`RequestConfigValue` moved verbatim into a new shared
  `analysis/literal-value.ts` (renamed `walkLiteralValue`/`LiteralValue`, plus a new
  `parseLiteralRoot` wrapping the `parseEmbeddedExpression` + `findAll(...BsAssignmentStatement...)`
  dance both call sites need) — `request-config.ts` now imports from there instead of owning a
  private copy. `request-config.ts` keeps 100% of its own `request`-specific key-set/shape
  validation (`validateHttpConfig`); only the generic "walk a literal tree" part is shared.
- **`field` gets a real type↔literal-shape check that never existed before, for EVERY type, not just
  the two new ones** — `classifyLiteralShape` in `field-state-literals.ts` reads `defaultLiteral`'s
  raw text (its leading character/exact value is enough to tell a string/number/boolean/`invalid`/
  array/AA apart, no parse needed) and compares against the declared `<Type>`
  (`dsl/field-default-type-mismatch`). Before this, `field x: node = "bogus"` or `field x: integer =
  "5"` silently compiled — `expectLiteral` never cross-checked the literal's kind against the
  declared type, only GRAMMAR.md's prose claimed `node`'s literal must be `invalid`. This closes that
  gap as a side effect of building the array/AA check (the same classification has to exist either
  way), not a separately-scoped fix.
- **`state` deliberately does NOT get the type↔shape check** — its `<Type>` stays unrestricted/
  decorative (`state x: banana = 5` still compiles), matching `reactivity-state.md`'s design-fork
  section for `state`. Only the array/AA CONTENTS get validated for `state`
  (`dsl/state-default-not-literal`), never the declared type against the literal's own shape.
- **Scope is `field`/`state` only, confirmed by the user, not the whole `FIELD_TYPES`-sharing
  surface** — `.flsh` class fields (`class-parser.ts`) and `<theme-template>` leaves
  (`theme-parser.ts`) both still call the original `expectLiteral` and the original (unwidened)
  `FIELD_TYPES` constant; `ScriptParser`'s own field-only superset lives in a separate
  `SCRIPT_FIELD_TYPES` constant in `script-parser.ts`, never merged into the shared one. Regression
  tests assert both keep rejecting a bracketed literal.
