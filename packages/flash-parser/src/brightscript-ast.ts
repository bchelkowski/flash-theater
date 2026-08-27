/**
 * Typed AST wrappers over the full-BrightScript CST produced by
 * `brightscript-parser.ts` — the Phase 0 grammar-ownership counterpart to
 * `packages/flash-parser/src/ast.ts` (the DSL layer's own typed wrappers).
 * Vendored and adapted from `kopytko-brightscript-parser`'s own `ast.js`
 * (`node_modules/kopytko-brightscript-parser/dist/src/ast.js`) — same
 * zero-cost-wrapper-over-CST pattern, same per-instance memoization via
 * `AstNode.memo`, same `wrapNode`-style dispatcher with its own `WeakMap`
 * cache (so repeated wrapping of the same `SyntaxNode` returns the same
 * wrapper instance — see this file's class doc comment on `AstNode`).
 *
 * Kept as a **separate** dispatcher (`wrapBrightScriptNode`, not merged into
 * `ast.ts`'s own `wrapNode`) because a DSL tree and a BrightScript tree are
 * never the same tree — they're bridged via `SyntaxNode.embedded` (an
 * `ExpressionRegion`/`StatementRegion`/`TemplateSection` node's own nested
 * parse), never merged into one, mirroring the existing
 * `EmbeddedBrightScriptParse`/`EmbeddedXmlParse` separation in
 * `syntaxNode.ts`.
 *
 * Genuinely new relative to the vendored source: `BsComparisonExpression`
 * (the DSL-only `==`/`!=` sugar `brightscript-parser.ts` produces at the
 * same precedence tier as a real comparison — see that file's own doc
 * comment) — same shape as `BsBinaryExpression`
 * (`left`/`operatorToken`/`operator`/`right`), kept as its own class so a
 * caller can distinguish "real BrightScript operator, pass through
 * unmodified" from "DSL sugar, needs `ft_equals(...)` lowering" by wrapper
 * type alone. `BsSafeNotExpression` (the DSL-only bare-`!` sugar, same
 * precedence tier as real `Not`) exists for the identical reason, alongside
 * `BsUnaryExpression`.
 */
import { SyntaxKind } from './syntaxKind.js';
import { SyntaxNode, isNode, isToken } from './syntaxNode.js';
import { TokenKind } from './tokenKind.js';
import { Token } from './token.js';
import { Trivia, TriviaKind } from './trivia.js';

// ─── Base ──────────────────────────────────────────────────────────────────
/** Base class for every typed BrightScript AST wrapper. */
export abstract class BsAstNode {
  readonly syntax: SyntaxNode;
  private _memo?: Map<string, unknown>;

  constructor(syntax: SyntaxNode) {
    this.syntax = syntax;
  }

  get pos(): number {
    return this.syntax.pos;
  }
  get end(): number {
    return this.syntax.end;
  }
  getText(): string {
    return this.syntax.getText();
  }

  /** Comment trivia attached before this node's first token. Empty for a childless node or one with no leading comment. */
  get leadingComments(): readonly Trivia[] {
    return this.memo('leadingComments', () => {
      const first = firstTokenOf(this.syntax);
      if (!first) return [];
      return first.leadingTrivia.filter((t) => t.kind === TriviaKind.Comment);
    });
  }

  /** Per-instance memoization for a getter's computed value — see this file's own doc comment. */
  protected memo<T>(key: string, compute: () => T): T {
    this._memo ??= new Map();
    if (this._memo.has(key)) return this._memo.get(key) as T;
    const value = compute();
    this._memo.set(key, value);
    return value;
  }
}

function firstTokenOf(node: SyntaxNode): Token | undefined {
  for (const child of node.children) {
    if (isToken(child)) return child;
    const found = firstTokenOf(child);
    if (found) return found;
  }
  return undefined;
}

type WrappedOrNull = BsAstNode | null;

