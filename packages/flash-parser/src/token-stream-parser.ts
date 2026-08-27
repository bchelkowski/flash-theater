/**
 * Shared token-stream helpers for every declaration-grammar parser in this
 * package: `<script>`/`<store>` declaration parsing (`ScriptParser`),
 * `<theme-template>`/`<theme>` member parsing (`ThemeParser`), and `.flsh`
 * import/class parsing (`ClassParser`) — all three extend this one base
 * class rather than duplicating token-stream plumbing (peek/advance/expect,
 * brace/paren depth-matching, the shared `if`/`else` statement grammar, the
 * expression/statement-region wrap-and-parse-via-`embedded.ts` machinery).
 */
import { TokenKind } from './tokenKind.js';
import { Token } from './token.js';
import { SyntaxKind } from './syntaxKind.js';
import { SyntaxChild, SyntaxNode } from './syntaxNode.js';
import { ParseDiagnostic } from './diagnostics.js';
import { parseEmbeddedExpression, parseEmbeddedStatements, translateBrightScriptDiagnostics } from './embedded.js';
import { buildTernaryCapableExpression, containsTernaryAnywhere } from './ternary.js';
import { RAW_BLOCK_START_MARKER, RAW_BLOCK_END_MARKER, hasRawStartMarker, hasRawEndMarker } from './raw-block.js';

/** The closed set of types a `field` (and a theme leaf, which shares the same SceneGraph-field-shaped constraint) may declare — see `ScriptParser.parseFieldDeclaration`/`ThemeParser.parseThemeMember`. `state`/`derived`/a function param or return type/a class field are all unrestricted identifiers instead, since none of those ever become a real XML `<field>`. */
export const FIELD_TYPES = new Set(['string', 'integer', 'float', 'boolean', 'node']);

export abstract class TokenStreamParser {
  protected pos = 0;

  constructor(
    protected readonly tokens: readonly Token[],
    protected readonly diagnostics: ParseDiagnostic[],
  ) {}

  protected peek(): Token {
    return this.tokens[this.pos];
  }

  protected check(kind: TokenKind): boolean {
    return this.tokens[this.pos].kind === kind;
  }

  protected advance(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return token;
  }

  protected expect(kind: TokenKind, code: string, message: string): Token | undefined {
    if (this.check(kind)) return this.advance();
    this.error(code, message, this.peek());
    return undefined;
  }

  protected expectLiteral(message: string, code: string): Token | undefined {
    const kind = this.peek().kind;
    if (kind === TokenKind.StringLiteral || kind === TokenKind.NumberLiteral || kind === TokenKind.True || kind === TokenKind.False || kind === TokenKind.Invalid) {
      return this.advance();
    }
    this.error(code, message, this.peek());
    return undefined;
  }

  /**
   * `field`/`state`'s own literal-position gate, widened beyond `expectLiteral`'s single-token
   * shape to also admit an array/AA literal (`[...]`/`{...}`) — deliberately NOT folded into
   * `expectLiteral` itself, since that method is still used verbatim by `ClassParser`/`ThemeParser`
   * (class fields and theme leaves keep the narrower single-token-only grammar; only `ScriptParser`'s
   * `field`/`state` declarations call this one). On a `[`/`{`, captures the whole balanced span via
   * `findMatchingBracket`/`findMatchingBrace` (same "count brackets, don't reimplement precedence"
   * approach `parseRequestDeclaration`'s `{ ... }` config capture already uses) and wraps it as an
   * `ExpressionRegion`, exactly like `request {}`'s own config block — deep validation of what's
   * actually inside (must be a pure literal, root kind must match the declared type) happens later,
   * in the compiler layer (`dsl-parser.ts`), not here; this method only ever confirms the brackets
   * balance. Falls back to `expectLiteral` for the existing scalar-token shape.
   */
  protected expectFieldOrStateLiteral(message: string, code: string): SyntaxChild | undefined {
    const openKind = this.peek().kind;
    if (openKind !== TokenKind.LBracket && openKind !== TokenKind.LBrace) {
      return this.expectLiteral(message, code);
    }

    const openIndex = this.pos;
    const closeIndex = openKind === TokenKind.LBracket ? this.findMatchingBracket(openIndex) : this.findMatchingBrace(openIndex);
    if (closeIndex === -1) {
      this.error(code, `No closing "${openKind === TokenKind.LBracket ? ']' : '}'}" found for this literal.`, this.tokens[openIndex]);
      return undefined;
    }

    const literalTokens = this.tokens.slice(openIndex, closeIndex + 1);
    const region = this.makeExpressionRegion(literalTokens);
    this.pos = closeIndex + 1;
    return region;
  }

  protected error(code: string, message: string, token: Token): void {
    this.diagnostics.push({ code, message, pos: token.pos, end: token.end, line: token.line });
  }

  protected errorNode(consumed: SyntaxChild[]): SyntaxNode {
    return new SyntaxNode(SyntaxKind.ErrorNode, consumed);
  }

  protected findMatchingBrace(openIndex: number): number {
    let depth = 1;
    for (let i = openIndex + 1; i < this.tokens.length; i++) {
      const kind = this.tokens[i].kind;
      if (kind === TokenKind.LBrace) depth++;
      else if (kind === TokenKind.RBrace) {
        depth--;
        if (depth === 0) return i;
      } else if (kind === TokenKind.EndOfFile) return -1;
    }
    return -1;
  }

  protected findMatchingParen(openIndex: number): number {
    let depth = 1;
    for (let i = openIndex + 1; i < this.tokens.length; i++) {
      const kind = this.tokens[i].kind;
      if (kind === TokenKind.LParen) depth++;
      else if (kind === TokenKind.RParen) {
        depth--;
        if (depth === 0) return i;
      } else if (kind === TokenKind.EndOfFile) return -1;
    }
    return -1;
  }

  /** Mirrors `findMatchingBrace`/`findMatchingParen` exactly, for an array literal's `[`/`]` — see `expectFieldOrStateLiteral`. */
  protected findMatchingBracket(openIndex: number): number {
    let depth = 1;
    for (let i = openIndex + 1; i < this.tokens.length; i++) {
      const kind = this.tokens[i].kind;
      if (kind === TokenKind.LBracket) depth++;
      else if (kind === TokenKind.RBracket) {
        depth--;
        if (depth === 0) return i;
      } else if (kind === TokenKind.EndOfFile) return -1;
    }
    return -1;
  }

  /**
   * Scans forward from `startIndex`, collecting tokens on the SAME physical line as `anchorLine`
   * — but tolerates a bracketed construct (a Tier-2 anonymous function's own multi-line body, an
   * AA/array literal, ...) that opens before the line ends and doesn't close until a LATER line:
   * once bracket depth returns to 0, the "same line" boundary is enforced again. `extraStop`, if
   * given, is checked only at bracket-depth 0 too (e.g. an inline `if`'s own body scan must also
   * stop at `else`).
   *
   * Shared by every same-line-bounded scan in this file (`state`/`store` write RHS capture, a
   * ternary-assignment RHS's own detection/capture, an inline `if (...) then <stmt>`/`else
   * <stmt>` body) — a plain same-line check alone stopped being sufficient once Tier 2 made a
   * call argument (or any expression position) able to legally contain a multi-line anonymous
   * function literal; confirmed live via a failed Tier-2 compile (`state x = list.Filter(function
   * (y) {\n ... \n})` truncated mid-header) before this depth-tracking was added — see
   * `parseBlockContent`'s own opaque-region scanner for the sibling fix this one mirrors.
   */
  protected scanSameLogicalLine(startIndex: number, anchorLine: number, extraStop?: (kind: TokenKind) => boolean): Token[] {
    const tokens: Token[] = [];
    let bracketDepth = 0;
    let i = startIndex;
    while (i < this.tokens.length) {
      const token = this.tokens[i];
      if (token.kind === TokenKind.EndOfFile) break;
      if (bracketDepth === 0 && token.line !== anchorLine) break;
      if (bracketDepth === 0 && extraStop?.(token.kind)) break;

      tokens.push(token);
      if (token.kind === TokenKind.LParen || token.kind === TokenKind.LBrace || token.kind === TokenKind.LBracket) bracketDepth++;
      else if (token.kind === TokenKind.RParen || token.kind === TokenKind.RBrace || token.kind === TokenKind.RBracket) bracketDepth = Math.max(0, bracketDepth - 1);
      i++;
    }
    return tokens;
  }

