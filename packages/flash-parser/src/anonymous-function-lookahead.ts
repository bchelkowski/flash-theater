/**
 * Tier-2 anonymous-function detection: locating a DSL `function (...) [: Type] { }` header
 * embedded inside an ordinary BrightScript expression (a call argument, an `if`/`for`/`while`
 * header, a ternary branch, ...) — reached via `brightscript-parser.ts`'s own primary-expression
 * grammar, structurally unrelated to Tier 1's statement-position lookahead
 * (`token-stream-parser.ts`'s own `looksLikeAnonymousFunctionAt`, kept separate so this module
 * only depends on `token.ts`/`tokenKind.ts`/`brightscript-lexer.ts` — never on
 * `token-stream-parser.ts` itself, which would reintroduce an import-cycle edge here too; the one
 * new cycle this feature needs is confined to `brightscript-parser.ts`, see that file).
 */
import { Token } from './token.js';
import { TokenKind, KEYWORD_MAP } from './tokenKind.js';
import { DSL_ONLY_KEYWORD_KINDS } from './brightscript-lexer.js';

function findMatchingParenIndex(tokens: readonly Token[], openIndex: number): number {
  let depth = 1;
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const kind = tokens[i].kind;
    if (kind === TokenKind.LParen) depth++;
    else if (kind === TokenKind.RParen) {
      depth--;
      if (depth === 0) return i;
    } else if (kind === TokenKind.EndOfFile) return -1;
  }
  return -1;
}

/**
 * Does `tokens[index]` start a DSL-shaped anonymous function header — `function (...) {` or
 * `function (...): Type {` — rather than real BrightScript's own function-literal syntax
 * (`function (...) as Type` / `function (...)` directly followed by a statement body and
 * `end function`/`end sub`)? A bare `{` immediately after the parameter list (or after an
 * optional `: Type` return-type clause) is never legal BrightScript — a real function header is
 * always followed by `as <Type>` or directly by its own statement body — so this is unambiguous;
 * no lookahead into the body is needed to disambiguate. Returns the matched `{` token's index, or
 * `-1` if `tokens[index]` isn't a DSL anonymous function header at all (never BrightScript's own
 * `sub` — the DSL always spells `function`, see `ast.ts`'s `AnonymousFunctionExpression` doc
 * comment).
 */
export function findDslAnonymousFunctionHeaderBrace(tokens: readonly Token[], index: number): number {
  if (tokens[index]?.kind !== TokenKind.Function) return -1;
  if (tokens[index + 1]?.kind !== TokenKind.LParen) return -1;

  const rparenIndex = findMatchingParenIndex(tokens, index + 1);
  if (rparenIndex === -1) return -1;

  let next = rparenIndex + 1;
  if (tokens[next]?.kind === TokenKind.Colon && tokens[next + 1]?.kind === TokenKind.Identifier) {
    next += 2;
  }

  return tokens[next]?.kind === TokenKind.LBrace ? next : -1;
}

/**
 * Re-derives the correct DSL `TokenKind` for every token in `tokens` that
 * `brightscript-lexer.ts` deliberately mis-tokenized as a plain `Identifier` — see that file's
 * own doc comment: it rejects any `KEYWORD_MAP` hit that's in `DSL_ONLY_KEYWORD_KINDS`
 * (`state`/`store`/`focus`/...) so ordinary BrightScript text (`store.count`) isn't accidentally
 * treated as DSL syntax. A Tier-2 anonymous function's own header+body span IS genuinely DSL
 * syntax though (it's handed to `token-stream-parser.ts`'s own block grammar, reused verbatim
 * from Tier 1 via `parseAnonymousFunctionExpressionFromTokens`), so those tokens need their real
 * DSL kind back first.
 *
 * This is a structural remap over the already-lexed, already-positioned token array — every
 * `pos`/`end`/`line`/`column`/`text`/`leadingTrivia` is untouched, only `kind` changes, and only
 * for an `Identifier` token whose exact text (case-sensitive — DSL keywords have no case-folded
 * form, see `lexer.ts`'s own doc comment and `tokenizeBrightScript`'s `KEYWORD_MAP[text] ??
 * Identifier` exact-match-only lookup) is one of the closed DSL-only keyword spellings. No
 * source text is ever re-sliced or re-scanned — this is not a second lex pass.
 *
 * Applied uniformly across the whole header+body span (not just the body): matches how every
 * other DSL function header already treats these spellings as unconditionally reserved (a
 * Tier-1 anonymous function's own parameter can no more be named `state` than a named
 * function's can — `lexer.ts` tokenizes the whole `.thr` shell the same way everywhere), so a
 * Tier-2 anonymous function's header must behave identically for consistency, not as a special
 * case.
 */
export function remapDslKeywordTokens(tokens: readonly Token[]): Token[] {
  return tokens.map((token) => {
    if (token.kind !== TokenKind.Identifier) return token;
    const dslKind = KEYWORD_MAP[token.text];
    if (dslKind === undefined || !DSL_ONLY_KEYWORD_KINDS.has(dslKind)) return token;
    return { ...token, kind: dslKind };
  });
}
