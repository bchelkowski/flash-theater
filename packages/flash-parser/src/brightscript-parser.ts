/**
 * Full BrightScript recursive-descent parser — the Phase 0 grammar-ownership
 * counterpart to `brightscript-lexer.ts` (see that file's own doc comment,
 * and `findings/compiler-parser-architecture.md`'s "flash-parser: a real, fully
 * self-sufficient CST/AST for the whole language"). Vendored and adapted
 * from `kopytko-brightscript-parser`'s own hand-written parser
 * (`node_modules/kopytko-brightscript-parser/dist/src/parser.js`) — same
 * recursive-descent structure and precedence-climbing expression grammar,
 * error-tolerant (always returns a tree + a diagnostics list, never throws),
 * reconciled with flash-parser's own established names:
 *
 * - Every produced `SyntaxNode` uses the `Bs`-prefixed `SyntaxKind` (e.g.
 *   `BsIfStatement`, not `IfStatement` — the bare name is the DSL's own
 *   JS-shaped `if`, a structurally different construct).
 * - Punctuation token kinds use the DSL's existing short names (`LParen`,
 *   not `LeftParen`; `Equals`, not `Equal`; `Question`, not `QuestionMark`;
 *   `EndOfFile`, not `Eof`) — see `tokenKind.ts`'s own doc comment for the
 *   full reconciliation list.
 * - Diagnostics are returned in the same raw `{message, pos, end, line,
 *   column}` shape kopytko's own parser used (not flash-parser's own
 *   `ParseDiagnostic`, which additionally requires a `code`) — exactly
 *   mirroring how every existing embedded-parse call site in this package
 *   (`ternary.ts`, `template-classify.ts`) already wraps a raw diagnostic
 *   with a context-appropriate `code` (`expression/parse-error`,
 *   `statement/parse-error`, ...) at the call site, not inside the parser
 *   itself. This module makes the same choice for consistency, deferring
 *   `code` assignment to Phase 1's actual call-site integration.
 *
 * Genuinely new relative to the vendored source: `==`/`!=`/`<`/`>`/`<=`/`>=`
 * (`EqualsEquals`/`BangEquals`/`Less`/`Greater`/`LessEqual`/`GreaterEqual`)
 * are recognized at the same precedence tier as real BrightScript's `=`/`<>`
 * (`COMPARISON_OPS`), but produce a distinct `BsComparisonExpression` node
 * instead of `BsBinaryExpression` — the compiler's lowering (`ft_equals(left,
 * right)` / `Not ft_equals(left, right)` for `==`/`!=`, `ft_relationalGuard(
 * left, right, "<op>")` for the other four, GRAMMAR.md's "Comparison"
 * section) needs to find these specifically, not treat them as an ordinary
 * BrightScript binary operator it would otherwise pass through unmodified.
 * `=`/`<>` deliberately stay plain, unguarded `BsBinaryExpression` — there's
 * no DSL sugar spelling for them, unlike every other comparison/relational
 * operator, which is now guarded unconditionally. Likewise, bare `!` (`Bang`) is
 * recognized in `parseNotExpression` — the same precedence tier and
 * right-recursive shape as real BrightScript's own `Not` keyword — but
 * produces a distinct `BsSafeNotExpression` node instead of sharing
 * `BsUnaryExpression` with `Not`/unary `-`/`+`, for the same reason: the
 * compiler's lowering (`ft_not(<operand>)`, GRAMMAR.md's "Safe NOT" section)
 * needs to find it specifically, without risking a false-positive match on
 * real, deliberately-unguarded `Not`/unary `-`/`+` nodes.
 */
import { TokenKind } from './tokenKind.js';
import { SyntaxKind } from './syntaxKind.js';
import { SyntaxNode, SyntaxChild, isNode } from './syntaxNode.js';
import { Token } from './token.js';
import { tokenizeBrightScript, BrightScriptTokenizeOptions } from './brightscript-lexer.js';
import { findDslAnonymousFunctionHeaderBrace, remapDslKeywordTokens } from './anonymous-function-lookahead.js';
// Deliberate mutual-dependency edge with token-stream-parser.ts (which already imports
// embedded.ts, which already imports this file) — see that file's own doc comment on
// `parseAnonymousFunctionExpressionFromTokens` for why: a Tier-2 anonymous function's header is
// found here (BrightScript-grammar territory, an ordinary expression position), but its
// header+body is parsed by the DSL's own block grammar there. Safe under Node/TS ESM because
// every cross-reference is inside a function/method body (both modules only define
// `export function`/`export class` at top level), never evaluated at module-init time.
import { parseAnonymousFunctionExpressionFromTokens } from './token-stream-parser.js';
import type { ParseDiagnostic } from './diagnostics.js';

