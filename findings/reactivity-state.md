# Reactivity core: theme/store/state design (`theme`, `store`, `state`, `read`/`watch`)

Compile-time module responsibilities and design rationale for the core reactive-data-flow
primitives: `field`-shadowing scoping rules, the `store`/`watch`/`read` runtime primitive, and
`state` as a private `m.x` member. See `packages/compiler/GRAMMAR.md`'s "Global store" and
"`read` / `watch`" sections for the grammar/semantics themselves — this file is the *why*. Sibling
files split out of this one:
[reactivity-theme-parsing.md](reactivity-theme-parsing.md) (`theme` global access resolution and
`.thr` root-tag dispatch — `<theme-template>`/`<theme>`/the `<store>` rejection/`<component>`/the
synthetic multi-child wrapper),
[reactivity-field-state-literals.md](reactivity-field-state-literals.md) (`field`/`state`
array/assocarray literal-default validation), [reactivity-bind.md](reactivity-bind.md) (the `bind:`
feature end to end), [reactivity-codegen-conventions.md](reactivity-codegen-conventions.md)
(general codegen conventions that happen to live in this area but aren't reactivity-specific), and
[reactivity-derived-type-check.md](reactivity-derived-type-check.md) (`derived`'s declared-type
enforcement — the static type-inference pass and its boundary).

## Assigning to a name that shadows a `field` inside a function body is NOT a bug — it's intentional lexical shadowing (correcting an earlier wrong finding)

A previous pass through this file (while building the store/theme feature) reported `count =
count + 1` inside a function body — where `count` is a declared `field` — as a bug: the claim was
that it should compile to `m.top.count = m.top.count + 1` but instead comes out completely
unrewritten. **That finding was wrong** — this is deliberate, tested behavior, not an oversight.
`test/analysis/scope-resolution.test.ts`'s `buildFunctionScope` suite has an explicit case titled
*"recognizes a plain local assignment as a local, **even when it shadows a field name**"* — the
wording alone shows the original author knew exactly what they were testing. `resolveIdentifier`'s
own docstring states the priority order plainly: "a real local/param always shadows a DSL binding
(ordinary lexical scoping)."

**Why this is correct**: function bodies are BrightScript-flavored text, passed through mostly
as-is (see "Function bodies are BrightScript-flavored text" in GRAMMAR.md). In real BrightScript,
`count = count + 1` — with no prior declaration of `count` in that scope — declares a plain local
in that function, full stop, regardless of what else in the surrounding program happens to be
named `count`. The DSL doesn't (and, per this precedent, deliberately doesn't) special-case "this
identifier happens to match a field name" to silently change an ordinary assignment's meaning into
a hidden field-write mechanism. `field` is a real SceneGraph interface field — public,
externally-set data (a "prop," not local mutable state) — and the DSL simply never defined syntax
for writing to one from inside the component's own code. `state` exists precisely because
component-local *writable* reactive data needs a mechanism `field` was never meant to provide (see
the `state`-vs-`field` design-fork section below).

**The reproduction from the earlier (wrong) finding was real, but the conclusion was backwards**:
```
<script>
field count: integer = 0
public function increment() {
  count = count + 1
}
</script>
<Label id="a" text="{count}" />
```
`increment()`'s body genuinely does compile to `count = count + 1` verbatim — but that's *correct*:
`count` here is a new local, shadowing the field for the rest of the function, exactly like the
tested behavior above. What it is **not** is a way to mutate the field — no syntax currently
provides that, and this precedent means none should be silently inferred from a same-named bare
assignment.

