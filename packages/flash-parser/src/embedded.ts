/**
 * Wrap-and-parse helpers for embedded content — a BrightScript expression/
 * statement (parsed by this package's own full grammar, see
 * `brightscript-parser.ts`) and the `.thr` template markup (parsed by this
 * package's own SceneGraph XML parser, see `xml/`). Neither is delegated to
 * `kopytko-brightscript-parser` anymore — see
 * findings/compiler-parser-architecture.md's "flash-parser: a real, fully
 * self-sufficient CST/AST for the whole language" for why, and for the
 * scale of the port this represents.
 *
 * Both BrightScript helpers memoize by exact source text: the same
 * expression/statement text always parses to the same result, and the same
 * text is legitimately looked at more than once in this codebase (once
 * eagerly here when flash-parser builds the CST, again later when the
 * compiler's dependency graph and codegen touch the same `derived`
 * expression or template binding) — see
 * packages/compiler/src/analysis/expression-region.ts.
 */
import { parseBrightScript } from './brightscript-parser.js';
import type { BrightScriptParseResult, BrightScriptParseDiagnostic } from './brightscript-parser.js';
import { findAll } from './visitor.js';
import { isNode as isBsSyntaxNode, firstToken as bsFirstToken, lastToken as bsLastToken } from './syntaxNode.js';
import type { SyntaxNode as BsSyntaxNode } from './syntaxNode.js';
import {
  BsIdentifierExpression as IdentifierExpression,
  BsDotExpression as DotExpression,
  BsIndexExpression as IndexExpression,
  BsCallExpression as CallExpression,
  BsAssignmentStatement as AssignmentStatement,
  BsExpressionStatement as ExpressionStatement,
  BsComparisonExpression as ComparisonExpression,
  BsSafeNotExpression as SafeNotExpression,
  BsAstNode,
} from './brightscript-ast.js';
import { SyntaxKind as BsSyntaxKind } from './syntaxKind.js';
import { TokenKind } from './tokenKind.js';
import type { Token } from './token.js';
import { parseXml } from './xml/xml-parser.js';
import type { XmlParseResult } from './xml/xml-parser.js';

const EXPRESSION_WRAPPER_PREFIX = 'sub ft_tmp()\n  ft_result = ';
const EXPRESSION_WRAPPER_SUFFIX = '\nend sub';

const STATEMENT_WRAPPER_PREFIX = 'sub ft_tmp()\n';
const STATEMENT_WRAPPER_SUFFIX = '\nend sub';

/** Synthetic callee name a `super(...)`'s raw argument-list text is wrapped in so it can be validated/parsed as a real call's argument list — never emitted, never collides with a real declared name (a `class`/`.flsh` name is never a bare identifier starting with `ft_`). */
const SUPER_ARGS_WRAPPER_PREFIX = 'sub ft_tmp()\n  ft_result = ft_super_args(';
const SUPER_ARGS_WRAPPER_SUFFIX = ')\nend sub';

export interface EmbeddedBrightScriptText {
  readonly result: BrightScriptParseResult;
  /** Length of the synthetic wrapper text prepended before the real content — subtract from an inner position to translate it back to the original (unwrapped) text. */
  readonly wrapperPrefixLength: number;
}

const expressionCache = new Map<string, EmbeddedBrightScriptText>();
const statementsCache = new Map<string, EmbeddedBrightScriptText>();
const superArgsCache = new Map<string, EmbeddedBrightScriptText>();

/** Wraps `expressionText` as the right-hand side of an assignment so this package's own brightscript-parser.ts can parse it as a standalone expression. Memoized by exact text. */
export function parseEmbeddedExpression(expressionText: string): EmbeddedBrightScriptText {
  const cached = expressionCache.get(expressionText);
  if (cached) return cached;

  const result = parseBrightScript(EXPRESSION_WRAPPER_PREFIX + expressionText + EXPRESSION_WRAPPER_SUFFIX);
  const parsed: EmbeddedBrightScriptText = { result, wrapperPrefixLength: EXPRESSION_WRAPPER_PREFIX.length };
  expressionCache.set(expressionText, parsed);
  return parsed;
}

/** Wraps `statementsText` as a sub body so this package's own brightscript-parser.ts can parse it as a sequence of statements. Memoized by exact text. */
export function parseEmbeddedStatements(statementsText: string): EmbeddedBrightScriptText {
  const cached = statementsCache.get(statementsText);
  if (cached) return cached;

  const result = parseBrightScript(STATEMENT_WRAPPER_PREFIX + statementsText + STATEMENT_WRAPPER_SUFFIX);
  const parsed: EmbeddedBrightScriptText = { result, wrapperPrefixLength: STATEMENT_WRAPPER_PREFIX.length };
  statementsCache.set(statementsText, parsed);
  return parsed;
}

/**
 * Wraps a `super(<args>)`'s raw argument-list text (e.g. `a, b` — never
 * itself a standalone expression once there's more than one argument, so
 * `parseEmbeddedExpression` can't be reused directly) with a synthetic
 * callee so this package's own brightscript-parser.ts can validate/parse it as a real
 * call's argument list. Same offset-translation contract as
 * `parseEmbeddedExpression`/`parseEmbeddedStatements` — subtract
 * `wrapperPrefixLength` from an inner position to land back on the original
 * (unwrapped) args text — so this is a drop-in `parseFn` for
 * `attachBrightScriptParse` in parser.ts. Memoized by exact text, same
 * reasoning as the other two wrap-and-parse helpers.
 */
export function parseEmbeddedCallArgs(rawArgsText: string): EmbeddedBrightScriptText {
  const cached = superArgsCache.get(rawArgsText);
  if (cached) return cached;

  const result = parseBrightScript(SUPER_ARGS_WRAPPER_PREFIX + rawArgsText + SUPER_ARGS_WRAPPER_SUFFIX);
  const parsed: EmbeddedBrightScriptText = { result, wrapperPrefixLength: SUPER_ARGS_WRAPPER_PREFIX.length };
  superArgsCache.set(rawArgsText, parsed);
  return parsed;
}

