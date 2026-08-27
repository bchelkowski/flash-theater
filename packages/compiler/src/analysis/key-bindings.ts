/**
 * `on:key[Key1,Key2]={expr}` — key-event handler binding. See
 * packages/compiler/GRAMMAR.md's "on:key event binding" section for the full
 * grammar and findings/focus-system.md for the bubbling-boundary
 * design this feeds (codegen/brs-emitter.ts's generated `onKeyEvent`).
 */
import { findRootCallExpression, parseEmbeddedExpression } from 'flash-parser';
import { CompileError, ComponentOnKeyBinding, TemplateElement } from '../dsl-parser/dsl-ast.js';
import type { EachBlockAnalysis } from '../codegen/each-block-emitter.js';
import { FunctionScope, ScriptBindings } from './scope-resolution.js';
import { GlobalBindingsContext } from './global-bindings.js';
import { rewriteExpression, rewriteExpressionWithoutChainOptionalization } from './identifier-rewrite.js';
import { walkTemplate } from './template-walk.js';

/** The reserved wildcard marker in a parsed on:key key list — matches any key not otherwise matched by a more specific on:key[...] entry on the same element. */
export const ON_KEY_WILDCARD = '*';

/** One `on:key[...]` attribute as found in the template, before grouping by element. */
export interface RawKeyBindingAttribute {
  readonly elementId: string;
  readonly keys: readonly string[];
  readonly expression: string;
}

/** Every `on:key[...]` attribute on one element, grouped — `specific` keyed by literal key string, `wildcard` the raw expression for that element's own `on:key[*]`, if any. */
export interface KeyBindingElement {
  readonly elementId: string;
  readonly specific: ReadonlyMap<string, string>;
  readonly wildcard: string | null;
  /** True when this element lives inside an {#each} block's own body — on:key IS supported there (unlike bind:), but needs a different codegen path (the per-item companion `_items` dict — see codegen/each-block-emitter.ts). */
  readonly insideEach: boolean;
  /** This element's nearest enclosing {#each} block's own id, when `insideEach` is true. */
  readonly nearestEachAncestorId: string | null;
}

/**
 * Every `on:key[...]` attribute anywhere in the template, in document order
 * — recurses into everything, including `{#each}` bodies (on:key is fully
 * supported inside an `{#each}` item — per-row handlers are a primary use
 * case, unlike `bind:`'s own `{#each}` rejection) and `{#if}`/`{#if:destroy}`
 * bodies.
 */
export function collectKeyBindingAttributes(root: TemplateElement): RawKeyBindingAttribute[] {
  const out: RawKeyBindingAttribute[] = [];
  walkTemplate(root, {
    recurseIntoEach: true,
    onElement: (element) => {
      for (const attr of element.attributes) {
        if (attr.kind === 'onKey') out.push({ elementId: element.id!, keys: attr.keys, expression: attr.expression });
      }
    },
  });
  return out;
}

/**
 * Groups every raw `on:key[...]` attribute by its owning element, validating
 * as it goes. Throws `CompileError` on the first violation, matching this
 * codebase's "first diagnostic wins" policy: `template/on-key-duplicate-key`
 * (two on:key attributes on the same element both claim the same literal
 * key — no defined "which wins" order), `template/on-key-multiple-wildcards`
 * (two on:key[*] entries on the same element), `template/on-key-expression-not-call`
 * (the expression's root isn't a single call expression, e.g. a bare
 * identifier or `a() + 1`).
 */
/** One element/owner's fully-grouped `on:key[...]` bindings — `specific` keyed by literal key string, `wildcard` the raw expression for `on:key[*]`, if any. Shared shape between an ordinary element (`checkAndGroupKeyBindings`) and `<component>` itself (`checkComponentKeyBindings`). */
export interface GroupedKeyBindings {
  readonly specific: ReadonlyMap<string, string>;
  readonly wildcard: string | null;
}

/** Groups one owner's raw `on:key[...]` attributes, validating as it goes — `ownerLabel` is the already-formatted description used in error messages (`element "row"`, `<component>`). Throws `template/on-key-duplicate-key`/`template/on-key-multiple-wildcards`/`template/on-key-expression-not-call`, matching this codebase's "first diagnostic wins" policy. */
function groupOwnerKeyBindings(ownerLabel: string, attrs: readonly { readonly keys: readonly string[]; readonly expression: string }[]): GroupedKeyBindings {
  const specific = new Map<string, string>();
  let wildcard: string | null = null;

  for (const attr of attrs) {
    assertCallExpressionShape(ownerLabel, attr.expression);

    for (const key of attr.keys) {
      if (key === ON_KEY_WILDCARD) {
        if (wildcard !== null) {
          throw new CompileError({
            code: 'template/on-key-multiple-wildcards',
            message: `${ownerLabel} has more than one on:key[*] wildcard entry — only one is allowed.`,
          });
        }
        wildcard = attr.expression;
        continue;
      }

      if (specific.has(key)) {
        throw new CompileError({
          code: 'template/on-key-duplicate-key',
          message: `${ownerLabel} has more than one on:key[...] entry claiming key "${key}" — no defined "which wins" order.`,
        });
      }
      specific.set(key, attr.expression);
    }
  }

  return { specific, wildcard };
}