  /**
   * Scans `tokens[start, endExclusive)` for the first occurrence of `kind` at
   * bracket-depth 0 (relative to this span) — used by `parseForStatement` to
   * find a numeric `for` header's own `to`/`step` keyword without mistaking
   * one nested inside a call's arguments (`for (i = f(1, 2) to 10)`), the
   * same "count brackets, never reimplement precedence" style
   * `findMatchingParen`/`findMatchingBrace` already use. Returns `-1` if not
   * found.
   */
  protected findTopLevelToken(start: number, endExclusive: number, kind: TokenKind): number {
    let depth = 0;
    for (let i = start; i < endExclusive; i++) {
      const k = this.tokens[i].kind;
      if (k === TokenKind.LParen || k === TokenKind.LBrace || k === TokenKind.LBracket) depth++;
      else if (k === TokenKind.RParen || k === TokenKind.RBrace || k === TokenKind.RBracket) depth--;
      else if (depth === 0 && k === kind) return i;
    }
    return -1;
  }

  /** `import <ClassName> from "<path>"` — valid in a `.thr` `<script>` section (`ScriptParser`) and at a `.flsh` file's top level (`ClassParser`). `<path>` is kept as the raw quoted string-literal token text; unquoting happens at the AST layer (`ImportDeclaration.path`). */
  protected parseImportDeclaration(): SyntaxNode {
    const MSG = 'Invalid import. Expected: import <ClassName> from "<path>"';
    const importToken = this.advance();

    const classNameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-import', MSG);
    if (!classNameToken) return this.errorNode([importToken]);

    const fromToken = this.expect(TokenKind.From, 'dsl/invalid-import', MSG);
    if (!fromToken) return this.errorNode([importToken, classNameToken]);

    const pathToken = this.expect(TokenKind.StringLiteral, 'dsl/invalid-import', MSG);
    if (!pathToken) return this.errorNode([importToken, classNameToken, fromToken]);

    const next = this.peek();
    if (next.kind !== TokenKind.EndOfFile && next.line === pathToken.line) {
      this.error('dsl/invalid-import', MSG, next);
      return this.errorNode([importToken, classNameToken, fromToken, pathToken]);
    }

    return new SyntaxNode(SyntaxKind.ImportDeclaration, [importToken, classNameToken, fromToken, pathToken]);
  }

  /** `void` is never a real type in this DSL (see GRAMMAR.md) — a function with nothing to return simply omits `: <Type>` and compiles to a `sub`. Called everywhere an unrestricted type identifier is accepted (state/derived types, function/method/constructor param/return types). Returns `false` (and pushes `dsl/void-not-a-type`) when `typeToken` is literally `void`. */
  protected rejectVoidType(typeToken: Token): boolean {
    if (typeToken.text !== 'void') return true;
    this.error('dsl/void-not-a-type', VOID_NOT_A_TYPE_MSG, typeToken);
    return false;
  }

  protected makeExpressionRegion(tokens: Token[]): SyntaxNode {
    const node = new SyntaxNode(SyntaxKind.ExpressionRegion, tokens);
    this.attachBrightScriptParse(node, parseEmbeddedExpression, 'expression/parse-error');
    return node;
  }

  /** Same as `makeExpressionRegion` for a ternary-free `tokens` (byte-identical `ExpressionRegion` output) — builds a `TernaryExpression`/`TernaryOperand` tree instead when `tokens` contains a ternary anywhere (see ternary.ts). */
  protected makeTernaryCapableExpression(tokens: Token[]): SyntaxNode {
    return buildTernaryCapableExpression(tokens, this.diagnostics);
  }

  protected makeStatementRegion(tokens: Token[], options: { stripTrailingSemicolon?: boolean } = {}): SyntaxNode {
    const node = new SyntaxNode(SyntaxKind.StatementRegion, tokens);
    this.attachBrightScriptParse(node, parseEmbeddedStatements, 'statement/parse-error', options.stripTrailingSemicolon ?? false);
    return node;
  }

  /**
   * Recognizes `' flash-theater:raw` ... `' flash-theater:end-raw` at the current position — see
   * GRAMMAR.md's "Raw BrightScript passthrough" section and raw-block.ts's own doc comment for why
   * this is comment-CONTENT-driven rather than token-driven, a deliberate one-off exception to this
   * file's usual "recognize real tokens, never sniff comment text" grammar style.
   *
   * Must be checked BEFORE any keyword-based dispatch in a block-content loop — real BrightScript
   * control flow inside a raw block (`if ... then ... end if`, a bare `for`/`while`) would otherwise
   * be misdispatched as this DSL's own JS-shaped grammar, the same class of bug
   * findings/statement-grammar-features.md documents for `for`/`while`/`try` nested inside an
   * ordinary opaque `StatementRegion`.
   *
   * Returns `null` (parser position untouched) when the current token carries no start marker.
   * `endExclusive` bounds the scan to the enclosing block/declaration-list — reaching it (or real
   * EndOfFile) before the end marker is `statement/unterminated-raw-block`, matching every other
   * "no closing X found" diagnostic in this file (`findMatchingBrace`/`findMatchingParen` callers).
   */
  protected tryParseRawBlock(endExclusive: number): SyntaxNode | null {
    const start = this.peek();
    if (!hasRawStartMarker(start.leadingTrivia)) return null;

    const startIndex = this.pos;
    this.advance();

    while (true) {
      const next = this.peek();
      if (hasRawEndMarker(next.leadingTrivia)) {
        return this.makeRawBrightScriptRegion(this.tokens.slice(startIndex, this.pos));
      }
      if (this.pos >= endExclusive || next.kind === TokenKind.EndOfFile) {
        this.error(
          'statement/unterminated-raw-block',
          `"' ${RAW_BLOCK_START_MARKER}" has no matching "' ${RAW_BLOCK_END_MARKER}" before the enclosing block ends.`,
          start,
        );
        return this.errorNode(this.tokens.slice(startIndex, this.pos));
      }
      this.advance();
    }
  }

  /**
   * Builds the `RawBrightScriptRegion` node and eagerly validates its content as real BrightScript
   * — same `attachBrightScriptParse`/`parseEmbeddedStatements` machinery `makeStatementRegion` uses,
   * so a syntax error inside a raw block is caught at `.thr`/`.flsh` compile time (attributed to the
   * author via `statement/invalid-raw-brightscript`) rather than only surfacing later when the
   * generated `.brs` itself runs on-device. The captured token span starts AT the marker-carrying
   * token, so its leading trivia (the marker comment) is included in what gets parsed here — parsed
   * harmlessly as an ordinary leading comment, never affecting validity; `RawBrightScriptStatement
   * .text` (ast.ts) strips it back out for codegen.
   */
  private makeRawBrightScriptRegion(tokens: Token[]): SyntaxNode {
    const node = new SyntaxNode(SyntaxKind.RawBrightScriptRegion, tokens);
    this.attachBrightScriptParse(node, parseEmbeddedStatements, 'statement/invalid-raw-brightscript');
    return node;
  }

