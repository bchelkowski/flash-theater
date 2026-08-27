import { TemplateElement, TemplateNode, ThrTemplateAst } from '../dsl-parser/dsl-ast.js';
import { DependencyGraph } from '../analysis/dependency-graph.js';
import { checkNoStreamCallsInReactiveExpression, parseExpression } from '../analysis/expression-region.js';
import { ScriptBindings } from '../analysis/scope-resolution.js';
import { GlobalBindingsContext } from '../analysis/global-bindings.js';
import { walkTemplate } from '../analysis/template-walk.js';
import { ConditionalBlock, ConditionalBlockAnalysis } from '../analysis/conditional-blocks.js';
import { EachBlock, EachBlockAnalysis, EMPTY_EACH_BLOCKS } from './each-block-emitter.js';

const NO_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };

export interface TemplateAttributeBinding {
  elementId: string;
  attributeName: string;
  /** Raw (not rewritten) DSL expression text, e.g. `focusPercent > 0.5`. */
  expression: string;
}

export interface TemplateBindings {
  /** Every dynamic attribute binding, in template document order — includes a synthetic `visible` binding for every toggle-mode `{#if}` block (see `syntheticToggleBindings`), which needs no other special-casing anywhere downstream. */
  all: TemplateAttributeBinding[];
  /** Reactive source (`field` or `state`) name → bindings that depend on it directly or via a derived. */
  affectedBySource: Map<string, TemplateAttributeBinding[]>;
  /** Reactive source name → destroy-mode `{#if:destroy}` blocks whose condition depends on it directly or via a derived — the create/destroy counterpart to `affectedBySource`, kept separate since a block's cascade action (construct/tear down a subtree) isn't a simple `m.<id>.<attr> = <expr>` line the way an ordinary binding's is. */
  affectedBySourceBlocks: Map<string, ConditionalBlock[]>;
  /**
   * Reactive source name → `{#each}` blocks whose *collection* expression
   * depends on it directly or via a derived (never the key expression,
   * which is evaluated per-item from the local item alias, not
   * independently reactive) — the each-block counterpart to
   * `affectedBySourceBlocks`. A source's change here triggers the whole
   * block's reconcile sub, not a single `m.<id>.<attr>` reassignment — a
   * binding *inside* an each-body that also reads a component-wide source
   * is deliberately never given its own `affectedBySource` entry (there's
   * no single node to reassign — there are N item nodes); such a source
   * dependency belongs entirely to the enclosing each-block's own reconcile
   * trigger instead, since the naive (and later, the keyed-diff) reconcile
   * always re-runs every per-item binding on every pass.
   */
  affectedByEachSourceBlocks: Map<string, EachBlock[]>;
  /**
   * Reactive source names whose change needs a cascade somewhere — either the TEMPLATE needs it
   * (`affectedBySource`/`affectedBySourceBlocks`/`affectedByEachSourceBlocks` non-empty) OR some
   * `derived`/`watch` depends on it regardless of template usage (`graph.dependentsOfSource`
   * non-empty for that source — see this function's own build step for why: a `watch`/`derived`
   * consumed only from a plain function body still needs its own value kept live, not frozen at
   * whatever it read during `init()`). Includes both `field` and `state` names —
   * `codegen/brs-emitter.ts` filters this down to `field`s only when
   * generating `on_<field>Change` subs (a `state` change is instead handled
   * inline at its own assignment site, since there's no SceneGraph observer
   * to hook a private `state` member into).
   */
  sourcesNeedingCascade: Set<string>;
}

/**
 * Connects the template to the `derived`↔reactive-source dependency graph:
 * for every dynamic template attribute (plus every toggle-mode block's own
 * synthetic `visible` binding, and every destroy-mode block's condition),
 * works out which reactive source(s) (`field`/`state`) it depends on
 * (directly, or through a `derived` chain) — this determines both which
 * fields get `onChange` in the generated XML (xml-emitter.ts) and what each
 * source's change needs to do in the generated .brs (brs-emitter.ts).
 *
 * `conditionalBlocks` is `analysis/conditional-blocks.ts`'s single shared
 * analysis of every `{#if}`/`{#if:destroy}` block in the template — computed
 * once by the caller (`compile.ts`) and threaded through here rather than
 * re-derived, so every consumer agrees on the same block ids.
 */
