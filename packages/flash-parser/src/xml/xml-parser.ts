/**
 * Recursive-descent parser for SceneGraph XML — vendored and adapted from
 * `kopytko-brightscript-parser`'s own `xml/xmlParser.ts` (see
 * `xml-syntax.ts`'s own doc comment for the full rationale).
 *
 * Consumes the token stream from `xml-lexer.ts` and produces a lossless
 * CST — calling `root.getText()` reproduces the original source.
 * Error-tolerant: always produces a tree, even for malformed input
 * (unrecognized/misplaced content is wrapped in `ErrorNode`s; a missing
 * required token is synthesized as a zero-width missing token rather than
 * re-attaching the current unconsumed token, which would duplicate its text
 * on every subsequent failed `expect()` — see `brightscript-parser.ts`'s
 * `expect()` for the same fix).
 *
 * **One deliberate deviation from real XML**: a bare attribute name with no
 * `="value"` at all is accepted — see `parseAttribute()`'s own doc comment.
 * `onKeyPreprocess.ts`'s own top comment documents the OTHER deliberate
 * deviation this template grammar has (`on:key[...]`) — that one needs a
 * dedicated pre-lexing transliteration pass since `[`/`]`/`,` aren't legal
 * XML `Name` characters at all; this one needed only a one-branch relaxation
 * here, since a bare name is already a legal `Name` token on its own.
 */
import { XmlTokenKind, XmlSyntaxKind, XmlSyntaxNode, XmlSyntaxChild } from './xml-syntax.js';
import { XmlToken } from './xml-syntax.js';
import { xmlTokenize } from './xml-lexer.js';

export interface XmlParseDiagnostic {
  readonly message: string;
  readonly pos: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface XmlParseResult {
  readonly root: XmlSyntaxNode;
  readonly diagnostics: readonly XmlParseDiagnostic[];
  readonly tokens: readonly XmlToken[];
}

/** Parses SceneGraph XML source into a lossless CST. */
export function parseXml(source: string): XmlParseResult {
  const tokens = xmlTokenize(source);
  const parser = new XmlParser(tokens);
  const root = parser.parseDocument();
  return { root, diagnostics: parser.diagnostics, tokens };
}

class XmlParser {
  private readonly tokens: readonly XmlToken[];
  private current = 0;
  readonly diagnostics: XmlParseDiagnostic[] = [];

  constructor(tokens: readonly XmlToken[]) {
    this.tokens = tokens;
  }

  private peek(): XmlToken {
    return this.tokens[this.current];
  }
  private peekKind(): XmlTokenKind {
    return this.peek().kind;
  }
  private isAtEnd(): boolean {
    return this.peekKind() === XmlTokenKind.Eof;
  }
  private advance(): XmlToken {
    const tok = this.peek();
    if (!this.isAtEnd()) this.current++;
    return tok;
  }
  private check(kind: XmlTokenKind): boolean {
    return this.peekKind() === kind;
  }
  private expect(kind: XmlTokenKind, message?: string): XmlToken {
    if (this.check(kind)) return this.advance();
    const tok = this.peek();
    this.error(message ?? `Expected ${kind} but found ${tok.kind}`, tok);
    return this.makeMissingToken(kind, tok);
  }
  private makeMissingToken(kind: XmlTokenKind, at: XmlToken): XmlToken {
    return { kind, text: '', pos: at.pos, end: at.pos, line: at.line, column: at.column, leadingTrivia: [], trailingTrivia: [], isMissing: true };
  }
  private error(message: string, token: XmlToken): void {
    this.diagnostics.push({ message, pos: token.pos, end: token.end, line: token.line, column: token.column });
  }
  private makeErrorNode(tokens: XmlSyntaxChild[]): XmlSyntaxNode {
    return new XmlSyntaxNode(XmlSyntaxKind.ErrorNode, tokens);
  }

  // ── Document ──────────────────────────────────────────────────────────
  parseDocument(): XmlSyntaxNode {
    const children: XmlSyntaxChild[] = [];
    // Defensively recover any stray content before the root element —
    // should not normally happen, since leading trivia already absorbs
    // whitespace, comments, and the `<?xml ...?>` declaration.
    while (!this.isAtEnd() && !this.check(XmlTokenKind.LessThan)) {
      children.push(this.makeErrorNode([this.advance()]));
    }
    if (this.check(XmlTokenKind.LessThan)) {
      children.push(this.parseElement());
    } else {
      this.error('Expected a root element', this.peek());
    }
    // Trailing content after the root element closes.
    while (!this.isAtEnd()) {
      children.push(this.makeErrorNode([this.advance()]));
    }
    if (this.check(XmlTokenKind.Eof)) children.push(this.advance());
    return new XmlSyntaxNode(XmlSyntaxKind.Document, children);
  }

