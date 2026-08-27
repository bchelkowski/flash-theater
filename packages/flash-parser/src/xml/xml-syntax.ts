/**
 * SceneGraph XML CST infrastructure — token/trivia kinds, `XmlToken`,
 * `XmlSyntaxNode` — the Phase 0 grammar-ownership counterpart to
 * `kopytko-brightscript-parser`'s own `xml/xmlTokenKind.ts`/`xmlTrivia.ts`/
 * `xmlToken.ts`/`xmlSyntaxKind.ts`/`xmlSyntaxNode.ts` (see
 * `findings/compiler-parser-architecture.md`'s "flash-parser: a real, fully
 * self-sufficient CST/AST for the whole language" — template markup parsing
 * was, until this, the one remaining thing still delegated to that
 * package). Scoped to what SceneGraph component XML actually uses (tags,
 * attributes, text content, comments) — not a general XML/DTD/namespace/
 * CDATA grammar, matching the vendored source's own scoping.
 *
 * **Deliberately keeps the vendored leading+trailing trivia split**, unlike
 * `brightscript-lexer.ts`'s adaptation to flash-parser's simplified
 * leading-only convention: this XML CST is entirely self-contained (its own
 * token/node kinds, never mixed into the same tree as a DSL or BrightScript
 * node), so there's no cross-consistency pressure to unify the trivia model,
 * and the trailing-trivia split is what lets a same-line comment attach to
 * the element it follows rather than the next one — working, tested
 * behavior not worth risking a subtle regression in for a
 * consistency-only gain.
 */

// ─── Token/trivia kinds ────────────────────────────────────────────────────
export enum XmlTokenKind {
  LessThan = 'LessThan',
  LessSlash = 'LessSlash',
  SlashGreaterThan = 'SlashGreaterThan',
  GreaterThan = 'GreaterThan',
  Equals = 'Equals',
  Name = 'Name',
  StringLiteral = 'StringLiteral',
  Text = 'Text',
  Eof = 'Eof',
  Unknown = 'Unknown',
}

export enum XmlTriviaKind {
  /** Horizontal whitespace: spaces and tabs (no line breaks). */
  Whitespace = 'Whitespace',
  /** One line break: `\n` or `\r\n`. */
  LineBreak = 'LineBreak',
  /** `<!-- ... -->`. Only valid in content position (never inside a tag). */
  Comment = 'Comment',
  /** `<? ... ?>` — an XML declaration or other processing instruction. */
  ProcessingInstruction = 'ProcessingInstruction',
}

export enum XmlSyntaxKind {
  /** The whole document: prolog trivia + exactly one root `Element` (usually `<component>`). */
  Document = 'Document',
  /** An element: open tag + attributes + children + close tag, or a self-closing tag. */
  Element = 'Element',
  /** A single `name="value"` (or `name='value'`) pair inside a tag. */
  Attribute = 'Attribute',
  /** Non-whitespace text content between tags. */
  Text = 'Text',
  /** Unparseable content the parser recovered from. */
  ErrorNode = 'ErrorNode',
}