  protected attachBrightScriptParse(
    node: SyntaxNode,
    parseFn: (text: string) => ReturnType<typeof parseEmbeddedExpression>,
    diagnosticCode: string,
    stripTrailingSemicolon = false,
  ): void {
    const raw = node.getText();
    let text = raw.trim();
    if (stripTrailingSemicolon && text.endsWith(';')) text = text.slice(0, -1).trimEnd();
    if (text.length === 0) return;

    const leadingWs = raw.length - raw.trimStart().length;
    const offset = node.pos + leadingWs;
    const parsed = parseFn(text);
    node.embedded = { kind: 'brightscript', result: parsed.result, offset };

    for (const d of translateBrightScriptDiagnostics(parsed, offset)) {
      this.diagnostics.push({ code: diagnosticCode, message: d.message, pos: d.pos, end: d.end, line: d.line });
    }
  }

  protected parseParameterList(functionName: string): { node: SyntaxNode } | undefined {
    const MSG = `Invalid parameter in function "${functionName}". Expected: <name>: <Type>`;
    const lparenToken = this.tokens[this.pos - 1];
    const children: SyntaxChild[] = [];

    if (this.check(TokenKind.RParen)) {
      const rparenToken = this.advance();
      return { node: new SyntaxNode(SyntaxKind.ParameterList, [lparenToken, rparenToken]) };
    }

    while (true) {
      const paramNameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-param', MSG);
      if (!paramNameToken) return undefined;
      const colonToken = this.expect(TokenKind.Colon, 'dsl/invalid-param', MSG);
      if (!colonToken) return undefined;
      const typeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-param', MSG);
      if (!typeToken) return undefined;
      if (!this.rejectVoidType(typeToken)) return undefined;

      children.push(new SyntaxNode(SyntaxKind.Parameter, [paramNameToken, colonToken, typeToken]));

      if (this.check(TokenKind.Comma)) {
        children.push(this.advance());
        continue;
      }
      break;
    }

    const rparenToken = this.expect(TokenKind.RParen, 'dsl/invalid-function-header', `Invalid function header for "${functionName}" — unterminated parameter list.`);
    if (!rparenToken) return undefined;

    return { node: new SyntaxNode(SyntaxKind.ParameterList, [lparenToken, ...children, rparenToken]) };
  }

  protected parseBlockContent(endExclusive: number): SyntaxChild[] {
    const children: SyntaxChild[] = [];

    while (this.pos < endExclusive) {
      if (this.diagnostics.length > 0) break;

      const rawBlock = this.tryParseRawBlock(endExclusive);
      if (rawBlock) {
        children.push(rawBlock);
        continue;
      }

      const kind = this.tokens[this.pos].kind;

      if (kind === TokenKind.If) {
        children.push(this.parseIfStatement());
        continue;
      }

      if (kind === TokenKind.Else) {
        this.error('statement/dangling-else', 'else with no matching if.', this.tokens[this.pos]);
        break;
      }

      if (kind === TokenKind.State) {
        children.push(this.parseStateAssignment());
        continue;
      }

      if (kind === TokenKind.Store) {
        children.push(this.parseStoreWriteStatement());
        continue;
      }

      if (kind === TokenKind.Scale) {
        children.push(this.parseScaleAssignment());
        continue;
      }

      if (kind === TokenKind.Focus) {
        children.push(this.parseFocusStatement());
        continue;
      }

      if (kind === TokenKind.JumpFocus) {
        children.push(this.parseJumpFocusStatement());
        continue;
      }

      if (kind === TokenKind.For) {
        children.push(this.parseForOrForEachStatement());
        continue;
      }

      if (kind === TokenKind.While) {
        children.push(this.parseWhileStatement());
        continue;
      }

      if (kind === TokenKind.Try) {
        children.push(this.parseTryStatement());
        continue;
      }

      if (kind === TokenKind.Catch) {
        this.error('statement/dangling-catch', 'catch with no matching try.', this.tokens[this.pos]);
        break;
      }

      if (kind === TokenKind.Identifier) {
        const anonymousFunctionAssignment = this.tryParseAnonymousFunctionAssignment();
        if (anonymousFunctionAssignment) {
          children.push(anonymousFunctionAssignment);
          continue;
        }
        const ternaryAssignment = this.tryParseTernaryAssignment();
        if (ternaryAssignment) {
          children.push(ternaryAssignment);
          continue;
        }
      }

      const regionStart = this.pos;
      // Bracket-depth-gated: a DSL keyword (`if`/`state`/`store`/...) only ends the opaque region
      // when it's genuinely at THIS statement's own top level — never when it's nested inside a
      // still-open `(`/`{`/`[`, e.g. a Tier-2 anonymous function's own body buried inside a call
      // argument (`list.Map(function (x) { if (x) { ... } })`). Without this, the scanner would
      // stop the region right before that inner `if`, wrongly split it out as its own top-level
      // `IfStatement`, and leave the anonymous function's header dangling with no closing brace —
      // confirmed live via a failed Tier-2 compile before this depth-tracking was added. A
      // Tier-1 anonymous-function-assignment never hits this loop at all (handled structurally by
      // `tryParseAnonymousFunctionAssignment` above, which correctly brace-matches its own body),
      // so this fix is specifically for Tier 2.
      let bracketDepth = 0;
      while (this.pos < endExclusive) {
        const tokenKind = this.tokens[this.pos].kind;
        const isTopLevelStopKeyword =
          tokenKind === TokenKind.If ||
          tokenKind === TokenKind.Else ||
          tokenKind === TokenKind.State ||
          tokenKind === TokenKind.Store ||
          tokenKind === TokenKind.Scale ||
          tokenKind === TokenKind.Focus ||
          tokenKind === TokenKind.JumpFocus ||
          tokenKind === TokenKind.For ||
          tokenKind === TokenKind.While ||
          tokenKind === TokenKind.Try ||
          tokenKind === TokenKind.Catch;
        const looksLikeNewAssignmentOnItsOwnLine =
          this.pos > regionStart &&
          this.tokens[this.pos].line !== this.tokens[this.pos - 1].line &&
          (this.looksLikeTernaryAssignmentAt(this.pos) || this.looksLikeAnonymousFunctionAssignmentAt(this.pos));
        // A raw block's own start marker must never be silently swallowed into this StatementRegion
        // as inert comment text — stop here so the outer loop's own tryParseRawBlock() check picks
        // it up on its next iteration. Same reasoning as looksLikeNewAssignmentOnItsOwnLine above.
        const startsRawBlock = this.pos > regionStart && hasRawStartMarker(this.tokens[this.pos].leadingTrivia);

        if (bracketDepth === 0 && (isTopLevelStopKeyword || looksLikeNewAssignmentOnItsOwnLine || startsRawBlock)) break;

        if (tokenKind === TokenKind.LParen || tokenKind === TokenKind.LBrace || tokenKind === TokenKind.LBracket) bracketDepth++;
        else if (tokenKind === TokenKind.RParen || tokenKind === TokenKind.RBrace || tokenKind === TokenKind.RBracket) bracketDepth = Math.max(0, bracketDepth - 1);

        this.pos++;
      }
      const regionTokens = this.tokens.slice(regionStart, this.pos);
      if (regionTokens.length > 0) children.push(this.makeStatementRegion(regionTokens));
    }

    return children;
  }

  /**
   * Non-consuming lookahead: does the line starting at token index `index` look like a plain bare
   * assignment (`Identifier '=' ...`) whose right-hand side contains a ternary anywhere? Shared by
   * `tryParseTernaryAssignment` (the dispatch check in `parseBlockContent`'s main loop) and the
   * opaque-scan fallback loop above (which must stop accumulating a `StatementRegion` the moment a
   * *later* physical line within it turns out to be a ternary-bearing assignment, so that line gets
   * picked up structurally on the next outer-loop iteration instead of being swallowed as opaque
   * text). A ternary-free assignment is deliberately invisible to this check — it's meant to stay
   * an ordinary opaque `StatementRegion`, unchanged from before this feature (see ternary.ts).
   */
  protected looksLikeTernaryAssignmentAt(index: number): boolean {
    if (this.tokens[index]?.kind !== TokenKind.Identifier) return false;
    const equalsToken = this.tokens[index + 1];
    if (equalsToken?.kind !== TokenKind.Equals) return false;

    const exprTokens = this.scanSameLogicalLine(index + 2, equalsToken.line);
    return containsTernaryAnywhere(exprTokens);
  }

