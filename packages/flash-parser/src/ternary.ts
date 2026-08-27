/**
 * Ternary detection and structural parsing — `<condition> ? <whenTrue> : <whenFalse>`, DSL-only
 * syntax with no BrightScript equivalent. Mirrors embedded.ts's style: a small, self-contained
 * module the parser delegates to, not a method on `TokenStreamParser` itself (no `this` needed
 * beyond a `ParseDiagnostic[]` sink, passed explicitly).
 *
 * Detection never needs to understand BrightScript's own expression grammar — `?` is not valid
 * BrightScript expression syntax anywhere (kopytko-brightscript-parser only recognizes a leading
 * `?` as a statement-level print shorthand, never inside an expression), so its mere presence at
 * "this bracket-nesting level" is enough to know a ternary was attempted here, before any
 * BrightScript parse is ever attempted on the surrounding text. Finding the *matching* `:` for a
 * given `?` is pure bracket-depth + "ternary-depth" counting (the same style
 * `TokenStreamParser.findMatchingParen`/`findMatchingBrace` already use for DSL punctuation) — a
 * depth-0 `?` increments a counter, a depth-0 `:` decrements it, and the first `:` that brings the
 * counter back to 0 is the match for the very first `?`. This one rule resolves both an
 * unparenthesized chain in the false branch (`c1 ? a : c2 ? b : c`) and unparenthesized nesting in
 * the true branch (`c1 ? c2 ? a : b : c`) correctly, with zero operator-precedence knowledge.
 */
import { TokenKind } from './tokenKind.js';
import { Token } from './token.js';
import { SyntaxKind } from './syntaxKind.js';
import { SyntaxChild, SyntaxNode } from './syntaxNode.js';
import { ParseDiagnostic } from './diagnostics.js';
import { parseEmbeddedExpression, translateBrightScriptDiagnostics } from './embedded.js';

function isOpenBracket(kind: TokenKind): boolean {
  return kind === TokenKind.LParen || kind === TokenKind.LBrace || kind === TokenKind.LBracket;
}

function isCloseBracket(kind: TokenKind): boolean {
  return kind === TokenKind.RParen || kind === TokenKind.RBrace || kind === TokenKind.RBracket;
}

function matchingCloseKind(openKind: TokenKind): TokenKind {
  if (openKind === TokenKind.LParen) return TokenKind.RParen;
  if (openKind === TokenKind.LBrace) return TokenKind.RBrace;
  return TokenKind.RBracket;
}

/** `-1` for `end` means "unterminated — ran off the end of `tokens` with the bracket still open." Operates on a local token array (not a parser's global token stream), so indices are relative to `tokens` itself. */
function findMatchingBracketIndex(tokens: readonly Token[], openIndex: number): number {
  const closeKind = matchingCloseKind(tokens[openIndex].kind);
  const openKind = tokens[openIndex].kind;
  let depth = 1;
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const kind = tokens[i].kind;
    if (kind === openKind) depth++;
    else if (kind === closeKind) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface TernarySplit {
  readonly questionIndex: number;
  /** `-1` means this `?` has no matching top-level `:` anywhere in `tokens` — an unterminated ternary. */
  readonly colonIndex: number;
}

/**
 * Finds the outermost ternary split in `tokens`, if any — the first bracket-depth-0 `?` and its
 * matching bracket-depth-0 `:` (tracked via a separate "ternary-depth" counter so a nested,
 * unparenthesized `?`/`:` pair — in either the true or false branch — is correctly skipped over
 * rather than mistaken for the outer ternary's own closing `:`). Returns `null` only when there is
 * no depth-0 `?` at all in `tokens` — i.e. no ternary is attempted at this level (there may still
 * be one nested inside a bracketed sub-span; see `containsTernaryAnywhere`).
 */
export function findTopLevelTernarySplit(tokens: readonly Token[]): TernarySplit | null {
  let bracketDepth = 0;
  let questionIndex = -1;
  let ternaryDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const kind = tokens[i].kind;

    if (isOpenBracket(kind)) {
      bracketDepth++;
      continue;
    }
    if (isCloseBracket(kind)) {
      if (bracketDepth > 0) bracketDepth--;
      continue;
    }
    if (bracketDepth > 0) continue;

    if (kind === TokenKind.Question) {
      if (questionIndex === -1) questionIndex = i;
      ternaryDepth++;
    } else if (kind === TokenKind.Colon && questionIndex !== -1) {
      ternaryDepth--;
      if (ternaryDepth === 0) return { questionIndex, colonIndex: i };
    }
  }

  return questionIndex === -1 ? null : { questionIndex, colonIndex: -1 };
}

