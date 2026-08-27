/**
 * Token — a single lexical unit produced by the DSL lexer (lexer.ts). Each
 * token carries its original source text, position information, and any
 * leading trivia (whitespace/comments) — see trivia.ts for why there's no
 * separate trailing trivia here. Concatenating every token's full text
 * reproduces the source byte-for-byte.
 */
import { TokenKind } from './tokenKind.js';
import { Trivia } from './trivia.js';
import type { SyntaxNode } from './syntaxNode.js';

export interface Token {
  readonly kind: TokenKind;
  /** The original source text of this token (leading trivia and any embedded content excluded — see leadingTrivia). */
  readonly text: string;
  /** Byte offset in the source where this token starts (excluding leading trivia). */
  readonly pos: number;
  /** Byte offset just past the end of this token (excluding trailing trivia — always none, see trivia.ts). */
  readonly end: number;
  /** 0-based line number of the token start. */
  readonly line: number;
  /** 0-based column (character offset within the line) of the token start. */
  readonly column: number;
  /** Whitespace/comments since the end of the previous token. */
  readonly leadingTrivia: readonly Trivia[];
  /** Always empty — see trivia.ts. Kept for shape parity with kopytko-brightscript-parser's Token. */
  readonly trailingTrivia: readonly Trivia[];
  /**
   * True for a synthetic zero-width token a parser inserts when a
   * required-but-absent token is missing from the source (see
   * `brightscript-parser.ts`'s `expect()`) — never set by a lexer. `text` is
   * always `''` and `pos === end`, so it contributes nothing to
   * `tokenFullText`/round-trip reconstruction; it exists purely so a
   * required child position in the tree is never left `undefined`.
   */
  readonly isMissing?: boolean;
  /**
   * The SyntaxNode this token is a direct child of. Set by SyntaxNode's
   * constructor. Mutable (unlike every other field) because it's only known
   * once the token is attached to a tree, mirroring
   * kopytko-brightscript-parser's own Token.parent.
   */
  parent?: SyntaxNode;
}

/** Reconstructs the full source text for a single token, including its leading trivia. */
export function tokenFullText(token: Token): string {
  let out = '';
  for (const trivia of token.leadingTrivia) out += trivia.text;
  out += token.text;
  for (const trivia of token.trailingTrivia) out += trivia.text;
  return out;
}

/** Reconstructs the full source text from a complete token array. */
export function tokensToText(tokens: readonly Token[]): string {
  return tokens.map(tokenFullText).join('');
}
