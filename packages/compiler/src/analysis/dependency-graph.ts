import { CompileError, ThrScriptAst } from '../dsl-parser/dsl-ast.js';
import { checkNoStreamCallsInReactiveExpression, parseExpression } from './expression-region.js';
import { ScriptBindings } from './scope-resolution.js';
import { GlobalBindingsContext } from './global-bindings.js';

const NO_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };

export interface DependencyGraph {
  /** `derived`/`watch` names, topologically sorted (dependencies before dependents). */
  order: string[];
  /** `derived`/`watch` name → names (a reactive source, a `store.<key>` composite key, or another `derived`/`watch`) used directly in its expression/path. */
  directDependencies: Map<string, string[]>;
  /**
   * Reactive source (`field`, `state`, or a global `store.<key>`/
   * `theme.<topLevelGroup>` composite key) name → `derived`/`watch` names
   * depending on it directly or transitively, in topological order — safe
   * to recompute in that exact order wherever that source's change is
   * handled (a generated `on_<field>Change` for a field, inline at a
   * `state x = expr` assignment for state, or a generated
   * `ObserveFieldScoped` for a global composite key — see
   * `codegen/brs-emitter.ts`).
   */
  dependentsOfSource: Map<string, string[]>;
}

/**
 * Builds the `derived`/`watch`↔reactive-source dependency graph, sorts it
 * topologically, and detects cycles at compile time — the only piece of the
 * full target-spec scheduler that's currently implemented (see GRAMMAR.md). A
 * reactive source is a `field`, a `state` (see `scope-resolution.ts`'s
 * `reactiveSourceNames`), or a global `theme.<topLevelGroup>`/
 * `store.<topLevelKey>` composite key — the former resolved against
 * `globalBindings` from a `derived`'s own expression text (see
 * `expression-region.ts`'s `globalSources`), the latter known structurally
 * from a `watch`'s own `path[0]` (never scanned from text, since `watch`
 * is a fixed grammar form, not a generic expression). `derived` and `watch`
 * are treated uniformly here as "recomputable nodes" — a `derived` can
 * depend on a `watch`'s name exactly like it can on another `derived`'s.
 * The only difference between them is *how* their own dependency is
 * noticed (a real expression, parsed and dependency-scanned, for
 * `derived`; a single fixed `store.<key>` edge for `watch`) — once that
 * edge exists, cascading is identical (SceneGraph's own field observer for
 * `field`, an inline cascade at the assignment site for `state`, a
 * generated `ObserveFieldScoped` for a global composite key — see
 * `codegen/brs-emitter.ts`'s `emitInitFunction`). Function names used in
 * expressions (e.g. `pickColor(...)`) are not part of the graph — those are
 * plain calls, not bindings. A `read` never enters this graph at all — it's
 * evaluated once in `init()` and never recomputed, like a `state` default.
 */
export function buildDependencyGraph(script: ThrScriptAst, bindings: ScriptBindings, globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS): DependencyGraph {
  const { reactiveSourceNames, derivedNames, watchNames, streamNames } = bindings;
  const recomputableNames = new Set([...derivedNames, ...watchNames]);

  const directDependencies = new Map<string, string[]>();
  for (const d of script.derived) {
    const contextLabel = `derived ${d.name}`;
    checkNoStreamCallsInReactiveExpression(d.expression, streamNames, contextLabel);
    const { identifiers, globalSources } = parseExpression(d.expression, contextLabel, globalBindings);
    const localDeps = identifiers.map((i) => i.name).filter((name) => reactiveSourceNames.has(name) || recomputableNames.has(name));
    directDependencies.set(d.name, Array.from(new Set([...localDeps, ...globalSources])));
  }
  for (const d of script.watches) {
    directDependencies.set(d.name, [`store.${d.path[0]}`]);
  }

  const allNames = [...script.derived.map((d) => d.name), ...script.watches.map((d) => d.name)];
  const order = topologicalSort(allNames, directDependencies, recomputableNames);

  const allSourceNames = new Set(reactiveSourceNames);
  for (const deps of directDependencies.values()) {
    for (const dep of deps) if (!recomputableNames.has(dep)) allSourceNames.add(dep);
  }
  const dependentsOfSource = buildDependentsOfSource(allSourceNames, recomputableNames, directDependencies, order);

  return { order, directDependencies, dependentsOfSource };
}

function topologicalSort(names: string[], directDependencies: Map<string, string[]>, recomputableNames: ReadonlySet<string>): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  function visit(name: string, path: string[]): void {
    if (state.get(name) === 'done') return;

    if (state.get(name) === 'visiting') {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name];
      throw new CompileError({
        code: 'dependency/cycle',
        message: `Cycle in the derived dependency graph: ${cycle.join(' → ')}`,
      });
    }

    state.set(name, 'visiting');
    for (const dep of directDependencies.get(name) ?? []) {
      if (recomputableNames.has(dep)) visit(dep, [...path, name]);
    }
    state.set(name, 'done');
    order.push(name);
  }

  for (const name of names) visit(name, []);

  return order;
}

function buildDependentsOfSource(
  reactiveSourceNames: ReadonlySet<string>,
  recomputableNames: ReadonlySet<string>,
  directDependencies: Map<string, string[]>,
  order: string[],
): Map<string, string[]> {
  const dependentsOfSource = new Map<string, string[]>();

  for (const sourceName of reactiveSourceNames) {
    const dependents: string[] = [];
    const dependentsSeen = new Set<string>();

    for (const derivedName of order) {
      const deps = directDependencies.get(derivedName) ?? [];
      const dependsOnSource = deps.some((dep) => dep === sourceName || (recomputableNames.has(dep) && dependentsSeen.has(dep)));
      if (dependsOnSource) {
        dependents.push(derivedName);
        dependentsSeen.add(derivedName);
      }
    }

    dependentsOfSource.set(sourceName, dependents);
  }

  return dependentsOfSource;
}
