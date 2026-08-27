/**
 * `{#if}`/`{#if:destroy}`/`{#each}` block analysis — id assignment, nesting
 * ancestry (`nearestDestroyAncestorById`/`nearestEachAncestorById`), and
 * which ids are statically present in the compiled XML. Pure template-shape
 * analysis, no codegen — moved out of `codegen/conditional-block-emitter.ts`
 * (which now only *consumes* this module's output to emit create/destroy
 * subs) to match this package's own documented pipeline layering (see
 * CLAUDE.md's "Compiler pipeline — module responsibilities" table): "does
 * this decide X" belongs in `analysis/`, "does this emit .brs" belongs in
 * `codegen/`.
 */
import { TemplateElement, TemplateEachBlock, TemplateIfBlock, TemplateNode } from '../dsl-parser/dsl-ast.js';
import { extendTemplateScope } from './scope-resolution.js';
import { conditionalBlockElementId, conditionalParentElementId, eachBlockElementId } from '../codegen/naming.js';
import type { EachBlock, EachBlockAnalysis } from '../codegen/each-block-emitter.js';

/** A preceding sibling under the same parent, for the runtime insertion-index computation a destroy-mode block's create sub needs (see `codegen/conditional-block-emitter.ts`'s `emitConditionalCreateSub`). */
export type PrecedingSibling = { readonly kind: 'always-present' } | { readonly kind: 'destroy'; readonly id: string };

export interface ConditionalBlock {
  /** The synthetic wrapper `Group`'s id — e.g. `ft_if_3` — assigned in document order across the whole template, toggle and destroy blocks sharing one sequence. */
  readonly id: string;
  readonly mode: 'toggle' | 'destroy';
  /** Raw (not yet identifier-rewritten) DSL condition expression. */
  readonly expression: string;
  readonly children: readonly TemplateNode[];
  /** The `m.<id>` (or `m.top` when `null`) this block's wrapper attaches to/detaches from. Only meaningful for destroy mode — a toggle-mode block is always statically present in its parent's XML, so it never needs one. */
  readonly containerId: string | null;
  /** This block's siblings under the same parent, in document order, up to (not including) this block itself — destroy mode only, used to compute the runtime insertion index. */
  readonly precedingSiblings: readonly PrecedingSibling[];
  /** Every id (ordinary element, synthesized parent, or nested `{#if}`/`{#if:destroy}` block) anywhere in this block's own subtree — destroy mode only, nulled out by this block's own teardown sub via a plain `m.<id> = invalid`. */
  readonly nestedIds: readonly string[];
  /** Every nested `{#each}` block's own id anywhere in this block's own subtree — destroy mode only, kept separate from `nestedIds` because tearing one down needs *three* null-outs (`m.<id>`, `m.<id>_keys`, `m.<id>_nodes`), not one. */
  readonly nestedEachIds: readonly string[];
}

export interface ConditionalBlockAnalysis {
  /**
   * Every `{#if}`/`{#if:destroy}` block in the template. A destroy-mode
   * block is only pushed once its own `nestedIds` can be fully computed —
   * i.e. after its children (including any nested block) have already been
   * recursed into — so a nested block's entry appears *before* the entry of
   * whichever block directly contains it; sibling blocks at the same
   * nesting level still appear in ordinary document order relative to each
   * other. No consumer depends on strict document order across nesting
   * levels: `emitConditionalBlockSubs` just needs one create/destroy sub
   * pair per destroy-mode block (BrightScript doesn't care about `sub`
   * declaration order), and `emitInitFunction`'s per-block initial-cascade
   * loop already filters to only top-level (no destroy ancestor) blocks.
   */
  readonly blocks: readonly ConditionalBlock[];
  readonly blockIdByNode: ReadonlyMap<TemplateIfBlock, string>;
  /** Element (by node identity) → a synthesized id, for an element that had no author-given `id` but needed one purely to serve as a `{#if:destroy}` block's parent (so its ref can be `findNode`-cached in `init()` for `appendChild`/`removeChild`). `codegen/xml-emitter.ts` must emit this as a real `id="..."` attribute for the map to do anything. */
  readonly syntheticParentIds: ReadonlyMap<TemplateElement, string>;
  /**
   * id (an ordinary element, a toggle-mode block's own id, a destroy-mode
   * block's own id, or an `{#each}` block's own id) → the id of its nearest
   * enclosing destroy-mode block, for every id that lives inside at least
   * one destroy-mode block's subtree. Absent for anything outside any
   * destroy-mode subtree — nothing there ever needs guarding. "Nearest" (not
   * every ancestor) is sufficient because a destroy-mode teardown nulls
   * every nested id transitively, including a nested block's own id — so
   * checking the nearest ancestor's mount state already reflects every
   * ancestor's mount state by construction. Shared (the exact same map
   * instance) with `EachBlockAnalysis.nearestDestroyAncestorById` — both are
   * produced by the one unified walk in `analyzeTemplateBlocks`. Note this
   * is orthogonal to `nearestEachAncestorById` below — a block can have
   * *both* entries at once (nested inside an `{#each}` that is itself
   * nested inside a `{#if:destroy}`), in which case both facts matter
   * independently for that block's own codegen.
   */
  readonly nearestDestroyAncestorById: ReadonlyMap<string, string>;
  /**
   * id → the id of its nearest enclosing `{#each}` block, for anything
   * living inside at least one `{#each}`'s per-item body — a `{#if}`/
   * `{#if:destroy}` block nested *inside* an `{#each}`'s body, or a `{#each}`
   * nested inside another `{#each}` (both directions, arbitrarily deep). A
   * block with an entry here is never given its own top-level create/
   * destroy/reconcile subs — its logic is inlined into the enclosing each's
   * own per-item construction/update (see `codegen/each-block-emitter.ts`'s
   * `emitItemConstruct`/`emitItemUpdate`), and its runtime state (if any) is
   * resolved by `findNode` against a unique, item-key-suffixed id rather
   * than cached in a flat `m.<id>` slot or a node field.
   */
  readonly nearestEachAncestorById: ReadonlyMap<string, string>;
}

