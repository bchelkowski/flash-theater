/**
 * Hand-written scanner for SceneGraph XML — vendored and adapted from
 * `kopytko-brightscript-parser`'s own `xml/xmlLexer.ts` (see
 * `xml-syntax.ts`'s own doc comment for the full rationale).
 *
 * Unlike the BrightScript lexer, XML tokenization is context-sensitive: `<`
 * inside a tag's attribute list means something different than `<` in
 * element content, `=` and quoted strings only make sense between a tag's
 * `<Name` and its closing `>`/`/>`, and comments can only appear in content
 * position. The scanner tracks this as two modes, `'content'` and `'tag'`,
 * switching on `<`/`</` (content → tag) and `>`/`/>` (tag → content).
 *
 * Every byte of the source is represented — either as a token's `text` or as
 * trivia attached to a token — so concatenating `xmlTokenFullText()` for
 * every token reproduces the original source byte-for-byte.
 */
import { XmlTokenKind, XmlTriviaKind, XmlToken, XmlTrivia } from './xml-syntax.js';

type XmlLexerMode = 'content' | 'tag';

function isHorizontalWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}
function isNameStartChar(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}
function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_.:-]/.test(ch);
}

export function xmlTokenize(source: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  const len = source.length;
  let pos = 0;
  let line = 0;
  let column = 0;
  let mode: XmlLexerMode = 'content';

  function peek(offset = 0): string {
    const idx = pos + offset;
    return idx < len ? source[idx] : '';
  }
  function advance(): string {
    const ch = source[pos];
    pos++;
    if (ch === '\n') {
      line++;
      column = 0;
    } else if (ch === '\r') {
      if (!(pos < len && source[pos] === '\n')) {
        line++;
        column = 0;
      }
    } else {
      column++;
    }
    return ch;
  }
  function isCommentStart(): boolean {
    return peek() === '<' && peek(1) === '!' && peek(2) === '-' && peek(3) === '-';
  }
  function isProcessingInstructionStart(): boolean {
    return peek() === '<' && peek(1) === '?';
  }

  function scanHorizontalWhitespace(): XmlTrivia {
    const start = pos,
      startLine = line,
      startCol = column;
    while (pos < len && isHorizontalWhitespace(source[pos])) advance();
    return { kind: XmlTriviaKind.Whitespace, text: source.slice(start, pos), pos: start, end: pos, line: startLine, column: startCol };
  }
  function scanLineBreak(): XmlTrivia {
    const start = pos,
      startLine = line,
      startCol = column;
    if (source[pos] === '\r') {
      advance();
      if (pos < len && source[pos] === '\n') advance();
    } else {
      advance();
    }
    return { kind: XmlTriviaKind.LineBreak, text: source.slice(start, pos), pos: start, end: pos, line: startLine, column: startCol };
  }
  function scanComment(): XmlTrivia {
    const start = pos,
      startLine = line,
      startCol = column;
    advance();
    advance();
    advance();
    advance(); // <!--
    while (pos < len && !(peek() === '-' && peek(1) === '-' && peek(2) === '>')) advance();
    if (pos < len) {
      advance();
      advance();
      advance();
    } // -->
    return { kind: XmlTriviaKind.Comment, text: source.slice(start, pos), pos: start, end: pos, line: startLine, column: startCol };
  }
  function scanProcessingInstruction(): XmlTrivia {
    const start = pos,
      startLine = line,
      startCol = column;
    advance();
    advance(); // <?
    while (pos < len && !(peek() === '?' && peek(1) === '>')) advance();
    if (pos < len) {
      advance();
      advance();
    } // ?>
    return { kind: XmlTriviaKind.ProcessingInstruction, text: source.slice(start, pos), pos: start, end: pos, line: startLine, column: startCol };
  }

  /** Everything before the next significant token: whitespace, line breaks, and (in content mode) comments/processing instructions. */
  function scanLeadingTrivia(): XmlTrivia[] {
    const trivia: XmlTrivia[] = [];
    while (pos < len) {
      const ch = source[pos];
      if (isHorizontalWhitespace(ch)) trivia.push(scanHorizontalWhitespace());
      else if (ch === '\n' || ch === '\r') trivia.push(scanLineBreak());
      else if (mode === 'content' && isCommentStart()) trivia.push(scanComment());
      else if (mode === 'content' && isProcessingInstructionStart()) trivia.push(scanProcessingInstruction());
      else break;
    }
    return trivia;
  }

  /**
   * Horizontal whitespace + an optional same-line comment (content mode
   * only) + the line break, if present — lets a comment on the same line as
   * a closed element attach to *that* element instead of the next one.
   */
  function scanTrailingTrivia(): XmlTrivia[] {
    const trivia: XmlTrivia[] = [];
    if (pos < len && isHorizontalWhitespace(source[pos])) trivia.push(scanHorizontalWhitespace());
    if (mode === 'content' && pos < len && isCommentStart()) trivia.push(scanComment());
    if (pos < len && (source[pos] === '\n' || source[pos] === '\r')) trivia.push(scanLineBreak());
    return trivia;
  }

  function makeToken(kind: XmlTokenKind, start: number, startLine: number, startCol: number, leading: XmlTrivia[]): XmlToken {
    const tokenEnd = pos; // capture before scanning trailing trivia
    const text = source.slice(start, tokenEnd);
    const trailing = scanTrailingTrivia();
    return { kind, text, pos: start, end: tokenEnd, line: startLine, column: startCol, leadingTrivia: leading, trailingTrivia: trailing };
  }

  while (true) {
    const leading = scanLeadingTrivia();
    if (pos >= len) {
      tokens.push(makeToken(XmlTokenKind.Eof, pos, line, column, leading));
      break;
    }

    const start = pos,
      startLine = line,
      startCol = column;

    if (mode === 'content') {
      if (peek() === '<' && peek(1) === '/') {
        advance();
        advance();
        tokens.push(makeToken(XmlTokenKind.LessSlash, start, startLine, startCol, leading));
        mode = 'tag';
      } else if (peek() === '<') {
        advance();
        tokens.push(makeToken(XmlTokenKind.LessThan, start, startLine, startCol, leading));
        mode = 'tag';
      } else {
        while (pos < len && source[pos] !== '<') advance();
        tokens.push(makeToken(XmlTokenKind.Text, start, startLine, startCol, leading));
      }
    } else {
      const ch = peek();
      if (ch === '/' && peek(1) === '>') {
        advance();
        advance();
        // Switch mode BEFORE calling makeToken(): a same-line comment right
        // after `/>` is only recognized as trivia in content mode.
        mode = 'content';
        tokens.push(makeToken(XmlTokenKind.SlashGreaterThan, start, startLine, startCol, leading));
      } else if (ch === '>') {
        advance();
        mode = 'content';
        tokens.push(makeToken(XmlTokenKind.GreaterThan, start, startLine, startCol, leading));
      } else if (ch === '=') {
        advance();
        tokens.push(makeToken(XmlTokenKind.Equals, start, startLine, startCol, leading));
      } else if (ch === '"' || ch === "'") {
        const quote = ch;
        advance();
        while (pos < len && source[pos] !== quote) advance();
        if (pos < len) advance(); // closing quote — tolerant of an unterminated value
        tokens.push(makeToken(XmlTokenKind.StringLiteral, start, startLine, startCol, leading));
      } else if (isNameStartChar(ch)) {
        while (pos < len && isNameChar(source[pos])) advance();
        tokens.push(makeToken(XmlTokenKind.Name, start, startLine, startCol, leading));
      } else {
        // Unrecognized character inside a tag (stray punctuation, or a
        // <!DOCTYPE/<![CDATA[ construct this scanner doesn't special-case —
        // SceneGraph XML doesn't use either). Consume one char and keep
        // going; the parser wraps runs of these in an ErrorNode.
        advance();
        tokens.push(makeToken(XmlTokenKind.Unknown, start, startLine, startCol, leading));
      }
    }
  }

  return tokens;
}
