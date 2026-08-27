/**
 * `{#each}` keyed-list-block codegen — a real keyed diff (add/
 * remove/reposition-in-place, preserving node identity across a key's
 * lifetime), not a destroy-and-rebuild-everything pass. Block *analysis*
 * (id assignment, item scope, ancestor tracking) lives in
 * `analysis/conditional-blocks.ts`'s `analyzeTemplateBlocks` — a
 * single walk shared with `{#if}`/`{#if:destroy}` analysis, since the two
 * block kinds can nest against each other in both directions and each needs
 * the other's ancestor context (see that function's doc comment).
 * `analyzeEachBlocks` here is a thin wrapper over it.
 *
 * **Nesting — both directions are fully supported**, arbitrarily deep, in
 * any combination:
 * - `{#each}` inside `{#if}`/`{#if:destroy}` — no per-item state needed at
 *   all (a destroy-mode block is still 0-or-1 instances; see
 *   `conditional-block-emitter.ts`'s `emitSubtreeConstruction`'s `'each'`
 *   branch, and the cascade guarding in `brs-emitter.ts`'s
 *   `emitCascadeLines`).
 * - `{#if}`/`{#if:destroy}`/`{#each}` nested *inside* an `{#each}`'s own
 *   body — this is the genuinely novel direction, since an `{#each}` really
 *   does render N independent copies of whatever's nested inside it. A
 *   block with a `nearestEachAncestorById` entry (see
 *   `conditional-block-emitter.ts`) is **never** given its own top-level
 *   create/destroy/reconcile subs — `brs-emitter.ts` filters it out of every
 *   init/cascade loop — its entire construction/update/teardown logic is
 *   inlined directly into the enclosing each's own per-item
 *   construct/update code (`emitItemConstruct`/`emitItemUpdate` below),
 *   which recurse for arbitrary nesting depth.
 *
 *   **Every dynamically-created node gets a genuinely unique `id`, and
 *   nothing is ever cached in a field.** Two earlier designs were tried and
 *   rejected here:
 *   - A compound value nested inside a single node field
 *     (`roSGNode.AddFields({ ft_state: {} })`, mutated via chained
 *     dot-writes like `ft_item.ft_state.ft_if_2 = ...`) — a compound
 *     value written into a *different* node's field doesn't reliably survive
 *     being read back later, unlike a component's own `m` scope. The write
 *     silently failed to persist and a later `.appendChild()` on the stale
 *     value crashed with "Interface not a member of BrightScript Component."
 *   - A flat reference field per node (`refFieldName`, `ft_ref_<id>`), added
 *     once via `roSGNode.AddFields()` at construction and read back by plain
 *     dot-notation. This replaced an even earlier `findNode`-based design
 *     that was confirmed wrong on a real device — but that earlier `findNode`
 *     failure was observed with every dynamically-created sibling reusing
 *     the *exact same* literal id (every row's `Label` got `id="row"`),
 *     which is equally explained by id collision as by any deeper
 *     `findNode` unreliability. The flat-ref-field design also turned out to
 *     have its own real bug: `roSGNode.AddFields()` silently no-ops when the
 *     field name already exists, so a nested destroy-mode `{#if}` that
 *     cycled true→false→true more than once left a stale field pointing at
 *     an orphaned, already-detached node — a leak, and a correctness bug
 *     (a later update could silently write to the orphaned node instead of
 *     the live one).
 *
 *   The current design retires node-field caching entirely: every
 *   dynamically-set `.id` is suffixed with the current item's own
 *   reconcile key (`uniqueIdExpr` — e.g. `"row_" & ft_key`), so no two
 *   siblings — inside one `{#each}` or across nested ones — ever share an
 *   id, and any later resolution goes through `<itemRoot>.findNode(id)`
 *   instead of a cached field. This re-opens the `findNode` question under
 *   the one condition the original device failure never actually tried —
 *   truly unique ids — and needs the same kind of real-device confirmation
 *   that motivated the two earlier redesigns; see
 *   findings/template-each-nesting.md for the device test that's meant to
 *   settle it.
 *   - A nested destroy-mode block's mount state is simply
 *     `<itemRoot>.findNode(id) <> invalid` — no pre-registration wrinkle to
 *     work around (that wrinkle was specific to `AddFields`-with-`invalid`,
 *     which no longer applies to anything here).
 *   - A nested destroy-mode block needs no stored *parent* reference either —
 *     its parent is always statically known at compile time (whichever
 *     element directly contains it in the template), exactly like the
 *     top-level `{#if:destroy}` mechanism never stores one. An unlabeled
 *     parent element gets a synthesized id via the same
 *     `syntheticParentIds`/`conditionalParentElementId` machinery the
 *     top-level case already uses (computed once, for both cases, by
 *     `analysis/conditional-blocks.ts`'s `analyzeTemplateBlocks`), and is
 *     itself resolved via `findNode` with the same key-suffixed uniqueness.
 *   - A nested `{#each}`'s `_keys`/`_nodes` diff bookkeeping (a real key→node
 *     map, not just an existence flag) moves into the **enclosing
 *     component's own `m` scope** — exactly like a top-level each's
 *     `_keys`/`_nodes` already reliably do — keyed by the chain of
 *     enclosing items' own reconcile keys (`m["$$<id>_keys"][<outerKey>]`,
 *     `[<outerKey>][<middleKey>]` for deeper nesting; see `naming.ts`'s
 *     `mFieldAccess` for the `$$`-prefixed bracket-syntax convention this
 *     uses). Because this bookkeeping no longer lives *on* the item node,
 *     it's no longer garbage-collected for free when that item is removed —
 *     the outer each's own removal pass explicitly deletes every
 *     transitively-nested each's dict entry for a removed key (see
 *     `EachBlock.nestedEachIds`).
 *
 *   **Update semantics for a nested destroy-mode block match the top-level
 *   idempotent create/destroy check**, not a simpler
 *   always-tear-down-and-maybe-rebuild pass: create only on a false→true
 *   transition, destroy only on a true→false transition, and — when already
 *   mounted and staying mounted — update its children in place instead of
 *   destroying and recreating the subtree.
 *
 * Unlike a `{#if:destroy}` block's wrapper (0-or-1 instances, sometimes
 * entirely absent from the tree), a *top-level* `{#each}` block's wrapper
 * `Group` is *always* statically present in the compiled XML — the list
 * itself is 0..N items, but the wrapper that holds them always exists. That
 * means a top-level each-block needs none of `{#if:destroy}`'s runtime
 * sibling-insertion-index machinery for its own placement:
 * `codegen/xml-emitter.ts` emits it as an ordinary static child (same shape
 * a toggle-mode `{#if}` block's wrapper already uses), and
 * `codegen/brs-emitter.ts` caches it via a plain `findNode` in `init()`,
 * just like any other statically-present id — this top-level, once-per-app
 * lookup is unaffected by any per-item id concern above, since a top-level
 * wrapper's id is never duplicated anywhere else in the document. An each
 * nested inside a `{#if:destroy}` subtree (not inside another each) is the
 * one exception — its wrapper doesn't exist until that ancestor's own create
 * sub runs, and an each nested inside *another each* never has a statically-
 * findable wrapper at all (it's created fresh per outer item, resolved
 * afterward via `findNode` against its own key-suffixed id).
 *
 * **The reconcile algorithm's correctness rests on one documented but
 * device-unverified `roSGNode` API behavior**: `InsertChild(child, index)`,
 * when `child` is already one of the node's children, removes and
 * re-inserts it at `index` instead of erroring/duplicating it — i.e. it is
 * both an insert-if-new *and* a move-if-existing primitive. If that
 * documented behavior doesn't hold as expected, every surviving item's
 * `insertChild` call in the position-pass below needs to become an explicit
 * `RemoveChildIndex` + `InsertChild` two-step instead of relying on
 * `InsertChild` alone. Flagged here and in findings/template-each-reconcile.md
 * pending real-device sideload verification.
 */