/** True if a ternary is attempted anywhere in `tokens` — at this level, or nested inside any bracketed sub-span. Used as the cheap, non-consuming lookahead that decides whether a plain assignment's right-hand side is worth structurally parsing as ternary-capable at all (a ternary-free assignment must stay a byte-identical opaque `StatementRegion`/`ExpressionRegion` — see findings/operators-ternary.md). */
export function containsTernaryAnywhere(tokens: readonly Token[]): boolean {
  if (findTopLevelTernarySplit(tokens) !== null) return true;

  for (let i = 0; i < tokens.length; i++) {
    if (isOpenBracket(tokens[i].kind)) {
      const closeIndex = findMatchingBracketIndex(tokens, i);
      const innerEnd = closeIndex === -1 ? tokens.length : closeIndex;
      if (containsTernaryAnywhere(tokens.slice(i + 1, innerEnd))) return true;
      i = innerEnd;
    }
  }

  return false;
}

function attachExpressionParse(node: SyntaxNode, diagnostics: ParseDiagnostic[]): void {
  const raw = node.getText();
  const text = raw.trim();
  if (text.length === 0) return;

  const leadingWs = raw.length - raw.trimStart().length;
  const offset = node.pos + leadingWs;
  const parsed = parseEmbeddedExpression(text);
  node.embedded = { kind: 'brightscript', result: parsed.result, offset };

  for (const d of translateBrightScriptDiagnostics(parsed, offset)) {
    diagnostics.push({ code: 'expression/parse-error', message: d.message, pos: d.pos, end: d.end, line: d.line });
  }
}

function makeLeafExpressionRegion(tokens: Token[], diagnostics: ParseDiagnostic[]): SyntaxNode {
  const node = new SyntaxNode(SyntaxKind.ExpressionRegion, tokens);
  attachExpressionParse(node, diagnostics);
  return node;
}

/**
 * Splits `tokens` on top-level (bracket-depth-0 relative to `tokens` itself) commas and builds
 * each segment independently — the content of a call's argument list or an array/AA literal is a
 * comma-separated list of otherwise-independent expression slots, and a ternary found in one slot
 * must never be allowed to swallow a sibling slot's own tokens (a naive single
 * `buildTernaryCapableExpression` call over the whole un-split content would, since a ternary's
 * `:` has no notion of "argument boundary" — confirmed by a real failing case,
 * `foo(a, cond ? b : c, d)`, where the un-split approach absorbed the trailing `, d` into the
 * ternary's own false branch). A ternary-free segment is pushed as plain raw tokens, exactly like
 * `buildTernaryOperand`'s own raw runs — only a segment that actually contains a ternary gets
 * wrapped. Does not attempt to special-case an AA literal's `key:` prefix (a colon there is a
 * different grammar production from a ternary's own `:`, indistinguishable from this module's
 * pure token-depth-counting approach without reimplementing AA-literal grammar) — an AA value that
 * is itself a ternary works (`{a: cond ? 1 : 2}` has no top-level comma to mis-split on), but a
 * ternary sitting immediately after a bare `key:` prefix is a known, accepted limitation.
 */