/** Splits a `parseEmbeddedCallArgs` result back into its individual argument texts (relative to `originalText`, the raw unwrapped args), each trimmed and safe to feed back through `parseEmbeddedExpression`/a rewrite pass on its own. Empty when the args text failed to parse as a call (already reported via `translateBrightScriptDiagnostics`) or had zero arguments. */
export function splitEmbeddedCallArgs(parsed: EmbeddedBrightScriptText, originalText: string): string[] {
  const offset = parsed.wrapperPrefixLength;
  const callNodes = findAll(parsed.result.root, BsSyntaxKind.BsCallExpression, (n) => new CallExpression(n));
  const callNode = callNodes[0];
  if (!callNode) return [];

  return callNode.args.map((arg) => {
    const firstToken = bsFirstToken(arg.syntax);
    const lastToken = bsLastToken(arg.syntax);
    if (!firstToken || !lastToken) return '';
    const start = Math.max(firstToken.pos - offset, 0);
    const end = Math.min(lastToken.end - offset, originalText.length);
    return originalText.slice(start, end).trim();
  });
}

export interface EmbeddedIdentifier {
  readonly name: string;
  /** Offset relative to the ORIGINAL (unwrapped) text. */
  readonly start: number;
  readonly end: number;
}

/**
 * Every top-level identifier in a parsed embedded expression (including the
 * callee name of a call expression, but NOT `.member` in a dot expression —
 * that's a token, not an IdentifierExpression node), with offsets relative
 * to the original unwrapped text.
 */
export function findTopLevelIdentifiers(parsed: EmbeddedBrightScriptText, originalText: string): EmbeddedIdentifier[] {
  const identifierNodes = findAll(parsed.result.root, BsSyntaxKind.BsIdentifierExpression, (node) => new IdentifierExpression(node));
  const offset = parsed.wrapperPrefixLength;

  const identifiers: EmbeddedIdentifier[] = [];
  for (const node of identifierNodes) {
    const token = node.nameToken;
    if (!token) continue;

    const start = token.pos - offset;
    const end = token.end - offset;
    if (start < 0 || end > originalText.length) continue; // a token from the wrapper itself, not the real content

    identifiers.push({ name: node.name, start, end });
  }
  return identifiers;
}

export interface GlobalPathAccess {
  /** The matched root identifier — `"store"` or `"theme"`, whichever of `rootNames` this chain starts with. */
  readonly root: string;
  /** The `.member` chain after the root, in order — e.g. `["colors", "primary"]` for `theme.colors.primary`. */
  readonly segments: readonly string[];
  /** Offsets of just the root token, relative to the ORIGINAL (unwrapped) text. */
  readonly rootStart: number;
  readonly rootEnd: number;
  /** Offset just past the end of the whole access, relative to the original text — includes the call's `(...)` when `isCallTarget`. */
  readonly chainEnd: number;
  /** True when this chain is the callee of a call expression (`store.setRange(min, max)`), not a plain read. */
  readonly isCallTarget: boolean;
  /** The call's argument list, joined with `, ` — convenience only. `null` when this isn't a call or has zero arguments. For an actual rewrite, prefer `callArgSpans` and re-process each argument individually — one can itself contain a nested `store.`/`theme.` access (`store.fn(store.x)`), which this flattened string does NOT reflect. */
  readonly callArgsText: string | null;
  /**
   * Per-argument `[start, end)` spans (relative to the original text), one
   * per call argument, in order — empty when not a call or the call has
   * zero arguments. Each span covers exactly one argument's own text and is
   * safe to slice out and recursively re-run `findGlobalPathAccesses`/a
   * rewrite pass over *individually* — unlike a single combined span over
   * the whole argument list, which would include the commas between
   * arguments and so would NOT reparse as a single valid expression once
   * there's more than one argument (`a, b` isn't a standalone expression).
   */
  readonly callArgSpans: readonly { readonly start: number; readonly end: number }[];
}

/**
 * Every `store.`/`theme.`-rooted BrightScript dot-chain in a parsed embedded
 * expression/statement — e.g. `store.count`, `theme.colors.primary`, or a
 * call `store.setRange(min, max)`. Unlike `findTopLevelIdentifiers` (which
 * deliberately skips `.member`), this walks the real `DotExpression`
 * (`.object`/`.member`) and `CallExpression` (`.callee`/`.args`) AST shapes
 * to see the chain's actual structure.
 *
 * Only attempts to flatten a chain at its outermost node — one whose parent
 * isn't itself using it as a `.object`/`.callee` base — so a chain broken by
 * an index or a nested call (`store.list[0].x`, `store.get().x`) can never
 * surface a truncated prefix (`store.list`, `store.get`) as if it were a
 * valid access on its own; the whole broken chain is silently skipped
 * instead (falls through to normal "unresolved" handling upstream), while
 * genuinely independent accesses elsewhere (call arguments, index
 * subscripts) are still found.
 */
