/**
 * SyntaxNode — a node in the lossless Concrete Syntax Tree. Every byte of
 * the original source is represented in the tree: a node's children are an
 * interleaved sequence of child SyntaxNodes and Tokens, and `getText()` on
 * the root `ThrFile` node reproduces the original `.thr` source
 * byte-for-byte. Structurally mirrors kopytko-brightscript-parser's
 * SyntaxNode — see findings/compiler-parser-architecture.md.
 */
import type { BrightScriptParseResult } from './brightscript-parser.js';
import type { XmlParseResult } from './xml/xml-parser.js';
import { SyntaxKind } from './syntaxKind.js';
import { TokenKind } from './tokenKind.js';
import { Token, tokenFullText } from './token.js';

export interface EmbeddedBrightScriptParse {
  readonly kind: 'brightscript';
  readonly result: BrightScriptParseResult;
  /** Added to inner-parse positions to translate them into the outer .thr source's coordinate space. */
  readonly offset: number;
}

export interface EmbeddedXmlParse {
  readonly kind: 'xml';
  readonly result: XmlParseResult;
  readonly offset: number;
}

export type EmbeddedParse = EmbeddedBrightScriptParse | EmbeddedXmlParse;

/** A child in the CST is either another node or a token. */
export type SyntaxChild = SyntaxNode | Token;

/** Type guard: is the child a SyntaxNode (not a Token)? */
export function isNode(child: SyntaxChild): child is SyntaxNode {
  return child instanceof SyntaxNode;
}

/** Type guard: is the child a Token (not a SyntaxNode)? */
export function isToken(child: SyntaxChild): child is Token {
  return !isNode(child);
}

/** Finds the first token in `node`'s subtree (depth-first), or `undefined` for a childless node. */
export function firstToken(node: SyntaxNode): Token | undefined {
  for (const child of node.children) {
    if (isToken(child)) return child;
    const found = firstToken(child);
    if (found) return found;
  }
  return undefined;
}

/** Finds the last token in `node`'s subtree (depth-first), or `undefined` for a childless node. */
export function lastToken(node: SyntaxNode): Token | undefined {
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    if (isToken(child)) return child;
    const found = lastToken(child);
    if (found) return found;
  }
  return undefined;
}

export class SyntaxNode {
  readonly kind: SyntaxKind;
  readonly children: SyntaxChild[];
  parent: SyntaxNode | null = null;

  /**
   * Set once by the parser, only on ExpressionRegion/StatementRegion/
   * TemplateSection nodes — the eagerly-computed nested parse of this
   * node's embedded BrightScript or XML content (see embedded.ts). Mutable
   * for the same reason Token.parent is: it's only known after the node is
   * constructed, not at construction time.
   */
  embedded?: EmbeddedParse;

  private _childNodes?: SyntaxNode[];
  private _childTokens?: Token[];

  constructor(kind: SyntaxKind, children: SyntaxChild[] = []) {
    this.kind = kind;
    this.children = children;
    for (const child of children) child.parent = this;
  }

  /** Byte offset of the start of this node (including trivia of the first child). Returns `-1` for a childless node. */
  get pos(): number {
    const first = firstToken(this);
    if (!first) return -1;
    return first.leadingTrivia.length > 0 ? first.leadingTrivia[0].pos : first.pos;
  }

  /** Byte offset just past the end of this node (including trivia of the last child). Returns `-1` for a childless node. */
  get end(): number {
    const last = lastToken(this);
    if (!last) return -1;
    const trailing = last.trailingTrivia;
    return trailing.length > 0 ? trailing[trailing.length - 1].end : last.end;
  }

  /** 0-based line number of the start of this node (including trivia of the first child). Returns `-1` for a childless node. */
  get line(): number {
    const first = firstToken(this);
    if (!first) return -1;
    return first.leadingTrivia.length > 0 ? first.leadingTrivia[0].line : first.line;
  }

  /**
   * Reconstructs the full source text of this node and all its
   * descendants, including all trivia. For the root `ThrFile` node, this
   * reproduces the original source byte-for-byte.
   */
  getText(): string {
    let out = '';
    for (const child of this.children) {
      out += isNode(child) ? child.getText() : tokenFullText(child);
    }
    return out;
  }

  /** Finds the first direct child node with the given SyntaxKind, or undefined. */
  findChild(kind: SyntaxKind): SyntaxNode | undefined {
    return this.childNodes.find((n) => n.kind === kind);
  }

  /** Finds all direct child nodes with the given SyntaxKind. */
  findAllChildren(kind: SyntaxKind): SyntaxNode[] {
    return this.childNodes.filter((n) => n.kind === kind);
  }

  /** Finds the first direct child token with the given TokenKind, or undefined. */
  findToken(kind: TokenKind): Token | undefined {
    return this.childTokens.find((t) => t.kind === kind);
  }

  /** Finds all direct child tokens with the given TokenKind. */
  findAllTokens(kind: TokenKind): Token[] {
    return this.childTokens.filter((t) => t.kind === kind);
  }

  /** Returns all direct child nodes (filtering out tokens). */
  get childNodes(): SyntaxNode[] {
    if (!this._childNodes) this._childNodes = this.children.filter(isNode);
    return this._childNodes;
  }

  /** Returns all direct child tokens (filtering out nodes). */
  get childTokens(): Token[] {
    if (!this._childTokens) this._childTokens = this.children.filter(isToken);
    return this._childTokens;
  }
}