function buildCommaSeparatedTernaryChildren(tokens: readonly Token[], diagnostics: ParseDiagnostic[]): SyntaxChild[] {
  const children: SyntaxChild[] = [];
  let segmentStart = 0;
  let depth = 0;

  const flushSegment = (end: number): void => {
    const segment = tokens.slice(segmentStart, end);
    if (segment.length === 0) return;
    if (containsTernaryAnywhere(segment)) {
      children.push(buildTernaryCapableExpression(segment.slice(), diagnostics));
    } else {
      children.push(...segment);
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const kind = tokens[i].kind;
    if (isOpenBracket(kind)) {
      depth++;
      continue;
    }
    if (isCloseBracket(kind)) {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && kind === TokenKind.Comma) {
      flushSegment(i);
      children.push(tokens[i]);
      segmentStart = i + 1;
    }
  }
  flushSegment(tokens.length);

  return children;
}

/**
 * The "opaque template with embedded ternary holes" shape, for a ternary nested somewhere inside a
 * larger expression (`x = 1 + (cond ? a : b)`) rather than being the expression's own outermost
 * form. Interleaves raw tokens (kept exactly as-is — including any ternary-free bracketed
 * sub-span, left completely untouched) with nested `TernaryExpression`/`TernaryOperand` children
 * for whichever bracketed sub-span(s) actually contain a ternary. Deliberately does NOT attach an
 * eager BrightScript parse of its own combined text the way `ExpressionRegion` does — that text
 * still contains `?`/`:`, not valid BrightScript on its own (see findings/operators-ternary.md
 * for the consequence: a malformed non-ternary fragment sitting beside a valid ternary here is
 * only caught one layer later, at codegen time).
 */
function buildTernaryOperand(tokens: Token[], diagnostics: ParseDiagnostic[]): SyntaxNode {
  const children: SyntaxChild[] = [];
  let i = 0;

  while (i < tokens.length) {
    const kind = tokens[i].kind;

    if (isOpenBracket(kind)) {
      const closeIndex = findMatchingBracketIndex(tokens, i);
      const innerEnd = closeIndex === -1 ? tokens.length : closeIndex;
      const innerTokens = tokens.slice(i + 1, innerEnd);

      if (containsTernaryAnywhere(innerTokens)) {
        children.push(tokens[i]);
        children.push(...buildCommaSeparatedTernaryChildren(innerTokens, diagnostics));
        if (closeIndex === -1) {
          i = tokens.length;
          continue;
        }
        children.push(tokens[closeIndex]);
        i = closeIndex + 1;
        continue;
      }
      // Ternary-free bracket group — left entirely as raw tokens; fall through to the plain-token
      // push below and keep scanning linearly (its own nested brackets, if any, get the same check
      // independently as the loop reaches them).
    }

    children.push(tokens[i]);
    i++;
  }

  return new SyntaxNode(SyntaxKind.TernaryOperand, children);
}

function buildTernaryExpression(tokens: Token[], diagnostics: ParseDiagnostic[]): SyntaxNode {
  const split = findTopLevelTernarySplit(tokens);
  if (!split) return buildTernaryOperand(tokens, diagnostics);

  const questionToken = tokens[split.questionIndex];

  if (split.colonIndex === -1) {
    diagnostics.push({
      code: 'expression/unterminated-ternary',
      message: 'Unterminated ternary — "?" has no matching ":". Expected: <condition> ? <whenTrue> : <whenFalse>.',
      pos: questionToken.pos,
      end: questionToken.end,
      line: questionToken.line,
    });
    // Deliberately skips the usual eager BrightScript parse (`makeLeafExpressionRegion`) — this
    // text is already known to be invalid (it contains a bare "?"), so attempting it would only
    // ever add a second, redundant expression/parse-error on top of the diagnosis above.
    return new SyntaxNode(SyntaxKind.ExpressionRegion, tokens);
  }

  const conditionTokens = tokens.slice(0, split.questionIndex);
  const colonToken = tokens[split.colonIndex];
  const whenTrueTokens = tokens.slice(split.questionIndex + 1, split.colonIndex);
  const whenFalseTokens = tokens.slice(split.colonIndex + 1);

  if (conditionTokens.length === 0 || whenTrueTokens.length === 0 || whenFalseTokens.length === 0) {
    diagnostics.push({
      code: 'expression/unterminated-ternary',
      message: 'Incomplete ternary — expected a non-empty <condition>, <whenTrue>, and <whenFalse> around "?"/":" .',
      pos: questionToken.pos,
      end: colonToken.end,
      line: questionToken.line,
    });
    // Same reasoning as the unterminated (`colonIndex === -1`) branch above — skip the doomed
    // eager BrightScript parse rather than add a redundant expression/parse-error on top.
    return new SyntaxNode(SyntaxKind.ExpressionRegion, tokens);
  }

  const conditionNode = buildTernaryCapableExpression(conditionTokens, diagnostics);
  const whenTrueNode = buildTernaryCapableExpression(whenTrueTokens, diagnostics);
  const whenFalseNode = buildTernaryCapableExpression(whenFalseTokens, diagnostics);

  return new SyntaxNode(SyntaxKind.TernaryExpression, [conditionNode, questionToken, whenTrueNode, colonToken, whenFalseNode]);
}

/**
 * Builds an `ExpressionRegion` (unchanged from today) when `tokens` contains no ternary anywhere —
 * byte-identical output to `TokenStreamParser.makeExpressionRegion` for every ternary-free
 * expression, which is what keeps this feature's blast radius on existing `.thr`/`.flsh` files at
 * zero. Otherwise builds the appropriate `TernaryExpression`/`TernaryOperand` tree, recursing into
 * `condition`/`whenTrue`/`whenFalse` (each independently re-checked the same way, which is what
 * makes chaining, true-branch nesting, and bracket-nested ternaries all fall out of the same
 * function with no special-casing per shape).
 */
export function buildTernaryCapableExpression(tokens: Token[], diagnostics: ParseDiagnostic[]): SyntaxNode {
  if (tokens.length === 0 || !containsTernaryAnywhere(tokens)) {
    return makeLeafExpressionRegion(tokens, diagnostics);
  }
  return buildTernaryExpression(tokens, diagnostics);
}