export function analyzeTemplateBindings(
  template: ThrTemplateAst,
  scriptBindings: ScriptBindings,
  graph: DependencyGraph,
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
  conditionalBlocks: ConditionalBlockAnalysis = {
    blocks: [],
    blockIdByNode: new Map(),
    syntheticParentIds: new Map(),
    nearestDestroyAncestorById: new Map(),
    nearestEachAncestorById: new Map(),
  },
  eachBlocks: EachBlockAnalysis = EMPTY_EACH_BLOCKS,
): TemplateBindings {
  const { reactiveSourceNames, derivedNames, watchNames, streamNames } = scriptBindings;
  const derivedLikeNames = new Set([...derivedNames, ...watchNames]);
  const sourcesByDerived = buildSourcesByDerived(graph);

  const all: TemplateAttributeBinding[] = [];
  collectBindings(template.root, all);
  for (const block of conditionalBlocks.blocks) {
    if (block.mode === 'toggle') all.push({ elementId: block.id, attributeName: 'visible', expression: block.expression });
  }

  const affectedBySource = new Map<string, TemplateAttributeBinding[]>();
  const affectedBySourceBlocks = new Map<string, ConditionalBlock[]>();
  const affectedByEachSourceBlocks = new Map<string, EachBlock[]>();
  for (const sourceName of reactiveSourceNames) {
    affectedBySource.set(sourceName, []);
    affectedBySourceBlocks.set(sourceName, []);
    affectedByEachSourceBlocks.set(sourceName, []);
  }

  for (const binding of all) {
    const contextLabel = `template ${binding.elementId}.${binding.attributeName}`;
    for (const sourceName of sourcesReferencedByExpression(binding.expression, contextLabel, globalBindings, reactiveSourceNames, derivedLikeNames, sourcesByDerived, streamNames)) {
      if (!affectedBySource.has(sourceName)) affectedBySource.set(sourceName, []);
      affectedBySource.get(sourceName)!.push(binding);
    }
  }

  for (const block of conditionalBlocks.blocks) {
    if (block.mode !== 'destroy') continue;
    // A destroy-mode block nested inside an {#each}'s body is never given its own top-level
    // cascade registration — its own condition is scanned as part of the *enclosing* each's own
    // dependency scan (collectEachBodyExpressions, below) instead, since it has no independent
    // existence outside that each's own per-item lifecycle (see codegen/each-block-emitter.ts).
    if (conditionalBlocks.nearestEachAncestorById.has(block.id)) continue;
    const contextLabel = `template ${block.id} condition`;
    for (const sourceName of sourcesReferencedByExpression(block.expression, contextLabel, globalBindings, reactiveSourceNames, derivedLikeNames, sourcesByDerived, streamNames)) {
      if (!affectedBySourceBlocks.has(sourceName)) affectedBySourceBlocks.set(sourceName, []);
      affectedBySourceBlocks.get(sourceName)!.push(block);
    }
  }

  for (const block of eachBlocks.blocks) {
    // An each block nested inside *another* each's body is likewise never given its own
    // top-level reconcile registration — re-running the outermost enclosing each's own reconcile
    // already re-runs this block's diff too (see codegen/each-block-emitter.ts's emitItemUpdate).
    if (eachBlocks.nearestEachAncestorById.has(block.id)) continue;
    // A reactive source can trigger this block's reconcile two ways: the collection expression
    // itself changing, or a component-wide source referenced by a binding *inside* the item body
    // (e.g. `text="{item.title + prefix}"` where `prefix` is a field) — both fold into the same
    // "reconcile the whole block" cascade action, never a narrower per-binding one, since there's
    // no single `m.<id>.<attr>` to reassign once a block can render N item nodes (see
    // findings/template-each-reconcile.md). The item alias itself never appears in either set: it's
    // guaranteed not to be a field/derived/state/read/watch name (checkEachItemAliasCollisions),
    // so scanning body expressions for reactive-source identifiers naturally skips over it.
    const sources = new Set<string>();
    const collectionContextLabel = `template ${block.id} collection`;
    for (const sourceName of sourcesReferencedByExpression(block.collectionExpression, collectionContextLabel, globalBindings, reactiveSourceNames, derivedLikeNames, sourcesByDerived, streamNames)) {
      sources.add(sourceName);
    }
    for (const bodyExpression of collectEachBodyExpressions(block.children)) {
      const bodyContextLabel = `template ${block.id} item body`;
      for (const sourceName of sourcesReferencedByExpression(bodyExpression, bodyContextLabel, globalBindings, reactiveSourceNames, derivedLikeNames, sourcesByDerived, streamNames)) {
        sources.add(sourceName);
      }
    }
    for (const sourceName of sources) {
      if (!affectedByEachSourceBlocks.has(sourceName)) affectedByEachSourceBlocks.set(sourceName, []);
      affectedByEachSourceBlocks.get(sourceName)!.push(block);
    }
  }

  const sourcesNeedingCascade = new Set<string>();
  for (const [sourceName, bindingList] of affectedBySource) {
    if (bindingList.length > 0) sourcesNeedingCascade.add(sourceName);
  }
  for (const [sourceName, blockList] of affectedBySourceBlocks) {
    if (blockList.length > 0) sourcesNeedingCascade.add(sourceName);
  }
  for (const [sourceName, blockList] of affectedByEachSourceBlocks) {
    if (blockList.length > 0) sourcesNeedingCascade.add(sourceName);
  }
  // A source also needs its cascade wired up when some `derived`/`watch` depends on it EVEN IF
  // nothing in the template ever reads that derived/watch — `graph.dependentsOfSource` is the
  // template-agnostic source of truth for "does anything recompute off this source", built
  // straight from every `derived`'s own parsed expression and every `watch`'s own fixed
  // `store(<path>)` root, regardless of where the result is consumed. Fixes a real bug: a `watch`
  // (or `derived`) read only from a plain function body — never from a template binding/block —
  // used to get a one-time init()-only snapshot instead of a live `ObserveFieldScoped`/`onChange`
  // cascade, so a later read of it inside that function body silently saw a permanently stale
  // value. Confirmed live: `Shell.thr`'s own `watch favoriteCount = store(favoriteCount)`, read
  // only inside `bumpFavorite()` (a plain `on:key[options]` handler, never templated), stayed
  // stuck reading `favoriteCount` as whatever it was at Shell's own `init()` — every press
  // recomputed the same `0 + 1 = 1` and rewrote the store with the identical value, an
  // indefinitely-stuck counter with no error, no crash, and no diagnostic. See
  // findings/reactivity-state.md.
  for (const [sourceName, dependents] of graph.dependentsOfSource) {
    if (dependents.length > 0) sourcesNeedingCascade.add(sourceName);
  }

  return { all, affectedBySource, affectedBySourceBlocks, affectedByEachSourceBlocks, sourcesNeedingCascade };
}