/**
 * Single top-down walk assigning every `{#if}`/`{#if:destroy}` **and**
 * `{#each}` block its id, working out each destroy-mode block's
 * parent/sibling/nested-id data, and recording the shared
 * nearest-destroy-ancestor/nearest-each-ancestor guard relationships — one
 * pass instead of two independent ones, because the two block kinds can
 * nest against each other in either direction and each needs to know about
 * the other's ancestor context: an `{#each}` block's own reconcile call
 * needs destroy-ancestor guarding when it sits inside a `{#if:destroy}`
 * subtree (exactly like an ordinary binding does today), and a block nested
 * *inside* an `{#each}`'s body needs its own state resolved via `findNode`
 * against a unique, item-key-suffixed id rather than a flat `m.<id>` slot
 * (see `codegen/each-block-emitter.ts`). Computed once and threaded by reference
 * into every consumer (`template-bindings.ts`, `xml-emitter.ts`,
 * `brs-emitter.ts`, `each-block-emitter.ts`) rather than having each
 * independently re-derive matching ids via its own counter.
 *
 * **Nesting support**: both directions are fully supported, arbitrarily
 * deep and in any combination — `{#each}` inside `{#if}`/`{#if:destroy}`,
 * `{#if}`/`{#if:destroy}` inside `{#each}`, and `{#each}` inside `{#each}`
 * (loop-in-loop). This walk only ever *assigns ids and ancestor-map
 * entries* for the forward direction (a block inside an `{#each}`'s body);
 * the actual per-item-instance codegen (routing that block's construction/
 * update/state through a unique, item-key-suffixed id resolved via
 * `findNode`, rather than a flat `m.<id>` slot or a cached node field) lives
 * entirely in `codegen/each-block-emitter.ts`'s
 * `emitItemConstruct`/`emitItemUpdate` — see that module's doc comment and
 * findings/template-each-reconcile.md for the full design.
 */