/**
 * `<component>`'s own `on:key[...]` attributes (see `dsl-ast.ts`'s `ComponentOnKeyBinding`) —
 * unconditional dispatch, not tied to any element id, so grouped once rather than per-element.
 * `null` when `<component>` has no `on:key[...]` at all (the common case — nothing to emit).
 */
export function checkComponentKeyBindings(bindings: readonly ComponentOnKeyBinding[]): GroupedKeyBindings | null {
  if (bindings.length === 0) return null;
  return groupOwnerKeyBindings('<component>', bindings);
}

export function checkAndGroupKeyBindings(raw: readonly RawKeyBindingAttribute[], eachBlocks: EachBlockAnalysis): KeyBindingElement[] {
  const byElement = new Map<string, RawKeyBindingAttribute[]>();
  for (const attr of raw) {
    const list = byElement.get(attr.elementId) ?? [];
    list.push(attr);
    byElement.set(attr.elementId, list);
  }

  return [...byElement.entries()].map(([elementId, attrs]) => {
    const entry = groupOwnerKeyBindings(`Element "${elementId}"`, attrs);
    const nearestEachAncestorId = eachBlocks.nearestEachAncestorById.get(elementId) ?? null;
    if (nearestEachAncestorId && eachBlocks.nearestEachAncestorById.has(nearestEachAncestorId)) {
      // The each-block this on:key lives in is itself nested inside another {#each} — the
      // per-item `_items` companion dict (see codegen/each-block-emitter.ts) is scoped to
      // top-level each blocks only for now; a genuinely nested case would need a chain-keyed
      // dict, the same generalization {#each}'s own _keys/_nodes already anticipate but this
      // feature doesn't implement yet. Rejected explicitly rather than silently generating a
      // handler that can never fire.
      throw new CompileError({
        code: 'template/on-key-inside-nested-each',
        message: `on:key[...] on element "${elementId}" lives inside an {#each} that is itself nested inside another {#each} — not yet supported (only a top-level {#each}'s own items can carry on:key).`,
      });
    }
    return {
      elementId,
      specific: entry.specific,
      wildcard: entry.wildcard,
      insideEach: nearestEachAncestorId !== null,
      nearestEachAncestorId,
    };
  });
}

function assertCallExpressionShape(ownerLabel: string, expression: string): void {
  const parsed = parseEmbeddedExpression(expression);
  if (parsed.result.diagnostics.length > 0) return; // surfaced separately as expression/parse-error
  const shape = findRootCallExpression(parsed, expression);
  if (!shape) {
    throw new CompileError({
      code: 'template/on-key-expression-not-call',
      message: `on:key[...] on ${ownerLabel} must be a single call expression (e.g. selectItem(item)) — "${expression}" is not a call.`,
    });
  }
}

/**
 * Rewrites an on:key expression's call into its generated form, with `key`
 * (string) and `press` (boolean) auto-prepended before any author-written
 * arguments — `on:key[OK]={selectItem(item)}` becomes a generated call
 * `selectItem(key, press, item)`. The callee and each argument are rewritten
 * *independently* through the normal identifier-rewrite path (so a `private
 * function` callee gets its `private_` rename for free, same as any other
 * call site) and reassembled with the injected args prepended — this
 * sidesteps any offset-splicing hazard between the argument-injection point
 * and identifier-rewrite's own splices, since neither pass ever re-scans the
 * other's output. `functionScope`/`contextLabel` differ by call site: plain
 * component-level scope outside an `{#each}`, that block's own item-alias
 * scope when this on:key lives inside one (see codegen/each-block-emitter.ts).
 *
 * The callee specifically uses `rewriteExpressionWithoutChainOptionalization`,
 * not `rewriteExpression` — the call this function assembles is always a bare,
 * void-context statement (see `codegen/brs-emitter.ts`'s `onKeyEvent`, which
 * emits it immediately followed by `return true`, its result never consumed).
 * `rewriteOptionalChains`'s own AST-based detection of "bare void-context call
 * statement" can only see that shape in a REAL statement's text — this
 * callee's text is rewritten in isolation before the call is even assembled,
 * so it would otherwise look like an ordinary lone read (`obj.method` →
 * `obj?.method`), producing a partial-chain callee that's inconsistent with
 * every other void-context call in generated output. Arguments remain a
 * genuine read context and keep the normal `rewriteExpression`.
 */
export function rewriteKeyHandlerCall(
  expression: string,
  scriptBindings: ScriptBindings,
  contextLabel: string,
  functionScope: FunctionScope,
  globalBindings: GlobalBindingsContext,
): string {
  const parsed = parseEmbeddedExpression(expression);
  const shape = findRootCallExpression(parsed, expression);
  if (!shape) {
    throw new CompileError({
      code: 'template/on-key-expression-not-call',
      message: `on:key[...] expression must be a single call expression (e.g. selectItem(item)) — "${expression}" is not a call.`,
    });
  }

  const calleeText = expression.slice(shape.calleeSpan.start, shape.calleeSpan.end);
  const rewrittenCallee = rewriteExpressionWithoutChainOptionalization(calleeText, scriptBindings, contextLabel, functionScope, globalBindings);
  const rewrittenArgs = shape.argSpans.map((span) =>
    rewriteExpression(expression.slice(span.start, span.end), scriptBindings, contextLabel, functionScope, globalBindings),
  );

  return `${rewrittenCallee}(${['key', 'press', ...rewrittenArgs].join(', ')})`;
}