  /** Commits to structurally parsing the current position as a `TernaryAssignmentStatement` — only ever called after `looksLikeTernaryAssignmentAt(this.pos)` (or an equivalent check) already confirmed a ternary is present; returns `undefined` (parser position untouched) otherwise, letting the caller fall through to the ordinary opaque `StatementRegion` scan. */
  protected tryParseTernaryAssignment(): SyntaxNode | undefined {
    if (!this.looksLikeTernaryAssignmentAt(this.pos)) return undefined;

    const identifierToken = this.tokens[this.pos];
    const equalsToken = this.tokens[this.pos + 1];

    const start = this.pos + 2;
    const exprTokens = this.scanSameLogicalLine(start, equalsToken.line);

    this.pos = start + exprTokens.length;
    const rhsNode = this.makeTernaryCapableExpression(exprTokens);
    return new SyntaxNode(SyntaxKind.TernaryAssignmentStatement, [identifierToken, equalsToken, rhsNode]);
  }

  /** Does token index `index` start `function (` — an anonymous function expression's own header? Non-consuming lookahead, shared by every RHS position that accepts one (Tier 1: `state <name> = ...` and a plain bare assignment, see GRAMMAR.md's "Anonymous function expressions"). */
  protected looksLikeAnonymousFunctionAt(index: number): boolean {
    return this.tokens[index]?.kind === TokenKind.Function && this.tokens[index + 1]?.kind === TokenKind.LParen;
  }

  /**
   * Non-consuming lookahead: does the line starting at token index `index` look like a plain bare
   * assignment (`Identifier '=' ...`) whose right-hand side is exactly an anonymous function
   * expression? Mirrors `looksLikeTernaryAssignmentAt`'s own shape/role — shared by
   * `tryParseAnonymousFunctionAssignment` (the dispatch check in `parseBlockContent`'s main loop)
   * and the opaque-scan fallback loop above (which must stop accumulating a `StatementRegion` the
   * moment a *later* physical line within it turns out to be this shape, so it's picked up
   * structurally on the next outer-loop iteration instead of being swallowed as opaque text).
   */
  protected looksLikeAnonymousFunctionAssignmentAt(index: number): boolean {
    if (this.tokens[index]?.kind !== TokenKind.Identifier) return false;
    if (this.tokens[index + 1]?.kind !== TokenKind.Equals) return false;
    return this.looksLikeAnonymousFunctionAt(index + 2);
  }

  /** Commits to structurally parsing the current position as an `AnonymousFunctionAssignmentStatement` — only ever called after `looksLikeAnonymousFunctionAssignmentAt(this.pos)` already confirmed the shape; returns `undefined` (parser position untouched) otherwise, letting the caller fall through to ternary-assignment detection and, ultimately, the ordinary opaque `StatementRegion` scan. */
  protected tryParseAnonymousFunctionAssignment(): SyntaxNode | undefined {
    if (!this.looksLikeAnonymousFunctionAssignmentAt(this.pos)) return undefined;

    const identifierToken = this.advance();
    const equalsToken = this.advance();
    const anonymousFunction = this.parseAnonymousFunctionExpression();

    return new SyntaxNode(SyntaxKind.AnonymousFunctionAssignmentStatement, [identifierToken, equalsToken, anonymousFunction]);
  }

  /**
   * `function (<param>: <Type>, ...) [: <Type>] { <Block> }` used as a value — reuses
   * `parseParameterList` (already generic over a declaration's own vs. an anonymous header's
   * param list) and the shared `: <Type>` return-type clause shape `parseFunctionDeclaration`
   * already uses, so a named and an anonymous function's header stay byte-for-byte consistent.
   * Assumes the caller already confirmed `looksLikeAnonymousFunctionAt(this.pos)`.
   */
  protected parseAnonymousFunctionExpression(): SyntaxNode {
    const HEADER_MSG = 'Invalid anonymous function. Expected: function (<param>: <Type>, ...) { or ...): <Type> {';
    const functionToken = this.advance();

    const lparenToken = this.expect(TokenKind.LParen, 'dsl/invalid-anonymous-function-header', HEADER_MSG);
    if (!lparenToken) return this.errorNode([functionToken]);

    const paramList = this.parseParameterList('<anonymous>');
    if (!paramList) return this.errorNode([functionToken]);

    const headerTail: SyntaxChild[] = [];
    if (this.check(TokenKind.Colon)) {
      const colonToken = this.advance();
      const returnTypeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-anonymous-function-header', HEADER_MSG);
      if (!returnTypeToken) return this.errorNode([functionToken, paramList.node, colonToken]);
      if (!this.rejectVoidType(returnTypeToken)) return this.errorNode([functionToken, paramList.node, colonToken, returnTypeToken]);
      headerTail.push(colonToken, returnTypeToken);
    }

    const lbraceToken = this.expect(TokenKind.LBrace, 'dsl/invalid-anonymous-function-header', HEADER_MSG);
    if (!lbraceToken) return this.errorNode([functionToken, paramList.node, ...headerTail]);

    const lbraceIndex = this.pos - 1;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('dsl/unterminated-anonymous-function-block', 'No closing "}" found for anonymous function.', functionToken);
      return this.errorNode([functionToken, paramList.node, ...headerTail, lbraceToken]);
    }

    const blockChildren = this.parseBlockContent(rbraceIndex);
    const rbraceToken = this.tokens[rbraceIndex];
    this.pos = rbraceIndex + 1;
    const block = new SyntaxNode(SyntaxKind.Block, [lbraceToken, ...blockChildren, rbraceToken]);

