import { findGlobalPathAccesses, findTopLevelIdentifiers, parseEmbeddedExpression, parseEmbeddedStatements } from 'flash-parser';
import type { EmbeddedBrightScriptText } from 'flash-parser';
import { CompileError } from '../dsl-parser/dsl-ast.js';
import { GlobalBindingsContext, resolveGlobalPath } from './global-bindings.js';

export interface ExpressionIdentifier {
  name: string;
  /** Offset relative to the ORIGINAL (unwrapped) expression text. */
  start: number;
  end: number;
}

export interface ParsedExpression {
  identifiers: ExpressionIdentifier[];
  /**
   * Composite reactive-source keys touched by a valid `theme` access in
   * this expression — `"theme.<topLevelGroup>"` (top-level-group
   * granularity — a theme switch replaces a whole group field wholesale,
   * the coarsest granularity real Roku field observation supports, see
   * `codegen/theme-emitter.ts`). Empty when no `globalBindings` was given.
   * An invalid access isn't reported here — it's silently omitted, since
   * `identifier-rewrite.ts`'s `validateAndRewriteGlobalPaths` will throw
   * the real `CompileError` for it later in the same compile pass, when
   * this same expression is actually rewritten for codegen; duplicating
   * that validation here would just be two copies of the same check
   * drifting apart over time.
   *
   * `store` never contributes a composite source here — bare `store.x`
   * text doesn't exist anymore (it's a reserved keyword, only reachable
   * through `read`/`watch`/a write statement, all parsed structurally).
   * A `watch`'s own `"store.<topLevelKey>"` composite source is registered
   * directly by `analysis/dependency-graph.ts` from `script.watches`, not
   * by scanning expression text here.
   */
  globalSources: string[];
}

const GLOBAL_ROOT_NAMES = ['theme', 'router', 'taskManager', 'env'] as const;

/**
 * `router.*` deliberately contributes nothing here — a route data read
 * (`router.path`, `router.params.x`) is a plain, non-reactive snapshot in
 * currently (mirroring `store`'s own `read` form, not `watch`): reading it in a
 * `derived`/template binding evaluates it at that binding's normal
 * recompute time, but the router itself never *triggers* a recompute the
 * way a `field`/`state`/`watch` change does. A component that genuinely
 * needs to react to a route change without being torn down and rebuilt by
 * its own `FlashTheaterRouterOutlet` (the router's actual, primary
 * reactivity mechanism — see GRAMMAR.md's "Router" section) combines the
 * read with a `field`/`state` the app updates itself. `router.navigate(...)`/
 * `router.back()`/etc. (the action methods) never legitimately appear in a
 * `derived`/template expression at all — `resolveGlobalPath` only resolves
 * an action call at all when it recognizes the method name, but nothing
 * here stops one from being written; see `identifier-rewrite.ts`'s own note
 * on this not being compiler-enforced, matching this DSL's existing
 * "`derived` purity isn't policed" stance.
 *
 * `env.*` contributes nothing here either, for a simpler reason than `router.*`: an environment's
 * variables are baked as literal strings at compile time and never reassigned at runtime at all, so
 * an `env.x` read is never itself a reactive dependency — there is no runtime event that could ever
 * make it worth recomputing a `derived`/`watch` over.
 */
function collectGlobalSources(parsed: EmbeddedBrightScriptText, text: string, globalBindings: GlobalBindingsContext | undefined): string[] {
  if (!globalBindings) return [];

  const sources = new Set<string>();
  for (const access of findGlobalPathAccesses(parsed, GLOBAL_ROOT_NAMES, text)) {
    const resolution = resolveGlobalPath(access.root, access.segments, access.isCallTarget, globalBindings);
    if (resolution.kind === 'theme-leaf' || resolution.kind === 'theme-group') sources.add(`theme.${resolution.topLevelGroup}`);
  }
  return Array.from(sources);
}