import { TemplateElement, TemplateEachBlock, TemplateIfBlock, TemplateNode } from '../dsl-parser/dsl-ast.js';
import { extendTemplateScope, FunctionScope, NO_FUNCTION_SCOPE, ScriptBindings } from '../analysis/scope-resolution.js';
import { walkTemplate } from '../analysis/template-walk.js';
import { GlobalBindingsContext } from '../analysis/global-bindings.js';
import { rewriteExpression } from '../analysis/identifier-rewrite.js';
import { analyzeTemplateBlocks } from '../analysis/conditional-blocks.js';
import type { ConditionalBlockAnalysis } from '../analysis/conditional-blocks.js';
import { eachCreateItemSubName, eachKeyNormalizerName, eachReconcileSubName, eachUpdateItemSubName, mFieldAccess, FOCUSABLE_ATTRIBUTE_NAME, DEFAULT_FOCUS_ATTRIBUTE_NAME, brsStringLiteral, UNMOUNT_FUNCTION_NAME } from './naming.js';
import { focusUnregisterCall, emitDynamicFocusableAssignment, staticFocusableRegisterLine, emitFieldAssignments } from './shared-emit.js';
import { isStaticallyDefaultFocusTrue } from '../analysis/focusable-elements.js';
import { globalFieldRef } from './global-fields.js';
import type { KeyBindingElement } from '../analysis/key-bindings.js';

const NO_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };

export interface EachBlock {
  /** The synthetic wrapper `Group`'s id — e.g. `ft_each_3` — assigned in document order across the whole template. */
  readonly id: string;
  /** Raw (not yet identifier-rewritten) DSL collection expression — evaluated in the *outer* scope, `itemAlias` is not in scope for it. */
  readonly collectionExpression: string;
  readonly itemAlias: string;
  /** Raw (not yet identifier-rewritten) DSL key expression — evaluated per-item, with `itemAlias` in scope. */
  readonly keyExpression: string;
  readonly children: readonly TemplateNode[];
  /** This block's own item scope (`itemAlias` shadowing any same-named DSL binding) — every binding inside `children` is rewritten against this, not the plain script-level scope. */
  readonly scope: FunctionScope;
  /** Every `{#each}` id nested anywhere inside this block's own item body, at *any* depth (recurses into a nested each's own body too, unlike an ordinary nested-id collector) — needed to delete that nested each's `m["$$<id>_keys"][key]`/`_nodes[key]` dict entry when *this* block removes an item carrying that key (see `emitEachReconcileSub`/`emitInlineEachDiff`'s stale-removal pass). */
  readonly nestedEachIds: readonly string[];
}

export interface EachBlockAnalysis {
  readonly blocks: readonly EachBlock[];
  readonly blockIdByNode: ReadonlyMap<TemplateEachBlock, string>;
  /** This each-block's own id → the id of its nearest enclosing destroy-mode `{#if:destroy}` block, if any — the reconcile-trigger counterpart to `ConditionalBlockAnalysis.nearestDestroyAncestorById` (same shared map, see `analysis/conditional-blocks.ts`'s `analyzeTemplateBlocks`). Used to guard this block's reconcile call (`brs-emitter.ts`'s `emitCascadeLines`) exactly like an ordinary binding is guarded. */
  readonly nearestDestroyAncestorById: ReadonlyMap<string, string>;
  /** This each-block's own id → the id of its nearest enclosing `{#each}` block, if any. Present iff this block is itself nested inside another `{#each}`'s body — such a block is never given its own top-level reconcile/create-item/update-item subs (`brs-emitter.ts` filters it out of every init/cascade loop); its diff logic is inlined into the enclosing each's own per-item construct/update code instead (see `emitInlineEachDiff`). */
  readonly nearestEachAncestorById: ReadonlyMap<string, string>;
}

export const EMPTY_EACH_BLOCKS: EachBlockAnalysis = { blocks: [], blockIdByNode: new Map(), nearestDestroyAncestorById: new Map(), nearestEachAncestorById: new Map() };

/** Thin wrapper around `analysis/conditional-blocks.ts`'s `analyzeTemplateBlocks` for a caller/test that only cares about `{#each}` blocks. */
export function analyzeEachBlocks(root: TemplateElement): EachBlockAnalysis {
  return analyzeTemplateBlocks(root).each;
}

/** Everything the recursive item-body emitters need about the surrounding template — the ids `analyzeTemplateBlocks` already assigned to every `{#if}`/`{#each}` node, so nested blocks reuse the exact same ids the analysis pass (and `nearestEachAncestorById`/`nearestDestroyAncestorById`) already agree on. */
export interface ItemEmitContext {
  readonly scriptBindings: ScriptBindings;
  readonly globalBindings: GlobalBindingsContext;
  readonly componentName: string;
  readonly ifBlockIdByNode: ReadonlyMap<TemplateIfBlock, string>;
  readonly eachBlockIdByNode: ReadonlyMap<TemplateEachBlock, string>;
  /** Threaded from `ConditionalBlockAnalysis.syntheticParentIds` — an item-body element with no author id that directly contains a nested destroy-mode `{#if:destroy}` needs this so that block's `findNode`-based parent resolution (create/update) has a real id to look up. */
  readonly syntheticParentIds: ReadonlyMap<TemplateElement, string>;
  /** blockId → the full `EachBlock` — used to look up a block's own `nestedEachIds` from inside `emitInlineEachDiff`, where only the id string (not the full analysis record) is otherwise in scope. */
  readonly eachBlockById: ReadonlyMap<string, EachBlock>;
}

/**
 * `sub <componentName>__reconcile_each_N()` — the real keyed-diff reconcile body
 * for a **top-level** each block (no `{#each}` ancestor — see the class doc
 * comment for the nested case, which inlines the same shape via
 * `emitInlineEachDiff` instead of calling out to named subs), three passes:
 *
 * 1. Evaluate the collection once, computing the new ordered key list and a
 *    keep-set (an AA used purely as a string-keyed set, via `DoesExist`).
 * 2. Remove every currently-rendered key that's no longer in the keep-set
 *    (`removeChild` + drop its `_nodes` entry) — done *before* the
 *    position pass below, since `insertChild`'s target index is relative to
 *    the *current* child list, not the desired final one; stale nodes must
 *    be gone first or every later index would be off.
 * 3. Walk the new key order ascending, reusing (`<componentName>__update_item_<id>`)
 *    a surviving key's existing node or creating (`<componentName>__create_item_<id>`)
 *    a new one, then unconditionally `insertChild`ing it at its target index.
 *    No minimal-move-set computation is needed: processing target indices
 *    `0, 1, 2, ...` in ascending order never disturbs an already-finalized
 *    position, so by the time the loop ends every node sits at its correct
 *    final index regardless of where it started (see the class doc comment
 *    above for the one `InsertChild` API assumption this relies on).
 *
 * Duplicate keys are not compile-time detectable (the collection is a
 * runtime value) — two items sharing a key silently collapse onto one
 * rendered node (the second occurrence's create/update and `insertChild`
 * simply re-target the same `_nodes` entry), a documented runtime
 * contract, not a compile error.
 */
