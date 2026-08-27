# Reactivity — `theme` access resolution and `.thr` root-tag dispatch

Compile-time module responsibilities and design rationale for resolving `theme.a.b` dot-chain
access, and for how `parser.ts` decides what kind of `.thr` file it's looking at
(`<theme-template>`/`<theme name="...">`/the `<store>` rejection/`<component>`/the synthetic
multi-child wrapper). Split out of [reactivity-state.md](reactivity-state.md), which covers the
rest of the core reactive-data-flow design (`field`-shadowing, `store`/`watch`/`read`, `state`) —
see that file's own intro for the full sibling-file list.

## `theme` global access resolution walks real `DotExpression`/`CallExpression` shapes, not `findTopLevelIdentifiers`

`findTopLevelIdentifiers` (embedded.ts) deliberately skips `.member` — correct for the ordinary
identifier-rewrite case (§"text-splice rewriting for identifiers" above), where only the *name* of
a binding matters. Validating a `theme.a.b` path needs the chain's actual shape, so
`findGlobalPathAccesses` walks `kopytko-brightscript-parser`'s `DotExpression.object`/`.member` and
`CallExpression.callee`/`.args` directly. The one subtlety: it must only attempt to flatten a chain
at its **outermost** node — one whose parent isn't itself using it as a `.object`/`.callee` base
(`node.parent.childNodes[0] === node` for a `DotExpression`/`IndexExpression`/`CallExpression`
parent). Without that check, a chain broken by an index or nested call (`theme.list[0].x`,
`theme.get().x`) would still get re-discovered via plain recursive descent into the broken node's
own children, surfacing a truncated prefix (`theme.list`, `theme.get`) as if it were a valid access
on its own — a real correctness bug caught in review, not just a style choice. The fix generalizes:
skip the flatten-attempt at any node that's structurally a postfix-chain continuation of its
parent, and only ever attempt at chain roots; genuinely independent accesses elsewhere (call
arguments, index subscripts) are still found via the normal recursive walk.

`GLOBAL_ROOT_NAMES` (defined in `analysis/identifier-rewrite.ts` and
`analysis/expression-region.ts`) is now `['theme', 'router', 'taskManager']` — it no longer
includes `store`, which used to go through this exact same generic dot-chain scanner (`store.x`,
`store.fn(args)`), but the store/theme redesign made `store` a fixed, three-production grammar form
(`read`/`watch`'s RHS, or a `store(<key>) = <expr>` write statement) parsed structurally by
flash-parser instead, so it never reaches this text-scanning machinery at all — see
[reactivity-state.md](reactivity-state.md)'s "Store rewriting is structural, not scanned" section.
(`router` and `taskManager` were added later when those features shipped through the same scanner
— see `findings/router.md`.)

## `.thr` root-tag dispatch: `<theme-template>`/`<theme name="...">` reuse `<script>`'s literal-prefix-scan pattern, not real XML tag parsing

`parser.ts`'s `parseThrFile` distinguishes a component/theme-template/theme-variant file by a
plain string-prefix check on the (post-whitespace) source, exactly like the original `<script>`
check — no bespoke XML attribute parser for `<theme-template default="dark">` or `<theme
name="dark">`. The open tag's `>` is found with a plain `indexOf`, its *entire* raw text (including
attributes) is kept as one `EmbeddedText` token for round-trip fidelity, and the AST layer
(`ThemeTemplateSection.defaultVariantName`, `ThemeVariantSection.variantName`) re-derives the
attribute value with a small regex against that token's text on read — the parser itself carries no
side-channel state about what the attribute means, matching how `FieldDeclaration.type` already
reads straight from a child token rather than something the parser computed and stashed.
`<theme-template>`/`<theme>` get a new sibling `ThemeParser` for the nested group/leaf grammar,
sharing brace-matching and token-stream helpers with `ScriptParser` via a common
`TokenStreamParser` base class rather than duplicating them.

A `<store>` prefix match is a **dedicated rejection**, not a parse attempt: `<store>` was a real
root tag in the original store/theme design (reusing `ScriptParser.parseScriptSection()`
verbatim, parameterized by `SyntaxKind` — `ScriptSection` vs the since-removed `StoreSection`),
but the store/theme redesign made it a built-in runtime primitive instead (see GRAMMAR.md's
"Global store") — a `.thr` file starting with `<store>` now pushes a single
`thr/store-tag-removed` diagnostic pointing at the `read`/`watch`/`store(...)` replacement
grammar and returns an empty `ErrorNode`, rather than falling through to the generic
"unrecognized root" message a truly-unknown tag gets. Worth the extra handful of lines: a
deleted-feature error that explains what replaced it is a much better upgrade experience than a
bare "expected `<script>`, `<theme-template>`, or `<theme name=\"...\">`".

