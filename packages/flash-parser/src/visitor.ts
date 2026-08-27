/**
 * Generic CST visitor — mirrors kopytko-brightscript-parser's `walk`/`findAll`.
 */
import { SyntaxKind } from './syntaxKind.js';
import { isNode, SyntaxNode } from './syntaxNode.js';

export type AstVisitor = (node: SyntaxNode) => void;

/** Depth-first walk of every SyntaxNode in the tree (tokens are not visited). */
export function walk(node: SyntaxNode, visitor: AstVisitor): void {
  visitor(node);
  for (const child of node.children) {
    if (isNode(child)) walk(child, visitor);
  }
}

/** Every descendant node (including `node` itself) with the given SyntaxKind, wrapped via `wrap`. */
export function findAll<T>(node: SyntaxNode, kind: SyntaxKind, wrap: (node: SyntaxNode) => T): T[] {
  const results: T[] = [];
  walk(node, (n) => {
    if (n.kind === kind) results.push(wrap(n));
  });
  return results;
}
