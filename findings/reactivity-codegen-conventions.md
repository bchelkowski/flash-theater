# Codegen conventions (generated `init()`, `setFields()` batching, `FlashTheater/` output layout)

General `packages/compiler/src/codegen/` conventions that happen to have been discovered while
building the reactivity features (`reactivity-state.md`/`reactivity-bind.md`) but aren't
reactivity-specific themselves — they apply to any codegen touching node construction/update or
compiler-generated output files. See `findings/compiler-codegen-conventions.md` for codegen conventions
generally (naming, `init()` structure).

## Generated `init()` is a `sub`, not `function ... as void` — a pure cleanup, not a `bind:` dependency

`codegen/brs-emitter.ts`'s `emitInitFunction` and `codegen/theme-emitter.ts`'s own
`emitInitFunction` both used to emit `function init() as void ... end function`. Changed to `sub
init() ... end sub` — `init()` never returns a value, and this DSL already has a real `sub`-vs-
`function` distinction driven by "does this return anything" for DSL-authored functions (see "No
`void` type" in `compiler-codegen-conventions.md`); the generated lifecycle callback was the one place
still using the older `function ... as void` shape instead of following that same rule. Every
golden fixture's `expected.brs` needed the mechanical update (the *first* `end function` in each
file is always `init()`'s own closer, since `init()` is always the first section `emitBrs`
assembles — never a blind `end function` → `end sub` replacement, since a fixture can legitimately
contain other real `function ... end function` declarations, e.g. a DSL function with a return
type, elsewhere in the same file).

## `setFields()` batches 2+ plain field assignments to the same node — but only at sites where the whole set is already known up front

`codegen/shared-emit.ts`'s `emitFieldAssignments(nodeRef, fields)` replaces N separate
`nodeRef.<name> = <value>` lines with one `nodeRef.setFields({<name>: <value>, ...})` call whenever
`fields.length >= 2` (falls back to a single plain dot-assignment for exactly one field, `[]` for
zero — callers never need their own single/multi branch). Wired into every codegen site that
constructs or updates a node's *plain* (non-`focusable`, non-`bind:`, non-`on:key`) attributes as a
batch: `each-block-emitter.ts`'s `emitItemConstruct`/`emitItemUpdate`, `conditional-block-emitter.ts`'s
`emitSubtreeConstruction`, and `brs-emitter.ts`'s `emitInitFunction`'s `bindings.all` loop (which
buffers a run of consecutive same-`elementId` entries — safe because `template-bindings.ts`'s
`collectBindings` already walks one element's attributes to completion before the next, so
same-element entries are guaranteed adjacent in `bindings.all`).

**Deliberately NOT batched: `brs-emitter.ts`'s `emitCascadeLines`'s `bindings.affectedBySource`
loop** (the per-reactive-source-change cascade inside `on_<x>Change` handlers). Those entries are
grouped by *source*, not by target node, so same-element entries aren't reliably adjacent, and each
is independently guard-wrapped via `wrapWithNearestDestroyGuard` depending on whether its element
lives inside a `{#if:destroy}` subtree. Batching there would need a full re-grouping pass (buffer by
elementId across the whole loop, not just a consecutive run) for a narrower payoff — most reactive
sources drive one field on one element. Left as individual `emitBindingAssignment` calls; if this
ever becomes worth revisiting, group-by-`elementId`-then-verify-identical-guard-status is the shape
to reach for, not a naive consecutive-run buffer (guard status only needs to *match* within a group,
not literal adjacency).

`focusable` (static or dynamic) is always excluded from the batch, even when it sits between other
plain attributes on the same node — a *dynamic* `focusable="{expr}"` needs its own temp-var +
register/unregister shape (`emitDynamicFocusableAssignment`), and a *static* one needs an immediate,
unconditional register call right after its own assignment; neither fits a bare AA-literal value
position. `bind:`/`on:key` were never per-attribute value assignments to begin with (an
`ObserveFieldScoped` call and no codegen at all, respectively), so they were never candidates.

Originally discovered while adding a real component (`apps/sample-app/src/components/FavoriteCounter`)
with a `derived label: string = ...` alongside a template element `<Label id="label" .../>` — both
compiled to the same generated slot, `m.label`, and whichever assignment ran second in `init()`
silently clobbered the other, producing `m.label.text = m.label` at runtime (a `Type Mismatch`, not
a compile error). Fixed by adding compile-time diagnostics rather than giving node-ref caching its
own `m.`-namespace (the other option considered) — smaller blast radius, and consistent with this
codebase's existing style of hard-erroring on ambiguity (`expression/unresolved-identifier`,
`statement/unknown-state`) rather than silently reinterpreting it.

**Module `packages/compiler/src/analysis/binding-collisions.ts`**, wired into
`compileThrSource` in `compile.ts` (right after `buildScriptBindings`, before
`buildDependencyGraph`/codegen — so a collision is caught before any codegen runs), exports three
checks. These cover `field`/`derived`/`state`/`read`/`watch`/element-`id` name collisions
generally, not just anything `bind:`-specific — the FavoriteCounter clobber above involved a plain
`derived` and a template `id`, no `bind:` in sight:

- `checkDuplicateBindingNames(bindings)` → `dsl/duplicate-binding-name` if a name is declared as
  more than one of `field`/`derived`/`state`/`read`/`watch`. This one isn't about a runtime slot
  clobber at all (`field` lives at `m.top.<name>`, a genuinely separate slot from
  `derived`/`state`/`read`/`watch`'s `m.<name>`) — it's about `resolveDsl`'s fixed priority order
  silently making every bare-name *reference* resolve to only the highest-priority kind, leaving
  the other declaration's generated code real but permanently unreachable.
  `<theme-template>`/`<theme>` don't need it, since their group/leaf grammar has no
  `field`/`derived`/`state`/`read`/`watch` at all — and there's no more `<store>` section to
  apply it to either (the store is a built-in runtime primitive now, never declared in the DSL).
- `checkElementIdCollisions(elementIds, bindings)` → `template/id-collides-with-binding` if an
  element `id` matches a `derived` or `state` name — the actual `m.<name>` slot clobber described
  above. **Deliberately excludes `field`**: confirmed via `emitInitFunction`
  (`codegen/brs-emitter.ts`) that a `field` read always goes through `m.top.<name>`, never a bare
  `m.<name>`, so `id="foo"` next to `field foo` shares no slot and is a safe, natural naming choice
  (e.g. a field describing the very element it labels) — flagging it would have been a false
  positive restricting legitimate code, not a bug fix.
- `checkDuplicateElementIds(elementIds)` → `template/duplicate-id`, a related gap noticed during
  the same investigation: `collectElementIds` never deduplicated, so two elements sharing an `id`
  silently cached the same node ref twice, the second line clobbering the first — same failure
  shape, previously completely unguarded.

`collectElementIds` itself moved from `codegen/brs-emitter.ts` (where it was `init()`-emission-only
and private) to `codegen/template-bindings.ts` (exported, alongside that file's existing
`collectBindings` template-traversal helper) so `compile.ts` can call it once, before codegen, to
feed both new template-side checks — `brs-emitter.ts` now imports it from there instead of defining
its own copy.

Tests: `packages/compiler/test/analysis/binding-collisions.test.ts` covers all three diagnostics
plus an explicit regression case proving `field` vs. element `id` still compiles successfully (not
an oversight). `apps/sample-app/src/components/FavoriteCounter` was deliberately left as-is (still
using the renamed `favoritesLabel` workaround) rather than reverted to the colliding name, since
this fix's job is to reject that pattern, not to make it newly work.

## Compiler-owned output (Store, compiled theme, `FlashTheaterGlobals.brs`) lives under a `FlashTheater/` subfolder — all three now fixed-name, fixed-location, independent of any source filename

An app's `components/`/`source/` trees mix two different kinds of file: components the app
author actually writes, and output that only the compiler ever produces or touches. To keep the
latter grouped in one obvious place instead of scattered as loose top-level entries alongside
real components, `cli.ts`'s `copyRuntimeStoreAsset`, `writeThemeOutput`, and `writeGlobalsBrs` all
write under a `FlashTheater/` subfolder — `components/FlashTheater/FlashTheaterStore/`,
`components/FlashTheater/FlashTheaterTheme/`, and `source/FlashTheater/FlashTheaterGlobals.brs` —
rather than directly in `componentsBaseDir`/`sourceDir`. Each `mkdirSync`s its own target dir
first, since (unlike `sourceDir`/`componentsBaseDir` themselves) the `FlashTheater/` subfolder
isn't guaranteed to exist yet.

**Superseded finding, corrected same session**: an earlier pass through this file argued the
theme's compiled name/location should stay filename-driven (like any ordinary component),
specifically rejecting a `FLASH_THEATER_THEME_COMPONENT_NAME` constant on the grounds that
"every other component's compiled name already derives from its filename; hardcoding just the
theme's name would special-case one kind of user-authored file." **That reasoning missed that the
theme-template isn't really "one kind of user-authored file" the way a regular component is** —
`compileApp` already finds it *structurally* by its `<theme-template>` root tag
(`ThrFile.kind === 'theme-template'`, see `reactivity-theme-parsing.md`'s literal-prefix-scan dispatch
section), never by filename, and there can be at most one per app
(`theme/multiple-templates`). Given that, forcing the app author to name their file exactly
`FlashTheaterTheme.thr` to get a consistent compiled name was an arbitrary, easy-to-miss extra rule
with zero enforcement (nothing failed if they named it something else — the compiled output would
just come out named after whatever they typed) and zero benefit — the compiler could trivially have
picked the fixed name itself all along.

**Current, corrected design**: `FLASH_THEATER_THEME_COMPONENT_NAME = 'FlashTheaterTheme'` (mirrors
`FLASH_THEATER_STORE_COMPONENT_NAME` exactly), used unconditionally by `compileApp` when calling
`compileTheme(themeShape, FLASH_THEATER_THEME_COMPONENT_NAME)` — the input file's own
`componentName` (`basename(p, extname(p))`) is no longer consulted for the theme at all, only for
regular components. `CompiledApp.themeOutput` was pulled out of the shared `outputs` array
entirely (mirroring how the store was already never part of `outputs`), specifically so `cli.ts`
routes it through its own `writeThemeOutput` — fixed name, fixed
`components/FlashTheater/FlashTheaterTheme/` location — instead of the generic
`writeCompiledOutput` loop, which writes next to `dirname(output.path)` (the *source* file's own
directory) and would otherwise have re-introduced the filename dependency. The one place the real
source filename still matters: `writeThemeOutput` passes the theme's actual source basename (not
`FLASH_THEATER_THEME_COMPONENT_NAME`) to `withXmlMarker`/`withBrsMarker`, so the generated
`<!-- flash-theater:generated ... source: X.thr -->` comment stays truthful for debugging even
though the compiled filename and the real source filename can now legitimately differ.
