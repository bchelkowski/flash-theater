/**
 * Shared "interpret a captured literal span as a structured, literal-only value tree" machinery —
 * extracted from `analysis/request-config.ts` (which needed this exact problem first, for a
 * `request <Kind> { ... }` config block) so `analysis/field-state-literals.ts` (a `field`/`state`
 * array/AA default) can reuse it instead of duplicating the walk. Reuses flash-parser's own
 * BrightScript expression AST (`parseEmbeddedExpression` + `BsAALiteral`/`BsArrayLiteral`/
 * `BsLiteralExpression`) to walk the literal structurally, instead of writing a second AA-literal
 * parser here — the same "delegate to flash-parser's own vendored grammar" discipline `CLAUDE.md`'s
 * compiler-pipeline table documents for everything else.
 */
import { parseEmbeddedExpression, findAll, SyntaxKind, TokenKind, BsAssignmentStatement, BsAALiteral, BsArrayLiteral, BsLiteralExpression, BsUnaryExpression, BsAstNode, EmbeddedBrightScriptText } from 'flash-parser';
import { CompileError } from '../dsl-parser/dsl-ast.js';

export type LiteralValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'invalid' }
  | { kind: 'array'; items: LiteralValue[] }
  | { kind: 'object'; entries: Record<string, LiteralValue> };

export function unquoteKey(rawKeyText: string): string {
  if (rawKeyText.length >= 2 && rawKeyText.startsWith('"') && rawKeyText.endsWith('"')) return rawKeyText.slice(1, -1);
  return rawKeyText;
}

function literalTokenToValue(node: BsLiteralExpression, code: string, contextLabel: string): LiteralValue {
  const token = node.token;
  if (!token) {
    throw new CompileError({ code, message: `Invalid literal in ${contextLabel}.` });
  }
  switch (token.kind) {
    case TokenKind.StringLiteral: {
      const raw = token.text;
      return { kind: 'string', value: raw.length >= 2 ? raw.slice(1, -1) : raw };
    }
    // A DSL-level `field`/`state` default literal is the undifferentiated `NumberLiteral` kind,
    // but a captured span here is parsed as a full BrightScript expression
    // (`parseEmbeddedExpression`), which tokenizes a numeric literal into one of these four more
    // precise kinds instead (see tokenKind.ts's own doc comment on `NumberLiteral`) — confirmed
    // live via a failing `{ method: 5 }` test, not assumed. Strips a trailing BrightScript
    // numeric-literal suffix (`&` LongInteger / `!` Float / `#` Double) before parsing, since
    // `Number("5&")` would otherwise yield `NaN`.
    case TokenKind.NumberLiteral:
    case TokenKind.IntegerLiteral:
    case TokenKind.LongIntegerLiteral:
    case TokenKind.FloatLiteral:
    case TokenKind.DoubleLiteral:
      return { kind: 'number', value: Number(token.text.replace(/[&!#]$/, '')) };
    case TokenKind.True:
      return { kind: 'boolean', value: true };
    case TokenKind.False:
      return { kind: 'boolean', value: false };
    case TokenKind.Invalid:
      return { kind: 'invalid' };
    default:
      throw new CompileError({
        code,
        message: `Invalid literal "${token.text}" in ${contextLabel} — must be a string/number/boolean/invalid literal, a nested object, or an array.`,
      });
  }
}

/**
 * Recursively walks a parsed BrightScript expression AST node, requiring every leaf to be a plain
 * literal (string/number/boolean/`invalid`) or a nested array/AA literal — never an identifier,
 * call, or other computed expression. Throws `code` (a caller-supplied diagnostic code, so
 * `request-config.ts` and `field-state-literals.ts` each surface their own) the moment it finds
 * one that isn't.
 */
export function walkLiteralValue(node: BsAstNode | null, code: string, contextLabel: string): LiteralValue {
  if (node === null) {
    throw new CompileError({ code, message: `Missing value in ${contextLabel}.` });
  }
  if (node instanceof BsAALiteral) {
    const entries: Record<string, LiteralValue> = {};
    for (const field of node.fields) {
      entries[unquoteKey(field.key)] = walkLiteralValue(field.value, code, contextLabel);
    }
    return { kind: 'object', entries };
  }
  if (node instanceof BsArrayLiteral) {
    return { kind: 'array', items: node.elements.map((e) => walkLiteralValue(e, code, contextLabel)) };
  }
  if (node instanceof BsLiteralExpression) {
    return literalTokenToValue(node, code, contextLabel);
  }
  // `-20` tokenizes as a unary-minus expression wrapping a positive `BsLiteralExpression`, not a
  // single signed-number token — negation is applied here, one level, on a numeric operand only
  // (a translation/keyValue array is the common case that needs negative literals, e.g. `[-20, 0]`).
  if (node instanceof BsUnaryExpression && node.operator === '-') {
    const operand = walkLiteralValue(node.operand, code, contextLabel);
    if (operand.kind !== 'number') {
      throw new CompileError({ code, message: `${contextLabel}: unary "-" is only valid on a number literal — found "${node.getText().trim()}".` });
    }
    return { kind: 'number', value: -operand.value };
  }
  throw new CompileError({
    code,
    message: `${contextLabel} must contain only literals (strings/numbers/booleans/nested objects/arrays) — found a non-literal expression ("${node.getText().trim()}").`,
  });
}

/**
 * Extracts the root expression node from an ALREADY-parsed embedded expression's implicit
 * `ft_result = <expr>` wrapper (`parseEmbeddedExpression` always wraps a bare expression in an
 * assignment so it parses as a full BrightScript statement). Shared by `parseLiteralRoot` below and
 * `analysis/derived-type-check.ts`'s own root-extraction — both need the identical unwrap, but
 * different parse-error policy (throw vs. skip silently), so only this common tail is shared, not
 * the diagnostics check.
 */
export function unwrapEmbeddedExpressionRoot(parsed: EmbeddedBrightScriptText): BsAstNode | null {
  const assignments = findAll(parsed.result.root, SyntaxKind.BsAssignmentStatement, (n) => new BsAssignmentStatement(n));
  return assignments[0]?.value ?? null;
}

/**
 * Parses `text` (expected to be a single array (`[...]`) or AA (`{...}`) literal, e.g. a `field`/
 * `state` default's captured span, or a `request {}` config block) as a BrightScript expression and
 * returns its root node — `null` if `text` doesn't parse as exactly one literal expression. Throws
 * `code` on an outright parse error (malformed BrightScript, not just "not a literal").
 */
export function parseLiteralRoot(text: string, code: string, contextLabel: string): BsAstNode | null {
  const parsed = parseEmbeddedExpression(text);
  if (parsed.result.diagnostics.length > 0) {
    throw new CompileError({ code, message: `Failed to parse ${contextLabel}: ${parsed.result.diagnostics[0].message}` });
  }

  return unwrapEmbeddedExpressionRoot(parsed);
}
