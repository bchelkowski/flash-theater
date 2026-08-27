/**
 * Depth-first, document-order walk of a template subtree, invoking
 * `onElement` for every element node — the traversal shape shared by every
 * whole-component-or-subtree collector in this codebase that only cares
 * about element nodes and their attributes, with one axis of variation:
 * whether to descend into an `{#each}` block's own item body.
 *
 * Two genuinely different, both-legitimate answers exist for that axis, and
 * each call site's own doc comment says which one it needs and why:
 * - `recurseIntoEach: true` — a misplaced attribute inside an each body must
 *   still be *found* so it can be rejected or correctly registered (e.g.
 *   `bind:` validation, `on:key` collection, `focusable` collection — all
 *   three need to see inside an each body even though an each item's own
 *   codegen is otherwise entirely separate).
 * - `recurseIntoEach: false` — an each item's own ids/bindings/focusable
 *   elements are handled entirely by `each-block-emitter.ts`'s per-item
 *   codegen (a fresh local/temp var per item, re-run every reconcile), so a
 *   whole-component walk collecting static `m.<id>` slots or component-level
 *   bindings must not also collect from inside an each body.
 *
 * NOT a fit for every template walk in this codebase — a walk that needs an
 * `{#if}`'s own condition expression or an `{#each}`'s own collection/key
 * expression (not just element attributes), or that returns more than one
 * parallel result array (e.g. `conditional-block-emitter.ts`'s
 * `analyzeTemplateBlocks`/`collectNestedIds`), stays a bespoke walk — forcing
 * those into this one shape would need extra parameters/branches that stop
 * being a genuine shared abstraction.
 */
import { TemplateElement, TemplateNode } from '../dsl-parser/dsl-ast.js';

export interface WalkTemplateOptions {
  /** Called once per element node, in document order, before its own children are visited. */
  readonly onElement: (element: TemplateElement) => void;
  /** Whether to descend into an `{#each}` block's own item body — see this module's doc comment. */
  readonly recurseIntoEach: boolean;
}

export function walkTemplate(node: TemplateNode, options: WalkTemplateOptions): void {
  if (node.kind === 'element') {
    options.onElement(node);
  } else if (node.kind === 'each' && !options.recurseIntoEach) {
    return;
  }
  for (const child of node.children) walkTemplate(child, options);
}