/** Raw parser diagnostic — see this file's own doc comment for why `code` isn't assigned here. */
export interface BrightScriptParseDiagnostic {
  readonly message: string;
  readonly pos: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface BrightScriptParseResult {
  readonly root: SyntaxNode;
  readonly diagnostics: readonly BrightScriptParseDiagnostic[];
  readonly tokens: readonly Token[];
}

/** Parses full BrightScript source into a lossless CST rooted at a `BsSourceFile` node. */
export function parseBrightScript(source: string, options: BrightScriptTokenizeOptions = {}): BrightScriptParseResult {
  const tokens = tokenizeBrightScript(source, options);
  const parser = new BrightScriptParser(tokens);
  const root = parser.parseSourceFile();
  return { root, diagnostics: parser.diagnostics, tokens };
}

const COMPOUND_ASSIGN_OPS: ReadonlySet<TokenKind> = new Set([
  TokenKind.PlusEqual,
  TokenKind.MinusEqual,
  TokenKind.StarEqual,
  TokenKind.SlashEqual,
  TokenKind.BackslashEqual,
  TokenKind.LeftShiftEqual,
  TokenKind.RightShiftEqual,
]);
/** Real, deliberately-unguarded BrightScript operators — `=`/`<>` produce a plain `BsBinaryExpression`, coexisting with guarded `==`/`!=` the same way real `<`/`>`/`<=`/`>=` used to coexist with `==`/`!=` before those four became crash-safe sugar too (see `COMPARISON_SUGAR_OPS`). */
const COMPARISON_OPS: ReadonlySet<TokenKind> = new Set([TokenKind.Equals, TokenKind.LessGreater]);
/** DSL-only crash-safe comparison/relational sugar — same precedence tier as `COMPARISON_OPS`, but produces a `BsComparisonExpression` (see this file's own doc comment). `==`/`!=` lower to `ft_equals(...)`; `<`/`>`/`<=`/`>=` lower to `ft_relationalGuard(...)` (GRAMMAR.md's "Comparison" section) — every relational comparison is guarded, unlike `==` which coexists with a still-raw `=`. */
const COMPARISON_SUGAR_OPS: ReadonlySet<TokenKind> = new Set([TokenKind.EqualsEquals, TokenKind.BangEquals, TokenKind.Less, TokenKind.Greater, TokenKind.LessEqual, TokenKind.GreaterEqual]);
const ADDITIVE_OPS: ReadonlySet<TokenKind> = new Set([TokenKind.Plus, TokenKind.Minus]);
const MULTIPLICATIVE_OPS: ReadonlySet<TokenKind> = new Set([TokenKind.Star, TokenKind.Slash, TokenKind.Backslash, TokenKind.Mod]);
const SHIFT_OPS: ReadonlySet<TokenKind> = new Set([TokenKind.LeftShift, TokenKind.RightShift]);
const OPTIONAL_CHAIN_OPS: ReadonlySet<TokenKind> = new Set([TokenKind.QuestionDot, TokenKind.QuestionBracket, TokenKind.QuestionParen, TokenKind.QuestionAt]);

/** Block-ending keywords that terminate a statement list. */
const BLOCK_ENDERS: ReadonlySet<TokenKind> = new Set([
  TokenKind.EndFunction,
  TokenKind.EndSub,
  TokenKind.EndIf,
  TokenKind.EndFor,
  TokenKind.EndWhile,
  TokenKind.EndTry,
  TokenKind.Else,
  TokenKind.ElseIf,
  TokenKind.Catch,
  TokenKind.Next,
  TokenKind.EndOfFile,
]);
function isBlockEnder(kind: TokenKind): boolean {
  return BLOCK_ENDERS.has(kind);
}

const CALLABLE_KEYWORDS: ReadonlySet<TokenKind> = new Set([
  TokenKind.CreateObject,
  TokenKind.Type,
  TokenKind.GetGlobalAA,
  TokenKind.Box,
  TokenKind.Eval,
  TokenKind.Run,
  TokenKind.Tab,
  TokenKind.Pos,
  TokenKind.GetLastRunCompileError,
  TokenKind.GetLastRunRunTimeError,
  TokenKind.ObjFun,
  TokenKind.Let,
]);

interface DelimitedListOptions {
  openLine?: number;
  multilineErrorMessage?: string;
  missingCloseMessage?: string;
}

class BrightScriptParser {
  private readonly tokens: readonly Token[];
  private current = 0;
  readonly diagnostics: BrightScriptParseDiagnostic[] = [];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  // ── Token access ────────────────────────────────────────────────────────
  private peek(): Token {
    return this.tokens[this.current];
  }
  private peekKind(): TokenKind {
    return this.peek().kind;
  }
  private peekAt(offset: number): Token {
    const idx = this.current + offset;
    return idx < this.tokens.length ? this.tokens[idx] : this.tokens[this.tokens.length - 1];
  }
  private isAtEnd(): boolean {
    return this.peekKind() === TokenKind.EndOfFile;
  }
  private advance(): Token {
    const tok = this.peek();
    if (!this.isAtEnd()) this.current++;
    return tok;
  }
  /** Advance and re-classify the consumed token as TypeName, preserving all other fields. */
  private advanceAsTypeName(): Token {
    const tok = this.advance();
    return { ...tok, kind: TokenKind.TypeName };
  }
  private check(kind: TokenKind): boolean {
    return this.peekKind() === kind;
  }
  private match(...kinds: TokenKind[]): boolean {
    return kinds.some((k) => this.check(k));
  }
  private expect(kind: TokenKind, message?: string): Token {
    if (this.check(kind)) return this.advance();
    const tok = this.peek();
    this.error(message ?? `Expected ${kind} but found ${tok.kind}`, tok);
    return this.makeMissingToken(kind, tok);
  }
  private makeMissingToken(kind: TokenKind, at: Token): Token {
    return {
      kind,
      text: '',
      pos: at.pos,
      end: at.pos,
      line: at.line,
      column: at.column,
      leadingTrivia: [],
      trailingTrivia: [],
      isMissing: true,
    };
  }
  private consume(kind: TokenKind): Token | null {
    if (this.check(kind)) return this.advance();
    return null;
  }
  private error(message: string, token: Token): void {
    this.diagnostics.push({ message, pos: token.pos, end: token.end, line: token.line, column: token.column });
  }

  /** True if the current token is on a different line than the previous one. */
  private isAfterNewline(): boolean {
    if (this.current === 0) return false;
    const prev = this.tokens[this.current - 1];
    const curr = this.peek();
    return curr.leadingTrivia.some((t) => t.kind === 'LineBreak') || curr.line > prev.line;
  }
  /** True if the current token is on the same line as the previous one. */
  private isOnSameLine(): boolean {
    if (this.current === 0) return true;
    const prev = this.tokens[this.current - 1];
    return this.peek().line === prev.line && !this.peek().leadingTrivia.some((t) => t.kind === 'LineBreak');
  }
  private consumeTerminator(): Token | null {
    if (this.check(TokenKind.Colon)) return this.advance();
    return null;
  }