**⚠️ The `count = count + 1` illustration above is itself a live crash if actually executed —
live-device-caught, not a hypothetical.** BrightScript determines local-vs-outer-scope by statically
scanning the WHOLE function body for assignment targets, not line-by-line — once `count` is assigned
anywhere in the function, EVERY bare `count` read in it, including the assignment's own right-hand
side, resolves to that not-yet-initialized local, never the field. Real BrightScript's own answer to
"read a variable before its first assignment, when that name is also assigned later in the same
function" is `Use of uninitialized variable`, a runtime crash — confirmed live via
`apps/reactive-state-demo`'s `StateDemo.thr`, which originally used this exact
`fieldName = fieldName + 1` shape to demonstrate shadowing and crashed on real hardware at that
line (see `findings/reactive-state-demo-app.md`'s device-pass writeup). This is unrelated to
whether the shadowing itself is "correct" (it is, per the whole section above) — it's a distinct,
ordinary BrightScript gotcha about self-referencing an about-to-be-shadowed name. **Any future demo
or doc example illustrating this shadowing precedent must assign a fresh literal
(`count = 999`), never `count = count + 1`**, or it will crash the moment it actually runs.

**Practical consequence for anything wanting mutable, externally-observable component-local
state**: use `state`, whose write has its own dedicated `state <name> = <expr>` grammar (never
ambiguous with a plain local), not a bare assignment to a `field`-named identifier. (The store
itself is a different, unrelated mechanism entirely now — see "Store rewriting is structural, not
scanned" below; this shadowing precedent is about a component's own `field`, not the store.)

## Store rewriting is structural, not scanned — and why store writes are flat-only

The store/theme redesign (store became a built-in runtime primitive, never declared in the DSL —
see GRAMMAR.md's "Global store") changed *how* store access gets rewritten, not just what it
looks like syntactically. Store used to be a generic `store.x`/`store.fn(args)` dot-chain,
discovered the same way `theme.a.b` still is (`findGlobalPathAccesses` scanning arbitrary
expression text — see the section above). It no longer is: `read <name> = store(<path>)`,
`watch <name> = store(<path>)`, and `store(<key>) = <expr>` are each a **fixed grammar
production**, parsed structurally by flash-parser (`ReadDeclaration`/`WatchDeclaration`/
`StoreWriteStatement`) rather than scanned out of free-form expression/statement text. This is
why `identifier-rewrite.ts`'s `GLOBAL_ROOT_NAMES` dropped `'store'` entirely — there is no more
generic "find a `store.`-rooted chain anywhere in this text" step for it. `rewriteStorePathRead`
(a plain `m.global.store.<path>` join) and `rewriteStoreWriteStatement` (wraps the RHS —
`m.global.store.callFunc("set", "<key>", <rewritten expr>)`) are called directly off those
structural AST nodes in `codegen/brs-emitter.ts`, not through the dot-chain scanner at all.

**Why a store write can only ever replace a whole top-level key, never a nested path**: this
traces straight back to real Roku SceneGraph semantics, not an arbitrary DSL restriction. A field
observer (`ObserveField`/`ObserveFieldScoped`) fires only when the **field itself** is reassigned
— never when something mutates a value already stored in it in place (e.g. `m.top.someAA.x = 1`
on an already-referenced associative array does not fire an observer on `someAA`, only a fresh
`m.top.someAA = {...}` does). Since the store's whole reactivity model depends on `set(key,
value)` calling `addFields({[key]: value})` to *reassign* the field, allowing a DSL-level write
like `store(some.value) = 2` would compile to something that either doesn't work (can't
reassign a sub-path via `addFields`) or silently wouldn't notify any `watch` watching that key
even if it did — a correctness trap, not a style preference. flash-parser's parser rejects a
multi-segment write target at parse time (`statement/store-nested-write`) specifically to make
this impossible to write by accident, rather than discovering the non-reactivity at runtime.

**Why `watch`'s dependency-graph edge is hardcoded, not scanned**: `analysis/dependency-graph.ts`
treats every `WatchDecl` as a "recomputable node" (same bucket as `derived`) with exactly one
direct dependency — `` `store.${path[0]}` `` — set directly from the AST, not discovered by
running `parseExpression` over anything (there's no expression to parse; a `watch`'s "RHS" is
just a path). This is a deliberate, cheap reuse: `codegen/brs-emitter.ts`'s existing
`isGlobalSourceKey`/`splitGlobalSourceKey`/`emitExternalFieldChangeHandler`/`ObserveFieldScoped`
machinery already understood the `"store.<x>"`/`"theme.<x>"` composite-key convention (it was
built for the old bare-`store.x`-scanning model) and needed **zero changes** — `watch`
declarations just became the new *producer* of that key instead of a scanned access. Worth
knowing before touching that machinery again: it doesn't care where a composite key comes from,
only that dependency-graph.ts and expression-region.ts agree on the `"root.name"` string shape.

## Bug (fixed): `sourcesNeedingCascade` only unioned template-derived binding maps, so a `watch`/`derived` consumed only from a plain function body never got its `ObserveFieldScoped` wired

Found live on a real device, not in a synthetic test: `Shell.thr` had `watch favoriteCount =
store(favoriteCount)`, read only inside a plain function (`bumpFavorite()`, which wrote
`store(favoriteCount) = favoriteCount + 1`) — never from a template `{expr}`. The very first
store write worked (the field's own `init()`-time snapshot happened to already be current), but
every write after that silently used a stale `m.favoriteCount` — the count appeared stuck at 1
forever. Root cause: `codegen/template-bindings.ts`'s `analyzeTemplateBindings` built
`sourcesNeedingCascade` (which drives BOTH `brs-emitter.ts`'s `ObserveFieldScoped` registration
and `xml-emitter.ts`'s `onChange=` attribute) by unioning only the three TEMPLATE-derived maps —
`affectedBySource`/`affectedBySourceBlocks`/`affectedByEachSourceBlocks` — never consulting
`graph.dependentsOfSource`, the complete, template-agnostic reactive-source → dependents mapping
`dependency-graph.ts` already builds from `derived`'s parsed expression identifiers and
`watch`'s fixed `store(<path>)` root. A source with a dependent reachable only through a plain
function body (never rendered by any template expression/`{#if}`/`{#each}`) produced an empty
entry in all three template maps and was silently dropped from the cascade set — its
`init()`-time snapshot read was emitted, but no reactive re-read, so the value only ever reflected
whatever the store held at construction time.

**Fix**: union in `graph.dependentsOfSource` too — any source with at least one dependent (by any
means, template or function-body) needs its cascade wired, full stop:
```ts
for (const [sourceName, dependents] of graph.dependentsOfSource) {
  if (dependents.length > 0) sourcesNeedingCascade.add(sourceName);
}
```
This widens `sourcesNeedingCascade`'s meaning from "affects the template" to "has at least one
dependent anywhere" — the correct meaning all along, since the whole point of the set is "does
this source need a change handler," not "does this source affect what's on screen right now."

**Why this went undetected for so long**: `packages/compiler/test/codegen/golden.test.ts` had
zero dedicated `watch` coverage before this fix (confirmed by grep) — every existing `watch`
usage in fixtures happened to also feed a template-consumed `derived` (the shape that already
worked), so the function-body-only path was never exercised. It also accidentally golden-locked
the SAME bug in an unrelated fixture: `test/golden/function-body-identifier-rewrite/`'s
`derived doubled: integer = score * 2`, consumed only inside a plain function `describe()`, had
its `expected.xml`/`expected.brs` regenerated as part of this fix (previously missing
`onChange="on_scoreChange"` and the `on_scoreChange` handler entirely). New coverage:
`test/golden/watch-function-body-only/` asserts a `watch`+`derived` pair consumed only from a
function body still gets `observeFieldScoped(...)` and a reactive recompute handler.

**Known, deliberately out-of-scope remainder**: in `function-body-identifier-rewrite`, a second
`derived summary` that depends on `doubled` only *through* an opaque function call
(`describe()`) still doesn't cascade — function calls are opaque to `dependency-graph.ts` by
design (see that file's own comments), a separate, pre-existing, documented limitation, not part
of this bug.

## `state`: a private `m.x` member, not a hidden `field` — and why that's a real design fork, not a shortcut

The obvious shortcut for "component-local reactive state" is to make it secretly a `field`: reuse
100% of the existing XML/`onChange`/dependency-graph machinery, and reads *and* writes both "just
work" for free (task 1's identifier-rewrite already rewrites both read *and* assignment-target
positions of a bare name). **This was rejected.** SceneGraph has no privacy mechanism for interface
fields at all — every `<field>` is externally reachable via `node.setField()` regardless of
documented intent — so a `state` modeled as a field would still be settable from outside the
component, defeating the entire point of calling it "component-local." A private `m.x` member,
by contrast, is genuinely unreachable from outside (a component's `m` isn't reachable from another
node's script context at all), so that's what `state` actually is.

The cost of that correctness: a private `m.x` member has no SceneGraph field observer to auto-fire
`on_<name>Change` the way a `field` change does — so a `state` write can't be "free" the way a
`field` write is. `state <name> = <expr>` (`StateAssignment` in flash-parser, a third statement
kind alongside `IfStatement`/`StatementRegion`) is a dedicated write statement precisely because
of this: `codegen/brs-emitter.ts`'s `printStateAssignment` inlines the *same* reactive cascade
`emitFieldChangeHandler` generates for a field (recompute dependent `derived`s, update affected
template bindings — factored into a shared `emitCascadeLines` helper) directly at the assignment
site, since that's the only place a notification can originate from. `dependency-graph.ts` and
`template-bindings.ts` were widened from "field-only" to a general **reactive source** concept
(`ScriptBindings.reactiveSourceNames` = `field` ∪ `state`) specifically so a `derived`/binding can
depend on either uniformly — `emitBrs` only special-cases the *last* step, filtering
`sourcesNeedingCascade` down to `field` names before generating `on_<field>Change` subs, since
`state`'s cascade is already handled inline and would otherwise generate a dead, unreachable sub.

## The reactive store-binding keyword is `watch`, not `derive` — renamed for readability, not semantics

Originally the reactive store binding (`<name> = store(<path>)`, recomputed whenever the store's
top-level key changes) was spelled `derive`. Renamed to `watch` because `derive`/`derived` differ
by one letter and one being reactive-to-store while the other is reactive-to-expression made them
easy to misread at a glance — `watch` reads unambiguously as "the store variant," and happens to
match what it compiles to (`ObserveFieldScoped`). This was a pure rename, not a semantic change:
`watch` still can't take an arbitrary type annotation (the store is schemaless, see "Global store"
in GRAMMAR.md) and `store(<path>)` is still restricted to exactly three fixed positions (`read`,
`watch`, and the `store(<key>) = <expr>` write) — see GRAMMAR.md's "`read` / `watch`" section for
why folding it directly into `derived <name>: Type = store(path)` syntax was considered and
rejected (the required-type-annotation conflict). Every layer touched the same way: flash-parser's
`TokenKind.Watch`/`SyntaxKind.WatchDeclaration`/`WatchDeclaration` AST class, the compiler's
`WatchDecl`/`ScriptBindings.watchNames`/`script.watches`, and the diagnostic code
`dsl/invalid-watch` (was `dsl/invalid-derive`). If old planning-doc references to `derive` ever
resurface, they mean this same construct under its old name.