export function findGlobalPathAccesses(parsed: EmbeddedBrightScriptText, rootNames: readonly string[], originalText: string): GlobalPathAccess[] {
  const offset = parsed.wrapperPrefixLength;
  const accesses: GlobalPathAccess[] = [];

  visitNode(parsed.result.root);
  return accesses;

  function isChainContinuation(node: BsSyntaxNode): boolean {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.kind !== BsSyntaxKind.BsDotExpression && parent.kind !== BsSyntaxKind.BsIndexExpression && parent.kind !== BsSyntaxKind.BsCallExpression) {
      return false;
    }
    return parent.childNodes[0] === node;
  }

  function visitNode(node: BsSyntaxNode): void {
    if (!isChainContinuation(node)) {
      if (node.kind === BsSyntaxKind.BsDotExpression) {
        if (tryFlattenChain(node, false, null)) return;
      } else if (node.kind === BsSyntaxKind.BsCallExpression) {
        const call = new CallExpression(node);
        const calleeSyntax = call.callee?.syntax;
        if (calleeSyntax?.kind === BsSyntaxKind.BsDotExpression) {
          if (tryFlattenChain(calleeSyntax, true, call)) {
            for (const arg of call.args) visitNode(arg.syntax);
            return;
          }
        }
      }
    }
    for (const child of node.children) {
      if (isBsSyntaxNode(child)) visitNode(child);
    }
  }

  /** Walks `dotNode`'s `.object` spine down to its root. Returns `true` iff it fully resolved to a `rootNames`-matching identifier followed only by plain `.member` hops — in which case the access (if any) has already been recorded. */
  function tryFlattenChain(dotNode: BsSyntaxNode, isCall: boolean, call: InstanceType<typeof CallExpression> | null): boolean {
    const members: string[] = [];
    let current: BsSyntaxNode = dotNode;

    while (current.kind === BsSyntaxKind.BsDotExpression) {
      const dot = new DotExpression(current);
      if (dot.isAttributeAccess) return false;
      members.unshift(dot.member);
      const objectNode = dot.object?.syntax;
      if (!objectNode) return false;
      current = objectNode;
    }

    if (current.kind !== BsSyntaxKind.BsIdentifierExpression) return false;

    const rootIdent = new IdentifierExpression(current);
    if (!rootNames.includes(rootIdent.name)) return false;

    const rootToken = rootIdent.nameToken;
    if (!rootToken) return false;

    const rootStart = rootToken.pos - offset;
    const rootEnd = rootToken.end - offset;
    // `.end` on a SyntaxNode includes trailing trivia of its last token (e.g. the
    // newline before the wrapper's `end sub`) — use the last real TOKEN's `.end`
    // instead, same reasoning `findTopLevelIdentifiers` uses token boundaries.
    let chainEnd = (bsLastToken(dotNode)?.end ?? dotNode.end) - offset;
    let isCallTarget = false;
    let callArgsText: string | null = null;
    const callArgSpans: { start: number; end: number }[] = [];

    if (isCall && call) {
      isCallTarget = true;
      const args = call.args;
      if (args.length > 0) {
        callArgsText = args.map((a) => a.getText().trim()).join(', ');
        for (const arg of args) {
          const firstArgToken = bsFirstToken(arg.syntax);
          const lastArgToken = bsLastToken(arg.syntax);
          if (firstArgToken && lastArgToken) {
            callArgSpans.push({ start: firstArgToken.pos - offset, end: lastArgToken.end - offset });
          }
        }
      }
      chainEnd = (bsLastToken(call.syntax)?.end ?? call.syntax.end) - offset;
    }

    if (rootStart < 0 || chainEnd > originalText.length) return true; // wrapper-only content — nothing to record, but this chain shape is still "resolved"

    accesses.push({ root: rootIdent.name, segments: members, rootStart, rootEnd, chainEnd, isCallTarget, callArgsText, callArgSpans });
    return true;
  }
}

export interface ComparisonAccess {
  /** `[start, end)` of the whole `<left> <op> <right>` span, relative to the ORIGINAL (unwrapped) text. */
  readonly start: number;
  readonly end: number;
  /** `'=='`, `'!='`, `'<'`, `'>'`, `'<='`, or `'>='`. */
  readonly operator: string;
  /** `true` for `!=`, `false` otherwise — kept for existing `==`/`!=` call sites; prefer `operator` for the widened operator set. */
  readonly isNegated: boolean;
  /** `[start, end)` of the left operand, relative to the original text — `null` only for a malformed comparison missing an operand (already reported as a parse diagnostic; never happens for a successfully-parsed `BsComparisonExpression`). */
  readonly leftSpan: { readonly start: number; readonly end: number } | null;
  readonly rightSpan: { readonly start: number; readonly end: number } | null;
}

/**
 * Every `==`/`!=`/`<`/`>`/`<=`/`>=` DSL-sugar comparison/relational in a
 * parsed embedded expression/statement, found via flash-parser's own
 * `BsComparisonExpression` node (`brightscript-parser.ts` parses these six
 * operators at the same precedence tier as real BrightScript `=`/`<>`, but
 * into this distinct node kind — see that file's own doc comment). Returns
 * EVERY comparison found, including ones nested inside another comparison's
 * own operand (`(a == b) == c`) or inside a call argument — unlike
 * `findGlobalPathAccesses`, this function does not itself decide which are
 * "top-level"; a caller that recursively re-rewrites each operand's own text
 * (as `packages/compiler/src/analysis/identifier-rewrite.ts`'s
 * `rewriteComparisons` does) only needs the outermost ones and filters
 * nested ones out itself, the same shape `dropNestedAccesses` already uses
 * for router-action calls.
 */
export function findComparisonExpressions(parsed: EmbeddedBrightScriptText, originalText: string): ComparisonAccess[] {
  const offset = parsed.wrapperPrefixLength;
  const nodes = findAll(parsed.result.root, BsSyntaxKind.BsComparisonExpression, (n) => new ComparisonExpression(n));

  const spanOf = (wrapped: BsAstNode | null): { start: number; end: number } | null => {
    if (!wrapped) return null;
    const first = bsFirstToken(wrapped.syntax);
    const last = bsLastToken(wrapped.syntax);
    if (!first || !last) return null;
    return { start: first.pos - offset, end: last.end - offset };
  };

  const accesses: ComparisonAccess[] = [];
  for (const node of nodes) {
    const first = bsFirstToken(node.syntax);
    const last = bsLastToken(node.syntax);
    if (!first || !last) continue;
    const start = first.pos - offset;
    const end = last.end - offset;
    if (start < 0 || end > originalText.length) continue; // wrapper-only content

    accesses.push({ start, end, operator: node.operator, isNegated: node.isNegated, leftSpan: spanOf(node.left), rightSpan: spanOf(node.right) });
  }
  return accesses;
}

export interface SafeNotAccess {
  /** `[start, end)` of the whole `!<operand>` span, relative to the ORIGINAL (unwrapped) text. */
  readonly start: number;
  readonly end: number;
  /** `[start, end)` of the operand, relative to the original text — `null` only for a malformed safe-NOT missing an operand (already reported as a parse diagnostic; never happens for a successfully-parsed `BsSafeNotExpression`). */
  readonly operandSpan: { readonly start: number; readonly end: number } | null;
}

/**
 * Every `!<operand>` DSL-sugar safe NOT in a parsed embedded expression/
 * statement, found via flash-parser's own `BsSafeNotExpression` node
 * (`brightscript-parser.ts` parses bare `!` at the same precedence tier as
 * real BrightScript `Not`, but into this distinct node kind — see that
 * file's own doc comment). Returns EVERY occurrence found, including ones
 * nested inside another safe-NOT's own operand (`!!x`) or inside a
 * comparison's operand (`!(a == b)`) — same "caller filters to top-level and
 * recursively re-rewrites each operand" shape `findComparisonExpressions`
 * already documents.
 */