**`<component>` (GRAMMAR.md's "`<component>` — the mandatory root tag") is deliberately NOT parsed
this way, unlike everything above** — a first draft put `extends="..."` on `<script>` itself using
exactly this literal-prefix-scan pattern, then got reverted (see git history / this file's own
superseded notes) once it became clear `<script>` conceptually never "extends" anything, and that
whenever a component has 2+ genuinely top-level siblings, the old "exactly one root element after
`</script>`" rule forced an artificial wrapper node purely to satisfy the parser, not because it was
semantically needed — real SceneGraph XML's `<children>` already holds multiple top-level nodes
natively. The fix: a mandatory `<component extends="..." on:key[...]="...">` tag now wraps
everything after `</script>` (`thr/expected-component-tag` if it's missing — same "clean break with
an upgrade-path diagnostic" treatment as the `<store>` rejection just above), and — critically —
it's parsed as **ordinary XML**, not a raw-text-prefix-scanned tag: `parser.ts`'s
`parseComponentFile` feeds the whole `<component>...</component>` region through the *same*
`preprocessOnKeyAttributes` → real-XML-parse pipeline every other element's markup already goes
through, so `<component>` naturally becomes that XML parse's single document root (satisfying its
"exactly one root" requirement with zero new logic — nothing to loosen there), and its attributes
get classified by the exact same `classifyAttribute` machinery as any other element's, for free.
`template-classify.ts`'s new `classifyComponentElement` (deliberately *not* `classifyTemplateElement`
— see its own doc comment: `<component>` isn't a real SceneGraph node, so it must skip
`classifyTemplateElement`'s `hasDynamic && !idAttribute` check, which would otherwise wrongly demand
an `id` the moment `on:key[...]` makes `hasDynamic` true) extracts `extends`/`on:key[...]` and
returns `<component>`'s children as the real content. The compiler side threads `extends` through as
an unrestricted `string | null` (`ThrTemplateAst.extends` → `compile.ts`'s `emitXml` call →
`EmitXmlOptions.extends`, a plain `string`) — deliberately *not* validated against a fixed set of
SceneGraph base classes, matching how a template element's own `tagName` is already unrestricted.

**Synthetic multi-child wrapper**: `<component>` with 2+ top-level children needed *some* answer for
`ThrTemplateAst.root: TemplateElement` (a single element every downstream analysis module already
expects — `analyzeTemplateBlocks`, `collectElementIds`, `collectBindTargets`,
`collectKeyBindingAttributes`, `collectFocusableElements`, `checkNestedFocusableConflicts`,
`collectBindings`, `collectStaticallyPresentIds`, `collectOnKeyEmissionOrder` — nine call sites,
confirmed by grep). Rippling "N independent roots" through all nine was rejected: several of them
use ordinal-based synthetic id generation (`ft_if_1`, `ft_each_1`, ...) that would collide across
independently-analyzed roots if called once per top-level child instead of once over the whole tree.
Cheaper, chosen fix: `dsl-parser.ts`'s `adaptTemplateSection` wraps 2+ children in an internal-only,
never-author-visible marker element (`tagName === SYNTHETIC_MULTI_CHILD_TAG`, a `$$ft_`-prefixed
sentinel — dsl-ast.ts — chosen because a real XML tag name can never contain `$`, mirroring
`mFieldAccess`'s own `$$ft_`-bracket convention for compiler-synthesized identifiers). Every one of
the nine call sites keeps walking a single root exactly as before, completely unaware the marker
exists (they already skip id-less elements for `m.<id>` caching, so the marker's `id: null` is
invisible to them too) — only `xml-emitter.ts`'s own top-level `emitXml` call needs to recognize it,
looping its children directly into `<children>` instead of printing a wrapper tag. One-line-ish
localized unwrap versus a nine-site ripple, for a case (`<component>` with 2+ top-level children)
that's genuinely rare — most real components still have exactly one — see
`apps/sample-app/src/components/MainScene.thr` for the first real 2-child example
(`ScheduleDateMenuItem`/`ScheduleList` as direct siblings, no wrapper `Group`).