export function emitEachReconcileSub(
  block: EachBlock,
  scriptBindings: ScriptBindings,
  componentName: string,
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
  needsItemsDict = false,
): string {
  const collectionExpr = rewriteExpression(block.collectionExpression, scriptBindings, `template ${block.id} collection`, NO_FUNCTION_SCOPE, globalBindings);
  const keyExpr = rewriteExpression(block.keyExpression, scriptBindings, `template ${block.id} key`, block.scope, globalBindings);
  const blockRef = mFieldAccess(block.id);
  const keysVar = mFieldAccess(block.id, '_keys');
  const nodesVar = mFieldAccess(block.id, '_nodes');
  const itemsVar = mFieldAccess(block.id, '_items');
  const nestedEachCleanup = block.nestedEachIds.flatMap((nestedId) => [`      ${mFieldAccess(nestedId, '_keys')}.Delete(ft_oldKey)`, `      ${mFieldAccess(nestedId, '_nodes')}.Delete(ft_oldKey)`]);
  // Unregister every focusable descendant of a removed item from the focus manager before it's
  // detached — same "before removeChild" ordering requirement as everywhere else this pattern is
  // used (see conditional-block-emitter.ts's matching comment).
  const focusableIds = collectEachItemFocusableIds(block.children);
  const focusUnregisterLines = focusableIds.flatMap((id) => [
    `      ft_focusTarget = ${nodesVar}[ft_oldKey].findNode(${uniqueIdExpr(id, ['ft_oldKey'])})`,
    `      if ft_focusTarget <> invalid then`,
    `        ${focusUnregisterCall('ft_focusTarget')}`,
    `      end if`,
  ]);
  // Cascade the component-unmount hook to a removed item before it's detached — the item's own
  // root node gets a direct, unconditional call (it's the value about to be removeChild'd, so it's
  // known non-invalid; a findNode-based lookup wouldn't reach it anyway, since findNode searches a
  // node's descendants, not the node itself), then every other id in its body via the same
  // guarded-findNode shape the focus-unregister lines above already use.
  const unmountIds = collectEachItemElementIds(block.children);
  const unmountLines = [`      ${nodesVar}[ft_oldKey].callFunc("${UNMOUNT_FUNCTION_NAME}")`, ...emitEachItemUnmountCascadeLines(`${nodesVar}[ft_oldKey]`, unmountIds, ['ft_oldKey'], 'ft_unmountTarget', '      ')];

  return [
    `sub ${eachReconcileSubName(componentName, block.id)}()`,
    `  ft_collection = ${collectionExpr}`,
    `  if type(ft_collection) = "roSGNode" then`,
    `    ft_collection = ft_collection.getChildren(-1, 0)`,
    `  end if`,
    `  ft_newKeys = []`,
    `  ft_keepSet = {}`,
    `  for ft_i = 0 to ft_collection.Count() - 1`,
    `    ${block.itemAlias} = ft_collection[ft_i]`,
    `    ft_key = ${eachKeyNormalizerName(componentName)}(${keyExpr})`,
    `    ft_newKeys.Push(ft_key)`,
    `    ft_keepSet[ft_key] = true`,
    `  end for`,
    ``,
    `  for each ft_oldKey in ${keysVar}`,
    `    if not ft_keepSet.DoesExist(ft_oldKey) then`,
    ...focusUnregisterLines,
    ...unmountLines,
    `      ${blockRef}.removeChild(${nodesVar}[ft_oldKey])`,
    `      ${nodesVar}.Delete(ft_oldKey)`,
    ...(needsItemsDict ? [`      ${itemsVar}.Delete(ft_oldKey)`] : []),
    ...nestedEachCleanup,
    `    end if`,
    `  end for`,
    ``,
    `  ft_newNodes = {}`,
    ...(needsItemsDict ? [`  ft_newItems = {}`] : []),
    `  for ft_i = 0 to ft_collection.Count() - 1`,
    `    ${block.itemAlias} = ft_collection[ft_i]`,
    `    ft_key = ft_newKeys[ft_i]`,
    `    if ${nodesVar}.DoesExist(ft_key) then`,
    `      ft_node = ${nodesVar}[ft_key]`,
    `      ${eachUpdateItemSubName(componentName, block.id)}(ft_key, ${block.itemAlias}, ft_node)`,
    `    else`,
    `      ft_node = ${eachCreateItemSubName(componentName, block.id)}(ft_key, ${block.itemAlias})`,
    `    end if`,
    `    ${blockRef}.insertChild(ft_node, ft_i)`,
    `    ft_newNodes[ft_key] = ft_node`,
    ...(needsItemsDict ? [`    ft_newItems[ft_key] = ${block.itemAlias}`] : []),
    `  end for`,
    ``,
    `  ${keysVar} = ft_newKeys`,
    `  ${nodesVar} = ft_newNodes`,
    ...(needsItemsDict ? [`  ${itemsVar} = ft_newItems`] : []),
    // Called once, at the very end — after every stale item is gone AND every surviving item has
    // been repositioned. Confirmed live that reassigning focus any earlier (e.g. inline with the
    // stale-removal pass, right after unregister()) gets silently clobbered by this reconcile's
    // own later, unconditional InsertChild reposition pass — see runtime-assets/FocusManager's
    // own doc comment on `recoverFocusFor` and findings/focus-runtime-bugs.md. Scoped to this
    // component (`m.top`) so a reconcile that never held focus is a no-op instead of grabbing
    // focus that belongs to another component — see that same doc comment.
    ...(focusableIds.length > 0 ? [`  ${globalFieldRef('focus')}.callFunc("recoverFocusFor", m.top)`] : []),
    'end sub',
  ].join('\n');
}

/**
 * `function <componentName>__create_item_each_N(ft_key as string, <itemAlias> as object) as object`
 * — hand-constructs one new item's subtree as BRS statements and returns its
 * root node, for a **top-level** each block. Delegates the actual body walk
 * to `emitItemConstruct` (shared with nested-each inline construction) —
 * every node inside always gets a fresh local/temp variable, *never*
 * `m.<id>`, even when the element has an author-given `id` in the DSL
 * source: this runs once per rendered *item*, so caching at a fixed
 * `m.<id>` slot would have each new item silently overwrite the previous
 * one's reference (and every concurrently-rendered item collide on the
 * exact same slot). `ft_key` is always threaded through (not gated on
 * whether the item body's own bindings reference it) — every dynamically-set
 * id needs it to stay unique across sibling items, regardless of whether the
 * item's own bindings otherwise care about the key.
 */
