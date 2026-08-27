# Template blocks: `{#each}` core mechanics

`{#each <collection> as <item> (<key>)}...{/each}`'s own parsing and static wrapper/codegen shape —
marker parsing shared with `{#if}`, item-scope resolution, the always-static wrapper, item-body
id-caching rules, node-collection iteration, and the missing-index-variable gap. For the reconcile
algorithm itself (dict-init ordering, dependency scanning, the keyed-diff proof, `findNode`-based
item-update relocation, the three-pass ordering requirement), see
[template-each-reconcile.md](template-each-reconcile.md). For the shared block-marker parsing
architecture and the unified `analyzeTemplateBlocks` walk, see
[template-blocks.md](template-blocks.md). For `{#if:destroy}`-only runtime mechanics, see
[template-conditional-blocks.md](template-conditional-blocks.md). For cross-nesting interactions (a
block nested inside `{#each}`'s body, or `{#each}` nested inside `{#if:destroy}`), see
[template-each-nesting.md](template-each-nesting.md). See `packages/compiler/GRAMMAR.md` for the
grammar itself.

## `{#each}`'s markers share `{#if}`'s real-parse-first block stack as a tagged union — and flash-parser never validates an identifier's *existence*, only its syntax

`{#each <collection> as <item> (<key>)}...{/each}` (`packages/flash-parser/src/templateModel.ts`'s
`TemplateNode`'s `'each'` variant; `parser.ts`'s `scanBlockMarkers`/`parseEachHeader`) reuses the
exact real-parse-first design [template-blocks.md](template-blocks.md) describes for `{#if}` — no
separate scanning pass, no new pre-processing. The one structural change needed:
`classifyTemplateChildren`'s block stack (`BlockFrame`) had to become a tagged union
(`IfBlockFrame | EachBlockFrame`) instead of the `{#if}`-only shape it started as, because the two
marker families can now nest against each other arbitrarily (`{#each}` inside `{#if}`, `{#if}`
inside `{#each}`, either inside itself) and a closing marker must be validated against the
*specific* opener kind it's popping, not just "some open block or other" — a `{/each}`
accidentally closing an `{#if}` frame (or vice versa) is a distinct, diagnosable authoring mistake
(`template/each-close-mismatch`), not a generic "unterminated block".

**flash-parser does not, and has never, validated whether an identifier actually resolves to
anything — only whether it's syntactically valid BrightScript.** This was traced precisely while
figuring out how `item` (the `{#each}` loop alias) avoids tripping `expression/unresolved-identifier`
inside the block body: `parseEmbeddedExpression` (`embedded.ts`) wraps expression text as
`sub ft_tmp()\n  ft_result = <expr>\nend sub` and hands it to `kopytko-brightscript-parser`'s
`parse()`, which does pure syntax parsing with no notion of "declared names" at all — a bare `item`
parses as an ordinary `IdentifierExpression` with zero complaint, exactly like any other
looks-undeclared name. `expression/unresolved-identifier` is thrown only in the *compiler* package's
`analysis/identifier-rewrite.ts`, during codegen, never during flash-parser's `parse()`. Consequence
for `{#each}`: the collection/key expressions and any body binding referencing `item` parse cleanly
at the flash-parser stage with **zero special-casing** — `item`-scoping (making `item` actually
resolve, instead of hitting `expression/unresolved-identifier` once codegen runs) is entirely a
compiler-side concern, and **is implemented**: `analysis/scope-resolution.ts` (around lines 263-286)
defines a `FunctionScope`-shaped `TemplateScope` interface plus an `extendTemplateScope()` function
that handles `{#each items as item (key)}` alias shadowing (`item` shadows any same-named DSL
binding, and nested `{#each}` scopes compose via a `parent` `TemplateScope`, innermost alias
checked first). The "not yet supported" throw stubs this note used to cite in
`codegen/conditional-block-emitter.ts` and `codegen/xml-emitter.ts` no longer exist in either
file — both now have real `{#each}` handling, consistent with the fully-working `{#each}` codegen
pipeline (`each-block-emitter.ts`, `emitEachReconcileSub`, `emitCreateItemSub`) described in
[template-each-reconcile.md](template-each-reconcile.md).

**The header's own `" as "` separator search is paren-depth-tracked, not a plain substring search**
(`parseEachHeader`'s `findTopLevelAsSeparator`) — found only at paren-depth 0, so a collection
expression containing `" as "` inside a nested call's parens can't be mistaken for the real
collection/alias separator. This made writing a "malformed collection expression" parser test
trickier than the equivalent `{#if}` test: `{#if}`'s own malformed-condition test uses a bare `(` as
the condition (`{#if (}`) because the header's closing `}` is found by a simple non-nested
`indexOf('}', ...)` scan, and an unmatched `(` there doesn't disturb anything else. Trying the same
trick for `{#each}`'s *collection* expression breaks the header parse itself — an unmatched `(`
throws off the paren-depth tracking the `" as "` search and the key-clause `(...)` search both rely
on, so the test ends up exercising a header-shape diagnostic (`template/each-invalid-header` /
`template/each-missing-key`) instead of reaching the embedded-expression parse it meant to test. The
fix (`test/parser/template-each.test.ts`) uses a paren-free malformed expression instead (a bare
`,`) for the collection-expression case, and a paren-*balanced* but syntactically incomplete one
(`item.`, a trailing dot with no member name) for the key-expression case.

## `{#each}`'s wrapper needs none of `{#if:destroy}`'s runtime-insertion-index machinery — it's always statically present

An `{#each}` block's wrapper `Group` (`codegen/each-block-emitter.ts`'s `analyzeEachBlocks`, id
`ft_each_N`) is **always** present in the compiled static XML — unlike a `{#if:destroy}` block
(0-or-1 instances, sometimes entirely absent from the tree), an `{#each}`'s *item count* is a
runtime fact but the wrapper that holds those items always exists, the same way a toggle-mode
`{#if}`'s wrapper always exists. Consequence: `codegen/xml-emitter.ts` emits it as an ordinary
self-closing `<Group id="ft_each_N" />` static child (reusing `emitElement`'s existing shape, no
new XML-emission machinery), and `codegen/brs-emitter.ts` caches it via a plain
`m["$$<id>"] = m.top.findNode("<id>")` in `init()` (bracket-`$$`-accessed since this id is
compiler-synthesized — see the naming section above), exactly like any other statically-present id
— **none** of `{#if:destroy}`'s runtime sibling-insertion-index computation
(`emitConditionalCreateSub`'s `ft_idx` accumulation) is needed for the wrapper's own placement. This was worth confirming
explicitly while designing the milestone that first implements `{#each}` codegen, since
`{#if:destroy}` is the only prior precedent for "a block that creates its own root node at
runtime" and it would be easy to over-apply its insertion-index pattern somewhere that doesn't
actually need it.

## `{#each}` item-body elements are *never* cached at `m.<id>` — even when they have an author-given `id`

`{#if:destroy}`'s `emitSubtreeConstruction` caches an element-with-an-`id` straight into `m.<id>`
(`conditional-block-emitter.ts:236`) because there's at most one instance of that subtree alive at
once. An `{#each}` item's own subtree-construction (`each-block-emitter.ts`'s
`emitItemSubtreeConstruction`) runs once *per rendered item* — reusing that same `m.<id>` caching
convention would have every new item silently overwrite the previous item's reference (and every
concurrently-rendered item collide on the exact same slot). Every node inside an item body gets a
fresh local/temp variable (`ft_n1`, `ft_n2`, ...) unconditionally, regardless of whether the
DSL author gave the element an `id` — the `id` field is still set on the constructed `roSGNode`, but
now suffixed with the item's own reconcile key (`uniqueIdExpr`, e.g. `"row_" + ft_key`) so it's
unique per rendered item rather than duplicated across siblings — see
[template-each-nesting.md](template-each-nesting.md)'s "Nesting a block *inside* `{#each}`'s body"
section for why that changed and what it's used for (a later `findNode`
lookup, not a compiler-side `m.<id>` reference). `codegen/template-bindings.ts`'s
`collectElementIds`/`collectBindings` both explicitly skip recursing into an `{#each}` node's
children for exactly this reason (an id in there never becomes a global `m.<id>` slot, so it's
opaque to whole-component id-collision/reservation checking). See
[template-each-reconcile.md](template-each-reconcile.md) for how the update pass re-locates these
same elements on a later reconcile pass.