    return new SyntaxNode(SyntaxKind.AnonymousFunctionExpression, [functionToken, paramList.node, ...headerTail, block]);
  }

  /** `state <name> = <expr>` — a function-body write to a declared `state`. Same single-line-scan shape as `parseDerivedDeclaration`, just a statement instead of a script-level declaration. */
  protected parseStateAssignment(): SyntaxNode {
    const MSG = 'Invalid state assignment. Expected: state <name> = <expression>';
    const stateToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, 'statement/invalid-state-assignment', MSG);
    if (!nameToken) return this.errorNode([stateToken]);

    const equalsToken = this.expect(TokenKind.Equals, 'statement/invalid-state-assignment', MSG);
    if (!equalsToken) return this.errorNode([stateToken, nameToken]);

    if (this.peek().kind === TokenKind.EndOfFile || this.peek().line !== equalsToken.line) {
      this.error('statement/invalid-state-assignment', MSG, equalsToken);
      return this.errorNode([stateToken, nameToken, equalsToken]);
    }

    // An anonymous function's own `{ }` body can span multiple lines, so it's parsed via
    // `parseAnonymousFunctionExpression`'s own position-aware `findMatchingBrace` rather than the
    // same-line token scan below (which only ever suits a genuine single-line expression).
    if (this.looksLikeAnonymousFunctionAt(this.pos)) {
      const anonymousFunction = this.parseAnonymousFunctionExpression();
      return new SyntaxNode(SyntaxKind.StateAssignment, [stateToken, nameToken, equalsToken, anonymousFunction]);
    }

    const exprTokens = this.scanSameLogicalLine(this.pos, equalsToken.line);
    this.pos += exprTokens.length;

    const region = this.makeTernaryCapableExpression(exprTokens);
    return new SyntaxNode(SyntaxKind.StateAssignment, [stateToken, nameToken, equalsToken, region]);
  }

  /**
   * `scale <name> = <expr>` (a local-variable assignment) or
   * `scale state <name> = <expr>` (the function-body write form of a declared
   * `state`) — both scaled at runtime by the app's configured design-resolution
   * factor (see GRAMMAR.md's "scale" section). Mirrors `parseStateAssignment`'s
   * own same-line-scan shape; `scale` is only ever consumed here, never falling
   * into the `Identifier` ternary/anonymous-function lookahead in
   * `parseBlockContent`, since `scale` is its own distinct `TokenKind`.
   */
  protected parseScaleAssignment(): SyntaxNode {
    const MSG = 'Invalid scale assignment. Expected: scale <name> = <expression> or scale state <name> = <expression>';
    const scaleToken = this.advance();

    if (this.check(TokenKind.State)) {
      const stateToken = this.advance();

      const nameToken = this.expect(TokenKind.Identifier, 'statement/invalid-scale-assignment', MSG);
      if (!nameToken) return this.errorNode([scaleToken, stateToken]);

      const equalsToken = this.expect(TokenKind.Equals, 'statement/invalid-scale-assignment', MSG);
      if (!equalsToken) return this.errorNode([scaleToken, stateToken, nameToken]);

      if (this.peek().kind === TokenKind.EndOfFile || this.peek().line !== equalsToken.line) {
        this.error('statement/invalid-scale-assignment', MSG, equalsToken);
        return this.errorNode([scaleToken, stateToken, nameToken, equalsToken]);
      }

      if (this.looksLikeAnonymousFunctionAt(this.pos)) {
        const anonymousFunction = this.parseAnonymousFunctionExpression();
        return new SyntaxNode(SyntaxKind.ScaleStateAssignmentStatement, [scaleToken, stateToken, nameToken, equalsToken, anonymousFunction]);
      }

      const stateExprTokens = this.scanSameLogicalLine(this.pos, equalsToken.line);
      this.pos += stateExprTokens.length;
      const stateRegion = this.makeTernaryCapableExpression(stateExprTokens);
      return new SyntaxNode(SyntaxKind.ScaleStateAssignmentStatement, [scaleToken, stateToken, nameToken, equalsToken, stateRegion]);
    }

    const nameToken = this.expect(TokenKind.Identifier, 'statement/invalid-scale-assignment', MSG);
    if (!nameToken) return this.errorNode([scaleToken]);

    const equalsToken = this.expect(TokenKind.Equals, 'statement/invalid-scale-assignment', MSG);
    if (!equalsToken) return this.errorNode([scaleToken, nameToken]);

    if (this.peek().kind === TokenKind.EndOfFile || this.peek().line !== equalsToken.line) {
      this.error('statement/invalid-scale-assignment', MSG, equalsToken);
      return this.errorNode([scaleToken, nameToken, equalsToken]);
    }

    if (this.looksLikeAnonymousFunctionAt(this.pos)) {
      const anonymousFunction = this.parseAnonymousFunctionExpression();
      return new SyntaxNode(SyntaxKind.ScaleLocalAssignmentStatement, [scaleToken, nameToken, equalsToken, anonymousFunction]);
    }

    const exprTokens = this.scanSameLogicalLine(this.pos, equalsToken.line);
    this.pos += exprTokens.length;
    const region = this.makeTernaryCapableExpression(exprTokens);
    return new SyntaxNode(SyntaxKind.ScaleLocalAssignmentStatement, [scaleToken, nameToken, equalsToken, region]);
  }

  /**
   * `store(<topLevelKey>) = <expression>` — a function-body write to the
   * global store. The target must be a single, dot-free segment — only a
   * whole top-level key can ever be replaced at once (`statement/store-nested-write`
   * otherwise), since a real SceneGraph field observer only fires when the
   * field itself is reassigned, never when something mutates a nested value
   * in place. Parsed fully (path, then a nested-write check, then the RHS)
   * before reporting that error, matching this file's usual "parse fully,
   * validate after" style.
   */
  protected parseStoreWriteStatement(): SyntaxNode {
    const MSG = 'Invalid store write. Expected: store(<topLevelKey>) = <expression>';
    const storeToken = this.advance();

    const lparenToken = this.expect(TokenKind.LParen, 'statement/invalid-store-write', MSG);
    if (!lparenToken) return this.errorNode([storeToken]);

    const pathTokens: Token[] = [];
    const firstSegment = this.expect(TokenKind.Identifier, 'statement/invalid-store-write', MSG);
    if (!firstSegment) return this.errorNode([storeToken, lparenToken]);
    pathTokens.push(firstSegment);

    while (this.check(TokenKind.Dot)) {
      pathTokens.push(this.advance());
      const segment = this.expect(TokenKind.Identifier, 'statement/invalid-store-write', MSG);
      if (!segment) return this.errorNode([storeToken, lparenToken, ...pathTokens]);
      pathTokens.push(segment);
    }

    const pathNode = new SyntaxNode(SyntaxKind.StorePathExpression, pathTokens);

    const rparenToken = this.expect(TokenKind.RParen, 'statement/invalid-store-write', MSG);
    if (!rparenToken) return this.errorNode([storeToken, lparenToken, pathNode]);

    if (pathNode.findAllTokens(TokenKind.Identifier).length > 1) {
      this.error(
        'statement/store-nested-write',
        `store(...) write target must be a single top-level key with no dots — got "${pathNode.getText()}". Only a whole top-level key can be replaced at once (a nested write wouldn't be observed live).`,
        firstSegment,
      );
      return this.errorNode([storeToken, lparenToken, pathNode, rparenToken]);
    }

    const equalsToken = this.expect(TokenKind.Equals, 'statement/invalid-store-write', MSG);
    if (!equalsToken) return this.errorNode([storeToken, lparenToken, pathNode, rparenToken]);

    if (this.peek().kind === TokenKind.EndOfFile || this.peek().line !== equalsToken.line) {
      this.error('statement/invalid-store-write', MSG, equalsToken);
      return this.errorNode([storeToken, lparenToken, pathNode, rparenToken, equalsToken]);
    }

    const exprTokens = this.scanSameLogicalLine(this.pos, equalsToken.line);
    this.pos += exprTokens.length;

    const region = this.makeExpressionRegion(exprTokens);
    return new SyntaxNode(SyntaxKind.StoreWriteStatement, [storeToken, lparenToken, pathNode, rparenToken, equalsToken, region]);
  }

  /**
   * `focus(<expr>)` — a function-body statement transferring real focus into another component.
   * Unlike `store(...)`'s write form, the argument can be an arbitrary expression (a string id
   * literal, a `node`-typed field, a nested call like `m.top.findNode("x")`, ...), so it needs
   * genuine balanced-paren capture, not `store`'s own "rest of the line" scan — same approach
   * `parseIfStatement`'s condition parsing already uses (`findMatchingParen`).
   */
  protected parseFocusStatement(): SyntaxNode {
    const MSG = 'Invalid focus(...) call. Expected: focus(<expression>)';
    const focusToken = this.advance();

    const lparenToken = this.expect(TokenKind.LParen, 'statement/focus-requires-parens', MSG);
    if (!lparenToken) return this.errorNode([focusToken]);

    const lparenIndex = this.pos - 1;
    const rparenIndex = this.findMatchingParen(lparenIndex);
    if (rparenIndex === -1) {
      this.error('statement/unterminated-focus-call', 'Unterminated focus(...) call.', focusToken);
      return this.errorNode([focusToken, lparenToken]);
    }

    const argTokens = this.tokens.slice(this.pos, rparenIndex);
    if (argTokens.length === 0) {
      this.error('statement/focus-requires-argument', MSG, focusToken);
      return this.errorNode([focusToken, lparenToken]);
    }

    const argRegion = this.makeExpressionRegion(argTokens);
    const rparenToken = this.tokens[rparenIndex];
    this.pos = rparenIndex + 1;

    return new SyntaxNode(SyntaxKind.FocusStatement, [focusToken, lparenToken, argRegion, rparenToken]);
  }

  /**
   * `jumpFocus(<direction>, <count>, <press>)` — a function-body statement jumping real focus
   * several registered candidates at once in one geometric direction (RowList-style), the
   * reserved-keyword counterpart to the automatic single-step LRUD `navigate()` fallthrough (see
   * GRAMMAR.md's "Focus system" section). Unlike `focus(<id>)`'s single argument, this needs three
   * independently-captured expressions — split via `findTopLevelToken` scanning for `Comma`, the
   * same technique `parseForStatement` already uses to split its own `<start> to <end> step
   * <step>` header, rather than a naive linear comma scan that would mis-split a comma nested
   * inside one argument's own call (e.g. `jumpFocus("down", listPageSize(a, b), press)`).
   */
  protected parseJumpFocusStatement(): SyntaxNode {
    const MSG = 'Invalid jumpFocus(...) call. Expected: jumpFocus(<direction>, <count>, <press>)';
    const jumpFocusToken = this.advance();

    const lparenToken = this.expect(TokenKind.LParen, 'statement/jump-focus-requires-parens', MSG);
    if (!lparenToken) return this.errorNode([jumpFocusToken]);

    const lparenIndex = this.pos - 1;
    const rparenIndex = this.findMatchingParen(lparenIndex);
    if (rparenIndex === -1) {
      this.error('statement/unterminated-jump-focus-call', 'Unterminated jumpFocus(...) call.', jumpFocusToken);
      return this.errorNode([jumpFocusToken, lparenToken]);
    }

    const firstCommaIndex = this.findTopLevelToken(this.pos, rparenIndex, TokenKind.Comma);
    const directionTokens = this.tokens.slice(this.pos, firstCommaIndex === -1 ? rparenIndex : firstCommaIndex);
    if (firstCommaIndex === -1 || directionTokens.length === 0) {
      this.error('statement/jump-focus-requires-three-arguments', MSG, jumpFocusToken);
      return this.errorNode([jumpFocusToken, lparenToken]);
    }
    const directionRegion = this.makeExpressionRegion(directionTokens);
    const firstCommaToken = this.tokens[firstCommaIndex];
    this.pos = firstCommaIndex + 1;

    const secondCommaIndex = this.findTopLevelToken(this.pos, rparenIndex, TokenKind.Comma);
    const countTokens = this.tokens.slice(this.pos, secondCommaIndex === -1 ? rparenIndex : secondCommaIndex);
    if (secondCommaIndex === -1 || countTokens.length === 0) {
      this.error('statement/jump-focus-requires-three-arguments', MSG, firstCommaToken);
      return this.errorNode([jumpFocusToken, lparenToken, directionRegion, firstCommaToken]);
    }
    const countRegion = this.makeExpressionRegion(countTokens);
    const secondCommaToken = this.tokens[secondCommaIndex];
    this.pos = secondCommaIndex + 1;

    const pressTokens = this.tokens.slice(this.pos, rparenIndex);
    if (pressTokens.length === 0) {
      this.error('statement/jump-focus-requires-three-arguments', MSG, secondCommaToken);
      return this.errorNode([jumpFocusToken, lparenToken, directionRegion, firstCommaToken, countRegion, secondCommaToken]);
    }
    const pressRegion = this.makeExpressionRegion(pressTokens);
    const rparenToken = this.tokens[rparenIndex];
    this.pos = rparenIndex + 1;

    return new SyntaxNode(SyntaxKind.JumpFocusStatement, [
      jumpFocusToken,
      lparenToken,
      directionRegion,
      firstCommaToken,
      countRegion,
      secondCommaToken,
      pressRegion,
      rparenToken,
    ]);
  }

  protected parseIfStatement(): SyntaxNode {
    const ifToken = this.advance();

    if (!this.check(TokenKind.LParen)) {
      this.error('statement/if-requires-parens', 'if must be followed by a parenthesized condition, e.g. "if (x) { ... }".', ifToken);
      return this.errorNode([ifToken]);
    }
    const lparenToken = this.advance();
    const lparenIndex = this.pos - 1;
    const rparenIndex = this.findMatchingParen(lparenIndex);
    if (rparenIndex === -1) {
      this.error('statement/unterminated-if-condition', 'Unterminated if condition.', ifToken);
      return this.errorNode([ifToken, lparenToken]);
    }

    const conditionTokens = this.tokens.slice(this.pos, rparenIndex);
    const conditionRegion = this.makeExpressionRegion(conditionTokens);
    const rparenToken = this.tokens[rparenIndex];
    this.pos = rparenIndex + 1;

    if (this.check(TokenKind.LBrace)) {
      const lbraceToken = this.advance();
      const lbraceIndex = this.pos - 1;
      const rbraceIndex = this.findMatchingBrace(lbraceIndex);
      if (rbraceIndex === -1) {
        this.error('statement/unterminated-if-block', 'Unterminated if block.', ifToken);
        return this.errorNode([ifToken, lparenToken, conditionRegion, rparenToken, lbraceToken]);
      }

      const blockChildren = this.parseBlockContent(rbraceIndex);
      const rbraceToken = this.tokens[rbraceIndex];
      this.pos = rbraceIndex + 1;
      const block = new SyntaxNode(SyntaxKind.Block, [lbraceToken, ...blockChildren, rbraceToken]);

      const children: SyntaxChild[] = [ifToken, lparenToken, conditionRegion, rparenToken, block];
      const elseClause = this.parseOptionalElseClause();
      if (elseClause) children.push(elseClause);
      return new SyntaxNode(SyntaxKind.IfStatement, children);
    }

    const inlineStart = this.pos;
    const inlineTokens = this.scanSameLogicalLine(inlineStart, rparenToken.line, (kind) => kind === TokenKind.Else);
    this.pos = inlineStart + inlineTokens.length;
    if (inlineTokens.length === 0) {
      this.error('statement/empty-inline-if', 'if (...) with no statement on the same line and no { } block.', ifToken);
      return this.errorNode([ifToken, lparenToken, conditionRegion, rparenToken]);
    }

    const statementRegion = this.makeStatementRegion(inlineTokens, { stripTrailingSemicolon: true });
    const children: SyntaxChild[] = [ifToken, lparenToken, conditionRegion, rparenToken, statementRegion];
    const elseClause = this.parseOptionalElseClause();
    if (elseClause) children.push(elseClause);
    return new SyntaxNode(SyntaxKind.IfStatement, children);
  }

  /**
   * Parses this if's `else` continuation, if present — `else if (...)` (a
   * recursive call, so a chain of any length falls out for free), `else { }`,
   * or inline `else <stmt>` (statement runs to the end of the line the
   * `else` itself is on, same convention as the inline `if` form). Returns
   * `undefined` when there's no `else` at all — never for a malformed one
   * (that still produces an `ElseClause` node, just childless beyond the
   * `else` token, so the caller doesn't need its own absent/malformed
   * distinction).
   */
  protected parseOptionalElseClause(): SyntaxNode | undefined {
    if (!this.check(TokenKind.Else)) return undefined;
    const elseToken = this.advance();

    if (this.check(TokenKind.If)) {
      const nestedIf = this.parseIfStatement();
      return new SyntaxNode(SyntaxKind.ElseClause, [elseToken, nestedIf]);
    }

    if (this.check(TokenKind.LBrace)) {
      const lbraceToken = this.advance();
      const lbraceIndex = this.pos - 1;
      const rbraceIndex = this.findMatchingBrace(lbraceIndex);
      if (rbraceIndex === -1) {
        this.error('statement/unterminated-else-block', 'Unterminated else block.', elseToken);
        return new SyntaxNode(SyntaxKind.ElseClause, [elseToken, lbraceToken]);
      }

      const blockChildren = this.parseBlockContent(rbraceIndex);
      const rbraceToken = this.tokens[rbraceIndex];
      this.pos = rbraceIndex + 1;
      const block = new SyntaxNode(SyntaxKind.Block, [lbraceToken, ...blockChildren, rbraceToken]);
      return new SyntaxNode(SyntaxKind.ElseClause, [elseToken, block]);
    }

    const inlineStart = this.pos;
    const inlineTokens = this.scanSameLogicalLine(inlineStart, elseToken.line);
    this.pos = inlineStart + inlineTokens.length;
    if (inlineTokens.length === 0) {
      this.error('statement/empty-else', 'else with no statement on the same line and no { } block.', elseToken);
      return new SyntaxNode(SyntaxKind.ElseClause, [elseToken]);
    }

    const statementRegion = this.makeStatementRegion(inlineTokens, { stripTrailingSemicolon: true });
    return new SyntaxNode(SyntaxKind.ElseClause, [elseToken, statementRegion]);
  }

  /** Dispatches on whether `each` immediately follows `for` — mirrors the full BrightScript grammar's own `for`/`for each` disambiguation (`brightscript-parser.ts`'s `parseForStatement`). */
  protected parseForOrForEachStatement(): SyntaxNode {
    if (this.tokens[this.pos + 1]?.kind === TokenKind.Each) return this.parseForEachStatement();
    return this.parseForStatement();
  }

  /**
   * `for (<var> = <start> to <end> [step <step>]) { }` — JS-bracket sugar
   * over BrightScript's `for i = 0 to 10 [step n] ... end for`, never
   * surfacing `end for` in DSL source. Unlike `if`, there is no inline
   * (braceless) form — a loop body without a visible block is a much likelier
   * source of confusion than a one-line `if`. The header's `<start>`/`<end>`/
   * `<step>` are each captured as their own independent `ExpressionRegion`
   * (found via `findTopLevelToken`, not a naive linear scan, so a nested call
   * containing its own `to`/`step`-shaped identifier can't be mistaken for
   * the loop's own) — `<var> = <start> to <end>` as a whole is for-statement-
   * specific syntax, not a standalone BrightScript expression, so it can't be
   * captured as a single `ExpressionRegion` the way `if`'s condition is.
   */
  protected parseForStatement(): SyntaxNode {
    const HEADER_MSG = 'Invalid for header. Expected: for (<var> = <start> to <end> [step <step>]) { ... }';
    const forToken = this.advance();

    if (!this.check(TokenKind.LParen)) {
      this.error('statement/for-requires-parens', 'for must be followed by a parenthesized header, e.g. "for (i = 0 to 10) { ... }".', forToken);
      return this.errorNode([forToken]);
    }
    const lparenToken = this.advance();
    const lparenIndex = this.pos - 1;
    const rparenIndex = this.findMatchingParen(lparenIndex);
    if (rparenIndex === -1) {
      this.error('statement/unterminated-for-header', 'Unterminated for header.', forToken);
      return this.errorNode([forToken, lparenToken]);
    }

    const loopVarToken = this.expect(TokenKind.Identifier, 'statement/invalid-for-header', HEADER_MSG);
    if (!loopVarToken) return this.errorNode([forToken, lparenToken]);

    const equalsToken = this.expect(TokenKind.Equals, 'statement/invalid-for-header', HEADER_MSG);
    if (!equalsToken) return this.errorNode([forToken, lparenToken, loopVarToken]);

    const toIndex = this.findTopLevelToken(this.pos, rparenIndex, TokenKind.To);
    const startTokens = this.tokens.slice(this.pos, toIndex === -1 ? rparenIndex : toIndex);
    if (toIndex === -1 || startTokens.length === 0) {
      this.error('statement/invalid-for-header', HEADER_MSG, equalsToken);
      return this.errorNode([forToken, lparenToken, loopVarToken, equalsToken]);
    }
    const startRegion = this.makeExpressionRegion(startTokens);
    const toToken = this.tokens[toIndex];
    this.pos = toIndex + 1;

    const stepIndex = this.findTopLevelToken(this.pos, rparenIndex, TokenKind.Step);
    const endTokens = this.tokens.slice(this.pos, stepIndex === -1 ? rparenIndex : stepIndex);
    if (endTokens.length === 0) {
      this.error('statement/invalid-for-header', HEADER_MSG, toToken);
      return this.errorNode([forToken, lparenToken, loopVarToken, equalsToken, startRegion, toToken]);
    }
    const endRegion = this.makeExpressionRegion(endTokens);
    this.pos = stepIndex === -1 ? rparenIndex : stepIndex;

    const tail: SyntaxChild[] = [];
    if (stepIndex !== -1) {
      const stepToken = this.tokens[stepIndex];
      this.pos = stepIndex + 1;
      const stepTokens = this.tokens.slice(this.pos, rparenIndex);
      if (stepTokens.length === 0) {
        this.error('statement/invalid-for-header', HEADER_MSG, stepToken);
        return this.errorNode([forToken, lparenToken, loopVarToken, equalsToken, startRegion, toToken, endRegion, stepToken]);
      }
      tail.push(stepToken, this.makeExpressionRegion(stepTokens));
      this.pos = rparenIndex;
    }

    const rparenToken = this.tokens[rparenIndex];
    this.pos = rparenIndex + 1;
    const headSoFar: SyntaxChild[] = [forToken, lparenToken, loopVarToken, equalsToken, startRegion, toToken, endRegion, ...tail, rparenToken];

    if (!this.check(TokenKind.LBrace)) {
      this.error('statement/for-requires-block', 'for (...) must be followed by a { } block — there is no inline single-statement for.', forToken);
      return this.errorNode(headSoFar);
    }
    const lbraceToken = this.advance();
    const lbraceIndex = this.pos - 1;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('statement/unterminated-for-block', 'Unterminated for block.', forToken);
      return this.errorNode([...headSoFar, lbraceToken]);
    }

    const blockChildren = this.parseBlockContent(rbraceIndex);
    const rbraceToken = this.tokens[rbraceIndex];
    this.pos = rbraceIndex + 1;
    const block = new SyntaxNode(SyntaxKind.Block, [lbraceToken, ...blockChildren, rbraceToken]);

    return new SyntaxNode(SyntaxKind.ForStatement, [...headSoFar, block]);
  }

  /**
   * `for each (<item> in <collection>) { }` — JS-bracket sugar over
   * BrightScript's `for each <item> in <collection> ... end for`. No inline
   * (braceless) form, same reasoning as `parseForStatement`.
   */
  protected parseForEachStatement(): SyntaxNode {
    const MSG = 'Invalid for each header. Expected: for each (<item> in <collection>) { ... }';
    const forToken = this.advance();
    const eachToken = this.advance();

    if (!this.check(TokenKind.LParen)) {
      this.error('statement/foreach-requires-parens', 'for each must be followed by a parenthesized header, e.g. "for each (item in collection) { ... }".', forToken);
      return this.errorNode([forToken, eachToken]);
    }
    const lparenToken = this.advance();
    const lparenIndex = this.pos - 1;
    const rparenIndex = this.findMatchingParen(lparenIndex);
    if (rparenIndex === -1) {
      this.error('statement/unterminated-foreach-header', 'Unterminated for each header.', forToken);
      return this.errorNode([forToken, eachToken, lparenToken]);
    }

    const itemVarToken = this.expect(TokenKind.Identifier, 'statement/foreach-requires-in', MSG);
    if (!itemVarToken) return this.errorNode([forToken, eachToken, lparenToken]);

    const inToken = this.expect(TokenKind.In, 'statement/foreach-requires-in', MSG);
    if (!inToken) return this.errorNode([forToken, eachToken, lparenToken, itemVarToken]);

    const collectionTokens = this.tokens.slice(this.pos, rparenIndex);
    if (collectionTokens.length === 0) {
      this.error('statement/foreach-requires-in', MSG, inToken);
      return this.errorNode([forToken, eachToken, lparenToken, itemVarToken, inToken]);
    }
    const collectionRegion = this.makeExpressionRegion(collectionTokens);
    const rparenToken = this.tokens[rparenIndex];
    this.pos = rparenIndex + 1;
    const headSoFar: SyntaxChild[] = [forToken, eachToken, lparenToken, itemVarToken, inToken, collectionRegion, rparenToken];

    if (!this.check(TokenKind.LBrace)) {
      this.error('statement/foreach-requires-block', 'for each (...) must be followed by a { } block — there is no inline single-statement for each.', forToken);
      return this.errorNode(headSoFar);
    }
    const lbraceToken = this.advance();
    const lbraceIndex = this.pos - 1;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('statement/unterminated-foreach-block', 'Unterminated for each block.', forToken);
      return this.errorNode([...headSoFar, lbraceToken]);
    }

    const blockChildren = this.parseBlockContent(rbraceIndex);
    const rbraceToken = this.tokens[rbraceIndex];
    this.pos = rbraceIndex + 1;
    const block = new SyntaxNode(SyntaxKind.Block, [lbraceToken, ...blockChildren, rbraceToken]);

    return new SyntaxNode(SyntaxKind.ForEachStatement, [...headSoFar, block]);
  }

  /** `while (<condition>) { }` — same `condition` capture as `parseIfStatement`'s single-condition half, no inline (braceless) form, no `else`. */
  protected parseWhileStatement(): SyntaxNode {
    const whileToken = this.advance();

    if (!this.check(TokenKind.LParen)) {
      this.error('statement/while-requires-parens', 'while must be followed by a parenthesized condition, e.g. "while (x) { ... }".', whileToken);
      return this.errorNode([whileToken]);
    }
    const lparenToken = this.advance();
    const lparenIndex = this.pos - 1;
    const rparenIndex = this.findMatchingParen(lparenIndex);
    if (rparenIndex === -1) {
      this.error('statement/unterminated-while-condition', 'Unterminated while condition.', whileToken);
      return this.errorNode([whileToken, lparenToken]);
    }

    const conditionTokens = this.tokens.slice(this.pos, rparenIndex);
    const conditionRegion = this.makeExpressionRegion(conditionTokens);
    const rparenToken = this.tokens[rparenIndex];
    this.pos = rparenIndex + 1;
    const headSoFar: SyntaxChild[] = [whileToken, lparenToken, conditionRegion, rparenToken];

    if (!this.check(TokenKind.LBrace)) {
      this.error('statement/while-requires-block', 'while (...) must be followed by a { } block — there is no inline single-statement while.', whileToken);
      return this.errorNode(headSoFar);
    }
    const lbraceToken = this.advance();
    const lbraceIndex = this.pos - 1;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('statement/unterminated-while-block', 'Unterminated while block.', whileToken);
      return this.errorNode([...headSoFar, lbraceToken]);
    }

    const blockChildren = this.parseBlockContent(rbraceIndex);
    const rbraceToken = this.tokens[rbraceIndex];
    this.pos = rbraceIndex + 1;
    const block = new SyntaxNode(SyntaxKind.Block, [lbraceToken, ...blockChildren, rbraceToken]);

    return new SyntaxNode(SyntaxKind.WhileStatement, [...headSoFar, block]);
  }

  /**
   * `try { } catch (<name>) { }` — `try` takes no header at all (no parens),
   * and always requires a `catch` clause — this DSL has no catch-less `try`,
   * no `finally`.
   */
  protected parseTryStatement(): SyntaxNode {
    const tryToken = this.advance();

    if (!this.check(TokenKind.LBrace)) {
      this.error(
        'statement/try-requires-block',
        'try must be followed directly by a { } block, e.g. "try { ... } catch (e) { ... }" — try takes no condition.',
        tryToken,
      );
      return this.errorNode([tryToken]);
    }
    const lbraceToken = this.advance();
    const lbraceIndex = this.pos - 1;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('statement/unterminated-try-block', 'Unterminated try block.', tryToken);
      return this.errorNode([tryToken, lbraceToken]);
    }
    const tryBlockChildren = this.parseBlockContent(rbraceIndex);
    const tryRbraceToken = this.tokens[rbraceIndex];
    this.pos = rbraceIndex + 1;
    const tryBlock = new SyntaxNode(SyntaxKind.Block, [lbraceToken, ...tryBlockChildren, tryRbraceToken]);

    if (!this.check(TokenKind.Catch)) {
      this.error(
        'statement/try-requires-catch',
        "try { } must be followed by catch (<name>) { } — this DSL's try/catch has no catch-less form.",
        tryToken,
      );
      return this.errorNode([tryToken, tryBlock]);
    }
    const catchClause = this.parseCatchClause();

    return new SyntaxNode(SyntaxKind.TryStatement, [tryToken, tryBlock, catchClause]);
  }

  /** A `TryStatement`'s mandatory `catch (<name>) { }` — parens around the caught variable are mandatory in this DSL, narrowing real BrightScript's own optional-paren `catch e`/`catch (e)` form for consistency with `if`/`while`/`for`'s always-parenthesized convention. */
  protected parseCatchClause(): SyntaxNode {
    const MSG = 'Invalid catch clause. Expected: catch (<name>) { ... }';
    const catchToken = this.advance();

    if (!this.check(TokenKind.LParen)) {
      this.error('statement/catch-requires-parens', 'catch must be followed by a parenthesized variable name, e.g. "catch (e) { ... }".', catchToken);
      return this.errorNode([catchToken]);
    }
    const lparenToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, 'statement/catch-requires-parens', MSG);
    if (!nameToken) return this.errorNode([catchToken, lparenToken]);

    const rparenToken = this.expect(TokenKind.RParen, 'statement/catch-requires-parens', MSG);
    if (!rparenToken) return this.errorNode([catchToken, lparenToken, nameToken]);
    const headSoFar: SyntaxChild[] = [catchToken, lparenToken, nameToken, rparenToken];

    if (!this.check(TokenKind.LBrace)) {
      this.error('statement/catch-requires-block', 'catch (...) must be followed by a { } block.', catchToken);
      return this.errorNode(headSoFar);
    }
    const lbraceToken = this.advance();
    const lbraceIndex = this.pos - 1;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('statement/unterminated-catch-block', 'Unterminated catch block.', catchToken);
      return this.errorNode([...headSoFar, lbraceToken]);
    }
    const blockChildren = this.parseBlockContent(rbraceIndex);
    const rbraceToken = this.tokens[rbraceIndex];
    this.pos = rbraceIndex + 1;
    const block = new SyntaxNode(SyntaxKind.Block, [lbraceToken, ...blockChildren, rbraceToken]);

    return new SyntaxNode(SyntaxKind.CatchClause, [...headSoFar, block]);
  }
}