export function findSafeNotExpressions(parsed: EmbeddedBrightScriptText, originalText: string): SafeNotAccess[] {
  const offset = parsed.wrapperPrefixLength;
  const nodes = findAll(parsed.result.root, BsSyntaxKind.BsSafeNotExpression, (n) => new SafeNotExpression(n));

  const spanOf = (wrapped: BsAstNode | null): { start: number; end: number } | null => {
    if (!wrapped) return null;
    const first = bsFirstToken(wrapped.syntax);
    const last = bsLastToken(wrapped.syntax);
    if (!first || !last) return null;
    return { start: first.pos - offset, end: last.end - offset };
  };

  const accesses: SafeNotAccess[] = [];
  for (const node of nodes) {
    const first = bsFirstToken(node.syntax);
    const last = bsLastToken(node.syntax);
    if (!first || !last) continue;
    const start = first.pos - offset;
    const end = last.end - offset;
    if (start < 0 || end > originalText.length) continue; // wrapper-only content

    accesses.push({ start, end, operandSpan: spanOf(node.operand) });
  }
  return accesses;
}

export interface ChainAccess {
  /** Offset, relative to the ORIGINAL (unwrapped) text, of the `.`/`@`/`[`/`(` operator token that begins this postfix hop — insert `'?'` immediately before it to make the hop optional (`?.`/`?@`/`?[`/`?(`). */
  readonly operatorStart: number;
}

/**
 * Every `.`/`@`/`[`/`(` postfix-access operator anywhere in a parsed embedded
 * expression/statement, found via flash-parser's own `BsDotExpression`/
 * `BsIndexExpression`/`BsCallExpression` node kinds — at every nesting depth
 * (call arguments, index subscripts, nested calls), since this walks every
 * matching node in the tree unconditionally, unlike
 * `findComparisonExpressions`/`findSafeNotExpressions`'s "caller filters to
 * top-level" shape.
 *
 * Deliberately excludes every operator token on the SPINE (the `.object`/
 * `.callee` link, walked from the write target down to its root) of:
 *   1. An assignment statement's own `.target` (`BsAssignmentStatement`).
 *   2. An increment/decrement statement's own operand (`x++`/`obj.count--`
 *      — parsed as a `BsExpressionStatement` ending in a `++`/`--` token).
 *   3. A bare void-context call statement (a `BsExpressionStatement` whose
 *      `.expression` is itself a `BsCallExpression`, its result discarded).
 * Roku's optional-chaining operators can't be used as an assignment target
 * or as a fully standalone call statement (see
 * developer.roku.com/dev/docs/expressions-variables-types, "Optional
 * chaining operators") — and a PARTIAL rewrite of these spines (chaining
 * every hop but the last) wouldn't add real safety anyway: if an earlier
 * optional hop short-circuits to `invalid`, the final plain write/call on it
 * still crashes. So the exclusion is the whole spine, not just its last
 * segment.
 *
 * A subscript expression inside an excluded `[...]`, or an argument inside
 * an excluded `(...)`, is never itself part of the excluded spine (only the
 * `.object`/`.callee` link is followed) — so `arr[getIndex().value] = x`'s
 * own `getIndex().value` is still found/returned normally; only the `[` that
 * forms `arr[...]`'s own write target is excluded.
 *
 * Also deliberately excludes a call whose callee is a BARE identifier —
 * `someFunction(...)` never becomes `someFunction?(...)`. Live-verified on a
 * real Roku device (sideload, not just `kopytko-brightscript-parser`'s own
 * validation): Roku's own compiler rejects `?(` on a plain global/built-in
 * function name ("the `?(` operator does not work on built-in or global
 * functions" — developer.roku.com/dev/docs/expressions-variables-types)
 * with a genuine install-time Compilation Failed, even nested inside a
 * larger expression (an AA-literal value, a call argument) where `?(`
 * would otherwise be legal. `?(` is only ever meaningful, and only ever
 * emitted, when the callee is itself a chain (`obj.method?()`,
 * `arr[i]?()`, `obj?.method?()`) — a receiver that could plausibly be
 * `invalid` — never a bare function-name call.
 */
export function findChainAccesses(parsed: EmbeddedBrightScriptText, originalText: string): ChainAccess[] {
  const offset = parsed.wrapperPrefixLength;
  const excludedOperatorPositions = new Set<number>(); // excluded operator tokens' `.pos`, in WRAPPED coordinates

  function excludeSpine(node: BsSyntaxNode | undefined): void {
    let current = node;
    while (current) {
      if (current.kind === BsSyntaxKind.BsDotExpression) {
        const dot = new DotExpression(current);
        const op = current.findToken(TokenKind.Dot) ?? current.findToken(TokenKind.At);
        if (op) excludedOperatorPositions.add(op.pos);
        current = dot.object?.syntax;
      } else if (current.kind === BsSyntaxKind.BsIndexExpression) {
        const idx = new IndexExpression(current);
        const op = current.findToken(TokenKind.LBracket);
        if (op) excludedOperatorPositions.add(op.pos);
        current = idx.object?.syntax;
      } else if (current.kind === BsSyntaxKind.BsCallExpression) {
        const call = new CallExpression(current);
        const op = call.argumentList?.syntax.findToken(TokenKind.LParen);
        if (op) excludedOperatorPositions.add(op.pos);
        current = call.callee?.syntax;
      } else {
        break;
      }
    }
  }

  for (const assignment of findAll(parsed.result.root, BsSyntaxKind.BsAssignmentStatement, (n) => new AssignmentStatement(n))) {
    excludeSpine(assignment.target?.syntax);
  }
  for (const exprStmt of findAll(parsed.result.root, BsSyntaxKind.BsExpressionStatement, (n) => new ExpressionStatement(n))) {
    const isIncrementOrDecrement = exprStmt.syntax.findToken(TokenKind.PlusPlus) ?? exprStmt.syntax.findToken(TokenKind.MinusMinus);
    if (isIncrementOrDecrement) {
      excludeSpine(exprStmt.expression?.syntax);
    } else if (exprStmt.expression?.syntax.kind === BsSyntaxKind.BsCallExpression) {
      excludeSpine(exprStmt.expression.syntax);
    }
  }

  const results: ChainAccess[] = [];
  const record = (token: Token | undefined): void => {
    if (!token || excludedOperatorPositions.has(token.pos)) return;
    const at = token.pos - offset;
    if (at < 0 || at > originalText.length) return; // wrapper-only content
    results.push({ operatorStart: at });
  };

  for (const node of findAll(parsed.result.root, BsSyntaxKind.BsDotExpression, (n) => new DotExpression(n))) {
    record(node.syntax.findToken(TokenKind.Dot) ?? node.syntax.findToken(TokenKind.At));
  }
  for (const node of findAll(parsed.result.root, BsSyntaxKind.BsIndexExpression, (n) => new IndexExpression(n))) {
    record(node.syntax.findToken(TokenKind.LBracket));
  }
  for (const node of findAll(parsed.result.root, BsSyntaxKind.BsCallExpression, (n) => new CallExpression(n))) {
    if (node.callee?.syntax.kind === BsSyntaxKind.BsIdentifierExpression) continue; // bare function-name call — see doc comment above
    record(node.argumentList?.syntax.findToken(TokenKind.LParen));
  }

  return results.sort((a, b) => a.operatorStart - b.operatorStart);
}

