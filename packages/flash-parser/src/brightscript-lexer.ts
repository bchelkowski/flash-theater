/**
 * Full BrightScript tokenizer — the Phase 0 grammar-ownership foundation
 * (see `findings/compiler-parser-architecture.md`'s "flash-parser: a real, fully
 * self-sufficient CST/AST for the whole language"). Vendored and adapted
 * from `kopytko-brightscript-parser`'s own hand-written lexer
 * (`node_modules/kopytko-brightscript-parser/dist/src/lexer.js`) — same
 * scanning logic (numeric-literal suffix/exponent handling, compound
 * keywords, optional chaining, conditional-compilation directives, REM
 * comments), reconciled with two things flash-parser's own DSL lexer
 * (`lexer.ts`) already established that this file must match, not diverge
 * from:
 *
 * 1. **Leading-only trivia** (`trivia.ts`'s own documented simplification —
 *    unlike kopytko's leading/trailing split, every whitespace/comment run
 *    between two tokens is the LEADING trivia of the next one, trailing is
 *    always empty). This also sidesteps the exact
 *    `SyntaxNode.end`-includes-trailing-trivia gotcha
 *    `findings/compiler-parser-architecture.md` documents as a trap in the old
 *    delegation architecture — there is no trailing trivia to leak in here.
 * 2. **This lexer tokenizes BrightScript *content* only — it must never
 *    produce a DSL-only keyword kind at all**, regardless of spelling.
 *    `tokenKind.ts`'s `KEYWORD_MAP` merges both vocabularies under one map
 *    keyed by lowercase spelling, purely as a *data* convenience; DSL
 *    declaration keywords (`field`/`derived`/`store`/`class`/...) are only
 *    ever meaningful at the separate DSL-shell level (`lexer.ts`) — inside
 *    an embedded expression/statement, the exact same spelling is always an
 *    ordinary identifier (`store.count`'s `store`, a real BrightScript local
 *    happening to be named `class`). `DSL_ONLY_KEYWORD_KINDS` is checked on
 *    *both* the exact-match and the case-folded lookup for exactly this
 *    reason — confirmed live: without excluding it from the exact-match
 *    branch too, `store.count` inside a `derived`/template expression
 *    tokenized `store` as `TokenKind.Store`, silently breaking
 *    `findGlobalPathAccesses`'s global-path detection. The exact-match step
 *    still matters on its own for BrightScript's own case-insensitivity: it
 *    correctly accepts a lowercase-spelled real keyword (`if`, `for`, ...)
 *    without needing to case-fold at all, the overwhelmingly common case;
 *    only a differently-cased BrightScript keyword (`IF`, `THEN`) falls
 *    through to the case-folded retry.
 *
 * Genuinely new relative to both source lexers: `==`/`!=` (`EqualsEquals`/
 * `BangEquals`, GRAMMAR.md's "Comparison" section) and bare `!` (`Bang`,
 * GRAMMAR.md's "Safe NOT" section) — DSL-only sugar with no BrightScript
 * equivalent, lexed the same way ternary's `?`/`:` already are (a dedicated
 * rule ahead of the generic operator dispatch).
 */
import { TokenKind, KEYWORD_MAP } from './tokenKind.js';
import { Token } from './token.js';
import { Trivia, TriviaKind } from './trivia.js';
import { skipStringLiteral } from './text-scan.js';

export interface BrightScriptTokenizeOptions {
  /** Byte offset in the outer source where `source` begins — added to every position so tokens carry outer-source coordinates. */
  posOffset?: number;
  /** 0-based line number in the outer source where `source` begins. */
  lineOffset?: number;
}

/**
 * Every DSL-only `TokenKind` that can also appear as `KEYWORD_MAP`'s value
 * for a lowercase key — the set a case-folded keyword match must be
 * rejected against, per this file's own doc comment above. Not exported from
 * `tokenKind.ts` itself: it's a lexing-policy concern (how to resolve a
 * case-fold ambiguity), not a fact about the kind space itself. Exported
 * from here (rather than kept module-private) because
 * `anonymous-function-lookahead.ts`'s `remapDslKeywordTokens` needs the
 * exact same closed set to reverse this lexer's own exclusion for the one
 * case where DSL keyword tokens genuinely are wanted inside an embedded
 * BrightScript token stream — a Tier-2 anonymous function's own body (see
 * that file's doc comment).
 */
