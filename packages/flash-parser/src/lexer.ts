/**
 * Hand-written lexer for the flash-theater DSL's `<script>`-region grammar.
 * Converts a source string into a lossless token stream (every byte is
 * either a token's own text or attached as leading trivia — see trivia.ts).
 *
 * The lexer is deliberately context-free: it tokenizes generically (an
 * identifier is an identifier, a `{` is a `{`), even inside what will later
 * turn out to be an embedded BrightScript region. The parser is the one
 * that decides where an ExpressionRegion/StatementRegion begins and ends,
 * by depth-counting LParen/RParen/LBrace/RBrace tokens and comparing
 * `Token.line` — see parser.ts. This keeps the lexer simple and correct
 * (string/comment-aware tokenization "for free" gives every later
 * delimiter-matching step string/comment safety too, with no separate
 * raw-text rescanning needed).
 */
import { TokenKind, KEYWORD_MAP } from './tokenKind.js';
import { Token } from './token.js';
import { Trivia, TriviaKind } from './trivia.js';
import { skipStringLiteral } from './text-scan.js';

export interface TokenizeOptions {
  /** Byte offset in the outer `.thr` source where `source` begins — added to every position so tokens carry outer-source coordinates. */
  posOffset?: number;
  /** 0-based line number in the outer `.thr` source where `source` begins. */
  lineOffset?: number;
}

const SINGLE_CHAR_PUNCTUATION: Readonly<Record<string, TokenKind>> = {
  ':': TokenKind.Colon,
  ',': TokenKind.Comma,
  '(': TokenKind.LParen,
  ')': TokenKind.RParen,
  '{': TokenKind.LBrace,
  '}': TokenKind.RBrace,
  '[': TokenKind.LBracket,
  ']': TokenKind.RBracket,
  '=': TokenKind.Equals,
  // A decimal point in a NumberLiteral is consumed by the digit-scanning
  // branch above, before this generic dispatch is ever reached for that
  // character — this only ever fires for a bare `.` in a `store(<path>)`
  // dotted path, never inside a number.
  '.': TokenKind.Dot,
  // Never valid BrightScript expression syntax on its own — see ternary.ts.
  '?': TokenKind.Question,
};

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** Tokenizes a `<script>`-region source string into a lossless token stream, always ending with an `EndOfFile` token. */
export function tokenize(source: string, options: TokenizeOptions = {}): Token[] {
  const posOffset = options.posOffset ?? 0;
  const lineOffset = options.lineOffset ?? 0;

  const tokens: Token[] = [];
  const pendingTrivia: Trivia[] = [];
  let i = 0;
  let line = 0;
  let lineStart = 0;

  function makeTrivia(kind: TriviaKind, start: number, end: number): Trivia {
    return {
      kind,
      text: source.slice(start, end),
      pos: start + posOffset,
      end: end + posOffset,
      line: line + lineOffset,
      column: start - lineStart,
    };
  }

  function collectTrivia(): void {
    while (i < source.length) {
      const ch = source[i];

      if (ch === ' ' || ch === '\t' || ch === '\r') {
        const start = i;
        while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\r')) i++;
        pendingTrivia.push(makeTrivia(TriviaKind.Whitespace, start, i));
        continue;
      }

      if (ch === '\n') {
        const start = i;
        i++;
        pendingTrivia.push(makeTrivia(TriviaKind.LineBreak, start, i));
        line++;
        lineStart = i;
        continue;
      }

      if (ch === "'") {
        const start = i;
        while (i < source.length && source[i] !== '\n') i++;
        pendingTrivia.push(makeTrivia(TriviaKind.Comment, start, i));
        continue;
      }

      break;
    }
  }

  function emit(kind: TokenKind, start: number, end: number): Token {
    const leadingTrivia = pendingTrivia.splice(0, pendingTrivia.length);
    const token: Token = {
      kind,
      text: source.slice(start, end),
      pos: start + posOffset,
      end: end + posOffset,
      line: line + lineOffset,
      column: start - lineStart,
      leadingTrivia,
      trailingTrivia: [],
    };
    tokens.push(token);
    return token;
  }

  while (true) {
    collectTrivia();

    if (i >= source.length) {
      emit(TokenKind.EndOfFile, i, i);
      break;
    }

    const start = i;
    const ch = source[i];

    if (isIdentifierStart(ch)) {
      while (i < source.length && isIdentifierChar(source[i])) i++;
      const text = source.slice(start, i);
      emit(KEYWORD_MAP[text] ?? TokenKind.Identifier, start, i);
      continue;
    }

    if (ch === '"') {
      i = skipStringLiteral(source, i);
      emit(TokenKind.StringLiteral, start, i);
      continue;
    }

    if (isDigit(ch)) {
      while (i < source.length && isDigit(source[i])) i++;
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i++;
        while (i < source.length && isDigit(source[i])) i++;
      }
      emit(TokenKind.NumberLiteral, start, i);
      continue;
    }

    const punctuationKind = SINGLE_CHAR_PUNCTUATION[ch];
    if (punctuationKind) {
      i++;
      emit(punctuationKind, start, i);
      continue;
    }

    i++;
    emit(TokenKind.Unknown, start, i);
  }

  return tokens;
}