export interface AnonymousFunctionAccess {
  /** `[start, end)` of the whole `function (...) [: Type] { ... }` span, relative to the ORIGINAL (unwrapped) text. */
  readonly start: number;
  readonly end: number;
  /** The raw `AnonymousFunctionExpression` CST node — wrap with flash-parser's own `AnonymousFunctionExpression` AST class (from `ast.ts`, re-exported from `index.ts`) to read `.parameters`/`.returnType`/`.block`, the same class `StateAssignment.rhs`/`AnonymousFunctionAssignmentStatement.value` already return for Tier 1. Not wrapped here to avoid an `embedded.ts` -> `ast.ts` import (which already imports `embedded.ts` itself). */
  readonly node: BsSyntaxNode;
}

/**
 * Every OUTERMOST Tier-2 `AnonymousFunctionExpression` in a parsed embedded expression/statement
 * — found via flash-parser's own `brightscript-parser.ts` production, wired into its general
 * expression grammar (see GRAMMAR.md's "Anonymous function expressions" section) so this can
 * appear at any nested depth: a call argument, an operand, a condition, ... Unlike
 * `findComparisonExpressions`, this DOES filter to top-level-only occurrences — an anon function
 * nested inside another one's own body is handled when the OUTER one is recursively printed
 * (`packages/compiler/src/codegen/brs-emitter.ts`'s `printAnonymousFunctionExpression`
 * re-triggers this same lowering for its own body's `ExpressionRegion`/`StatementRegion`
 * children), so surfacing the inner one here too would double-hoist it and corrupt the outer
 * span's own splice.
 */
export function findAnonymousFunctionExpressions(parsed: EmbeddedBrightScriptText, originalText: string): AnonymousFunctionAccess[] {
  const offset = parsed.wrapperPrefixLength;
  const nodes = findAll(parsed.result.root, BsSyntaxKind.AnonymousFunctionExpression, (n) => n);

  const all: AnonymousFunctionAccess[] = [];
  for (const node of nodes) {
    const first = bsFirstToken(node);
    const last = bsLastToken(node);
    if (!first || !last) continue;
    const start = first.pos - offset;
    const end = last.end - offset;
    if (start < 0 || end > originalText.length) continue; // wrapper-only content
    all.push({ start, end, node });
  }

  return all.filter((access) => !all.some((other) => other !== access && other.start <= access.start && other.end >= access.end));
}

export interface MemberAccess {
  /** The member name after the dot — e.g. `"a"` for `m.a`. */
  readonly name: string;
  /** Offsets of just the member-name token, relative to the ORIGINAL (unwrapped) text. */
  readonly nameStart: number;
  readonly nameEnd: number;
  /** Offsets of just the root token (`rootName` itself, e.g. `m`), relative to the ORIGINAL (unwrapped) text — lets a caller splice the root too (e.g. `m` → `self` inside a generated `private_constructor`), not just the member name. */
  readonly rootStart: number;
  readonly rootEnd: number;
}

/**
 * Every `<rootName>.<name>` member access in a parsed embedded
 * expression/statement — used to rewrite a class method/constructor body's
 * explicit `m.<name>` (or, inside the generated `private_constructor`
 * helper, `self.<name>`) references to `<rootName>.private_<name>` for a
 * declared private member (see GRAMMAR.md's "class declarations" section —
 * unlike `.thr` field/derived/state, class-member access is always
 * explicit in DSL source, never auto-rewritten from a bare name).
 *
 * Deliberately much simpler than `findGlobalPathAccesses`: only the
 * immediate first hop after a bare `rootName` is ever recorded, and every
 * `DotExpression` in the tree is inspected independently rather than
 * flattening whole chains from their outermost node. `m.a.b` therefore
 * naturally matches only the `.a` hop — `.b`'s `.object` is a
 * `DotExpression`, not a bare `rootName` identifier, so it's left
 * untouched, exactly right since only `.a` is a class-member access and
 * `.b` is a plain member of whatever `.a` evaluates to. A call target
 * (`m.foo(x)`) and an assignment target (`m.a = x`) both fall out of the
 * same generic walk for free, since neither is special-cased.
 */
export function findMemberAccesses(parsed: EmbeddedBrightScriptText, rootName: string, originalText: string): MemberAccess[] {
  const offset = parsed.wrapperPrefixLength;
  const accesses: MemberAccess[] = [];

  visit(parsed.result.root);
  return accesses;

  function visit(node: BsSyntaxNode): void {
    if (node.kind === BsSyntaxKind.BsDotExpression) {
      const dot = new DotExpression(node);
      if (!dot.isAttributeAccess) {
        const objectNode = dot.object?.syntax;
        if (objectNode?.kind === BsSyntaxKind.BsIdentifierExpression) {
          const rootIdent = new IdentifierExpression(objectNode);
          if (rootIdent.name === rootName) {
            const rootToken = rootIdent.nameToken;
            const memberToken = bsLastToken(node);
            if (rootToken && memberToken) {
              const rootStart = rootToken.pos - offset;
              const rootEnd = rootToken.end - offset;
              const nameStart = memberToken.pos - offset;
              const nameEnd = memberToken.end - offset;
              if (rootStart >= 0 && nameEnd <= originalText.length) {
                accesses.push({ name: dot.member, nameStart, nameEnd, rootStart, rootEnd });
              }
            }
          }
        }
      }
    }
    for (const child of node.children) {
      if (isBsSyntaxNode(child)) visit(child);
    }
  }
}