## `{#each}`'s collection may be a SceneGraph node, iterated over its own children — a runtime type branch, no new grammar

`{#each <collectionExpr> as ...}` always accepted any embedded BrightScript expression with zero
parser changes needed — `parseEachHeader` never restricted the collection expression's shape, so a
node-yielding expression was already syntactically legal, just semantically unhandled downstream
(the generated code assumed `.Count()`/`[i]` array-indexing worked on whatever came back). The fix
is confined to `emitEachReconcileSub` and its near-duplicate `emitInlineEachDiff` (both already
independently re-implement the same three-pass diff — see
[template-each-reconcile.md](template-each-reconcile.md)): right after evaluating the
collection expression, `if type(ft_collection) = "roSGNode" then ft_collection =
ft_collection.getChildren(-1, 0) end if` — one `getChildren(-1, 0)` call materializes the node's
children into a plain array once, and every downstream `.Count()`/`[i]` line runs unchanged against
that array. Item values may be anything (an associative array, a node, a scalar) — how child UI gets
built from an item's shape is entirely up to the template body; the compiler's only constraint stays
the key expression normalizing to a scalar (`<componentName>__each_key_to_string`, unchanged). See
`test/golden/each-node-collection/` for the reference fixture (`{#each container as child
(child.id)}` where `container` is a `field ...: node`).

## `{#each}` has no built-in index variable — a list item that needs its own layout position must carry that position as part of its own data

There is no automatic "loop index" binding inside an `{#each items as item (key)}` body — only
`item` itself is in scope. This matters for anything visually list-like: `apps/sample-app/src/components/ScheduleList/ScheduleList.thr`
needed each row to render at a distinct vertical position, but a `{#each}`-rendered item's wrapper
`Group` is always created via a bare `CreateObject("roSGNode", "Group")` with no positional
`translation` of its own (see `codegen/each-block-emitter.ts`'s `emitCreateItemSub`) — and there's
no way to reference "my position in the list" from inside the DSL template today. The fix used in
the sample component: compute each item's own `y` field as part of the *data* (`renumbered()`,
a private helper re-run after every add/remove/reorder, assigning `day.y = i * 40` for each item's
current index) and bind `translation="{[10, day.y]}"` in the template — ordinary per-item data,
not a language feature. Worth remembering as a real, currently-unaddressed usability gap (not
merely a "figure it out with WrapGroup layout" solvable one): a `{#each}` block's wrapper `Group`
is *not* a direct child of whatever `LayoutGroup` might contain the `{#each}` block — the
wrapper indirection means a `LayoutGroup` parent's automatic child-layout algorithm never reaches
the individual rendered items at all, only sees the one always-present `{#each}` wrapper `Group`
as its single child. Automatic list layout (no index needed, no per-item position data) would need
either exposing an index binding or teaching the wrapper's own children to participate in the
parent's layout directly — neither exists yet.