export const DSL_ONLY_KEYWORD_KINDS: ReadonlySet<TokenKind> = new Set([
  TokenKind.Field,
  TokenKind.Derived,
  TokenKind.State,
  TokenKind.Private,
  TokenKind.Public,
  TokenKind.Store,
  TokenKind.Focus,
  TokenKind.JumpFocus,
  TokenKind.Read,
  TokenKind.Watch,
  TokenKind.Class,
  TokenKind.Extends,
  TokenKind.Override,
  TokenKind.Protected,
  TokenKind.Constructor,
  TokenKind.Super,
  TokenKind.Import,
  TokenKind.From,
]);

/** Two-word compound keyword forms: `end if`/`endif`, `else if`/`elseif`, `exit while`/`exitwhile`, ... — see `tokenKind.ts`'s `COMPOUND_KEYWORD_SPACED_FORMS` for the canonical list this mirrors (lowercase first+second word -> compact spelling, looked up in `KEYWORD_MAP` directly here since the compact spelling is already a real key). */
const COMPOUND_FIRST_WORDS: ReadonlySet<string> = new Set(['end', 'else', 'exit', 'continue']);

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}
function isAlpha(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}
function isAlphaNumeric(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch);
}
function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

/** Tokenizes full BrightScript source into a lossless token stream, always ending with an `EndOfFile` token. */
export function tokenizeBrightScript(source: string, options: BrightScriptTokenizeOptions = {}): Token[] {
  const posOffset = options.posOffset ?? 0;
  const lineOffset = options.lineOffset ?? 0;

  const tokens: Token[] = [];
  const pendingTrivia: Trivia[] = [];
  let i = 0;
  let line = 0;
  let lineStart = 0;

  function makeTrivia(kind: TriviaKind, start: number, end: number): Trivia {
    return {
      kind,
      text: source.slice(start, end),
      pos: start + posOffset,
      end: end + posOffset,
      line: line + lineOffset,
      column: start - lineStart,
    };
  }

  /** Statement-start check for REM-comment recognition — mirrors kopytko's `isStatementStart`: true at source start, or right after a line break / `:` / whitespace. */
  function isStatementStart(at: number): boolean {
    if (at === 0) return true;
    const before = source[at - 1];
    return before === '\n' || before === '\r' || before === ':' || isWhitespace(before);
  }

  /** `rem` as a statement-position keyword, followed by non-alphanumeric (or EOF) — a `rem` inside an identifier (`remainder`) must not match. */
  function isRemCommentAt(at: number): boolean {
    if (source.slice(at, at + 3).toLowerCase() !== 'rem') return false;
    const after = source[at + 3];
    if (after !== undefined && isAlphaNumeric(after)) return false;
    return isStatementStart(at);
  }

  function collectTrivia(): void {
    while (i < source.length) {
      const ch = source[i];

      if (isWhitespace(ch)) {
        const start = i;
        while (i < source.length && isWhitespace(source[i])) i++;
        pendingTrivia.push(makeTrivia(TriviaKind.Whitespace, start, i));
        continue;
      }

      if (ch === '\n') {
        const start = i;
        i++;
        pendingTrivia.push(makeTrivia(TriviaKind.LineBreak, start, i));
        line++;
        lineStart = i;
        continue;
      }

      if (ch === "'") {
        const start = i;
        while (i < source.length && source[i] !== '\n') i++;
        pendingTrivia.push(makeTrivia(TriviaKind.Comment, start, i));
        continue;
      }

      if (isRemCommentAt(i)) {
        const start = i;
        while (i < source.length && source[i] !== '\n') i++;
        // Flash-parser's Trivia has no separate RemComment kind (DSL layer
        // never needed one) — a REM comment is trivia-content-equivalent to
        // a tick comment for every purpose this CST is used for (round-trip
        // text, nothing structural reads the difference), so it's recorded
        // as an ordinary Comment.
        pendingTrivia.push(makeTrivia(TriviaKind.Comment, start, i));
        continue;
      }

      break;
    }
  }

  function emit(kind: TokenKind, start: number, end: number): Token {
    const leadingTrivia = pendingTrivia.splice(0, pendingTrivia.length);
    const token: Token = {
      kind,
      text: source.slice(start, end),
      pos: start + posOffset,
      end: end + posOffset,
      line: line + lineOffset,
      column: start - lineStart,
      leadingTrivia,
      trailingTrivia: [],
    };
    tokens.push(token);
    return token;
  }

  function scanString(): Token {
    const start = i;
    i = skipStringLiteral(source, i);
    return emit(TokenKind.StringLiteral, start, i)!;
  }

  /**
   * Numeric literal: integer/long-integer/float/double, decimal or hex, with
   * BrightScript's type-designator suffixes (`%` integer, `&` long integer,
   * `!` float, `#` double) and exponents (`E`/`e` float, `D`/`d` double).
   * Faithful port of kopytko's `scanNumber` — see that file for the full
   * worked-example doc comment (255, 9876543210&, 2.01, 1.23E+5, 1.23D-12,
   * &HFF, &hABCD&).
   */
  function scanNumber(): Token {
    const start = i;

    if (source[i] === '&' && (source[i + 1] === 'H' || source[i + 1] === 'h')) {
      i += 2;
      while (i < source.length && isHexDigit(source[i])) i++;
      if (source[i] === '&') {
        i++;
        return emit(TokenKind.LongIntegerLiteral, start, i)!;
      }
      return emit(TokenKind.IntegerLiteral, start, i)!;
    }

    while (i < source.length && isDigit(source[i])) i++;
    let isFloat = false;
    let isDouble = false;

    if (source[i] === '.') {
      if (isDigit(source[i + 1])) {
        i++;
        while (i < source.length && isDigit(source[i])) i++;
        isFloat = true;
      } else if (!isAlpha(source[i + 1] ?? '')) {
        i++;
        isFloat = true;
      }
    }

    if (source[i] === 'E' || source[i] === 'e') {
      i++;
      if (source[i] === '+' || source[i] === '-') i++;
      while (i < source.length && isDigit(source[i])) i++;
      isFloat = true;
    } else if ((source[i] === 'D' || source[i] === 'd') && (source[i + 1] === '+' || source[i + 1] === '-' || isDigit(source[i + 1] ?? ''))) {
      i++;
      if (source[i] === '+' || source[i] === '-') i++;
      while (i < source.length && isDigit(source[i])) i++;
      isDouble = true;
    }

    if (source[i] === '#') {
      i++;
      isDouble = true;
    } else if (source[i] === '!') {
      i++;
      isFloat = true;
    } else if (source[i] === '&') {
      i++;
      return emit(TokenKind.LongIntegerLiteral, start, i)!;
    } else if (source[i] === '%') {
      i++;
      return emit(TokenKind.IntegerLiteral, start, i)!;
    }

    if (isDouble) return emit(TokenKind.DoubleLiteral, start, i)!;
    if (isFloat) return emit(TokenKind.FloatLiteral, start, i)!;
    return emit(TokenKind.IntegerLiteral, start, i)!;
  }

  /**
   * Attempts a two-word compound keyword (`end if`, `else if`, `exit
   * while`, `continue for`) starting at `firstWord`'s already-scanned end
   * (`afterFirstWord`). Returns the compound `Token` on a match, or `null`
   * (leaving `i` untouched — caller already emitted the first word) if the
   * second word doesn't complete a real compound.
   */
  function tryCompoundKeyword(firstWordLower: string, start: number, afterFirstWord: number): Token | null {
    let j = afterFirstWord;
    while (j < source.length && isWhitespace(source[j])) j++;
    if (j === afterFirstWord) return null;
    const secondStart = j;
    while (j < source.length && isAlphaNumeric(source[j])) j++;
    if (j === secondStart) return null;
    const secondWordLower = source.slice(secondStart, j).toLowerCase();
    const compoundKind = KEYWORD_MAP[firstWordLower + secondWordLower];
    if (compoundKind === undefined) return null;
    i = j;
    return emit(compoundKind, start, i)!;
  }

  function scanIdentifierOrKeyword(): Token {
    const start = i;
    while (i < source.length && isAlphaNumeric(source[i])) i++;

    // Type-designator suffix ($ % ! # &) — always an Identifier, never a
    // keyword. The explicit `i < source.length` bounds check matters: at
    // EOF, `source[i]` is `undefined`, and `.includes(undefined ?? '')`
    // would otherwise always be true (`String.prototype.includes('')` is
    // true for any string), wrongly treating an identifier that happens to
    // end exactly at end-of-source as suffixed and skipping the keyword
    // lookup entirely — confirmed live via this file's own round-trip test
    // on a bare `field`/`endif` with nothing following it.
    if (i < source.length && '$%!#&'.includes(source[i])) {
      i++;
      return emit(TokenKind.Identifier, start, i)!;
    }

    const text = source.slice(start, i);
    const afterFirstWord = i;

    // Exact (case-sensitive) match first. Correctly accepts a lowercase
    // BrightScript keyword — but a DSL-only kind (Field/Derived/Store/...)
    // is rejected here too, not just in the case-folded fallback below: this
    // lexer tokenizes embedded BrightScript *content* only (an expression, a
    // statement) — text that can legitimately reference `store`/`field`/
    // `class`/... as an ordinary identifier (`store.count`, a real
    // BrightScript local named `class`, ...), since those spellings are only
    // ever DSL declaration keywords at the separate DSL-shell level
    // (lexer.ts), never inside BrightScript content. Confirmed live: without
    // this exclusion, `store.count` inside a `derived`/template expression
    // tokenized `store` as TokenKind.Store instead of Identifier, breaking
    // findGlobalPathAccesses's global-path detection entirely.
    const exactKind = KEYWORD_MAP[text];
    if (exactKind !== undefined && !DSL_ONLY_KEYWORD_KINDS.has(exactKind)) {
      if (COMPOUND_FIRST_WORDS.has(text)) {
        const compound = tryCompoundKeyword(text, start, afterFirstWord);
        if (compound) return compound;
      }
      return emit(exactKind, start, i)!;
    }

    // Case-folded fallback — BrightScript keywords only (see this file's
    // own doc comment for why a DSL-only kind is rejected here).
    const lower = text.toLowerCase();
    const foldedKind = KEYWORD_MAP[lower];
    if (foldedKind !== undefined && !DSL_ONLY_KEYWORD_KINDS.has(foldedKind)) {
      if (COMPOUND_FIRST_WORDS.has(lower)) {
        const compound = tryCompoundKeyword(lower, start, afterFirstWord);
        if (compound) return compound;
      }
      return emit(foldedKind, start, i)!;
    }

    return emit(TokenKind.Identifier, start, i)!;
  }

  /** `#if`/`#elseif`/`#else if`/`#else`/`#endif`/`#end if`/`#const`/`#error` — case-insensitive, matching every other BrightScript keyword. */
  function scanPreprocessor(): Token {
    const start = i;
    i++; // consume #
    const wordStart = i;
    while (i < source.length && isAlpha(source[i])) i++;
    const word = source.slice(wordStart, i).toLowerCase();

    if (word === 'if') return emit(TokenKind.HashIf, start, i)!;
    if (word === 'const') return emit(TokenKind.HashConst, start, i)!;
    if (word === 'error') {
      while (i < source.length && source[i] !== '\n') i++;
      return emit(TokenKind.HashError, start, i)!;
    }
    if (word === 'elseif') return emit(TokenKind.HashElseIf, start, i)!;
    if (word === 'endif') return emit(TokenKind.HashEndIf, start, i)!;
    if (word === 'else' || word === 'end') {
      const saved = i;
      while (i < source.length && isWhitespace(source[i])) i++;
      const w2Start = i;
      while (i < source.length && isAlpha(source[i])) i++;
      const w2 = source.slice(w2Start, i).toLowerCase();
      if (w2 === 'if') return emit(word === 'else' ? TokenKind.HashElseIf : TokenKind.HashEndIf, start, i)!;
      i = saved;
      if (word === 'else') return emit(TokenKind.HashElse, start, i)!;
      return emit(TokenKind.Unknown, start, i)!;
    }
    return emit(TokenKind.Unknown, start, i)!;
  }

  function scanOperatorOrPunctuation(): Token {
    const start = i;
    const ch = source[i];

    switch (ch) {
      case '(':
        i++;
        return emit(TokenKind.LParen, start, i)!;
      case ')':
        i++;
        return emit(TokenKind.RParen, start, i)!;
      case '[':
        i++;
        return emit(TokenKind.LBracket, start, i)!;
      case ']':
        i++;
        return emit(TokenKind.RBracket, start, i)!;
      case '{':
        i++;
        return emit(TokenKind.LBrace, start, i)!;
      case '}':
        i++;
        return emit(TokenKind.RBrace, start, i)!;
      case ',':
        i++;
        return emit(TokenKind.Comma, start, i)!;
      case ':':
        i++;
        return emit(TokenKind.Colon, start, i)!;
      case ';':
        i++;
        return emit(TokenKind.Semicolon, start, i)!;
      case '@':
        i++;
        return emit(TokenKind.At, start, i)!;
      case '^':
        i++;
        return emit(TokenKind.Caret, start, i)!;
      case '\\':
        i++;
        if (source[i] === '=') {
          i++;
          return emit(TokenKind.BackslashEqual, start, i)!;
        }
        return emit(TokenKind.Backslash, start, i)!;
      case '.':
        if (isDigit(source[i + 1] ?? '')) return scanNumber();
        i++;
        return emit(TokenKind.Dot, start, i)!;
      case '+':
        i++;
        if (source[i] === '+') {
          i++;
          return emit(TokenKind.PlusPlus, start, i)!;
        }
        if (source[i] === '=') {
          i++;
          return emit(TokenKind.PlusEqual, start, i)!;
        }
        return emit(TokenKind.Plus, start, i)!;
      case '-':
        i++;
        if (source[i] === '-') {
          i++;
          return emit(TokenKind.MinusMinus, start, i)!;
        }
        if (source[i] === '=') {
          i++;
          return emit(TokenKind.MinusEqual, start, i)!;
        }
        return emit(TokenKind.Minus, start, i)!;
      case '*':
        i++;
        if (source[i] === '=') {
          i++;
          return emit(TokenKind.StarEqual, start, i)!;
        }
        return emit(TokenKind.Star, start, i)!;
      case '/':
        i++;
        if (source[i] === '=') {
          i++;
          return emit(TokenKind.SlashEqual, start, i)!;
        }
        return emit(TokenKind.Slash, start, i)!;
      case '=':
        i++;
        // `==` — DSL-only crash-safe comparison sugar (see this file's own
        // doc comment); never valid BrightScript on its own. A lone `=` is
        // BrightScript's real equality/assignment operator.
        if (source[i] === '=') {
          i++;
          return emit(TokenKind.EqualsEquals, start, i)!;
        }
        return emit(TokenKind.Equals, start, i)!;
      case '!':
        // `!=` — DSL-only crash-safe inequality sugar. A bare `!` (not
        // otherwise valid BrightScript syntax — no boolean-not operator
        // spelled `!`; that's the `Not` keyword) is DSL-only crash-safe
        // unary NOT sugar instead.
        i++;
        if (source[i] === '=') {
          i++;
          return emit(TokenKind.BangEquals, start, i)!;
        }
        return emit(TokenKind.Bang, start, i)!;
      case '<':
        i++;
        if (source[i] === '>') {
          i++;
          return emit(TokenKind.LessGreater, start, i)!;
        }
        if (source[i] === '=') {
          i++;
          return emit(TokenKind.LessEqual, start, i)!;
        }
        if (source[i] === '<') {
          i++;
          if (source[i] === '=') {
            i++;
            return emit(TokenKind.LeftShiftEqual, start, i)!;
          }
          return emit(TokenKind.LeftShift, start, i)!;
        }
        return emit(TokenKind.Less, start, i)!;
      case '>':
        i++;
        if (source[i] === '=') {
          i++;
          return emit(TokenKind.GreaterEqual, start, i)!;
        }
        if (source[i] === '>') {
          i++;
          if (source[i] === '=') {
            i++;
            return emit(TokenKind.RightShiftEqual, start, i)!;
          }
          return emit(TokenKind.RightShift, start, i)!;
        }
        return emit(TokenKind.Greater, start, i)!;
      case '?': {
        const next = source[i + 1];
        if (next === '.') {
          i += 2;
          return emit(TokenKind.QuestionDot, start, i)!;
        }
        if (next === '[') {
          i += 2;
          return emit(TokenKind.QuestionBracket, start, i)!;
        }
        if (next === '(') {
          i += 2;
          return emit(TokenKind.QuestionParen, start, i)!;
        }
        if (next === '@') {
          i += 2;
          return emit(TokenKind.QuestionAt, start, i)!;
        }
        i++;
        return emit(TokenKind.Question, start, i)!;
      }
      default:
        i++;
        return emit(TokenKind.Unknown, start, i)!;
    }
  }

  while (true) {
    collectTrivia();

    if (i >= source.length) {
      emit(TokenKind.EndOfFile, i, i);
      break;
    }

    const ch = source[i];

    if (ch === '"') {
      scanString();
    } else if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? '')) || (ch === '&' && (source[i + 1] === 'H' || source[i + 1] === 'h'))) {
      scanNumber();
    } else if (isAlpha(ch)) {
      scanIdentifierOrKeyword();
    } else if (ch === '#') {
      scanPreprocessor();
    } else {
      scanOperatorOrPunctuation();
    }
  }

  return tokens;
}