export function emitCreateItemSub(block: EachBlock, ctx: ItemEmitContext): string {
  const lines: string[] = [`function ${eachCreateItemSubName(ctx.componentName, block.id)}(ft_key as string, ${block.itemAlias} as object) as object`, `  ft_item = CreateObject("roSGNode", "Group")`];
  const tempCounter = { n: 0 };
  emitItemConstruct(block.children, 'ft_item', 'ft_item', ['ft_key'], 1, lines, block.scope, tempCounter, ctx);
  lines.push(`  return ft_item`, 'end function');
  return lines.join('\n');
}

/**
 * `sub <componentName>__update_item_each_N(ft_key as string, <itemAlias> as object, ft_item as object)`
 * — re-runs every dynamic binding inside the item body against a *surviving*
 * (key-persisted, node identity preserved) item, unconditionally, every
 * reconcile pass (no finer-grained "did this specific value actually
 * change" check — a deliberate simplification, same "cascade
 * unconditionally reassigns" style already used elsewhere in this
 * codebase), for a **top-level** each block. A nested destroy-mode
 * `{#if:destroy}` inside the body is the one exception to "unconditional":
 * its own create/destroy is still idempotent (see `emitItemUpdate`'s
 * destroy-mode branch) — only its *surviving-and-still-mounted* case re-runs
 * bindings unconditionally, same as everything else here. Delegates to
 * `emitItemUpdate` (shared with nested-each inline update).
 */
export function emitUpdateItemSub(block: EachBlock, ctx: ItemEmitContext): string {
  const lines: string[] = [`sub ${eachUpdateItemSubName(ctx.componentName, block.id)}(ft_key as string, ${block.itemAlias} as object, ft_item as object)`];
  emitItemUpdate(block.children, 'ft_item', null, ['ft_key'], 1, lines, block.scope, { n: 0 }, ctx);
  lines.push('end sub');
  return lines.join('\n');
}

/**
 * Builds the `ItemEmitContext` every recursive item-body emitter needs —
 * critically, `ifBlockIdByNode`/`eachBlockIdByNode` here are the exact same
 * map instances `analyzeTemplateBlocks(root)` produced for the *whole*
 * template (threaded in via `conditionalAnalysis`/`eachAnalysis`), **not**
 * independently re-derived over just one block's own `children`. Nested
 * blocks already got real, globally-unique ids from that one canonical walk
 * (the whole reason `{#each}` support extended it instead of writing a
 * second one, see that function's own doc comment). A real bug caught while
 * first wiring this up: an earlier version of this code re-ran
 * `analyzeTemplateBlocks` on just a block's own `children`, restarting that
 * analysis's id counters from zero for every call — a nested `{#each}`
 * inside a top-level `{#each}` ended up with the exact same id
 * (`ft_each_1`) as its own enclosing block, since each independent,
 * subtree-scoped call started counting from scratch.
 */
export function buildItemEmitContext(
  conditionalAnalysis: ConditionalBlockAnalysis,
  eachAnalysis: EachBlockAnalysis,
  scriptBindings: ScriptBindings,
  componentName: string,
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
): ItemEmitContext {
  return {
    scriptBindings,
    globalBindings,
    componentName,
    ifBlockIdByNode: conditionalAnalysis.blockIdByNode,
    eachBlockIdByNode: eachAnalysis.blockIdByNode,
    syntheticParentIds: conditionalAnalysis.syntheticParentIds,
    eachBlockById: new Map(eachAnalysis.blocks.map((b) => [b.id, b])),
  };
}

/**
 * The set of top-level `{#each}` block ids whose own item body contains at
 * least one `on:key[...]` attribute — these, and only these, get the extra
 * `_items` companion dict (key -> raw item value) that lets a generated
 * `onKeyEvent` recover which row's own data to pass into its handler call
 * (see GRAMMAR.md's "on:key event binding" section). Bookkeeping cost is
 * skipped for every other each block. `analysis/key-bindings.ts`'s
 * `checkAndGroupKeyBindings` already rejects on:key inside a *nested* each
 * (`template/on-key-inside-nested-each`), so every `nearestEachAncestorId`
 * this sees is guaranteed to be a real top-level block's own id.
 */
export function eachBlocksNeedingItemsDict(keyBindings: readonly KeyBindingElement[]): ReadonlySet<string> {
  return new Set(keyBindings.filter((k) => k.insideEach).map((k) => k.nearestEachAncestorId!));
}

/** Every top-level `{#each}` block's reconcile + create-item + update-item subs, plus the one shared key-normalizer helper (emitted once, only if at least one `{#each}` block exists anywhere in the template). A block nested inside another `{#each}` (`nearestEachAncestorById` has an entry for it) is **excluded** — it never gets its own subs; its logic is inlined into its enclosing each's own create-item/update-item instead. */
export function emitEachBlockSubs(
  analysis: EachBlockAnalysis,
  conditionalAnalysis: ConditionalBlockAnalysis,
  scriptBindings: ScriptBindings,
  componentName: string,
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
  keyBindings: readonly KeyBindingElement[] = [],
): string[] {
  const topLevelBlocks = analysis.blocks.filter((b) => !analysis.nearestEachAncestorById.has(b.id));
  if (topLevelBlocks.length === 0) return [];

  const needsItems = eachBlocksNeedingItemsDict(keyBindings);
  const ctx = buildItemEmitContext(conditionalAnalysis, analysis, scriptBindings, componentName, globalBindings);
  const sections: string[] = [emitEachKeyNormalizer(componentName)];
  for (const block of topLevelBlocks) {
    sections.push(emitEachReconcileSub(block, scriptBindings, componentName, globalBindings, needsItems.has(block.id)));
    sections.push(emitCreateItemSub(block, ctx));
    sections.push(emitUpdateItemSub(block, ctx));
  }
  return sections;
}

/**
 * `roAssociativeArray` keys must be strings, but a `(key)` clause may
 * evaluate to any scalar (an integer id, a boolean, ...) — normalizes any
 * such value into a string. A boxed/unboxed string is returned as-is (never
 * round-tripped through `.ToStr()`, which would be a no-op anyway but reads
 * clearer written explicitly); anything else goes through `.ToStr()`
 * (BrightScript auto-boxes an intrinsic scalar when a method is called on
 * it, so this works for a plain unboxed Integer/Float/Boolean too, not just
 * an already-boxed `roInt`/`roFloat`/`roBoolean`). Assumes the key is a
 * plain scalar, never an object/node/array — documented as a current limitation
 * in GRAMMAR.md's "Keyed list rendering" section.
 */
function emitEachKeyNormalizer(componentName: string): string {
  return [
    `function ${eachKeyNormalizerName(componentName)}(key as dynamic) as string`,
    `  if type(key) = "roString" or type(key) = "String" then return key`,
    `  return key.ToStr()`,
    'end function',
  ].join('\n');
}

/**
 * The current item's own reconcile key, as a BrightScript variable-name
 * expression — always the last entry of `keyChainParts`. Every create/update
 * item sub takes a leading `ft_key` parameter unconditionally (see
 * `emitCreateItemSub`/`emitUpdateItemSub`), and every nested-each's own
 * per-item construct/update call extends the chain by one entry (see
 * `emitInlineEachDiff`), so `keyChainParts` is never empty here.
 */