export function analyzeTemplateBlocks(root: TemplateElement): { readonly conditional: ConditionalBlockAnalysis; readonly each: EachBlockAnalysis } {
  const blocks: ConditionalBlock[] = [];
  const blockIdByNode = new Map<TemplateIfBlock, string>();
  const syntheticParentIds = new Map<TemplateElement, string>();
  const nearestDestroyAncestorById = new Map<string, string>();
  const nearestEachAncestorById = new Map<string, string>();

  const eachBlocks: EachBlock[] = [];
  const eachBlockIdByNode = new Map<TemplateEachBlock, string>();

  let ifBlockCounter = 0;
  let eachBlockCounter = 0;
  let parentCounter = 0;

  /** `ids`: ordinary/if-block ids, nulled with a single `m.<id> = invalid`. `eachIds`: `{#each}` block ids, nulled with three (`m.<id>`/`_keys`/`_nodes`). Never recurses into an `{#each}` node's own body — nothing in there is ever a flat `m.<id>` slot (see `codegen/each-block-emitter.ts`), regardless of what's nested inside it. */
  function collectNestedIds(nodes: readonly TemplateNode[]): { ids: string[]; eachIds: string[] } {
    const ids: string[] = [];
    const eachIds: string[] = [];
    for (const node of nodes) {
      if (node.kind === 'element') {
        const id = node.id ?? syntheticParentIds.get(node) ?? null;
        if (id) ids.push(id);
        const nested = collectNestedIds(node.children);
        ids.push(...nested.ids);
        eachIds.push(...nested.eachIds);
      } else if (node.kind === 'if') {
        ids.push(blockIdByNode.get(node)!);
        const nested = collectNestedIds(node.children);
        ids.push(...nested.ids);
        eachIds.push(...nested.eachIds);
      } else {
        eachIds.push(eachBlockIdByNode.get(node)!);
      }
    }
    return { ids, eachIds };
  }

  /**
   * Every `{#each}` block id nested anywhere within `nodes`, at any depth — unlike
   * `collectNestedIds`, this DOES recurse into a nested each's own body. Post the
   * findNode/m-scope-dict redesign (see `codegen/each-block-emitter.ts`), a nested each's own
   * `_keys`/`_nodes` bookkeeping lives in the *enclosing* component's own `m` scope, keyed by the
   * chain of enclosing items' own keys — so removing an outer item must transitively clean up
   * every descendant each's dict entry for that key, not just its own direct child's.
   */
  function collectAllNestedEachIds(nodes: readonly TemplateNode[]): string[] {
    const ids: string[] = [];
    for (const node of nodes) {
      if (node.kind === 'element' || node.kind === 'if') {
        ids.push(...collectAllNestedEachIds(node.children));
        continue;
      }
      const id = eachBlockIdByNode.get(node)!;
      ids.push(id, ...collectAllNestedEachIds(node.children));
    }
    return ids;
  }

  /** An element's own id (author-given), or a synthesized one if it has none but needs one to serve as a `findNode`-able parent for a direct destroy-mode child (`conditionalParentElementId`) — shared by every element in the walk *and* the template's own root element, which needs the exact same treatment (see the call site below) but is never itself visited as a `child` inside `walk` since it's the walk's own entry point, not a member of any `children` array. */
  function resolveContainerId(element: TemplateElement): string | null {
    const hasDirectDestroyChild = element.children.some((c) => c.kind === 'if' && c.mode === 'destroy');
    let elementId: string | null = element.id;
    if (hasDirectDestroyChild && !elementId) {
      elementId = syntheticParentIds.get(element) ?? conditionalParentElementId(++parentCounter);
      syntheticParentIds.set(element, elementId);
    }
    return elementId;
  }

  function walk(
    children: readonly TemplateNode[],
    containerId: string | null,
    nearestDestroyAncestorId: string | null,
    nearestEachAncestorId: string | null,
  ): void {
    const siblingDescriptors: PrecedingSibling[] = [];

    for (const child of children) {
      if (child.kind === 'element') {
        if (child.id) {
          if (nearestDestroyAncestorId) nearestDestroyAncestorById.set(child.id, nearestDestroyAncestorId);
          if (nearestEachAncestorId) nearestEachAncestorById.set(child.id, nearestEachAncestorId);
        }

        const elementId = resolveContainerId(child);
        walk(child.children, elementId, nearestDestroyAncestorId, nearestEachAncestorId);
        siblingDescriptors.push({ kind: 'always-present' });
        continue;
      }

      if (child.kind === 'each') {
        const id = eachBlockElementId(++eachBlockCounter);
        eachBlockIdByNode.set(child, id);
        if (nearestDestroyAncestorId) nearestDestroyAncestorById.set(id, nearestDestroyAncestorId);
        if (nearestEachAncestorId) nearestEachAncestorById.set(id, nearestEachAncestorId);

        // Recurse into the each's own body BEFORE pushing this block — mirrors how a destroy-mode
        // ConditionalBlock is already pushed after its own recursive walk (below), so a nested
        // each's own id is already assigned by the time collectAllNestedEachIds walks this block's
        // children. `containerId` resets to `null` (each-item codegen never uses it — items attach
        // directly to the each's own `m.<id>` wrapper, or — when nested — to the enclosing item's
        // own root, not a containerId concept); `nearestDestroyAncestorId` propagates *unchanged*
        // (the each's own mount state already mirrors its nearest destroy ancestor, if any —
        // nothing inside it is *additionally* destroy-conditional beyond that); `nearestEachAncestorId`
        // becomes *this* each's own id for anything nested inside it — a block one level deeper
        // always routes its own bookkeeping through *this* each's own per-item state, never further
        // up the chain (see `codegen/each-block-emitter.ts`'s per-item state design).
        walk(child.children, null, nearestDestroyAncestorId, id);

        eachBlocks.push({
          id,
          collectionExpression: child.collectionExpression,
          itemAlias: child.itemAlias,
          keyExpression: child.keyExpression,
          children: child.children,
          scope: extendTemplateScope(child.itemAlias),
          nestedEachIds: collectAllNestedEachIds(child.children),
        });

        siblingDescriptors.push({ kind: 'always-present' });
        continue;
      }

      const id = conditionalBlockElementId(++ifBlockCounter);
      blockIdByNode.set(child, id);
      if (nearestDestroyAncestorId) nearestDestroyAncestorById.set(id, nearestDestroyAncestorId);
      if (nearestEachAncestorId) nearestEachAncestorById.set(id, nearestEachAncestorId);

      const childNearestDestroyAncestorId = child.mode === 'destroy' ? id : nearestDestroyAncestorId;
      walk(child.children, id, childNearestDestroyAncestorId, nearestEachAncestorId);

      if (child.mode === 'destroy') {
        const nested = collectNestedIds(child.children);
        blocks.push({
          id,
          mode: 'destroy',
          expression: child.expression,
          children: child.children,
          containerId,
          precedingSiblings: [...siblingDescriptors],
          nestedIds: nested.ids,
          nestedEachIds: nested.eachIds,
        });
        siblingDescriptors.push({ kind: 'destroy', id });
      } else {
        blocks.push({ id, mode: 'toggle', expression: child.expression, children: child.children, containerId, precedingSiblings: [], nestedIds: [], nestedEachIds: [] });
        siblingDescriptors.push({ kind: 'always-present' });
      }
    }
  }

  // The template's own root element is a real container, exactly like any other element with
  // children — a direct destroy-mode child's sibling-insertion-index must count root itself as an
  // implicit already-present sibling at m.top (root is always the sole static XML child), or the
  // computed index undercounts and the block gets inserted BEFORE root instead of after it,
  // landing behind root in paint order (root's own background then covers it entirely). Confirmed
  // on a real device: every existing fixture with a root-level destroy block happened to have
  // exactly one *other* preceding sibling inside root, which coincidentally produced the same
  // index root already occupies — masking this for every fixture until one with zero preceding
  // siblings (`apps/sample-app/src/components/ScheduleList/ScheduleList.thr`) exposed it.
  walk(root.children, resolveContainerId(root), null, null);

  return {
    conditional: { blocks, blockIdByNode, syntheticParentIds, nearestDestroyAncestorById, nearestEachAncestorById },
    each: { blocks: eachBlocks, blockIdByNode: eachBlockIdByNode, nearestDestroyAncestorById, nearestEachAncestorById },
  };
}