/** Translates a wrapped-BrightScript-parse's diagnostics into the outer `.thr` source's coordinate space. `outerOffset` is where the unwrapped text starts in that outer source. */
export function translateBrightScriptDiagnostics(
  parsed: EmbeddedBrightScriptText,
  outerOffset: number,
): { message: string; pos: number; end: number; line: number }[] {
  return parsed.result.diagnostics.map((d: BrightScriptParseDiagnostic) => ({
    message: d.message,
    pos: outerOffset + Math.max(d.pos - parsed.wrapperPrefixLength, 0),
    end: outerOffset + Math.max(d.end - parsed.wrapperPrefixLength, 0),
    line: d.line,
  }));
}

export interface RootCallExpressionShape {
  /** `[start, end)` span of the callee (whatever comes before the outermost `(`), relative to the original (unwrapped) text — a bare identifier or a dot-chain, either way just sliced and re-rewritten as its own independent text, same treatment `splitEmbeddedCallArgs` already gives each argument. */
  readonly calleeSpan: { readonly start: number; readonly end: number };
  /** One `[start, end)` span per existing argument, in order, relative to the original text — empty for a zero-argument call. */
  readonly argSpans: readonly { readonly start: number; readonly end: number }[];
}

/**
 * `on:key[...]="{expr}"` requires `expr` to be a single call expression at
 * its root (e.g. `selectItem(item)`, not `selectItem(item) + 1` or a bare
 * identifier) — the compiler injects `key`/`press` as the call's first two
 * arguments (see `analysis/key-bindings.ts` in packages/compiler). Returns
 * `null` when the parsed expression's root value is not, structurally, a
 * single `CallExpression` — a bare identifier, a binary/unary expression, a
 * member access with no trailing call, etc. Reuses the same synthetic
 * `ft_result = <expr>` wrapper every `parseEmbeddedExpression` result
 * already has, so the "root value" is exactly that assignment's own
 * `.value` — mirrors `splitEmbeddedCallArgs`'s span-extraction approach
 * (callee and each argument sliced independently from the original text, so
 * each can be fed back through `parseEmbeddedExpression`/a rewrite pass on
 * its own) rather than one combined span that would include the parens/
 * commas and so wouldn't reparse as a standalone expression.
 */
export function findRootCallExpression(parsed: EmbeddedBrightScriptText, originalText: string): RootCallExpressionShape | null {
  const offset = parsed.wrapperPrefixLength;
  const assignments = findAll(parsed.result.root, BsSyntaxKind.BsAssignmentStatement, (n) => new AssignmentStatement(n));
  const assignment = assignments[0];
  if (!assignment) return null;

  const value = assignment.value;
  if (!value || value.syntax.kind !== BsSyntaxKind.BsCallExpression) return null;

  const call = new CallExpression(value.syntax);
  const callee = call.callee;
  if (!callee) return null;

  const calleeFirst = bsFirstToken(callee.syntax);
  const calleeLast = bsLastToken(callee.syntax);
  if (!calleeFirst || !calleeLast) return null;

  const calleeSpan = { start: Math.max(calleeFirst.pos - offset, 0), end: Math.min(calleeLast.end - offset, originalText.length) };
  const argSpans = call.args.map((arg) => {
    const first = bsFirstToken(arg.syntax);
    const last = bsLastToken(arg.syntax);
    if (!first || !last) return { start: 0, end: 0 };
    return { start: Math.max(first.pos - offset, 0), end: Math.min(last.end - offset, originalText.length) };
  });

  return { calleeSpan, argSpans };
}

export interface StreamSubscribeBoundReference {
  /** `[start, end)` of the whole call argument — the bare `<target>.<action>` expression — relative to the ORIGINAL (unwrapped) text. This is what a caller splices `{ target: <rewritten target>, action: "<action>" }` into. */
  readonly argStart: number;
  readonly argEnd: number;
  /** `[start, end)` of just the target sub-expression (everything before the final `.`), relative to the original text — sliced out and independently re-rewritten by the caller, the same "slice, recurse, splice" shape `findComparisonExpressions`'s `leftSpan`/`rightSpan` already use. */
  readonly targetStart: number;
  readonly targetEnd: number;
  /** The bare method/member name after the final dot — used as a string literal, never itself rewritten (it's a BrightScript AA key, not a DSL identifier). */
  readonly action: string;
}

/**
 * Every `<receiver>.subscribe(<target>.<action>)` call in a parsed embedded expression/statement,
 * where the sole argument is itself a BARE member access (no trailing call parens) — the DSL sugar
 * for passing a bound method reference to the `stream` primitive's `.subscribe(...)` (see
 * GRAMMAR.md's "`stream`" section and `findings/streams.md`'s writeup on why a bare Function value
 * does not reliably survive being stored and invoked later once detached from a real SceneGraph
 * node). Deliberately scoped to the LITERAL method name `subscribe` and this exact single-bare-
 * member-access-argument shape — the compiler has no cross-object type information to confirm
 * `<receiver>` is actually a stream, so this is a syntactic pattern match, same "trust the shape,
 * don't try to type-check it" precedent `on:key[...]`'s `findRootCallExpression`/this DSL's whole
 * `.emit`/`.subscribe` treatment already sets (see GRAMMAR.md's "`stream`" section: "ordinary
 * method calls, not special DSL grammar"). `<target>` may be any expression (`m`, `self`, a local
 * variable holding another instance, a nested field access, ...) — only the call's own shape
 * matters, not what `<target>` evaluates to.
 *
 * Does NOT match `.subscribe(function (...) { ... })` (an anonymous function, not a DotExpression)
 * or `.subscribe(someCall())` (a CallExpression, not a bare member access) — both pass through
 * completely unaffected, exactly as before this sugar existed.
 */