function itemKeyExpr(keyChainParts: readonly string[]): string {
  return keyChainParts[keyChainParts.length - 1];
}

/**
 * A dynamically-created node's runtime-unique id expression: the
 * compile-time-known literal (an author id, a synthesized parent id, or a
 * compiler-synthesized block id) suffixed with the current item's own
 * reconcile key — e.g. `"row_" + ft_key`. No two dynamically-created
 * siblings, inside one `{#each}` or across nested ones, ever share an id.
 * Used both to set a node's `.id` at construction and to reconstruct the
 * exact same string later for a `findNode` lookup — see the class doc
 * comment for why this replaced a per-node cached reference field. Uses `+`
 * for string concatenation, not BrightScript's `&` operator — this
 * codebase's own BrightScript parser (`kopytko-brightscript-parser`, used to
 * validate every golden fixture) doesn't accept `&`; `+` is already relied
 * on elsewhere in generated code (e.g. the sibling-insertion-index
 * accumulator's `ft_idx + 1`) and both keyExpr's `ToStr()` normalization and
 * the literal here are always strings, so `+` is unambiguous concatenation.
 */
function uniqueIdExpr(id: string, keyChainParts: readonly string[]): string {
  return `${brsStringLiteral(`${id}_`)} + ${itemKeyExpr(keyChainParts)}`;
}

/**
 * Every `focusable`-bearing (static or dynamic) element id anywhere in one
 * `{#each}` item's own body — mirrors `conditional-block-emitter.ts`'s
 * `collectNestedFocusableIds`, but stops at a nested `{#each}`'s own
 * boundary (that nested each's own removal pass owns unregistering its own
 * items' focusable descendants, addressed via its own key, not this one's).
 * Used by a stale-item removal pass to unregister every focusable
 * descendant of a removed item from the focus manager before it's detached.
 */
function collectEachItemFocusableIds(nodes: readonly TemplateNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    walkTemplate(node, {
      recurseIntoEach: false,
      onElement: (element) => {
        if (element.attributes.some((a) => (a.kind === 'static' || a.kind === 'dynamic') && a.name === FOCUSABLE_ATTRIBUTE_NAME)) {
          out.push(element.id!);
        }
      },
    });
  }
  return out;
}

/**
 * Every element id (author-given) anywhere in one `{#each}` item's own body — mirrors
 * `collectEachItemFocusableIds`'s exact shape and its "stop at a nested `{#each}`'s own boundary"
 * rule (that nested each's own removal pass owns cascading `ft_unmount` to its own items), but
 * collects EVERY id, not just focusable ones. Used by a stale-item removal pass to cascade the
 * component-unmount hook (`ft_unmount` — see `naming.ts`'s `UNMOUNT_FUNCTION_NAME` doc comment) to
 * every element in a removed item's own subtree before it's detached — the `{#each}` counterpart of
 * `conditional-block-emitter.ts`'s `nestedIds` cascade for `{#if:destroy}`. Calling `ft_unmount` on a
 * plain native element (most of these) is a safe, silent no-op — an undeclared interface function —
 * so this doesn't need to distinguish "might be a custom component" from "definitely isn't"; it's
 * exactly the same trust-the-safety-net approach `{#if:destroy}`'s own cascade already uses. Same
 * "needs an `id` to be reachable at all" restriction as `{#if:destroy}`'s own cascade — a nested
 * custom component with no author-given `id` inside an each-item body is not reachable here.
 */
function collectEachItemElementIds(nodes: readonly TemplateNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    walkTemplate(node, {
      recurseIntoEach: false,
      onElement: (element) => {
        if (element.id) out.push(element.id);
      },
    });
  }
  return out;
}

/**
 * The guarded `<itemRoot>.findNode(<uniqueId>).callFunc("ft_unmount")` lines for every id in
 * `unmountIds`, resolved against `itemRootVarExpr` (always the OVERALL item root, never a nested
 * found-node — same "resolution for anything nested goes via the same item root" rule
 * `emitItemUpdate`'s own destroy-mode branch already documents) — mirrors the shape of a
 * focus-unregister block exactly, one guarded `findNode` + conditional `callFunc` per id.
 * `tempVarName` lets each of the three call sites in this file use its own non-colliding local
 * (`ft_unmountTarget`, `ft_unmountTarget_<blockId>`, ...), matching how `focusUnregisterLines`
 * threads a per-call-site `ft_focusTarget...` name through its own three call sites.
 */
function emitEachItemUnmountCascadeLines(itemRootVarExpr: string, unmountIds: readonly string[], keyChainParts: readonly string[], tempVarName: string, indent: string): string[] {
  return unmountIds.flatMap((id) => [
    `${indent}${tempVarName} = ${itemRootVarExpr}.findNode(${uniqueIdExpr(id, keyChainParts)})`,
    `${indent}if ${tempVarName} <> invalid then`,
    `${indent}  ${tempVarName}.callFunc("${UNMOUNT_FUNCTION_NAME}")`,
    `${indent}end if`,
  ]);
}

/**
 * Hand-constructs one item's subtree as BRS statements — shared by a
 * top-level each's `emitCreateItemSub` and (recursively) by
 * `emitInlineEachDiff` for a nested each's own new items. Every node always
 * gets a fresh local/temp variable, never `m.<id>` (see the class doc
 * comment on why); an id-bearing node's `.id` is set to `uniqueIdExpr` so a
 * later, separate `emitItemUpdate` call — which has no access to this
 * function's own local variables — can still resolve it via `findNode`.
 * `parentRefExpr` is the live node reference to `appendChild` onto —
 * changes as construction descends into nested elements/blocks.
 * `itemRootExpr` is *this specific item's own root* — unlike
 * `parentRefExpr`, it stays fixed for everything inside one item (only
 * changing when construction crosses into a nested each's own item, which
 * is a genuinely new item with its own root and its own key). `keyChainParts`
 * is the compile-time-known sequence of enclosing items' own key variables
 * (outermost first) — always at least one entry (see `itemKeyExpr`), growing
 * by one entry every time construction crosses into a nested each's own
 * items (see the `'each'` branch below and `emitInlineEachDiff`). Also used
 * to address a *nested* each's `_keys`/`_nodes` chain-keyed dictionary at the
 * enclosing component's own `m` scope — an entirely separate concern from
 * the per-node unique ids above (that one is cross-*call* bookkeeping at the
 * enclosing component's own `m` scope; this one is per-*item* node identity).
 */