/** Every reactive source (`field`/`state`, or a global `store.`/`theme.` composite key) `expression` depends on, directly or through a `derived`/`watch` chain — shared by an ordinary/toggle attribute binding and a destroy-mode block's own condition, which both need identical dependency discovery. */
function sourcesReferencedByExpression(
  expression: string,
  contextLabel: string,
  globalBindings: GlobalBindingsContext,
  reactiveSourceNames: ReadonlySet<string>,
  derivedLikeNames: ReadonlySet<string>,
  sourcesByDerived: ReadonlyMap<string, string[]>,
  streamNames: ReadonlySet<string>,
): Set<string> {
  checkNoStreamCallsInReactiveExpression(expression, streamNames, contextLabel);
  const { identifiers, globalSources } = parseExpression(expression, contextLabel, globalBindings);
  const referencedSources = new Set<string>(globalSources);

  for (const id of identifiers) {
    if (reactiveSourceNames.has(id.name)) {
      referencedSources.add(id.name);
    } else if (derivedLikeNames.has(id.name)) {
      for (const sourceName of sourcesByDerived.get(id.name) ?? []) referencedSources.add(sourceName);
    }
  }

  return referencedSources;
}

function collectBindings(node: TemplateNode, out: TemplateAttributeBinding[]): void {
  // An {#each} body's own bindings are handled entirely by codegen/each-block-emitter.ts's
  // per-item construction (rewritten against the block's own item scope, re-run on every
  // reconcile pass) — never collected into the generic whole-component `bindings.all` here, hence
  // recurseIntoEach: false.
  walkTemplate(node, {
    recurseIntoEach: false,
    onElement: (element) => {
      for (const attr of element.attributes) {
        if (attr.kind === 'dynamic') {
          out.push({ elementId: element.id!, attributeName: attr.name, expression: attr.expression });
        }
      }
    },
  });
}