export function findStreamSubscribeBoundReferences(parsed: EmbeddedBrightScriptText, originalText: string): StreamSubscribeBoundReference[] {
  const offset = parsed.wrapperPrefixLength;
  const calls = findAll(parsed.result.root, BsSyntaxKind.BsCallExpression, (n) => new CallExpression(n));

  const results: StreamSubscribeBoundReference[] = [];
  for (const call of calls) {
    const callee = call.callee;
    if (!callee || callee.syntax.kind !== BsSyntaxKind.BsDotExpression) continue;
    const calleeDot = new DotExpression(callee.syntax);
    if (calleeDot.isAttributeAccess || calleeDot.member !== 'subscribe') continue;
    if (call.args.length !== 1) continue;

    const arg = call.args[0];
    if (arg.syntax.kind !== BsSyntaxKind.BsDotExpression) continue;
    const argDot = new DotExpression(arg.syntax);
    if (argDot.isAttributeAccess) continue;

    const argFirst = bsFirstToken(arg.syntax);
    const argLast = bsLastToken(arg.syntax);
    if (!argFirst || !argLast) continue;
    const argStart = argFirst.pos - offset;
    const argEnd = argLast.end - offset;
    if (argStart < 0 || argEnd > originalText.length) continue; // wrapper-only content

    const target = argDot.object;
    if (!target) continue;
    const targetFirst = bsFirstToken(target.syntax);
    const targetLast = bsLastToken(target.syntax);
    if (!targetFirst || !targetLast) continue;

    results.push({
      argStart,
      argEnd,
      targetStart: targetFirst.pos - offset,
      targetEnd: targetLast.end - offset,
      action: argDot.member,
    });
  }

  return results;
}

export interface AnimationControlCallMatch {
  /** `[start, end)` of the whole `<name>.<method>()` call — the entire span a caller splices its BrightScript replacement into — relative to the ORIGINAL (unwrapped) text. */
  readonly calleeStart: number;
  readonly calleeEnd: number;
  /** The bare identifier before the dot — a script-declared `animation <name> { ... }`'s own name. */
  readonly animationName: string;
  /** One of `start`/`stop`/`pause`/`resume`/`finish` — matches Roku's own `AnimationBase.control` field values 1:1. */
  readonly method: string;
}

const ANIMATION_CONTROL_METHODS = new Set(['start', 'stop', 'pause', 'resume', 'finish']);

/**
 * Every `<name>.<method>()` call in a parsed embedded expression/statement, where `<name>` is a
 * BARE identifier (never a further dot-chain — `x.y.start()` does not match, only a directly-named
 * script-level `animation` declaration can ever be triggered this way) and `<method>` is one of
 * `ANIMATION_CONTROL_METHODS`, with ZERO call arguments (unlike `.subscribe`'s exactly-one). Same
 * "trust the shape, don't try to type-check it" syntactic pattern match `findStreamSubscribeBound
 * References` already establishes — the compiler has no cross-object type information to confirm
 * `<name>` is actually a declared `animation`, so callers filter these matches against the known
 * `animationNames` set themselves (see `packages/compiler/src/analysis/identifier-rewrite.ts`).
 */
export function findAnimationControlCalls(parsed: EmbeddedBrightScriptText, originalText: string): AnimationControlCallMatch[] {
  const offset = parsed.wrapperPrefixLength;
  const calls = findAll(parsed.result.root, BsSyntaxKind.BsCallExpression, (n) => new CallExpression(n));

  const results: AnimationControlCallMatch[] = [];
  for (const call of calls) {
    const callee = call.callee;
    if (!callee || callee.syntax.kind !== BsSyntaxKind.BsDotExpression) continue;
    const calleeDot = new DotExpression(callee.syntax);
    if (calleeDot.isAttributeAccess || !ANIMATION_CONTROL_METHODS.has(calleeDot.member)) continue;
    if (call.args.length !== 0) continue;

    const object = calleeDot.object;
    if (!object || object.syntax.kind !== BsSyntaxKind.BsIdentifierExpression) continue;
    const nameIdent = new IdentifierExpression(object.syntax);

    const nameFirst = bsFirstToken(object.syntax);
    const callLast = bsLastToken(call.syntax);
    if (!nameFirst || !callLast) continue;
    const calleeStart = nameFirst.pos - offset;
    const calleeEnd = callLast.end - offset;
    if (calleeStart < 0 || calleeEnd > originalText.length) continue; // wrapper-only content

    results.push({ calleeStart, calleeEnd, animationName: nameIdent.name, method: calleeDot.member });
  }

  return results;
}

export interface AnimationOnFinishCallMatch {
  /** `[start, end)` of the whole `<name>.onFinish(<callback>)` call, relative to the ORIGINAL (unwrapped) text — the entire span a caller splices its BrightScript replacement into. */
  readonly calleeStart: number;
  readonly calleeEnd: number;
  /** The bare identifier before the dot — a script-declared `animation <name> { ... }`'s own name. */
  readonly animationName: string;
  /** `[start, end)` of the sole callback argument, relative to the original text — sliced out and independently re-rewritten by the caller (it may itself reference other script identifiers, or be an inline anonymous function), the same "slice, recurse, splice" contract as `GlobalPathAccess.callArgSpans`. Always exactly one entry — `onFinish` takes exactly one argument. */
  readonly argStart: number;
  readonly argEnd: number;
}

/**
 * Every `<name>.onFinish(<callback>)` call in a parsed embedded expression/statement, where `<name>`
 * is a BARE identifier (never a further dot-chain, same restriction `findAnimationControlCalls`
 * applies) with exactly ONE call argument — unlike `ANIMATION_CONTROL_METHODS`'s zero-arg trigger
 * sugar (`.start()`/.../`.finish()`), which this deliberately does NOT fold `onFinish` into, since
 * the two shapes (zero args vs. one arg needing its own recursive rewrite) don't share a matcher
 * cleanly. Same "trust the shape, don't try to type-check it" discipline as `findAnimationControlCalls`
 * — callers filter these matches against the known `animationNames` set themselves (see
 * `packages/compiler/src/analysis/identifier-rewrite.ts`).
 */