/** Thin wrapper around `analyzeTemplateBlocks` for a caller/test that only cares about `{#if}`/`{#if:destroy}` blocks. */
export function analyzeConditionalBlocks(root: TemplateElement): ConditionalBlockAnalysis {
  return analyzeTemplateBlocks(root).conditional;
}

/**
 * Every id that's statically present in the compiled XML and needs
 * `findNode`-caching in `init()` — ordinary element ids (including a
 * compiler-synthesized parent id) and toggle-mode blocks' own ids, but never
 * anything inside a destroy-mode subtree (it doesn't exist until its create
 * sub runs) or a destroy-mode block's own id (same reason). Contrast with
 * `codegen/template-bindings.ts`'s `collectElementIds`, which deliberately
 * *does* recurse into a destroy-mode subtree — that one is for collision
 * validation (every id generated code will ever reference, regardless of
 * when), not for `init()`'s unconditional `findNode` loop.
 */
export function collectStaticallyPresentIds(root: TemplateElement, analysis: ConditionalBlockAnalysis, eachAnalysis: EachBlockAnalysis): string[] {
  const ids: string[] = [];

  function visit(nodes: readonly TemplateNode[]): void {
    for (const node of nodes) {
      if (node.kind === 'element') {
        const id = node.id ?? analysis.syntheticParentIds.get(node) ?? null;
        if (id) ids.push(id);
        visit(node.children);
        continue;
      }
      if (node.kind === 'each') {
        // Only reached when NOT inside a destroy-mode subtree (a destroy-mode branch below never
        // recurses into its own children at all) — so an {#each} block reached here is always
        // statically present, exactly like a toggle-mode {#if}'s wrapper. Its own wrapper id is
        // findNode-cacheable; nothing *inside* its body ever is (items are runtime-created), so
        // — unlike an ordinary element or a toggle-mode {#if} — this never recurses into its
        // children.
        ids.push(eachAnalysis.blockIdByNode.get(node)!);
        continue;
      }
      if (node.mode === 'toggle') {
        ids.push(analysis.blockIdByNode.get(node)!);
        visit(node.children);
      }
      // destroy-mode: not statically present, never findNode-able.
    }
  }

  // The template's own root element is never itself a block (see `template/if-cannot-be-root`),
  // so its id (author-given, or synthesized when it has a direct destroy-mode child and no
  // author-given id — see analyzeTemplateBlocks's resolveContainerId) is always statically
  // present — visited here explicitly, since `visit` above only walks a node's *children*.
  const rootId = root.id ?? analysis.syntheticParentIds.get(root) ?? null;
  if (rootId) ids.push(rootId);
  visit(root.children);
  return ids;
}