export function emitItemConstruct(
  nodes: readonly TemplateNode[],
  parentRefExpr: string,
  itemRootExpr: string,
  keyChainParts: readonly string[],
  depth: number,
  lines: string[],
  itemScope: FunctionScope,
  tempCounter: { n: number },
  ctx: ItemEmitContext,
): void {
  const indent = '  '.repeat(depth);

  for (const node of nodes) {
    if (node.kind === 'element') {
      const varExpr = `ft_n${++tempCounter.n}`;
      lines.push(`${indent}${varExpr} = CreateObject("roSGNode", "${node.tagName}")`);
      const elementId = node.id ?? ctx.syntheticParentIds.get(node) ?? null;
      if (elementId) lines.push(`${indent}${varExpr}.id = ${uniqueIdExpr(elementId, keyChainParts)}`);

      // Plain static/dynamic (non-focusable) attribute values are batched into one
      // setFields() call below instead of one dot-assignment per attribute; only
      // focusable (its own register/unregister shape) is pushed immediately.
      const plainFields: { name: string; value: string }[] = [];
      for (const attr of node.attributes) {
        if (attr.kind === 'static') {
          if (attr.name === FOCUSABLE_ATTRIBUTE_NAME) {
            lines.push(`${indent}${varExpr}.${attr.name} = ${brsStringLiteral(attr.value)}`);
          } else if (attr.name !== DEFAULT_FOCUS_ATTRIBUTE_NAME) {
            // default-focus is a pure compiler-internal/DSL marker with no corresponding native
            // SceneGraph field — never a real field assignment (confirmed live — see
            // findings/router.md), unlike `focusable`, which legitimately is a real native field.
            plainFields.push({ name: attr.name, value: brsStringLiteral(attr.value) });
          }
          const registerLine = staticFocusableRegisterLine(varExpr, attr.name, attr.value, isStaticallyDefaultFocusTrue(node));
          if (registerLine) lines.push(`${indent}${registerLine}`);
        } else if (attr.kind === 'dynamic') {
          const rewritten = rewriteExpression(attr.expression, ctx.scriptBindings, `each-item ${node.id ?? node.tagName}.${attr.name}`, itemScope, ctx.globalBindings);
          if (attr.name === FOCUSABLE_ATTRIBUTE_NAME) {
            // Same reactive register/unregister shape as brs-emitter.ts's emitBindingAssignment/
            // conditional-block-emitter.ts's construction path — the *initial* evaluation for this
            // item; emitItemUpdate's own dynamicAttrs handling covers every reconcile after that.
            for (const line of emitDynamicFocusableAssignment(varExpr, `ft_focusable_${varExpr}`, rewritten, attr.name)) {
              lines.push(`${indent}${line}`);
            }
          } else {
            plainFields.push({ name: attr.name, value: rewritten });
          }
        }
        // bind: is rejected inside {#each} (template/bind-inside-each, analysis/bind-targets.ts) —
        // never reaches here. on:key is allowed inside {#each} but needs no construction-time push
        // — see conditional-block-emitter.ts's matching comment.
      }
      for (const line of emitFieldAssignments(varExpr, plainFields)) {
        lines.push(`${indent}${line}`);
      }

      lines.push(`${indent}${parentRefExpr}.appendChild(${varExpr})`);
      emitItemConstruct(node.children, varExpr, itemRootExpr, keyChainParts, depth, lines, itemScope, tempCounter, ctx);
      continue;
    }

    if (node.kind === 'if') {
      const ifId = ctx.ifBlockIdByNode.get(node)!;
      const condition = rewriteExpression(node.expression, ctx.scriptBindings, `each-item ${ifId} condition`, itemScope, ctx.globalBindings);

      if (node.mode === 'toggle') {
        const varExpr = `ft_n${++tempCounter.n}`;
        lines.push(`${indent}${varExpr} = CreateObject("roSGNode", "Group")`);
        lines.push(`${indent}${varExpr}.id = ${uniqueIdExpr(ifId, keyChainParts)}`);
        lines.push(`${indent}${varExpr}.visible = ${condition}`);
        lines.push(`${indent}${parentRefExpr}.appendChild(${varExpr})`);
        emitItemConstruct(node.children, varExpr, itemRootExpr, keyChainParts, depth, lines, itemScope, tempCounter, ctx);
        continue;
      }

      // destroy mode — a freshly-constructed item has nothing mounted yet, so construction is
      // always a plain create-if-condition-holds, no mount check needed (that's only relevant at
      // update time — see emitItemUpdate).
      lines.push(`${indent}if ${condition} then`);
      const wrapperVar = `ft_n${++tempCounter.n}`;
      lines.push(`${indent}  ${wrapperVar} = CreateObject("roSGNode", "Group")`);
      lines.push(`${indent}  ${wrapperVar}.id = ${uniqueIdExpr(ifId, keyChainParts)}`);
      lines.push(`${indent}  ${parentRefExpr}.appendChild(${wrapperVar})`);
      emitItemConstruct(node.children, wrapperVar, itemRootExpr, keyChainParts, depth + 1, lines, itemScope, tempCounter, ctx);
      lines.push(`${indent}end if`);
      continue;
    }

    // node.kind === 'each' — a nested {#each}. Its own wrapper is created once, here, and never
    // moves again (only its *items* change on later reconciles) — no parent-ref bookkeeping
    // needed the way destroy-mode above needs, since the wrapper itself is never removed. Its
    // _keys/_nodes bookkeeping lives at the enclosing component's own m scope, addressed by the
    // chain of enclosing items' own keys. Every intermediate chain level except the last is
    // guarded (DoesExist-then-create) since it may already exist from a sibling item sharing the
    // same outer key prefix; the last level is a brand-new entry for this item's own key, always
    // freshly created here. The wrapper's own id is keyed by *this* item's own key (the current
    // last entry of keyChainParts, before extending it below for the nested each's own items).
    const innerId = ctx.eachBlockIdByNode.get(node)!;
    const wrapperVar = `ft_n${++tempCounter.n}`;
    lines.push(`${indent}${wrapperVar} = CreateObject("roSGNode", "Group")`);
    lines.push(`${indent}${wrapperVar}.id = ${uniqueIdExpr(innerId, keyChainParts)}`);
    lines.push(`${indent}${parentRefExpr}.appendChild(${wrapperVar})`);
    const keysRef = mFieldAccess(innerId, '_keys');
    const nodesRef = mFieldAccess(innerId, '_nodes');
    for (let i = 1; i < keyChainParts.length; i++) {
      const prefix = keyChainParts.slice(0, i).map((k) => `[${k}]`).join('');
      const step = keyChainParts[i];
      lines.push(`${indent}if not ${keysRef}${prefix}.DoesExist(${step}) then`);
      lines.push(`${indent}  ${keysRef}${prefix}[${step}] = {}`);
      lines.push(`${indent}  ${nodesRef}${prefix}[${step}] = {}`);
      lines.push(`${indent}end if`);
    }
    const chainSuffix = keyChainParts.map((k) => `[${k}]`).join('');
    lines.push(`${indent}${keysRef}${chainSuffix} = []`);
    lines.push(`${indent}${nodesRef}${chainSuffix} = {}`);
    emitInlineEachDiff(node, innerId, wrapperVar, keyChainParts, depth, lines, itemScope, tempCounter, ctx);
  }
}