export function findAnimationOnFinishCalls(parsed: EmbeddedBrightScriptText, originalText: string): AnimationOnFinishCallMatch[] {
  const offset = parsed.wrapperPrefixLength;
  const calls = findAll(parsed.result.root, BsSyntaxKind.BsCallExpression, (n) => new CallExpression(n));

  const results: AnimationOnFinishCallMatch[] = [];
  for (const call of calls) {
    const callee = call.callee;
    if (!callee || callee.syntax.kind !== BsSyntaxKind.BsDotExpression) continue;
    const calleeDot = new DotExpression(callee.syntax);
    if (calleeDot.isAttributeAccess || calleeDot.member !== 'onFinish') continue;
    if (call.args.length !== 1) continue;

    const object = calleeDot.object;
    if (!object || object.syntax.kind !== BsSyntaxKind.BsIdentifierExpression) continue;
    const nameIdent = new IdentifierExpression(object.syntax);

    const nameFirst = bsFirstToken(object.syntax);
    const callLast = bsLastToken(call.syntax);
    if (!nameFirst || !callLast) continue;
    const calleeStart = nameFirst.pos - offset;
    const calleeEnd = callLast.end - offset;
    if (calleeStart < 0 || calleeEnd > originalText.length) continue; // wrapper-only content

    const arg = call.args[0];
    const argFirst = bsFirstToken(arg.syntax);
    const argLast = bsLastToken(arg.syntax);
    if (!argFirst || !argLast) continue;
    const argStart = argFirst.pos - offset;
    const argEnd = argLast.end - offset;
    if (argStart < 0 || argEnd > originalText.length) continue; // wrapper-only content

    results.push({ calleeStart, calleeEnd, animationName: nameIdent.name, argStart, argEnd });
  }

  return results;
}

export interface GlobalFunctionCallMatch {
  /** The matched callee name — one of the `functionNames` passed in. */
  readonly name: string;
  /** `[start, end)` of the WHOLE call (`name(...)`, closing paren included), relative to the ORIGINAL (unwrapped) text. */
  readonly start: number;
  readonly end: number;
  /** Per-argument `[start, end)` spans, relative to the original text — same "slice, recurse, splice" contract as `GlobalPathAccess.callArgSpans`. */
  readonly argSpans: readonly { readonly start: number; readonly end: number }[];
}

/**
 * Every BARE `<name>(...)` call in a parsed embedded expression/statement, where `<name>` is a
 * plain `IdentifierExpression` callee (never a `DotExpression` — `obj.setTimeout()` is a completely
 * different shape and is NOT matched) matching one of `functionNames`. The un-dotted sibling of
 * `findGlobalPathAccesses` — that one walks a `<root>.<member>` chain; this one walks a bare
 * `<name>(...)` call with no receiver at all, which `setTimeout`/`setInterval`/`clearTimeout`/
 * `clearInterval` need since they are deliberately NOT namespaced (a namespaced
 * `taskManager.run(...)`-style call would already be covered by `findGlobalPathAccesses`; these are
 * bare globals, JS-`setTimeout`-shaped on purpose — see `packages/compiler/GRAMMAR.md`'s "Timer
 * statements" section). Same "trust the shape, don't try to type-check it" discipline as
 * `findAnimationControlCalls` — the compiler has no cross-scope information to confirm `<name>`
 * genuinely refers to the reserved global and not some other value, so a caller filters/validates
 * separately (see `packages/compiler/src/analysis/binding-collisions.ts`'s
 * `checkReservedGlobalFunctionNames`, which rejects any DSL declaration that would shadow one of
 * these names in the first place).
 */
export function findGlobalFunctionCalls(parsed: EmbeddedBrightScriptText, functionNames: readonly string[], originalText: string): GlobalFunctionCallMatch[] {
  const offset = parsed.wrapperPrefixLength;
  const calls = findAll(parsed.result.root, BsSyntaxKind.BsCallExpression, (n) => new CallExpression(n));

  const results: GlobalFunctionCallMatch[] = [];
  for (const call of calls) {
    const callee = call.callee;
    if (!callee || callee.syntax.kind !== BsSyntaxKind.BsIdentifierExpression) continue;
    const nameIdent = new IdentifierExpression(callee.syntax);
    if (!functionNames.includes(nameIdent.name)) continue;

    const nameFirst = bsFirstToken(callee.syntax);
    const callLast = bsLastToken(call.syntax);
    if (!nameFirst || !callLast) continue;
    const start = nameFirst.pos - offset;
    const end = callLast.end - offset;
    if (start < 0 || end > originalText.length) continue; // wrapper-only content

    // Deliberately walks the RAW argument-list syntax nodes directly, never `call.args`
    // (`BsCallExpression.args`/`BsArgumentList.args`) — those go through `wrapBrightScriptNode`,
    // which returns `null` (silently DROPPED by `.filter()`) for a node kind it has no wrapper
    // class for, and an `AnonymousFunctionExpression` argument (`setTimeout(function() {...}, ms)`,
    // the exact shape this feature needs to support) is exactly such a kind — it belongs to this
    // DSL's own statement grammar, not `brightscript-ast.ts`'s wrapped node catalog. Only span
    // boundaries are needed here, not a semantic wrapper, so reading each raw child node's own
    // first/last token directly sidesteps the gap entirely.
    const argListNode = call.syntax.findChild(BsSyntaxKind.BsArgumentList);
    const argSpans = (argListNode?.childNodes ?? []).map((argNode) => {
      const argFirst = bsFirstToken(argNode);
      const argLast = bsLastToken(argNode);
      if (!argFirst || !argLast) return { start: 0, end: 0 };
      return { start: argFirst.pos - offset, end: argLast.end - offset };
    });

    results.push({ name: nameIdent.name, start, end, argSpans });
  }

  return results;
}

export interface EmbeddedXmlText {
  readonly result: XmlParseResult;
}

/** Parses `.thr` template markup as XML. Not memoized — a `.thr` file has exactly one template section, parsed exactly once. */
export function parseEmbeddedTemplate(markup: string): EmbeddedXmlText {
  return { result: parseXml(markup) };
}
