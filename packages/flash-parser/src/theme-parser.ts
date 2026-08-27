import { TokenKind } from './tokenKind.js';
import { SyntaxKind } from './syntaxKind.js';
import { SyntaxChild, SyntaxNode } from './syntaxNode.js';
import { TokenStreamParser, FIELD_TYPES } from './token-stream-parser.js';

/**
 * Token-stream-driven recursive-descent parser for a `<theme-template>`/
 * `<theme name="...">` region's nested group/leaf declarations. Each member
 * is either a leaf (`<name>: <Type> = <literal>` — same 5-token shape as
 * `FieldDeclaration` minus the `field` keyword, same closed `FIELD_TYPES`
 * set) or a group (`<name>: { <member>* }`, unbounded nesting via recursive
 * `parseThemeMembers`).
 */
export class ThemeParser extends TokenStreamParser {
  parseThemeSection(kind: SyntaxKind): SyntaxNode {
    const children: SyntaxChild[] = [];
    while (!this.check(TokenKind.EndOfFile)) {
      if (this.diagnostics.length > 0) break; // Policy: first error wins, see GRAMMAR.md
      children.push(this.parseThemeMember());
    }
    return new SyntaxNode(kind, children);
  }

  private parseThemeMembers(endExclusive: number): SyntaxChild[] {
    const children: SyntaxChild[] = [];
    while (this.pos < endExclusive) {
      if (this.diagnostics.length > 0) break;
      children.push(this.parseThemeMember());
    }
    return children;
  }

  private parseThemeMember(): SyntaxNode {
    const MSG = 'Invalid theme member. Expected: <name>: <Type> = <literal>  or  <name>: { <member>* }';
    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-theme-member', MSG);
    if (!nameToken) return this.errorNode([]);

    const colonToken = this.expect(TokenKind.Colon, 'dsl/invalid-theme-member', MSG);
    if (!colonToken) return this.errorNode([nameToken]);

    if (this.check(TokenKind.LBrace)) {
      const lbraceToken = this.advance();
      const lbraceIndex = this.pos - 1;
      const rbraceIndex = this.findMatchingBrace(lbraceIndex);
      if (rbraceIndex === -1) {
        this.error('dsl/invalid-theme-group', `No closing "}" found for theme group "${nameToken.text}".`, nameToken);
        return this.errorNode([nameToken, colonToken, lbraceToken]);
      }

      const memberChildren = this.parseThemeMembers(rbraceIndex);
      const rbraceToken = this.tokens[rbraceIndex];
      this.pos = rbraceIndex + 1;
      return new SyntaxNode(SyntaxKind.ThemeGroupDeclaration, [nameToken, colonToken, lbraceToken, ...memberChildren, rbraceToken]);
    }

    const typeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-theme-leaf', MSG);
    if (!typeToken) return this.errorNode([nameToken, colonToken]);

    if (!FIELD_TYPES.has(typeToken.text)) {
      this.error(
        'dsl/invalid-theme-leaf',
        `Unknown theme leaf type "${typeToken.text}" for "${nameToken.text}". Allowed: ${[...FIELD_TYPES].join(', ')}.`,
        typeToken,
      );
      return this.errorNode([nameToken, colonToken, typeToken]);
    }

    const equalsToken = this.expect(TokenKind.Equals, 'dsl/invalid-theme-leaf', MSG);
    if (!equalsToken) return this.errorNode([nameToken, colonToken, typeToken]);

    const literalToken = this.expectLiteral(MSG, 'dsl/invalid-theme-leaf');
    if (!literalToken) return this.errorNode([nameToken, colonToken, typeToken, equalsToken]);

    const next = this.peek();
    if (next.kind !== TokenKind.EndOfFile && next.line === literalToken.line) {
      this.error('dsl/invalid-theme-leaf', MSG, next);
      return this.errorNode([nameToken, colonToken, typeToken, equalsToken, literalToken]);
    }

    return new SyntaxNode(SyntaxKind.ThemeLeafDeclaration, [nameToken, colonToken, typeToken, equalsToken, literalToken]);
  }
}