// ─── Trivia / Token ────────────────────────────────────────────────────────
export interface XmlTrivia {
  readonly kind: XmlTriviaKind;
  readonly text: string;
  readonly pos: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface XmlToken {
  readonly kind: XmlTokenKind;
  readonly text: string;
  readonly pos: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly leadingTrivia: readonly XmlTrivia[];
  readonly trailingTrivia: readonly XmlTrivia[];
  /** A synthetic zero-width token inserted when a required token (e.g. a closing `>`, or the value after `=`) is missing. */
  readonly isMissing?: boolean;
  /** The `XmlSyntaxNode` this token is a direct child of. */
  parent?: XmlSyntaxNode;
}

export function xmlTokenFullText(token: XmlToken): string {
  let result = '';
  for (const t of token.leadingTrivia) result += t.text;
  result += token.text;
  for (const t of token.trailingTrivia) result += t.text;
  return result;
}

export function xmlTokensToText(tokens: readonly XmlToken[]): string {
  let result = '';
  for (const token of tokens) result += xmlTokenFullText(token);
  return result;
}

// ─── SyntaxNode ────────────────────────────────────────────────────────────
export type XmlSyntaxChild = XmlSyntaxNode | XmlToken;

export function isXmlNode(child: XmlSyntaxChild): child is XmlSyntaxNode {
  return child instanceof XmlSyntaxNode;
}
export function isXmlToken(child: XmlSyntaxChild): child is XmlToken {
  return !isXmlNode(child);
}

/** Finds the first token in `node`'s subtree (depth-first), or `undefined` for a childless node. */
export function firstXmlToken(node: XmlSyntaxNode): XmlToken | undefined {
  for (const child of node.children) {
    if (isXmlToken(child)) return child;
    const found = firstXmlToken(child);
    if (found) return found;
  }
  return undefined;
}

/** Finds the last token in `node`'s subtree (depth-first), or `undefined` for a childless node. */
export function lastXmlToken(node: XmlSyntaxNode): XmlToken | undefined {
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    if (isXmlToken(child)) return child;
    const found = lastXmlToken(child);
    if (found) return found;
  }
  return undefined;
}

export class XmlSyntaxNode {
  readonly kind: XmlSyntaxKind;
  readonly children: XmlSyntaxChild[];
  parent: XmlSyntaxNode | null = null;

  private _childNodes?: XmlSyntaxNode[];
  private _childTokens?: XmlToken[];

  constructor(kind: XmlSyntaxKind, children: XmlSyntaxChild[] = []) {
    this.kind = kind;
    this.children = children;
    for (const child of children) child.parent = this;
  }

  get pos(): number {
    if (this.children.length === 0) return -1;
    const first = this.children[0];
    if (isXmlToken(first)) return first.leadingTrivia.length > 0 ? first.leadingTrivia[0].pos : first.pos;
    return first.pos;
  }
  get end(): number {
    if (this.children.length === 0) return -1;
    const last = this.children[this.children.length - 1];
    if (isXmlToken(last)) return last.trailingTrivia.length > 0 ? last.trailingTrivia[last.trailingTrivia.length - 1].end : last.end;
    return last.end;
  }
  get line(): number {
    if (this.children.length === 0) return -1;
    const first = this.children[0];
    if (isXmlToken(first)) return first.leadingTrivia.length > 0 ? first.leadingTrivia[0].line : first.line;
    return first.line;
  }
  get column(): number {
    if (this.children.length === 0) return -1;
    const first = this.children[0];
    if (isXmlToken(first)) return first.leadingTrivia.length > 0 ? first.leadingTrivia[0].column : first.column;
    return first.column;
  }

  getText(): string {
    const chunks: string[] = [];
    this.appendText(chunks);
    return chunks.join('');
  }
  private appendText(chunks: string[]): void {
    for (const child of this.children) {
      if (isXmlToken(child)) {
        chunks.push(xmlTokenFullText(child));
      } else {
        child.appendText(chunks);
      }
    }
  }

  findChild(kind: XmlSyntaxKind): XmlSyntaxNode | undefined {
    return this.children.find((c): c is XmlSyntaxNode => isXmlNode(c) && c.kind === kind);
  }
  findAllChildren(kind: XmlSyntaxKind): XmlSyntaxNode[] {
    return this.children.filter((c): c is XmlSyntaxNode => isXmlNode(c) && c.kind === kind);
  }
  findToken(kind: XmlTokenKind): XmlToken | undefined {
    return this.children.find((c): c is XmlToken => isXmlToken(c) && c.kind === kind);
  }

  get childNodes(): XmlSyntaxNode[] {
    if (!this._childNodes) this._childNodes = this.children.filter(isXmlNode);
    return this._childNodes;
  }
  get childTokens(): XmlToken[] {
    if (!this._childTokens) this._childTokens = this.children.filter(isXmlToken);
    return this._childTokens;
  }
}