  // ── Top-level ──────────────────────────────────────────────────────────
  parseSourceFile(): SyntaxNode {
    const children: SyntaxChild[] = [];
    while (!this.isAtEnd()) {
      const beforePos = this.current;
      const stmt = this.parseStatement();
      if (stmt) children.push(stmt);
      const term = this.consumeTerminator();
      if (term) children.push(term);
      if (this.current === beforePos) {
        if (!this.isAtEnd()) {
          children.push(this.recoverToErrorNode());
        } else {
          break;
        }
      }
    }
    if (this.check(TokenKind.EndOfFile)) children.push(this.advance());
    return new SyntaxNode(SyntaxKind.BsSourceFile, children);
  }

  // ── Statement dispatch ─────────────────────────────────────────────────
  private parseStatement(): SyntaxNode | undefined {
    const kind = this.peekKind();

    if (kind === TokenKind.Function || kind === TokenKind.Sub) return this.parseFunctionOrExpressionStatement();
    if (kind === TokenKind.If) return this.parseIfStatement();
    if (kind === TokenKind.For) return this.parseForStatement();
    if (kind === TokenKind.While) return this.parseWhileStatement();
    if (kind === TokenKind.Try) return this.parseTryStatement();
    if (kind === TokenKind.Return) return this.parseReturnStatement();
    if (kind === TokenKind.Throw) return this.parseThrowStatement();
    if (kind === TokenKind.Goto) return this.parseGotoStatement();
    if (kind === TokenKind.Exit) return this.parseExitStatement();
    if (kind === TokenKind.ExitWhile) return new SyntaxNode(SyntaxKind.BsExitWhileStatement, [this.advance()]);
    if (kind === TokenKind.Continue) return this.parseContinueStatement();
    if (kind === TokenKind.Print || kind === TokenKind.Question) return this.parsePrintStatement();
    if (kind === TokenKind.Dim) return this.parseDimStatement();
    if (kind === TokenKind.Stop) return new SyntaxNode(SyntaxKind.BsStopStatement, [this.advance()]);
    if (kind === TokenKind.End) return new SyntaxNode(SyntaxKind.BsEndStatement, [this.advance()]);
    if (kind === TokenKind.HashIf) return this.parseConditionalCompilation();
    if (kind === TokenKind.HashConst) return this.parseHashConst();
    if (kind === TokenKind.HashError) return new SyntaxNode(SyntaxKind.BsHashErrorStatement, [this.advance()]);
    if (kind === TokenKind.EndOfFile) return undefined;

    return this.parseAssignmentOrExpressionStatement();
  }

  // ── Function / Sub declaration ─────────────────────────────────────────
  private parseFunctionOrExpressionStatement(): SyntaxNode {
    if (this.peekAt(1).kind === TokenKind.Identifier) return this.parseFunctionDeclaration();
    return this.parseExpressionStatement();
  }