// ─── Top-level ─────────────────────────────────────────────────────────────
export class BsSourceFile extends BsAstNode {
  get statements(): readonly BsAstNode[] {
    return this.memo('statements', () =>
      this.syntax.childNodes
        .filter((n) => n.kind !== SyntaxKind.ErrorNode)
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
}

// ─── Function / Sub ────────────────────────────────────────────────────────
export class BsFunctionDeclaration extends BsAstNode {
  get nameToken(): Token | undefined {
    return this.memo('nameToken', () => this.syntax.findToken(TokenKind.Identifier));
  }
  get name(): string {
    return this.nameToken?.text ?? '';
  }
  get isFunction(): boolean {
    return this.memo('isFunction', () => this.syntax.findToken(TokenKind.Function) !== undefined);
  }
  get isSub(): boolean {
    return this.memo('isSub', () => this.syntax.findToken(TokenKind.Sub) !== undefined);
  }
  get parameterList(): BsParameterList | undefined {
    return this.memo('parameterList', () => {
      const node = this.syntax.findChild(SyntaxKind.BsParameterList);
      return node ? new BsParameterList(node) : undefined;
    });
  }
  get params(): readonly BsParameter[] {
    return this.parameterList?.params ?? [];
  }
  get returnTypeClause(): BsReturnTypeClause | undefined {
    return this.memo('returnTypeClause', () => {
      const node = this.syntax.findChild(SyntaxKind.BsReturnTypeClause);
      return node ? new BsReturnTypeClause(node) : undefined;
    });
  }
  get returnType(): string | undefined {
    return this.returnTypeClause?.typeName;
  }
  get body(): readonly BsAstNode[] {
    return this.memo('body', () =>
      this.syntax.childNodes
        .filter((n) => n.kind !== SyntaxKind.BsParameterList && n.kind !== SyntaxKind.BsReturnTypeClause)
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
}

export class BsFunctionExpression extends BsAstNode {
  get isFunction(): boolean {
    return this.memo('isFunction', () => this.syntax.findToken(TokenKind.Function) !== undefined);
  }
  get isSub(): boolean {
    return this.memo('isSub', () => this.syntax.findToken(TokenKind.Sub) !== undefined);
  }
  get parameterList(): BsParameterList | undefined {
    return this.memo('parameterList', () => {
      const node = this.syntax.findChild(SyntaxKind.BsParameterList);
      return node ? new BsParameterList(node) : undefined;
    });
  }
  get params(): readonly BsParameter[] {
    return this.parameterList?.params ?? [];
  }
  get returnType(): string | undefined {
    return this.memo('returnType', () => {
      const clause = this.syntax.findChild(SyntaxKind.BsReturnTypeClause);
      return clause ? new BsReturnTypeClause(clause).typeName : undefined;
    });
  }
  get body(): readonly BsAstNode[] {
    return this.memo('body', () =>
      this.syntax.childNodes
        .filter((n) => n.kind !== SyntaxKind.BsParameterList && n.kind !== SyntaxKind.BsReturnTypeClause)
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
}

export class BsParameterList extends BsAstNode {
  get params(): readonly BsParameter[] {
    return this.memo('params', () => this.syntax.findAllChildren(SyntaxKind.BsParameter).map((n) => new BsParameter(n)));
  }
}

export class BsParameter extends BsAstNode {
  get nameToken(): Token | undefined {
    return this.memo('nameToken', () => this.syntax.findToken(TokenKind.Identifier));
  }
  get name(): string {
    return this.nameToken?.text ?? '';
  }
  get typeName(): string | undefined {
    return this.memo('typeName', () => {
      const asToken = this.syntax.findToken(TokenKind.As);
      if (!asToken) return undefined;
      const children = this.syntax.children;
      const asIdx = children.indexOf(asToken);
      const typeToken = asIdx >= 0 ? children[asIdx + 1] : undefined;
      return typeToken && isToken(typeToken) ? typeToken.text : undefined;
    });
  }
  get hasDefault(): boolean {
    return this.memo('hasDefault', () => this.syntax.findToken(TokenKind.Equals) !== undefined);
  }
}

export class BsReturnTypeClause extends BsAstNode {
  get typeName(): string {
    return this.memo('typeName', () => {
      const children = this.syntax.children;
      return children.length >= 2 && isToken(children[1]) ? children[1].text : '';
    });
  }
}

// ─── If / Else ─────────────────────────────────────────────────────────────
export class BsIfStatement extends BsAstNode {
  get condition(): WrappedOrNull {
    return this.memo('condition', () => {
      for (const child of this.syntax.childNodes) {
        if (child.kind !== SyntaxKind.BsElseIfClause && child.kind !== SyntaxKind.BsElseClause) {
          const wrapped = wrapBrightScriptNode(child);
          if (wrapped) return wrapped;
        }
      }
      return null;
    });
  }
  get body(): readonly BsAstNode[] {
    return this.memo('body', () =>
      this.syntax.childNodes
        .filter((n) => n.kind !== SyntaxKind.BsElseIfClause && n.kind !== SyntaxKind.BsElseClause && !isExpressionKind(n.kind))
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
  get elseIfClauses(): readonly BsElseIfClause[] {
    return this.memo('elseIfClauses', () => this.syntax.findAllChildren(SyntaxKind.BsElseIfClause).map((n) => new BsElseIfClause(n)));
  }
  get elseClause(): BsElseClause | undefined {
    return this.memo('elseClause', () => {
      const node = this.syntax.findChild(SyntaxKind.BsElseClause);
      return node ? new BsElseClause(node) : undefined;
    });
  }
}

export class BsElseIfClause extends BsAstNode {
  get condition(): WrappedOrNull {
    return this.memo('condition', () => {
      for (const child of this.syntax.childNodes) {
        const wrapped = wrapBrightScriptNode(child);
        if (wrapped) return wrapped;
      }
      return null;
    });
  }
  get body(): readonly BsAstNode[] {
    return this.memo('body', () =>
      this.syntax.childNodes
        .filter((n) => !isExpressionKind(n.kind))
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
}

export class BsElseClause extends BsAstNode {
  get body(): readonly BsAstNode[] {
    return this.memo('body', () =>
      this.syntax.childNodes
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
}

// ─── Loops ─────────────────────────────────────────────────────────────────
export class BsForStatement extends BsAstNode {
  get variableToken(): Token | undefined {
    return this.memo('variableToken', () => this.syntax.findToken(TokenKind.Identifier));
  }
  get variable(): string {
    return this.variableToken?.text ?? '';
  }
  get body(): readonly BsAstNode[] {
    return this.memo('body', () => getBodyStatements(this.syntax));
  }
}

export class BsForEachStatement extends BsAstNode {
  get variableToken(): Token | undefined {
    return this.memo('variableToken', () => {
      let foundEach = false;
      for (const child of this.syntax.children) {
        if (isToken(child) && child.kind === TokenKind.Each) {
          foundEach = true;
          continue;
        }
        if (foundEach && isToken(child) && child.kind === TokenKind.Identifier) return child;
      }
      return undefined;
    });
  }
  get variable(): string {
    return this.variableToken?.text ?? '';
  }
  get body(): readonly BsAstNode[] {
    return this.memo('body', () => getBodyStatements(this.syntax));
  }
}

export class BsWhileStatement extends BsAstNode {
  get condition(): WrappedOrNull {
    return this.memo('condition', () => {
      for (const child of this.syntax.childNodes) {
        const wrapped = wrapBrightScriptNode(child);
        if (wrapped) return wrapped;
      }
      return null;
    });
  }
  get body(): readonly BsAstNode[] {
    return this.memo('body', () => getBodyStatements(this.syntax));
  }
}

// ─── Try / Catch ───────────────────────────────────────────────────────────
export class BsTryStatement extends BsAstNode {
  get body(): readonly BsAstNode[] {
    return this.memo('body', () =>
      this.syntax.childNodes
        .filter((n) => n.kind !== SyntaxKind.BsCatchClause)
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
  get catchClause(): BsCatchClause | undefined {
    return this.memo('catchClause', () => {
      const node = this.syntax.findChild(SyntaxKind.BsCatchClause);
      return node ? new BsCatchClause(node) : undefined;
    });
  }
}

export class BsCatchClause extends BsAstNode {
  get variableToken(): Token | undefined {
    return this.memo('variableToken', () => this.syntax.findToken(TokenKind.Identifier));
  }
  get variable(): string {
    return this.variableToken?.text ?? '';
  }
  get body(): readonly BsAstNode[] {
    return this.memo('body', () => getBodyStatements(this.syntax));
  }
}

// ─── Simple statements ─────────────────────────────────────────────────────
export class BsReturnStatement extends BsAstNode {
  get value(): WrappedOrNull {
    return this.memo('value', () => {
      const expr = this.syntax.childNodes[0];
      return expr ? wrapBrightScriptNode(expr) : null;
    });
  }
  get hasValue(): boolean {
    return this.memo('hasValue', () => this.syntax.childNodes.length > 0);
  }
}

export class BsPrintStatement extends BsAstNode {
  get expressions(): readonly BsAstNode[] {
    return this.memo('expressions', () =>
      this.syntax.childNodes
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
}

export class BsThrowStatement extends BsAstNode {
  get expression(): WrappedOrNull {
    return this.memo('expression', () => {
      const expr = this.syntax.childNodes[0];
      return expr ? wrapBrightScriptNode(expr) : null;
    });
  }
}

export class BsDimStatement extends BsAstNode {
  get variableToken(): Token | undefined {
    return this.memo('variableToken', () => this.syntax.findToken(TokenKind.Identifier));
  }
  get variable(): string {
    return this.variableToken?.text ?? '';
  }
}

export class BsGotoStatement extends BsAstNode {
  get label(): string {
    return this.memo('label', () => this.syntax.findToken(TokenKind.Identifier)?.text ?? '');
  }
}

export class BsLabelStatement extends BsAstNode {
  get name(): string {
    return this.memo('name', () => this.syntax.findToken(TokenKind.Identifier)?.text ?? '');
  }
}

export class BsStopStatement extends BsAstNode {}
export class BsEndStatement extends BsAstNode {}
export class BsExitForStatement extends BsAstNode {}
export class BsExitWhileStatement extends BsAstNode {}
export class BsContinueForStatement extends BsAstNode {}
export class BsContinueWhileStatement extends BsAstNode {}

// ─── Assignment ────────────────────────────────────────────────────────────
const COMPOUND_ASSIGN_TOKEN_KINDS: ReadonlySet<TokenKind> = new Set([
  TokenKind.Equals,
  TokenKind.PlusEqual,
  TokenKind.MinusEqual,
  TokenKind.StarEqual,
  TokenKind.SlashEqual,
  TokenKind.BackslashEqual,
  TokenKind.LeftShiftEqual,
  TokenKind.RightShiftEqual,
]);

export class BsAssignmentStatement extends BsAstNode {
  get target(): WrappedOrNull {
    return this.memo('target', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
  get operatorToken(): Token | undefined {
    return this.memo('operatorToken', () => {
      for (const child of this.syntax.children) {
        if (isToken(child) && COMPOUND_ASSIGN_TOKEN_KINDS.has(child.kind)) return child;
      }
      return undefined;
    });
  }
  get isCompound(): boolean {
    const op = this.operatorToken;
    return op !== undefined && op.kind !== TokenKind.Equals;
  }
  get value(): WrappedOrNull {
    return this.memo('value', () => {
      const nodes = this.syntax.childNodes;
      return nodes.length >= 2 ? wrapBrightScriptNode(nodes[nodes.length - 1]) : null;
    });
  }
}

export class BsExpressionStatement extends BsAstNode {
  get expression(): WrappedOrNull {
    return this.memo('expression', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
}

// ─── Expressions ───────────────────────────────────────────────────────────
export class BsBinaryExpression extends BsAstNode {
  get left(): WrappedOrNull {
    return this.memo('left', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
  get operatorToken(): Token | undefined {
    return this.memo('operatorToken', () => {
      for (const child of this.syntax.children) {
        if (isToken(child) && child.kind !== TokenKind.LParen && child.kind !== TokenKind.RParen) return child;
      }
      return undefined;
    });
  }
  get operator(): string {
    return this.operatorToken?.text ?? '';
  }
  get right(): WrappedOrNull {
    return this.memo('right', () => {
      const nodes = this.syntax.childNodes;
      return nodes.length >= 2 ? wrapBrightScriptNode(nodes[nodes.length - 1]) : null;
    });
  }
}

const COMPARISON_SUGAR_TOKEN_KINDS: ReadonlySet<TokenKind> = new Set([
  TokenKind.EqualsEquals,
  TokenKind.BangEquals,
  TokenKind.Less,
  TokenKind.Greater,
  TokenKind.LessEqual,
  TokenKind.GreaterEqual,
]);

/**
 * `<left> == <right>` / `<left> != <right>` / `<left> < <right>` / `<left> >
 * <right>` / `<left> <= <right>` / `<left> >= <right>` — DSL-only crash-safe
 * comparison/relational sugar (GRAMMAR.md's "Comparison" section), same
 * shape as `BsBinaryExpression` but kept as its own wrapper class so a
 * caller (the compiler's `ft_equals(...)`/`Not ft_equals(...)` lowering for
 * `==`/`!=`, `ft_relationalGuard(...)` for the other four) can distinguish
 * it from a real, deliberately-unguarded BrightScript `=`/`<>` operator by
 * wrapper type alone, without re-checking the operator token's kind at every
 * call site.
 */
export class BsComparisonExpression extends BsAstNode {
  get left(): WrappedOrNull {
    return this.memo('left', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
  get operatorToken(): Token | undefined {
    return this.memo('operatorToken', () => {
      for (const child of this.syntax.children) {
        if (isToken(child) && COMPARISON_SUGAR_TOKEN_KINDS.has(child.kind)) return child;
      }
      return undefined;
    });
  }
  /** `'=='`, `'!='`, `'<'`, `'>'`, `'<='`, or `'>='`. */
  get operator(): string {
    return this.operatorToken?.text ?? '';
  }
  get isNegated(): boolean {
    return this.operatorToken?.kind === TokenKind.BangEquals;
  }
  get right(): WrappedOrNull {
    return this.memo('right', () => {
      const nodes = this.syntax.childNodes;
      return nodes.length >= 2 ? wrapBrightScriptNode(nodes[nodes.length - 1]) : null;
    });
  }
}

export class BsUnaryExpression extends BsAstNode {
  get operatorToken(): Token | undefined {
    return this.memo('operatorToken', () => {
      for (const child of this.syntax.children) {
        if (isToken(child)) return child;
      }
      return undefined;
    });
  }
  get operator(): string {
    return this.operatorToken?.text ?? '';
  }
  get operand(): WrappedOrNull {
    return this.memo('operand', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
}

/**
 * `!<operand>` — DSL-only crash-safe unary NOT sugar (GRAMMAR.md's "Safe NOT"
 * section), same shape as `BsUnaryExpression` but kept as its own wrapper
 * class so a caller (the compiler's `ft_not(<operand>)` lowering) can
 * distinguish it from a real BrightScript `Not`/unary `-`/`+` by wrapper type
 * alone, without re-checking the operator token's kind at every call site —
 * the same reason `BsComparisonExpression` exists separately from
 * `BsBinaryExpression`.
 */
export class BsSafeNotExpression extends BsAstNode {
  get operatorToken(): Token | undefined {
    return this.memo('operatorToken', () => this.syntax.findToken(TokenKind.Bang));
  }
  /** Always `'!'`. */
  get operator(): string {
    return this.operatorToken?.text ?? '';
  }
  get operand(): WrappedOrNull {
    return this.memo('operand', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
}

export class BsGroupingExpression extends BsAstNode {
  get expression(): WrappedOrNull {
    return this.memo('expression', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
}

export class BsCallExpression extends BsAstNode {
  get callee(): WrappedOrNull {
    return this.memo('callee', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
  get argumentList(): BsArgumentList | undefined {
    return this.memo('argumentList', () => {
      const node = this.syntax.findChild(SyntaxKind.BsArgumentList);
      return node ? new BsArgumentList(node) : undefined;
    });
  }
  get args(): readonly BsAstNode[] {
    return this.argumentList?.args ?? [];
  }
}

export class BsArgumentList extends BsAstNode {
  get args(): readonly BsAstNode[] {
    return this.memo('args', () =>
      this.syntax.childNodes
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
}

export class BsDotExpression extends BsAstNode {
  get object(): WrappedOrNull {
    return this.memo('object', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
  get memberToken(): Token | undefined {
    return this.memo('memberToken', () => {
      const children = this.syntax.children;
      for (let i = children.length - 1; i >= 0; i--) {
        const c = children[i];
        if (isToken(c) && c.kind !== TokenKind.Dot) return c;
      }
      return undefined;
    });
  }
  get member(): string {
    return this.memberToken?.text ?? '';
  }
  /** True if this dot access is actually an `@attr` XML attribute access — the parser produces `BsDotExpression` for both `.` and `@`. */
  get isAttributeAccess(): boolean {
    return this.memo('isAttributeAccess', () => this.syntax.findToken(TokenKind.At) !== undefined);
  }
}

export class BsIndexExpression extends BsAstNode {
  get object(): WrappedOrNull {
    return this.memo('object', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
  get indices(): readonly BsAstNode[] {
    return this.memo('indices', () =>
      this.syntax.childNodes
        .slice(1)
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
}

const OPTIONAL_CHAIN_TOKEN_KINDS: ReadonlySet<TokenKind> = new Set([TokenKind.QuestionDot, TokenKind.QuestionBracket, TokenKind.QuestionParen, TokenKind.QuestionAt]);

export class BsOptionalChainingExpression extends BsAstNode {
  get object(): WrappedOrNull {
    return this.memo('object', () => {
      const first = this.syntax.childNodes[0];
      return first ? wrapBrightScriptNode(first) : null;
    });
  }
  /** The `?.`, `?[`, `?(`, or `?@` token that opens this expression. */
  get operatorToken(): Token | undefined {
    return this.memo('operatorToken', () => {
      for (const child of this.syntax.children) {
        if (isToken(child) && OPTIONAL_CHAIN_TOKEN_KINDS.has(child.kind)) return child;
      }
      return undefined;
    });
  }
  get operator(): string {
    return this.operatorToken?.text ?? '';
  }
  /** The member name token for `?.member` / `?@attr`, if this is that form. */
  get memberToken(): Token | undefined {
    return this.memo('memberToken', () => {
      const op = this.operatorToken;
      if (!op || (op.kind !== TokenKind.QuestionDot && op.kind !== TokenKind.QuestionAt)) return undefined;
      const children = this.syntax.children;
      const opIdx = children.indexOf(op);
      const next = opIdx >= 0 ? children[opIdx + 1] : undefined;
      return next && isToken(next) ? next : undefined;
    });
  }
  get member(): string {
    return this.memberToken?.text ?? '';
  }
  /** The index expression for `?[index]`, or the argument expressions for `?(args)`. Empty for `?.member`/`?@attr`. */
  get args(): readonly BsAstNode[] {
    return this.memo('args', () =>
      this.syntax.childNodes
        .slice(1)
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
}

export class BsIdentifierExpression extends BsAstNode {
  get nameToken(): Token | undefined {
    return this.memo('nameToken', () => {
      for (const child of this.syntax.children) {
        if (isToken(child)) return child;
      }
      return undefined;
    });
  }
  get name(): string {
    return this.nameToken?.text ?? '';
  }
}

export class BsLiteralExpression extends BsAstNode {
  get token(): Token | undefined {
    return this.memo('token', () => {
      for (const child of this.syntax.children) {
        if (isToken(child)) return child;
      }
      return undefined;
    });
  }
  get value(): string {
    return this.token?.text ?? '';
  }
}

export class BsArrayLiteral extends BsAstNode {
  get elements(): readonly BsAstNode[] {
    return this.memo('elements', () =>
      this.syntax.childNodes
        .map((n) => wrapBrightScriptNode(n))
        .filter((n): n is BsAstNode => n !== null),
    );
  }
}

export class BsAALiteral extends BsAstNode {
  get fields(): readonly BsAAField[] {
    return this.memo('fields', () => this.syntax.findAllChildren(SyntaxKind.BsAAField).map((n) => new BsAAField(n)));
  }
}

export class BsAAField extends BsAstNode {
  get keyToken(): Token | undefined {
    return this.memo('keyToken', () => {
      for (const child of this.syntax.children) {
        if (isToken(child) && child.kind !== TokenKind.Colon) return child;
      }
      return undefined;
    });
  }
  get key(): string {
    return this.keyToken?.text ?? '';
  }
  get value(): WrappedOrNull {
    return this.memo('value', () => {
      const nodes = this.syntax.childNodes;
      return nodes.length > 0 ? wrapBrightScriptNode(nodes[nodes.length - 1]) : null;
    });
  }
}

interface ConditionalCompilationParts {
  readonly condition: WrappedOrNull;
  readonly body: readonly BsAstNode[];
  readonly elseIfBranches: readonly { condition: WrappedOrNull; body: readonly BsAstNode[] }[];
  readonly elseBody: readonly BsAstNode[] | undefined;
}

/**
 * `#if <condition> ... [#elseif <condition> ...]* [#else ...] #end if` — a
 * flat, token-interleaved children list (no nesting), matching how
 * `brightscript-parser.ts`'s `parseConditionalCompilation` builds it.
 */
export class BsConditionalCompilation extends BsAstNode {
  private parts(): ConditionalCompilationParts {
    return this.memo('parts', () => {
      const children = this.syntax.children;
      let i = 0;
      if (i < children.length && isToken(children[i]) && (children[i] as Token).kind === TokenKind.HashIf) i++;

      const readCondition = (): WrappedOrNull => {
        if (i < children.length && isNode(children[i])) {
          const wrapped = wrapBrightScriptNode(children[i] as SyntaxNode);
          i++;
          return wrapped;
        }
        return null;
      };
      const readBody = (): BsAstNode[] => {
        const body: BsAstNode[] = [];
        while (i < children.length) {
          const c = children[i];
          if (isToken(c) && (c.kind === TokenKind.HashElseIf || c.kind === TokenKind.HashElse || c.kind === TokenKind.HashEndIf)) break;
          if (isNode(c)) {
            const wrapped = wrapBrightScriptNode(c);
            if (wrapped) body.push(wrapped);
          }
          i++;
        }
        return body;
      };

      const condition = readCondition();
      const body = readBody();
      const elseIfBranches: { condition: WrappedOrNull; body: readonly BsAstNode[] }[] = [];
      while (i < children.length && isToken(children[i]) && (children[i] as Token).kind === TokenKind.HashElseIf) {
        i++;
        elseIfBranches.push({ condition: readCondition(), body: readBody() });
      }
      let elseBody: BsAstNode[] | undefined;
      if (i < children.length && isToken(children[i]) && (children[i] as Token).kind === TokenKind.HashElse) {
        i++;
        elseBody = readBody();
      }
      return { condition, body, elseIfBranches, elseBody };
    });
  }

  get condition(): WrappedOrNull {
    return this.parts().condition;
  }
  get body(): readonly BsAstNode[] {
    return this.parts().body;
  }
  get elseIfBranches(): readonly { condition: WrappedOrNull; body: readonly BsAstNode[] }[] {
    return this.parts().elseIfBranches;
  }
  get elseBody(): readonly BsAstNode[] | undefined {
    return this.parts().elseBody;
  }
}

export class BsHashConstStatement extends BsAstNode {
  get name(): string {
    return this.memo('name', () => this.syntax.findToken(TokenKind.Identifier)?.text ?? '');
  }
  get value(): WrappedOrNull {
    return this.memo('value', () => {
      const nodes = this.syntax.childNodes;
      return nodes.length > 0 ? wrapBrightScriptNode(nodes[nodes.length - 1]) : null;
    });
  }
}

export class BsHashErrorStatement extends BsAstNode {
  /** The error message text following `#error`, as written in source. */
  get message(): string {
    return this.memo('message', () => {
      const errToken = this.syntax.findToken(TokenKind.HashError);
      return errToken?.text.replace(/^#error\s*/i, '') ?? '';
    });
  }
}

export class BsErrorNodeWrapper extends BsAstNode {}

// ─── Utilities ─────────────────────────────────────────────────────────────
function isExpressionKind(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.BsBinaryExpression ||
    kind === SyntaxKind.BsComparisonExpression ||
    kind === SyntaxKind.BsUnaryExpression ||
    kind === SyntaxKind.BsSafeNotExpression ||
    kind === SyntaxKind.BsGroupingExpression ||
    kind === SyntaxKind.BsCallExpression ||
    kind === SyntaxKind.BsDotExpression ||
    kind === SyntaxKind.BsIndexExpression ||
    kind === SyntaxKind.BsOptionalChainingExpression ||
    kind === SyntaxKind.BsFunctionExpression ||
    kind === SyntaxKind.BsIdentifierExpression ||
    kind === SyntaxKind.BsLiteralExpression ||
    kind === SyntaxKind.BsArrayLiteral ||
    kind === SyntaxKind.BsAALiteral
  );
}

function getBodyStatements(node: SyntaxNode): readonly BsAstNode[] {
  return node.childNodes
    .filter((n) => !isExpressionKind(n.kind))
    .map((n) => wrapBrightScriptNode(n))
    .filter((n): n is BsAstNode => n !== null);
}

/**
 * Wraps a raw CST `SyntaxNode` (produced by `brightscript-parser.ts`) in the
 * appropriate typed wrapper. Returns the same wrapper instance for the same
 * node on repeated calls — see this file's own doc comment for why that
 * matters for `BsAstNode.memo`.
 */
const wrapperCache = new WeakMap<SyntaxNode, BsAstNode>();
export function wrapBrightScriptNode(node: SyntaxNode): BsAstNode | null {
  const cached = wrapperCache.get(node);
  if (cached) return cached;
  const wrapped = wrapBrightScriptNodeUncached(node);
  if (wrapped) wrapperCache.set(node, wrapped);
  return wrapped;
}

function wrapBrightScriptNodeUncached(node: SyntaxNode): BsAstNode | null {
  switch (node.kind) {
    case SyntaxKind.BsSourceFile:
      return new BsSourceFile(node);
    case SyntaxKind.BsFunctionDeclaration:
      return new BsFunctionDeclaration(node);
    case SyntaxKind.BsFunctionExpression:
      return new BsFunctionExpression(node);
    case SyntaxKind.BsParameterList:
      return new BsParameterList(node);
    case SyntaxKind.BsParameter:
      return new BsParameter(node);
    case SyntaxKind.BsReturnTypeClause:
      return new BsReturnTypeClause(node);
    case SyntaxKind.BsIfStatement:
      return new BsIfStatement(node);
    case SyntaxKind.BsElseIfClause:
      return new BsElseIfClause(node);
    case SyntaxKind.BsElseClause:
      return new BsElseClause(node);
    case SyntaxKind.BsForStatement:
      return new BsForStatement(node);
    case SyntaxKind.BsForEachStatement:
      return new BsForEachStatement(node);
    case SyntaxKind.BsWhileStatement:
      return new BsWhileStatement(node);
    case SyntaxKind.BsTryStatement:
      return new BsTryStatement(node);
    case SyntaxKind.BsCatchClause:
      return new BsCatchClause(node);
    case SyntaxKind.BsReturnStatement:
      return new BsReturnStatement(node);
    case SyntaxKind.BsPrintStatement:
      return new BsPrintStatement(node);
    case SyntaxKind.BsThrowStatement:
      return new BsThrowStatement(node);
    case SyntaxKind.BsDimStatement:
      return new BsDimStatement(node);
    case SyntaxKind.BsStopStatement:
      return new BsStopStatement(node);
    case SyntaxKind.BsEndStatement:
      return new BsEndStatement(node);
    case SyntaxKind.BsGotoStatement:
      return new BsGotoStatement(node);
    case SyntaxKind.BsLabelStatement:
      return new BsLabelStatement(node);
    case SyntaxKind.BsExitForStatement:
      return new BsExitForStatement(node);
    case SyntaxKind.BsExitWhileStatement:
      return new BsExitWhileStatement(node);
    case SyntaxKind.BsContinueForStatement:
      return new BsContinueForStatement(node);
    case SyntaxKind.BsContinueWhileStatement:
      return new BsContinueWhileStatement(node);
    case SyntaxKind.BsAssignmentStatement:
      return new BsAssignmentStatement(node);
    case SyntaxKind.BsExpressionStatement:
      return new BsExpressionStatement(node);
    case SyntaxKind.BsBinaryExpression:
      return new BsBinaryExpression(node);
    case SyntaxKind.BsComparisonExpression:
      return new BsComparisonExpression(node);
    case SyntaxKind.BsUnaryExpression:
      return new BsUnaryExpression(node);
    case SyntaxKind.BsSafeNotExpression:
      return new BsSafeNotExpression(node);
    case SyntaxKind.BsGroupingExpression:
      return new BsGroupingExpression(node);
    case SyntaxKind.BsCallExpression:
      return new BsCallExpression(node);
    case SyntaxKind.BsDotExpression:
      return new BsDotExpression(node);
    case SyntaxKind.BsIndexExpression:
      return new BsIndexExpression(node);
    case SyntaxKind.BsOptionalChainingExpression:
      return new BsOptionalChainingExpression(node);
    case SyntaxKind.BsIdentifierExpression:
      return new BsIdentifierExpression(node);
    case SyntaxKind.BsLiteralExpression:
      return new BsLiteralExpression(node);
    case SyntaxKind.BsArrayLiteral:
      return new BsArrayLiteral(node);
    case SyntaxKind.BsAALiteral:
      return new BsAALiteral(node);
    case SyntaxKind.BsAAField:
      return new BsAAField(node);
    case SyntaxKind.BsArgumentList:
      return new BsArgumentList(node);
    case SyntaxKind.BsConditionalCompilation:
      return new BsConditionalCompilation(node);
    case SyntaxKind.BsHashConstStatement:
      return new BsHashConstStatement(node);
    case SyntaxKind.BsHashErrorStatement:
      return new BsHashErrorStatement(node);
    case SyntaxKind.ErrorNode:
      return new BsErrorNodeWrapper(node);
    default:
      return null;
  }
}