/**
 * Parses a single DSL expression (the right-hand side of `derived`, the
 * inside of a `{expr}` template binding) and returns the positions of every
 * top-level identifier (including the callee name in a `CallExpression` —
 * but NOT `.member` in a `DotExpression`, since that's represented as a
 * token, not a separate `IdentifierExpression` node).
 *
 * Delegates the actual wrap-and-parse to flash-parser's `parseEmbeddedExpression`
 * (memoized by exact text there) instead of doing it again here — the same
 * expression text is typically parsed once already, eagerly, while
 * flash-parser builds its CST, and then looked at again by
 * `analysis/dependency-graph.ts` and `codegen/brs-emitter.ts`; the shared
 * cache means only the first of those calls actually invokes
 * kopytko-brightscript-parser.
 */
/** Escapes every regex metacharacter in `text` so it can be embedded literally inside a larger `RegExp` pattern. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `<streamName>.subscribe(...)`/`.emit(...)` may only be called from a
 * function body — never from a `derived` expression or a template `{expr}`
 * binding, both of which recompute every time one of their own dependencies
 * changes. Calling `.subscribe(...)` there would re-subscribe (and grow the
 * stream's subscriber array) on every single recompute — an unbounded leak,
 * mirroring `identifier-rewrite.ts`'s
 * `checkTaskManagerOnAlertChangedNotInReactiveExpression`, which guards the
 * exact same shape of footgun for `taskManager.onAlertChanged(...)`. Unlike
 * that check, a stream isn't a global-singleton dot-chain
 * (`findGlobalPathAccesses` never sees it) — it's an ordinary per-component
 * `m.<name>` binding, so this is a plain text scan against the known stream
 * names instead of a structural AST check. Called only from the two
 * genuinely reactive-recompute call sites (`analysis/dependency-graph.ts`'s
 * `derived` expression scan, `codegen/template-bindings.ts`'s template
 * binding scan) — deliberately NOT from `identifier-rewrite.ts`'s
 * `rewriteExpression` (also used for a plain function-body `if` condition,
 * which only evaluates when that code path runs, not on every dependency
 * change, so a stream call there is legitimate).
 */
export function checkNoStreamCallsInReactiveExpression(text: string, streamNames: ReadonlySet<string>, contextLabel: string): void {
  for (const name of streamNames) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\.\\s*(subscribe|emit)\\s*\\(`);
    if (pattern.test(text)) {
      throw new CompileError({
        code: 'expression/stream-call-in-reactive-expression',
        message:
          `Stream "${name}" .subscribe(...)/.emit(...) cannot be called in ${contextLabel} — a derived expression or template binding ` +
          `recomputes repeatedly, which would re-subscribe/re-emit on every recompute. Call it once from a function body instead.`,
      });
    }
  }
}

export function parseExpression(expressionText: string, contextLabel: string, globalBindings?: GlobalBindingsContext): ParsedExpression {
  const parsed = parseEmbeddedExpression(expressionText);

  if (parsed.result.diagnostics.length > 0) {
    throw new CompileError({
      code: 'expression/parse-error',
      message: `Failed to parse expression in ${contextLabel}: ${parsed.result.diagnostics[0].message}`,
    });
  }

  return { identifiers: findTopLevelIdentifiers(parsed, expressionText), globalSources: collectGlobalSources(parsed, expressionText, globalBindings) };
}

/**
 * Statement-text counterpart to `parseExpression`, for a `StatementRegion`
 * (function-body content that isn't a DSL `if`) rather than a `derived`
 * RHS/template binding. Delegates to flash-parser's `parseEmbeddedStatements`
 * (memoized there the same way `parseEmbeddedExpression` is) instead of
 * wrapping the text again here.
 */
export function parseStatements(statementsText: string, contextLabel: string, globalBindings?: GlobalBindingsContext): ParsedExpression {
  const parsed = parseEmbeddedStatements(statementsText);

  if (parsed.result.diagnostics.length > 0) {
    throw new CompileError({
      code: 'expression/parse-error',
      message: `Failed to parse statement in ${contextLabel}: ${parsed.result.diagnostics[0].message}`,
    });
  }

  return { identifiers: findTopLevelIdentifiers(parsed, statementsText), globalSources: collectGlobalSources(parsed, statementsText, globalBindings) };
}