  private parseFunctionDeclaration(): SyntaxNode {
    const children: SyntaxChild[] = [];
    children.push(this.advance()); // function | sub
    children.push(this.expect(TokenKind.Identifier, 'Expected function name'));
    children.push(this.parseParameterList());
    if (this.check(TokenKind.As)) children.push(this.parseReturnTypeClause());
    this.parseBodyStatements(children);
    if (this.match(TokenKind.EndFunction, TokenKind.EndSub)) {
      children.push(this.advance());
    } else {
      this.error('Expected "end function" or "end sub"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsFunctionDeclaration, children);
  }

  /**
   * Tier-2 dispatch: `this.current` is a confirmed DSL-shaped anonymous function header
   * (`findDslAnonymousFunctionHeaderBrace` already found `headerBraceIndex`, its opening `{`).
   * Delegates the whole `function ... }` span to `token-stream-parser.ts`'s own block grammar
   * (`parseAnonymousFunctionExpressionFromTokens`) instead of this file's own
   * `parseFunctionExpression` (real BrightScript's `end function`/`end sub`-terminated syntax,
   * structurally unrelated) — see GRAMMAR.md's "Anonymous function expressions" section.
   */
  private parseDslAnonymousFunctionExpression(headerBraceIndex: number): SyntaxNode {
    const functionIndex = this.current;
    const rbraceIndex = this.findMatchingBraceIndex(headerBraceIndex);
    if (rbraceIndex === -1) {
      this.error('No closing "}" found for anonymous function.', this.tokens[functionIndex]);
      return this.recoverToErrorNode();
    }

    const spanTokens = this.tokens.slice(functionIndex, rbraceIndex + 1);
    const remapped = remapDslKeywordTokens(spanTokens);
    const lastToken = remapped[remapped.length - 1];
    const eofToken: Token = {
      kind: TokenKind.EndOfFile,
      text: '',
      pos: lastToken.end,
      end: lastToken.end,
      line: lastToken.line,
      column: lastToken.column + (lastToken.end - lastToken.pos),
      leadingTrivia: [],
      trailingTrivia: [],
    };

    const dslDiagnostics: ParseDiagnostic[] = [];
    const node = parseAnonymousFunctionExpressionFromTokens([...remapped, eofToken], dslDiagnostics);
    for (const d of dslDiagnostics) {
      this.diagnostics.push({ message: d.message, pos: d.pos, end: d.end, line: d.line, column: 0 });
    }

    this.current = rbraceIndex + 1;
    return node;
  }

  /** Brace-depth-matching from a known `{` index (`openIndex`) over `this.tokens` — same style as `token-stream-parser.ts`'s own `findMatchingBrace`, reimplemented locally since this class doesn't extend `TokenStreamParser`. */
  private findMatchingBraceIndex(openIndex: number): number {
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

  private parseFunctionExpression(): SyntaxNode {
    const children: SyntaxChild[] = [];
    children.push(this.advance()); // function | sub
    children.push(this.parseParameterList());
    if (this.check(TokenKind.As)) children.push(this.parseReturnTypeClause());
    this.parseBodyStatements(children);
    if (this.match(TokenKind.EndFunction, TokenKind.EndSub)) {
      children.push(this.advance());
    } else {
      this.error('Expected "end function" or "end sub"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsFunctionExpression, children);
  }

  private parseParameterList(): SyntaxNode {
    const children: SyntaxChild[] = [];
    const openParen = this.expect(TokenKind.LParen, 'Expected "("');
    children.push(openParen);
    const openLine = openParen.line;

    if (!this.check(TokenKind.RParen) && !this.isAtEnd()) {
      children.push(this.parseParameter());
      while (this.check(TokenKind.Comma)) {
        children.push(this.advance());
        children.push(this.parseParameter());
      }
    }

    if (this.check(TokenKind.RParen)) {
      const closeParen = this.advance();
      children.push(closeParen);
      if (closeParen.line !== openLine) {
        const hasMultiLineDefault = children.some((c) => isNode(c) && c.kind === SyntaxKind.BsParameter && containsMultiLineConstruct(c));
        if (!hasMultiLineDefault) this.error('Function parameters must be on one line', closeParen);
      }
    } else {
      this.error('Expected ")"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsParameterList, children);
  }

  private parseParameter(): SyntaxNode {
    const children: SyntaxChild[] = [];
    children.push(this.expect(TokenKind.Identifier, 'Expected parameter name'));
    if (this.check(TokenKind.Equals)) {
      children.push(this.advance());
      children.push(this.parseExpression());
    }
    if (this.check(TokenKind.As)) {
      children.push(this.advance());
      children.push(this.advanceAsTypeName());
    }
    return new SyntaxNode(SyntaxKind.BsParameter, children);
  }

  private parseReturnTypeClause(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance(), this.advanceAsTypeName()];
    return new SyntaxNode(SyntaxKind.BsReturnTypeClause, children);
  }

  /** Parses body statements until a block-ending keyword is found. */
  private parseBodyStatements(into: SyntaxChild[]): void {
    while (this.check(TokenKind.Colon) && !this.isAtEnd()) into.push(this.advance());
    while (!this.isAtEnd() && !isBlockEnder(this.peekKind())) {
      const beforePos = this.current;
      const stmt = this.parseStatement();
      if (stmt) into.push(stmt);
      while (this.check(TokenKind.Colon) && !this.isAtEnd()) into.push(this.advance());
      if (this.current === beforePos) {
        if (!this.isAtEnd() && !isBlockEnder(this.peekKind())) {
          into.push(this.recoverToErrorNode());
        } else {
          break;
        }
      }
    }
  }

  // ── If / Else If / Else ────────────────────────────────────────────────
  private parseIfStatement(): SyntaxNode {
    const children: SyntaxChild[] = [];
    children.push(this.advance()); // if
    children.push(this.parseExpression());
    const thenToken = this.consume(TokenKind.Then);
    if (thenToken) children.push(thenToken);

    if (this.isSingleLineIf()) {
      this.parseSingleLineIfBody(children);
    } else {
      this.parseBodyStatements(children);
      while (this.check(TokenKind.ElseIf)) children.push(this.parseElseIfClause());
      if (this.check(TokenKind.Else)) children.push(this.parseElseClause());
      if (this.match(TokenKind.EndIf)) {
        children.push(this.advance());
      } else {
        this.error('Expected "end if"', this.peek());
      }
    }
    return new SyntaxNode(SyntaxKind.BsIfStatement, children);
  }

  private isSingleLineIf(): boolean {
    if (this.isAtEnd()) return false;
    if (this.check(TokenKind.Colon)) return false;
    return !this.isAfterNewline();
  }

  private parseSingleLineIfBody(children: SyntaxChild[]): void {
    const stmt = this.parseStatement();
    if (stmt) children.push(stmt);

    while (this.check(TokenKind.Colon)) {
      const next = this.peekAt(1).kind;
      if (next === TokenKind.Else || next === TokenKind.ElseIf) break;
      if (isBlockEnder(next)) break;
      children.push(this.advance());
      const s = this.parseStatement();
      if (s) children.push(s);
    }

    if (this.check(TokenKind.Colon) && this.peekAt(1).kind === TokenKind.Else) {
      children.push(this.advance());
    }
    if (this.check(TokenKind.Else)) {
      const elseChildren: SyntaxChild[] = [this.advance()];
      const elseStmt = this.parseStatement();
      if (elseStmt) elseChildren.push(elseStmt);
      children.push(new SyntaxNode(SyntaxKind.BsElseClause, elseChildren));
    }
  }

  private parseElseIfClause(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // elseif / else if
    children.push(this.parseExpression());
    const thenToken = this.consume(TokenKind.Then);
    if (thenToken) children.push(thenToken);
    this.parseBodyStatements(children);
    return new SyntaxNode(SyntaxKind.BsElseIfClause, children);
  }

  private parseElseClause(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // else
    this.parseBodyStatements(children);
    return new SyntaxNode(SyntaxKind.BsElseClause, children);
  }

  // ── For / For Each ──────────────────────────────────────────────────────
  private parseForStatement(): SyntaxNode {
    if (this.peekAt(1).kind === TokenKind.Each) return this.parseForEachStatement();

    const children: SyntaxChild[] = [this.advance()]; // for
    children.push(this.expect(TokenKind.Identifier, 'Expected loop variable'));
    if (this.check(TokenKind.Equals)) children.push(this.advance());
    children.push(this.parseExpression());
    if (this.check(TokenKind.To)) {
      children.push(this.advance());
    } else {
      this.error('Expected "to"', this.peek());
    }
    children.push(this.parseExpression());
    if (this.check(TokenKind.Step)) {
      children.push(this.advance());
      children.push(this.parseExpression());
    }
    this.parseBodyStatements(children);
    if (this.match(TokenKind.EndFor, TokenKind.Next)) {
      children.push(this.advance());
    } else {
      this.error('Expected "end for", "endfor", or "next"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsForStatement, children);
  }

  private parseForEachStatement(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance(), this.advance()]; // for, each
    children.push(this.expect(TokenKind.Identifier, 'Expected iterator variable'));
    if (this.check(TokenKind.In)) {
      children.push(this.advance());
    } else {
      this.error('Expected "in"', this.peek());
    }
    children.push(this.parseExpression());
    this.parseBodyStatements(children);
    if (this.match(TokenKind.EndFor, TokenKind.Next)) {
      children.push(this.advance());
    } else {
      this.error('Expected "end for", "endfor", or "next"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsForEachStatement, children);
  }

  // ── While ────────────────────────────────────────────────────────────────
  private parseWhileStatement(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // while
    children.push(this.parseExpression());
    this.parseBodyStatements(children);
    if (this.match(TokenKind.EndWhile)) {
      children.push(this.advance());
    } else {
      this.error('Expected "end while"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsWhileStatement, children);
  }

  // ── Try / Catch ──────────────────────────────────────────────────────────
  private parseTryStatement(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // try
    this.parseBodyStatements(children);
    if (this.check(TokenKind.Catch)) {
      children.push(this.parseCatchClause());
    } else {
      this.error('Expected "catch"', this.peek());
    }
    if (this.match(TokenKind.EndTry)) {
      children.push(this.advance());
    } else {
      this.error('Expected "end try"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsTryStatement, children);
  }

  private parseCatchClause(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // catch
    if (this.check(TokenKind.LParen)) {
      children.push(this.advance());
      children.push(this.expect(TokenKind.Identifier, 'Expected exception variable name'));
      if (this.check(TokenKind.RParen)) {
        children.push(this.advance());
      } else {
        this.error('Expected ")"', this.peek());
      }
    } else {
      children.push(this.expect(TokenKind.Identifier, 'Expected exception variable name'));
    }
    this.parseBodyStatements(children);
    return new SyntaxNode(SyntaxKind.BsCatchClause, children);
  }

  // ── Simple statements ───────────────────────────────────────────────────
  private parseReturnStatement(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // return
    if (!this.isAtEnd() && !isBlockEnder(this.peekKind()) && this.isOnSameLine()) {
      children.push(this.parseExpression());
    }
    return new SyntaxNode(SyntaxKind.BsReturnStatement, children);
  }

  private parsePrintStatement(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // print | ?
    while (!this.isAtEnd() && !isBlockEnder(this.peekKind()) && this.isOnSameLine()) {
      children.push(this.parseExpression());
      if (this.match(TokenKind.Semicolon, TokenKind.Comma)) children.push(this.advance());
    }
    return new SyntaxNode(SyntaxKind.BsPrintStatement, children);
  }

  private parseThrowStatement(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // throw
    if (!this.isAtEnd() && this.isOnSameLine()) children.push(this.parseExpression());
    return new SyntaxNode(SyntaxKind.BsThrowStatement, children);
  }

  private parseDimStatement(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // dim
    children.push(this.expect(TokenKind.Identifier, 'Expected variable name'));
    if (this.check(TokenKind.LBracket)) {
      children.push(this.advance());
      if (!this.check(TokenKind.RBracket)) {
        children.push(this.parseExpression());
        while (this.check(TokenKind.Comma)) {
          children.push(this.advance());
          children.push(this.parseExpression());
        }
      }
      if (this.check(TokenKind.RBracket)) children.push(this.advance());
    }
    return new SyntaxNode(SyntaxKind.BsDimStatement, children);
  }

  private parseGotoStatement(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // goto
    children.push(this.expect(TokenKind.Identifier, 'Expected label name'));
    return new SyntaxNode(SyntaxKind.BsGotoStatement, children);
  }

  private parseExitStatement(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // exit
    if (this.check(TokenKind.For)) {
      children.push(this.advance());
      return new SyntaxNode(SyntaxKind.BsExitForStatement, children);
    }
    if (this.check(TokenKind.While)) {
      children.push(this.advance());
      return new SyntaxNode(SyntaxKind.BsExitWhileStatement, children);
    }
    this.error('Expected "for" or "while" after "exit"', this.peek());
    return new SyntaxNode(SyntaxKind.BsExitForStatement, children);
  }

  private parseContinueStatement(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // continue
    if (this.check(TokenKind.For)) {
      children.push(this.advance());
      return new SyntaxNode(SyntaxKind.BsContinueForStatement, children);
    }
    if (this.check(TokenKind.While)) {
      children.push(this.advance());
      return new SyntaxNode(SyntaxKind.BsContinueWhileStatement, children);
    }
    this.error('Expected "for" or "while" after "continue"', this.peek());
    return new SyntaxNode(SyntaxKind.BsContinueForStatement, children);
  }

  // ── Conditional compilation ──────────────────────────────────────────────
  private parseConditionalCompilation(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // #if
    children.push(this.parseExpression());
    this.parseConditionalBody(children);
    while (this.check(TokenKind.HashElseIf)) {
      children.push(this.advance());
      children.push(this.parseExpression());
      this.parseConditionalBody(children);
    }
    if (this.check(TokenKind.HashElse)) {
      children.push(this.advance());
      this.parseConditionalBody(children);
    }
    if (this.check(TokenKind.HashEndIf)) {
      children.push(this.advance());
    } else {
      this.error('Expected "#end if"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsConditionalCompilation, children);
  }

  private parseConditionalBody(into: SyntaxChild[]): void {
    while (!this.isAtEnd() && !this.match(TokenKind.HashElseIf, TokenKind.HashElse, TokenKind.HashEndIf)) {
      const beforePos = this.current;
      const stmt = this.parseStatement();
      if (stmt) into.push(stmt);
      const term = this.consumeTerminator();
      if (term) into.push(term);
      if (this.current === beforePos) {
        if (!this.isAtEnd() && !this.match(TokenKind.HashElseIf, TokenKind.HashElse, TokenKind.HashEndIf)) {
          into.push(this.recoverToErrorNode((k) => k === TokenKind.HashElseIf || k === TokenKind.HashElse || k === TokenKind.HashEndIf));
        } else {
          break;
        }
      }
    }
  }

  private parseHashConst(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // #const
    children.push(this.expect(TokenKind.Identifier, 'Expected constant name'));
    if (this.check(TokenKind.Equals)) {
      children.push(this.advance());
      children.push(this.parseExpression());
    }
    return new SyntaxNode(SyntaxKind.BsHashConstStatement, children);
  }

  // ── Assignment or expression statement ──────────────────────────────────
  private parseAssignmentOrExpressionStatement(): SyntaxNode {
    const label = this.parseLabelStatementIfPresent();
    if (label) return label;

    const lhsNode = this.parseAssignmentLeftHandSide();
    const assignment = this.parseAssignmentStatementIfPresent(lhsNode);
    if (assignment) return assignment;

    const increment = this.parseIncrementExpressionStatementIfPresent(lhsNode);
    if (increment) return increment;

    return this.parseExpressionStatementFromParsedLeft(lhsNode);
  }

  private parseLabelStatementIfPresent(): SyntaxNode | undefined {
    if (this.check(TokenKind.Identifier) && this.peekAt(1).kind === TokenKind.Colon) {
      const afterColon = this.peekAt(2);
      if (afterColon.kind === TokenKind.EndOfFile || afterColon.line > this.peekAt(1).line) {
        const children: SyntaxChild[] = [this.advance(), this.advance()]; // name, :
        return new SyntaxNode(SyntaxKind.BsLabelStatement, children);
      }
    }
    return undefined;
  }

  /** Parses the LHS as a postfix expression only (not a full expression) — avoids consuming `=` as a comparison operator. */
  private parseAssignmentLeftHandSide(): SyntaxNode {
    return this.parsePostfixExpression();
  }

  private parseAssignmentStatementIfPresent(lhsNode: SyntaxNode): SyntaxNode | undefined {
    if (this.isAssignmentOperator(this.peekKind())) {
      const children: SyntaxChild[] = [lhsNode, this.advance(), this.parseExpression()];
      return new SyntaxNode(SyntaxKind.BsAssignmentStatement, children);
    }
    return undefined;
  }

  private isAssignmentOperator(kind: TokenKind): boolean {
    return kind === TokenKind.Equals || COMPOUND_ASSIGN_OPS.has(kind);
  }

  private parseIncrementExpressionStatementIfPresent(lhsNode: SyntaxNode): SyntaxNode | undefined {
    if (this.match(TokenKind.PlusPlus, TokenKind.MinusMinus)) {
      return new SyntaxNode(SyntaxKind.BsExpressionStatement, [lhsNode, this.advance()]);
    }
    return undefined;
  }

  private parseExpressionStatementFromParsedLeft(lhsNode: SyntaxNode): SyntaxNode {
    let expr = lhsNode;
    if (this.shouldContinueExpressionOnSameLine()) {
      expr = this.continueAsBinaryExpression(expr);
    }
    return new SyntaxNode(SyntaxKind.BsExpressionStatement, [expr]);
  }

  private shouldContinueExpressionOnSameLine(): boolean {
    return !this.isAtEnd() && this.isOnSameLine() && !this.check(TokenKind.Colon) && !isBlockEnder(this.peekKind());
  }

  /**
   * Continues parsing binary operators after a left-hand side has already
   * been parsed as a postfix expression — re-enters the real precedence
   * chain one level at a time, seeded with `left`, rather than folding
   * remaining operators at equal precedence (which would build the wrong
   * tree for e.g. `a + b * c`).
   */
  private continueAsBinaryExpression(left: SyntaxNode): SyntaxNode {
    left = this.continueExponentiation(left);
    left = this.continueMultiplicative(left);
    left = this.continueAdditive(left);
    left = this.continueShift(left);
    left = this.continueComparison(left);
    left = this.continueAnd(left);
    left = this.continueOr(left);
    return left;
  }

  private continueExponentiation(left: SyntaxNode): SyntaxNode {
    if (this.check(TokenKind.Caret)) {
      const op = this.advance();
      const right = this.parseExponentiationExpression();
      return new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, right]);
    }
    return left;
  }
  private continueMultiplicative(left: SyntaxNode): SyntaxNode {
    while (MULTIPLICATIVE_OPS.has(this.peekKind())) {
      const op = this.advance();
      left = new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, this.parseUnaryExpression()]);
    }
    return left;
  }
  private continueAdditive(left: SyntaxNode): SyntaxNode {
    while (ADDITIVE_OPS.has(this.peekKind())) {
      const op = this.advance();
      left = new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, this.parseMultiplicativeExpression()]);
    }
    return left;
  }
  private continueShift(left: SyntaxNode): SyntaxNode {
    while (SHIFT_OPS.has(this.peekKind())) {
      const op = this.advance();
      left = new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, this.parseAdditiveExpression()]);
    }
    return left;
  }
  private continueComparison(left: SyntaxNode): SyntaxNode {
    while (COMPARISON_OPS.has(this.peekKind()) || COMPARISON_SUGAR_OPS.has(this.peekKind())) {
      const isSugar = COMPARISON_SUGAR_OPS.has(this.peekKind());
      const op = this.advance();
      const right = this.parseShiftExpression();
      left = new SyntaxNode(isSugar ? SyntaxKind.BsComparisonExpression : SyntaxKind.BsBinaryExpression, [left, op, right]);
    }
    return left;
  }
  private continueAnd(left: SyntaxNode): SyntaxNode {
    while (this.check(TokenKind.And)) {
      const op = this.advance();
      left = new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, this.parseNotExpression()]);
    }
    return left;
  }
  private continueOr(left: SyntaxNode): SyntaxNode {
    while (this.check(TokenKind.Or)) {
      const op = this.advance();
      left = new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, this.parseAndExpression()]);
    }
    return left;
  }

  private parseExpressionStatement(): SyntaxNode {
    return new SyntaxNode(SyntaxKind.BsExpressionStatement, [this.parseExpression()]);
  }

  // ── Expression parsing (precedence climbing) ────────────────────────────
  /**
   * Expression precedence (lowest to highest, from Roku docs):
   *  1. OR
   *  2. AND
   *  3. NOT (unary), and DSL-only ! at the same tier
   *  4. Comparisons: < > = <> <= >=, and DSL-only == != at the same tier
   *  5. Bitshift: << >>
   *  6. Additive: + -
   *  7. Multiplicative: * / \ MOD
   *  8. Unary: - +
   *  9. Exponentiation: ^ (right-associative)
   * 10. Postfix: . [] () ?. ?[ ?( ?@ ++ --
   * 11. Primary: literals, identifiers, grouping, array/AA literals, function expr
   */
  parseExpression(): SyntaxNode {
    return this.parseOrExpression();
  }

  private parseOrExpression(): SyntaxNode {
    let left = this.parseAndExpression();
    while (this.check(TokenKind.Or)) {
      const op = this.advance();
      left = new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, this.parseAndExpression()]);
    }
    return left;
  }
  private parseAndExpression(): SyntaxNode {
    let left = this.parseNotExpression();
    while (this.check(TokenKind.And)) {
      const op = this.advance();
      left = new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, this.parseNotExpression()]);
    }
    return left;
  }
  private parseNotExpression(): SyntaxNode {
    if (this.check(TokenKind.Not)) {
      const op = this.advance();
      return new SyntaxNode(SyntaxKind.BsUnaryExpression, [op, this.parseNotExpression()]);
    }
    if (this.check(TokenKind.Bang)) {
      const op = this.advance();
      return new SyntaxNode(SyntaxKind.BsSafeNotExpression, [op, this.parseNotExpression()]);
    }
    return this.parseComparisonExpression();
  }
  private parseComparisonExpression(): SyntaxNode {
    let left = this.parseShiftExpression();
    while (COMPARISON_OPS.has(this.peekKind()) || COMPARISON_SUGAR_OPS.has(this.peekKind())) {
      const isSugar = COMPARISON_SUGAR_OPS.has(this.peekKind());
      const op = this.advance();
      const right = this.parseShiftExpression();
      left = new SyntaxNode(isSugar ? SyntaxKind.BsComparisonExpression : SyntaxKind.BsBinaryExpression, [left, op, right]);
    }
    return left;
  }
  private parseShiftExpression(): SyntaxNode {
    let left = this.parseAdditiveExpression();
    while (SHIFT_OPS.has(this.peekKind())) {
      const op = this.advance();
      left = new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, this.parseAdditiveExpression()]);
    }
    return left;
  }
  private parseAdditiveExpression(): SyntaxNode {
    let left = this.parseMultiplicativeExpression();
    while (ADDITIVE_OPS.has(this.peekKind())) {
      const op = this.advance();
      left = new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, this.parseMultiplicativeExpression()]);
    }
    return left;
  }
  private parseMultiplicativeExpression(): SyntaxNode {
    let left = this.parseUnaryExpression();
    while (MULTIPLICATIVE_OPS.has(this.peekKind())) {
      const op = this.advance();
      left = new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, this.parseUnaryExpression()]);
    }
    return left;
  }
  private parseUnaryExpression(): SyntaxNode {
    if (this.match(TokenKind.Minus, TokenKind.Plus)) {
      const op = this.advance();
      return new SyntaxNode(SyntaxKind.BsUnaryExpression, [op, this.parseUnaryExpression()]);
    }
    return this.parseExponentiationExpression();
  }
  private parseExponentiationExpression(): SyntaxNode {
    const left = this.parsePostfixExpression();
    if (this.check(TokenKind.Caret)) {
      const op = this.advance();
      const right = this.parseExponentiationExpression(); // right-associative
      return new SyntaxNode(SyntaxKind.BsBinaryExpression, [left, op, right]);
    }
    return left;
  }

  // ── Postfix expressions ──────────────────────────────────────────────────
  private parsePostfixExpression(): SyntaxNode {
    let expr = this.parsePrimaryExpression();
    while (true) {
      if (this.check(TokenKind.Dot)) {
        const dot = this.advance();
        const member = this.advance(); // identifier or keyword (interface names)
        expr = new SyntaxNode(SyntaxKind.BsDotExpression, [expr, dot, member]);
      } else if (this.check(TokenKind.LBracket)) {
        const children: SyntaxChild[] = [expr, this.advance()];
        if (!this.check(TokenKind.RBracket)) {
          children.push(this.parseExpression());
          while (this.check(TokenKind.Comma)) {
            children.push(this.advance());
            children.push(this.parseExpression());
          }
        }
        if (this.check(TokenKind.RBracket)) children.push(this.advance());
        expr = new SyntaxNode(SyntaxKind.BsIndexExpression, children);
      } else if (this.check(TokenKind.LParen)) {
        expr = this.parseCallExpression(expr);
      } else if (this.check(TokenKind.At)) {
        const at = this.advance();
        const attr = this.advance();
        expr = new SyntaxNode(SyntaxKind.BsDotExpression, [expr, at, attr]);
      } else if (OPTIONAL_CHAIN_OPS.has(this.peekKind())) {
        expr = this.parseOptionalChaining(expr);
      } else {
        break;
      }
    }
    return expr;
  }

  private parseCallExpression(callee: SyntaxNode): SyntaxNode {
    return new SyntaxNode(SyntaxKind.BsCallExpression, [callee, this.parseArgumentList()]);
  }

  private parseArgumentList(): SyntaxNode {
    const openParen = this.advance(); // (
    const children: SyntaxChild[] = [openParen];
    this.parseDelimitedExpressionList(children, TokenKind.RParen, {
      openLine: openParen.line,
      multilineErrorMessage: 'Function call arguments must be on one line',
      missingCloseMessage: 'Expected ")"',
    });
    return new SyntaxNode(SyntaxKind.BsArgumentList, children);
  }

  private parseOptionalChaining(left: SyntaxNode): SyntaxNode {
    const children: SyntaxChild[] = [left];
    const op = this.advance(); // ?. ?[ ?( ?@
    children.push(op);
    if (op.kind === TokenKind.QuestionDot || op.kind === TokenKind.QuestionAt) {
      children.push(this.advance()); // member/attr name
    } else if (op.kind === TokenKind.QuestionBracket) {
      children.push(this.parseExpression());
      if (this.check(TokenKind.RBracket)) children.push(this.advance());
    } else if (op.kind === TokenKind.QuestionParen) {
      this.parseDelimitedExpressionList(children, TokenKind.RParen, { openLine: op.line, multilineErrorMessage: 'Function call arguments must be on one line' });
    }
    return new SyntaxNode(SyntaxKind.BsOptionalChainingExpression, children);
  }

  private parseDelimitedExpressionList(children: SyntaxChild[], closeKind: TokenKind, options: DelimitedListOptions = {}): void {
    if (!this.check(closeKind) && !this.isAtEnd()) {
      children.push(this.parseExpression());
      while (this.check(TokenKind.Comma)) {
        children.push(this.advance());
        children.push(this.parseExpression());
      }
    }
    if (this.check(closeKind)) {
      const closeToken = this.advance();
      children.push(closeToken);
      if (options.openLine !== undefined && options.multilineErrorMessage && closeToken.line !== options.openLine) {
        const hasMultiLine = children.some((c) => isNode(c) && containsMultiLineConstruct(c));
        if (!hasMultiLine) this.error(options.multilineErrorMessage, closeToken);
      }
    } else if (options.missingCloseMessage) {
      this.error(options.missingCloseMessage, this.peek());
    }
  }

  // ── Primary expressions ───────────────────────────────────────────────────
  private parsePrimaryExpression(): SyntaxNode {
    const kind = this.peekKind();

    if (kind === TokenKind.LParen) return this.parseGroupingExpression();
    if (kind === TokenKind.LBracket) return this.parseArrayLiteral();
    if (kind === TokenKind.LBrace) return this.parseAALiteral();

    if (kind === TokenKind.Function) {
      const headerBraceIndex = findDslAnonymousFunctionHeaderBrace(this.tokens, this.current);
      if (headerBraceIndex !== -1) return this.parseDslAnonymousFunctionExpression(headerBraceIndex);
    }

    if (kind === TokenKind.Function || kind === TokenKind.Sub) {
      if (this.peekAt(1).kind === TokenKind.LParen) return this.parseFunctionExpression();
    }

    if (kind === TokenKind.IntegerLiteral || kind === TokenKind.LongIntegerLiteral || kind === TokenKind.FloatLiteral || kind === TokenKind.DoubleLiteral || kind === TokenKind.StringLiteral) {
      return new SyntaxNode(SyntaxKind.BsLiteralExpression, [this.advance()]);
    }
    if (kind === TokenKind.True || kind === TokenKind.False || kind === TokenKind.Invalid) {
      return new SyntaxNode(SyntaxKind.BsLiteralExpression, [this.advance()]);
    }
    if (kind === TokenKind.LineNum) {
      return new SyntaxNode(SyntaxKind.BsLiteralExpression, [this.advance()]);
    }
    if (kind === TokenKind.Identifier) {
      return new SyntaxNode(SyntaxKind.BsIdentifierExpression, [this.advance()]);
    }
    if (CALLABLE_KEYWORDS.has(kind)) {
      return new SyntaxNode(SyntaxKind.BsIdentifierExpression, [this.advance()]);
    }

    const tok = this.advance();
    this.error(`Unexpected token "${tok.text}"`, tok);
    return new SyntaxNode(SyntaxKind.ErrorNode, [tok]);
  }

  private parseGroupingExpression(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance(), this.parseExpression()]; // (
    if (this.check(TokenKind.RParen)) {
      children.push(this.advance());
    } else {
      this.error('Expected ")"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsGroupingExpression, children);
  }

  private parseArrayLiteral(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // [
    while (!this.check(TokenKind.RBracket) && !this.isAtEnd()) {
      children.push(this.parseExpression());
      if (this.check(TokenKind.Comma)) children.push(this.advance());
    }
    if (this.check(TokenKind.RBracket)) {
      children.push(this.advance());
    } else {
      this.error('Expected "]"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsArrayLiteral, children);
  }

  private parseAALiteral(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // {
    while (!this.check(TokenKind.RBrace) && !this.isAtEnd()) {
      children.push(this.parseAAField());
      if (this.check(TokenKind.Comma)) children.push(this.advance());
    }
    if (this.check(TokenKind.RBrace)) {
      children.push(this.advance());
    } else {
      this.error('Expected "}"', this.peek());
    }
    return new SyntaxNode(SyntaxKind.BsAALiteral, children);
  }

  private parseAAField(): SyntaxNode {
    const children: SyntaxChild[] = [this.advance()]; // key: string literal, identifier, or keyword
    if (this.check(TokenKind.Colon)) {
      children.push(this.advance());
    } else {
      this.error('Expected ":" after field name', this.peek());
    }
    children.push(this.parseExpression());
    return new SyntaxNode(SyntaxKind.BsAAField, children);
  }

  // ── Error recovery ─────────────────────────────────────────────────────
  /**
   * Panic-mode resync: consumes tokens into a single ErrorNode until a safe
   * resumption point — start of a new line, a block-ending keyword, EOF, or
   * a caller-supplied stop condition.
   */
  private recoverToErrorNode(extraStop?: (kind: TokenKind) => boolean): SyntaxNode {
    const tokens: Token[] = [this.advance()];
    while (!this.isAtEnd() && !isBlockEnder(this.peekKind()) && !this.isAfterNewline() && !(extraStop && extraStop(this.peekKind()))) {
      tokens.push(this.advance());
    }
    return new SyntaxNode(SyntaxKind.ErrorNode, tokens);
  }
}

/** Recursively checks if a node tree contains a multi-line construct (AA/array literal, function expr/decl, DSL anonymous function) that justifies newlines inside an otherwise single-line-required list. */
function containsMultiLineConstruct(node: SyntaxNode): boolean {
  if (
    node.kind === SyntaxKind.BsAALiteral ||
    node.kind === SyntaxKind.BsArrayLiteral ||
    node.kind === SyntaxKind.BsFunctionExpression ||
    node.kind === SyntaxKind.BsFunctionDeclaration ||
    node.kind === SyntaxKind.AnonymousFunctionExpression
  ) {
    return true;
  }
  for (const child of node.children) {
    if (isNode(child) && containsMultiLineConstruct(child)) return true;
  }
  return false;
}