  // ── Element ───────────────────────────────────────────────────────────
  private parseElement(): XmlSyntaxNode {
    const children: XmlSyntaxChild[] = [];
    children.push(this.advance()); // <
    const nameToken = this.expect(XmlTokenKind.Name, 'Expected a tag name');
    children.push(nameToken);

    while (this.check(XmlTokenKind.Name)) {
      children.push(this.parseAttribute());
    }

    if (this.check(XmlTokenKind.SlashGreaterThan)) {
      children.push(this.advance());
      return new XmlSyntaxNode(XmlSyntaxKind.Element, children);
    }
    if (!this.check(XmlTokenKind.GreaterThan)) {
      this.error('Expected ">" or "/>"', this.peek());
      children.push(this.expect(XmlTokenKind.GreaterThan, 'Expected ">"'));
      return new XmlSyntaxNode(XmlSyntaxKind.Element, children);
    }
    children.push(this.advance()); // >

    while (!this.isAtEnd() && !this.check(XmlTokenKind.LessSlash)) {
      const before = this.current;
      if (this.check(XmlTokenKind.LessThan)) {
        children.push(this.parseElement());
      } else if (this.check(XmlTokenKind.Text)) {
        children.push(new XmlSyntaxNode(XmlSyntaxKind.Text, [this.advance()]));
      } else {
        children.push(this.makeErrorNode([this.advance()]));
      }
      if (this.current === before) {
        if (this.isAtEnd()) break;
        children.push(this.makeErrorNode([this.advance()]));
      }
    }

    if (this.check(XmlTokenKind.LessSlash)) {
      children.push(this.advance()); // </
      const closeNameToken = this.expect(XmlTokenKind.Name, 'Expected a closing tag name');
      children.push(closeNameToken);
      if (!closeNameToken.isMissing && !nameToken.isMissing && closeNameToken.text.toLowerCase() !== nameToken.text.toLowerCase()) {
        this.error(`Mismatched closing tag: expected "</${nameToken.text}>" but found "</${closeNameToken.text}>"`, closeNameToken);
      }
      if (this.check(XmlTokenKind.GreaterThan)) {
        children.push(this.advance());
      } else {
        this.error('Expected ">"', this.peek());
        children.push(this.expect(XmlTokenKind.GreaterThan, 'Expected ">"'));
      }
    } else {
      this.error(`Expected a closing tag "</${nameToken.text}>"`, this.peek());
    }

    return new XmlSyntaxNode(XmlSyntaxKind.Element, children);
  }

  // ── Attribute ─────────────────────────────────────────────────────────
  /**
   * `name="value"` as real XML requires, OR a bare `name` with no `=` at all — this file's own top
   * comment flags this as the one deliberate relaxation from real XML this grammar makes. A bare
   * name is treated identically to `name=""`: `xml-ast.ts`'s `XmlAttribute.value` already falls
   * back to `''` when there's no value token at all (it has to, for a tolerantly-parsed malformed
   * `name=` with nothing after the `=` either), so every downstream consumer that already treats an
   * empty value as meaningful — `transition:`/`in:`/`out:`/`animate:`/router-outlet-transition
   * attributes' own "empty = use the defaults" convention (`template-classify.ts`'s
   * `classifyDoubleBraceOrEmptyValue`) — accepts a bare attribute for free, no separate handling
   * needed. `name=` with an `=` but no value after it is still an error (`expect()` below still
   * fires) — only a `=` that's ENTIRELY absent is treated as "no value", never a dangling one, so a
   * genuine typo still gets a diagnostic instead of silently meaning the same thing.
   */
  private parseAttribute(): XmlSyntaxNode {
    const children: XmlSyntaxChild[] = [this.advance()]; // name
    if (this.check(XmlTokenKind.Equals)) {
      children.push(this.advance());
      children.push(this.expect(XmlTokenKind.StringLiteral, 'Expected an attribute value'));
    }
    return new XmlSyntaxNode(XmlSyntaxKind.Attribute, children);
  }
}