/**
 * Re-runs every dynamic binding inside a *surviving* item's body — the
 * update-time counterpart to `emitItemConstruct`, shared by a top-level
 * each's `emitUpdateItemSub` and (recursively) `emitInlineEachDiff` for a
 * nested each's own surviving items. `itemRootExpr` is the live node this
 * pass resolves an ordinary/toggle-mode element's or nested block's node
 * from, via `findNode` against the same `uniqueIdExpr` set at construction
 * time — this only ever changes when crossing into a nested each's own item
 * (its own body's nodes live under *that* item's own root, not some
 * ancestor's); it's left unchanged for a plain element or a toggle-mode
 * `{#if}`, since neither introduces a new per-instance boundary. `parentId`
 * is the id of the nearest id-bearing ancestor within *this* item (`null`
 * means "the parent is `itemRootExpr` itself") — used only by a nested
 * destroy-mode `{#if:destroy}` to resolve its own parent when it needs to
 * append/remove. `keyChainParts` is the same chain `emitItemConstruct`
 * threads through, for the same reason.
 */
export function emitItemUpdate(
  nodes: readonly TemplateNode[],
  itemRootExpr: string,
  parentId: string | null,
  keyChainParts: readonly string[],
  depth: number,
  lines: string[],
  itemScope: FunctionScope,
  tempCounter: { n: number },
  ctx: ItemEmitContext,
): void {
  const indent = '  '.repeat(depth);
  const parentExpr = parentId === null ? itemRootExpr : `${itemRootExpr}.findNode(${uniqueIdExpr(parentId, keyChainParts)})`;

  for (const node of nodes) {
    if (node.kind === 'element') {
      const dynamicAttrs = node.attributes.filter((a) => a.kind === 'dynamic');
      const elementId = node.id ?? ctx.syntheticParentIds.get(node) ?? null;
      if (elementId && dynamicAttrs.length > 0) {
        const varExpr = `ft_u${++tempCounter.n}`;
        lines.push(`${indent}${varExpr} = ${itemRootExpr}.findNode(${uniqueIdExpr(elementId, keyChainParts)})`);
        const plainFields: { name: string; value: string }[] = [];
        for (const attr of dynamicAttrs) {
          const rewritten = rewriteExpression(attr.expression, ctx.scriptBindings, `each-item ${node.id}.${attr.name}`, itemScope, ctx.globalBindings);
          if (attr.name === FOCUSABLE_ATTRIBUTE_NAME) {
            for (const line of emitDynamicFocusableAssignment(varExpr, `ft_focusable_${varExpr}`, rewritten, attr.name)) {
              lines.push(`${indent}${line}`);
            }
          } else {
            plainFields.push({ name: attr.name, value: rewritten });
          }
        }
        for (const line of emitFieldAssignments(varExpr, plainFields)) {
          lines.push(`${indent}${line}`);
        }
      }
      emitItemUpdate(node.children, itemRootExpr, elementId ?? parentId, keyChainParts, depth, lines, itemScope, tempCounter, ctx);
      continue;
    }

    if (node.kind === 'if') {
      const ifId = ctx.ifBlockIdByNode.get(node)!;
      const condition = rewriteExpression(node.expression, ctx.scriptBindings, `each-item ${ifId} condition`, itemScope, ctx.globalBindings);

      if (node.mode === 'toggle') {
        lines.push(`${indent}${itemRootExpr}.findNode(${uniqueIdExpr(ifId, keyChainParts)}).visible = ${condition}`);
        emitItemUpdate(node.children, itemRootExpr, ifId, keyChainParts, depth, lines, itemScope, tempCounter, ctx);
        continue;
      }

      // destroy mode — idempotent, matching the top-level create/destroy check
      // (conditional-block-emitter.ts's emitConditionalBlockCascadeCheck): create only on a
      // false→true transition, destroy only on a true→false transition, and — when already
      // mounted and staying mounted — update its children in place rather than recreating the
      // subtree. foundVar is a plain local (resolved fresh via findNode every update pass, never
      // cached), so there's nothing left to null out on removal — no stale-reference class of bug
      // here (see the class doc comment).
      const foundVar = `ft_u${++tempCounter.n}`;
      lines.push(`${indent}${foundVar} = ${itemRootExpr}.findNode(${uniqueIdExpr(ifId, keyChainParts)})`);
      lines.push(`${indent}if ${condition} and ${foundVar} = invalid then`);
      const newVar = `ft_n${++tempCounter.n}`;
      lines.push(`${indent}  ${newVar} = CreateObject("roSGNode", "Group")`);
      lines.push(`${indent}  ${newVar}.id = ${uniqueIdExpr(ifId, keyChainParts)}`);
      lines.push(`${indent}  ${parentExpr}.appendChild(${newVar})`);
      emitItemConstruct(node.children, newVar, itemRootExpr, keyChainParts, depth + 1, lines, itemScope, tempCounter, ctx);
      lines.push(`${indent}else if not (${condition}) and ${foundVar} <> invalid then`);
      // Cascade ft_unmount before detaching — foundVar itself (the destroy-block's own synthetic
      // Group wrapper) gets a direct call, then every id nested inside its own markup via the same
      // guarded-findNode shape used everywhere else this cascade appears. Resolution stays rooted at
      // itemRootExpr (the overall item root), matching this branch's own existing "resolution for
      // anything nested here still goes via the same item root" rule below.
      lines.push(`${indent}  ${foundVar}.callFunc("${UNMOUNT_FUNCTION_NAME}")`);
      for (const line of emitEachItemUnmountCascadeLines(itemRootExpr, collectEachItemElementIds(node.children), keyChainParts, `ft_unmountTarget${++tempCounter.n}`, `${indent}  `)) {
        lines.push(line);
      }
      lines.push(`${indent}  ${parentExpr}.removeChild(${foundVar})`);
      lines.push(`${indent}else if ${condition} then`);
      // itemRootExpr stays the overall item root (not the found node) — resolution for anything
      // nested inside this destroy-block still goes via the same item root, unlike crossing into a
      // nested each's own item below (a genuinely separate, own-keyed subtree, which does need its
      // own scoped root).
      emitItemUpdate(node.children, itemRootExpr, ifId, keyChainParts, depth + 1, lines, itemScope, tempCounter, ctx);
      lines.push(`${indent}end if`);
      continue;
    }

    // node.kind === 'each' — a nested {#each}, still present from construction (its wrapper is
    // never removed) — resolve it fresh via findNode, then just re-run its own diff against
    // whatever its collection currently is. Resolved once into a local var (not inlined into every
    // wrapperExpr use site inside emitInlineEachDiff's loop bodies) since it's referenced from
    // inside a loop there.
    const innerId = ctx.eachBlockIdByNode.get(node)!;
    const wrapperVar = `ft_u${++tempCounter.n}`;
    lines.push(`${indent}${wrapperVar} = ${itemRootExpr}.findNode(${uniqueIdExpr(innerId, keyChainParts)})`);
    emitInlineEachDiff(node, innerId, wrapperVar, keyChainParts, depth, lines, itemScope, tempCounter, ctx);
  }
}