/**
 * Every element `id` anywhere in the template, in document order (duplicates
 * included — callers that care about uniqueness check for that themselves).
 * Recurses into `{#if}`/`{#if:destroy}` blocks' children too — an id inside
 * a destroy-mode subtree still needs the same collision validation as any
 * other, since generated code still uses its `m.<id>` slot once
 * constructed. `syntheticParentIds`, when given, folds in an element's
 * compiler-synthesized id (see `conditional-block-emitter.ts`) as if it were
 * an author-given one — harmless for collision-checking purposes (a
 * `ft_`-prefixed id can never collide with anything real, see
 * `analysis/binding-collisions.ts`'s `dsl/reserved-identifier-prefix`
 * check), and lets `codegen/brs-emitter.ts` reuse this same function for its
 * `init()` id-caching list.
 */
export function collectElementIds(node: TemplateNode, syntheticParentIds?: ReadonlyMap<TemplateElement, string>): string[] {
  const ids: string[] = [];
  // An id inside an {#each} body never becomes a global `m.<id>` slot (every item gets a fresh
  // local/temp var, see codegen/each-block-emitter.ts) — it's opaque to whole-component id
  // collision/reservation checking, same reasoning as `collectBindings` skipping each-bodies above,
  // hence recurseIntoEach: false.
  walkTemplate(node, {
    recurseIntoEach: false,
    onElement: (element) => {
      const id = element.id ?? syntheticParentIds?.get(element) ?? null;
      if (id) ids.push(id);
    },
  });
  return ids;
}

/**
 * Every reactive-source-scannable expression anywhere inside an `{#each}`
 * block's body — every dynamic attribute expression, every nested `{#if}`/
 * `{#if:destroy}`'s own condition, and every nested `{#each}`'s own
 * *collection* expression (never a nested each's key expression, which is
 * per-item-local, matching the same exclusion the top-level each's own scan
 * already applies to its own key expression). Recurses through arbitrary
 * nesting depth — any external source referenced anywhere in the subtree
 * folds up into the *outermost* enclosing each's own cascade trigger (see
 * `analyzeTemplateBindings`'s each-block loop above), since a nested block
 * is never independently cascade-registered — an identifier belonging to an
 * enclosing item alias (e.g. a nested each's collection expression reading
 * an outer item's own field) is silently ignored here exactly like the
 * item alias already is at the top level: `sourcesReferencedByExpression`
 * only ever adds a name that's actually in `reactiveSourceNames`/
 * `derivedLikeNames`, so an alias that's neither is a no-op, not an error.
 */
function collectEachBodyExpressions(nodes: readonly TemplateNode[]): string[] {
  const expressions: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'element') {
      for (const attr of node.attributes) {
        if (attr.kind === 'dynamic') expressions.push(attr.expression);
      }
      expressions.push(...collectEachBodyExpressions(node.children));
      continue;
    }
    if (node.kind === 'if') {
      expressions.push(node.expression);
      expressions.push(...collectEachBodyExpressions(node.children));
      continue;
    }
    // node.kind === 'each' (nested)
    expressions.push(node.collectionExpression);
    expressions.push(...collectEachBodyExpressions(node.children));
  }
  return expressions;
}

/**
 * `graph.dependentsOfSource` inverted once per compile — source → derived/watch names it affects,
 * flipped to derived/watch name → the source(s) that affect it — so `sourcesReferencedByExpression`
 * (called once per derived/watch identifier reference across every template binding, block
 * condition, and each-item expression) does an O(1) lookup instead of rescanning the whole map with
 * an `Array.includes` per source on every call.
 */
function buildSourcesByDerived(graph: DependencyGraph): Map<string, string[]> {
  const sourcesByDerived = new Map<string, string[]>();
  for (const [sourceName, dependents] of graph.dependentsOfSource) {
    for (const dependentName of dependents) {
      const sources = sourcesByDerived.get(dependentName);
      if (sources) sources.push(sourceName);
      else sourcesByDerived.set(dependentName, [sourceName]);
    }
  }
  return sourcesByDerived;
}