/**
 * Entry point for `brightscript-parser.ts`'s Tier-2 anonymous-function dispatch (a DSL anonymous
 * function nested inside an ordinary BrightScript expression — a call argument, an `if`/`for`/
 * `while` header, a ternary branch, ...). Reuses `parseAnonymousFunctionExpression` completely
 * unmodified via a bodiless concrete subclass (`TokenStreamParser` has no abstract *methods*,
 * only the class itself is marked abstract, so this is legal) — the exact same grammar Tier 1's
 * two RHS-position hosts already use, zero duplicated parsing logic.
 *
 * `tokens` must start at the `function` token, already keyword-remapped
 * (`anonymous-function-lookahead.ts`'s `remapDslKeywordTokens` — undoes `brightscript-lexer.ts`'s
 * deliberate DSL-keyword exclusion so `state`/`store`/`focus`/... inside the body parse as DSL
 * syntax, not plain identifiers), and end with an `EndOfFile` sentinel, matching the convention
 * every other `TokenStreamParser` consumer's token array follows.
 */
class EmbeddedAnonymousFunctionParser extends TokenStreamParser {
  parsePublicAnonymousFunctionExpression(): SyntaxNode {
    return this.parseAnonymousFunctionExpression();
  }
}

export function parseAnonymousFunctionExpressionFromTokens(tokens: readonly Token[], diagnostics: ParseDiagnostic[]): SyntaxNode {
  return new EmbeddedAnonymousFunctionParser(tokens, diagnostics).parsePublicAnonymousFunctionExpression();
}

const VOID_NOT_A_TYPE_MSG =
  '"void" is not a valid type in this DSL. A function with no return value simply omits the ": <Type>" annotation — there is no "void" type for parameters, state, or derived declarations either.';
