# Template blocks: {#if}/{#if:destroy}/{#each} — shared parsing & analysis architecture

The two architectural pieces `{#if}`/`{#if:destroy}`/`{#each}` all share: how block markers get
parsed out of raw template markup at all, and how the two block kinds' analysis passes stay
unified once they can nest against each other. Kind-specific mechanics live in sibling files: for
`{#each}`-only mechanics (markers, wrapper, keyed diff, `findNode` item relocation, no built-in
index variable, ...) see [template-each-blocks.md](template-each-blocks.md); for
`{#if:destroy}`-only runtime mechanics (synthetic `Group`, sibling-insertion index, root-as-
container, nested-binding guarding, `blocks` array ordering) see
[template-conditional-blocks.md](template-conditional-blocks.md); for cross-nesting interactions
between the two block kinds see [template-each-nesting.md](template-each-nesting.md). See
`packages/compiler/GRAMMAR.md` for the grammar itself.

## `{#if}`/`{#if:destroy}`: real block syntax parses via the *unmodified* XML lexer, not a text-splice pre-pass

The template's raw markup is still handed to `parseXml` completely unchanged
(`embedded.ts`'s `parseEmbeddedTemplate`) — no pre-processing pass rewrites `{#if}`/`{/if}` markers
into synthetic XML tags before parsing, and none is needed. The reason: `kopytko-brightscript-parser`'s
XML lexer already tokenizes arbitrary content-position text as a `Text` node with real, correct
source positions (`xmlLexer.js`'s "Text content: everything up to the next `<` (or EOF)" branch) —
so `{#if cond}<Rectangle/>{/if}` already parsed, byte-for-byte correctly positioned, **before this
feature existed**. `parser.ts`'s `classifyTemplateChildren`/`scanIfMarkers` just walk each
element's raw interleaved `Element`/`Text` children (`element.syntax.children`, not the
elements-only `XmlElement.children` getter `classifyTemplateElement`'s attribute logic uses) and
scan each already-positioned `Text` token's own text for the literal markers, depth-counting them
the same way `findMatchingBrace` depth-counts `{`/`}` over a token stream elsewhere in this file.

**A text-splice-to-synthetic-tag design was seriously considered and rejected**, for a concrete,
verified reason, not just a style preference: it would need a hand-written XML-quoting-aware
pre-scanner to safely skip a `{#if`-lookalike sequence sitting inside a comment or an attribute
value — and the only existing helper that does anything like that,
`text-scan.ts`'s `findLiteralOutsideStringsAndComments`, encodes **BrightScript's** quoting rules
(`""`-doubled-quote strings, `'`-starts-a-line-comment), not XML's (`"`/`'` either work as a quote,
no doubling escape, no `'`-comment concept at all). Reusing it would have silently mis-scanned a
real case — a static attribute containing an apostrophe (`caption="it's fine"`) would make it treat
everything after the apostrophe as "inside a comment" until the next newline. Building a *correct*
XML-aware pre-scanner instead would mean re-deriving the tag/attribute-quote state machine
`xmlLexer.js` already implements — exactly the kind of hand-rolled XML-adjacent parsing this
repo's delegation rule (see "Never do this" above) exists to prevent. The real-parse-first design
sidesteps this category of bug entirely: markers are only ever looked for inside a span the
*delegated* XML tokenizer has already told you is content-position text, so no XML-quoting-aware
scanning is ever hand-written. `test/parser/template-conditional.test.ts` has a regression case
for exactly this (`caption="it's fine"` immediately before a `{#if}` marker) — it would have failed
under the rejected design and passes under this one.

A second, related payoff: no diagnostic-offset-remapping layer was needed either. A text-splice
design would have required composing two offset-translation layers (rewritten-text-offset →
original-template-offset → outer-`.thr`-offset) with no existing precedent to build on — a real
gap, discovered while checking: `classifyAttribute`'s existing diagnostic translation for an
ordinary `attr="{expr}"` expression parse error was itself passing `outerOffset = 0` instead of the
attribute value's real position (`XmlAttribute.valuePos` was exposed by the delegated parser but
never read) — an untested, latent bug, fixed as part of this same change (both `classifyAttribute`
and the new `{#if}`-condition scanning now anchor correctly via a `baseOffset` threaded down from
`parseComponentFile`'s `templateContentStart`).

## `{#each}`/`{#if}` block analysis was unified into one walk (`analyzeTemplateBlocks`) once the two kinds needed to nest against each other — a split-then-thin-wrapper refactor, not a rewrite of either caller

Once `{#each}` nested inside `{#if:destroy}` needed real support, the two independent analysis
passes from earlier milestones (`analyzeConditionalBlocks`, `analyzeEachBlocks`) could no longer
stay independent: an `{#each}` block's own reconcile call needs `nearestDestroyAncestorById` (to
guard it, exactly like an ordinary binding), and — for the still-unimplemented reverse direction —
a block nested *inside* an `{#each}` will eventually need `nearestEachAncestorById`. Neither pass
could compute the *other* kind's ancestor map on its own, since each only knew how to assign ids to
its own block kind.

The fix (now `analysis/conditional-blocks.ts`'s `analyzeTemplateBlocks` — originally landed inside
`codegen/conditional-block-emitter.ts`, moved out to match this package's own documented pipeline
layering, see the architecture-cleanup entry near the end of this file) merges both walks into one
top-down pass assigning **both** id sequences (kept independent — `ft_if_N`/`ft_each_N` number
exactly as they did before the merge, since each still has its own counter) while threading
`nearestDestroyAncestorId`/`nearestEachAncestorId`/`insideEach` together. `analyzeConditionalBlocks`
and `analyzeEachBlocks` (in `each-block-emitter.ts`) both survive as one-line wrappers
(`analyzeTemplateBlocks(root).conditional` / `.each`) purely so every existing call site and
isolated unit test (constructing an if-only or each-only fixture) keeps working unchanged — for a
tree containing only one block kind, the merged walk's output is byte-identical to what the old
standalone walk produced, since the other kind's tracking is simply never exercised.

**No import cycle, despite each file needing the other's types**: `analysis/conditional-blocks.ts`
needs `EachBlock`/`EachBlockAnalysis` (to construct the `each` half of the unified result) and
`codegen/each-block-emitter.ts` needs the `analyzeTemplateBlocks` *function* (a real value) from
`analysis/conditional-blocks.ts`. The former is only ever a **type-only** dependency
(`import type { EachBlock, EachBlockAnalysis } from '../codegen/each-block-emitter.js'`), which
TypeScript erases entirely at compile time — the emitted `.js` has no `require`/`import` for it at
all — so the actual *runtime* dependency graph is one-directional (`each-block-emitter.js` →
`conditional-blocks.js`) even though the *type* graph looks circular. Worth remembering next time
two modules seem to need each other: check whether one side's need is type-only before assuming a
bigger restructure (a shared third file) is required.