/**
 * Inlines a nested `{#each}` block's own keyed-diff reconcile — the same
 * three-pass shape as the top-level `emitEachReconcileSub`, but generated
 * directly into the *enclosing* item's own construct/update code (via
 * `emitItemConstruct`'s/`emitItemUpdate`'s `'each'` branches) instead of a
 * separate named sub, since it needs the enclosing item's own alias
 * (`outerItemScope`) in scope for its collection expression, and per-call
 * unique local variable names (suffixed `_<blockId>`) so multiple nested
 * each-diffs inlined into the same generated function — sibling nested
 * eaches, or this same each's own diff appearing once in
 * `emitCreateItemSub`-derived code and again in `emitUpdateItemSub`-derived
 * code for the *outer* each — never collide. `keyChainParts` here already
 * includes *this* each's own enclosing item's key (the caller extends the
 * chain before calling in — see the `'each'` branches above) — used to
 * address `_keys`/`_nodes` at the enclosing component's own `m` scope, and
 * extended by one more entry (`childKeyChainParts`) for its own items'
 * construct/update calls, so a further-nested block can address its own
 * unique ids and dictionary chain.
 */
function emitInlineEachDiff(
  node: TemplateEachBlock,
  blockId: string,
  wrapperExpr: string,
  keyChainParts: readonly string[],
  depth: number,
  lines: string[],
  outerItemScope: FunctionScope,
  tempCounter: { n: number },
  ctx: ItemEmitContext,
): void {
  const indent = '  '.repeat(depth);
  const itemScope = extendTemplateScope(node.itemAlias, outerItemScope);
  const collectionExpr = rewriteExpression(node.collectionExpression, ctx.scriptBindings, `template ${blockId} collection`, outerItemScope, ctx.globalBindings);
  const keyExpr = rewriteExpression(node.keyExpression, ctx.scriptBindings, `template ${blockId} key`, itemScope, ctx.globalBindings);
  const chainSuffix = keyChainParts.map((k) => `[${k}]`).join('');
  const keysVar = `${mFieldAccess(blockId, '_keys')}${chainSuffix}`;
  const nodesVar = `${mFieldAccess(blockId, '_nodes')}${chainSuffix}`;
  const collVar = `ft_coll_${blockId}`;
  const iVar = `ft_i_${blockId}`;
  const keyVar = `ft_key_${blockId}`;
  const newKeysVar = `ft_newKeys_${blockId}`;
  const keepSetVar = `ft_keepSet_${blockId}`;
  const oldKeyVar = `ft_oldKey_${blockId}`;
  const newNodesVar = `ft_newNodes_${blockId}`;
  const nodeVar = `ft_node_${blockId}`;
  const childKeyChainParts = [...keyChainParts, keyVar];
  const nestedEachCleanup = ctx.eachBlockById
    .get(blockId)!
    .nestedEachIds.flatMap((nestedId) => [`${indent}    ${mFieldAccess(nestedId, '_keys')}${chainSuffix}.Delete(${oldKeyVar})`, `${indent}    ${mFieldAccess(nestedId, '_nodes')}${chainSuffix}.Delete(${oldKeyVar})`]);

  lines.push(`${indent}${collVar} = ${collectionExpr}`);
  lines.push(`${indent}if type(${collVar}) = "roSGNode" then`);
  lines.push(`${indent}  ${collVar} = ${collVar}.getChildren(-1, 0)`);
  lines.push(`${indent}end if`);
  lines.push(`${indent}${newKeysVar} = []`);
  lines.push(`${indent}${keepSetVar} = {}`);
  lines.push(`${indent}for ${iVar} = 0 to ${collVar}.Count() - 1`);
  lines.push(`${indent}  ${node.itemAlias} = ${collVar}[${iVar}]`);
  lines.push(`${indent}  ${keyVar} = ${eachKeyNormalizerName(ctx.componentName)}(${keyExpr})`);
  lines.push(`${indent}  ${newKeysVar}.Push(${keyVar})`);
  lines.push(`${indent}  ${keepSetVar}[${keyVar}] = true`);
  lines.push(`${indent}end for`);
  lines.push(``);
  const focusableIds = collectEachItemFocusableIds(node.children);
  const focusUnregisterLines = focusableIds.flatMap((id) => [
    `${indent}    ft_focusTarget_${blockId} = ${nodesVar}[${oldKeyVar}].findNode(${uniqueIdExpr(id, [oldKeyVar])})`,
    `${indent}    if ft_focusTarget_${blockId} <> invalid then`,
    `${indent}      ${focusUnregisterCall(`ft_focusTarget_${blockId}`)}`,
    `${indent}    end if`,
  ]);
  // Same ft_unmount cascade as the top-level emitEachReconcileSub — direct call on the item's own
  // root, then every other id in its body via a guarded findNode, both scoped with this call site's
  // own blockId suffix so a sibling nested-each-diff inlined elsewhere never collides.
  const unmountIds = collectEachItemElementIds(node.children);
  const unmountLines = [
    `${indent}    ${nodesVar}[${oldKeyVar}].callFunc("${UNMOUNT_FUNCTION_NAME}")`,
    ...emitEachItemUnmountCascadeLines(`${nodesVar}[${oldKeyVar}]`, unmountIds, [oldKeyVar], `ft_unmountTarget_${blockId}`, `${indent}    `),
  ];

  lines.push(`${indent}for each ${oldKeyVar} in ${keysVar}`);
  lines.push(`${indent}  if not ${keepSetVar}.DoesExist(${oldKeyVar}) then`);
  lines.push(...focusUnregisterLines);
  lines.push(...unmountLines);
  lines.push(`${indent}    ${wrapperExpr}.removeChild(${nodesVar}[${oldKeyVar}])`);
  lines.push(`${indent}    ${nodesVar}.Delete(${oldKeyVar})`);
  lines.push(...nestedEachCleanup);
  lines.push(`${indent}  end if`);
  lines.push(`${indent}end for`);
  lines.push(``);
  lines.push(`${indent}${newNodesVar} = {}`);
  lines.push(`${indent}for ${iVar} = 0 to ${collVar}.Count() - 1`);
  lines.push(`${indent}  ${node.itemAlias} = ${collVar}[${iVar}]`);
  lines.push(`${indent}  ${keyVar} = ${newKeysVar}[${iVar}]`);
  lines.push(`${indent}  if ${nodesVar}.DoesExist(${keyVar}) then`);
  lines.push(`${indent}    ${nodeVar} = ${nodesVar}[${keyVar}]`);
  emitItemUpdate(node.children, nodeVar, null, childKeyChainParts, depth + 2, lines, itemScope, tempCounter, ctx);
  lines.push(`${indent}  else`);
  lines.push(`${indent}    ${nodeVar} = CreateObject("roSGNode", "Group")`);
  emitItemConstruct(node.children, nodeVar, nodeVar, childKeyChainParts, depth + 2, lines, itemScope, tempCounter, ctx);
  lines.push(`${indent}  end if`);
  lines.push(`${indent}  ${wrapperExpr}.insertChild(${nodeVar}, ${iVar})`);
  lines.push(`${indent}  ${newNodesVar}[${keyVar}] = ${nodeVar}`);
  lines.push(`${indent}end for`);
  lines.push(``);
  lines.push(`${indent}${keysVar} = ${newKeysVar}`);
  lines.push(`${indent}${nodesVar} = ${newNodesVar}`);
  // Same end-of-pass timing requirement as emitEachReconcileSub's own recoverFocusFor call — see
  // that function's comment.
  if (focusableIds.length > 0) lines.push(`${indent}${globalFieldRef('focus')}.callFunc("recoverFocusFor", m.top)`);
}
