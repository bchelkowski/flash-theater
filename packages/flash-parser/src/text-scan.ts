/**
 * Low-level text-scanning primitives for the DSL lexer and the top-level
 * `<script>`/template split — the only two places that scan raw text before
 * real tokens exist. Everything else that used to need manual delimiter
 * matching (a `derived` expression's raw span, an `if` condition's matching
 * `)`, a function body's matching `}`) is instead done by depth-counting or
 * comparing `Token.line` over the already-produced token stream — see
 * parser.ts. A real lexer's string/comment-aware tokenization makes most of
 * that manual scanning unnecessary, which is why this module is much
 * smaller than the compiler's original hand-rolled scanner set (see
 * findings/compiler-parser-architecture.md).
 */

/**
 * Index just past the closing quote of a `"`-string starting at
 * `quoteIndex`, handling `""` as an escaped quote. Stops at end of line if
 * unterminated — BrightScript string literals can't span lines.
 */
export function skipStringLiteral(source: string, quoteIndex: number): number {
  let i = quoteIndex + 1;
  while (i < source.length && source[i] !== '\n') {
    if (source[i] === '"') {
      if (source[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * Scans forward from `from` for `literal` (e.g. `</script>`) outside string
 * literals (`""` escaped) and `'` line comments. Returns the index where
 * `literal` starts, or -1 if it's never found.
 */
export function findLiteralOutsideStringsAndComments(source: string, from: number, literal: string): number {
  let i = from;
  let inString = false;
  let inComment = false;

  while (i < source.length) {
    const ch = source[i];

    if (inComment) {
      if (ch === '\n') inComment = false;
      i++;
      continue;
    }

    if (inString) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          i += 2;
          continue;
        }
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }

    if (ch === "'") {
      inComment = true;
      i++;
      continue;
    }

    if (source.startsWith(literal, i)) return i;
    i++;
  }

  return -1;
}

/** 0-based line number of `index` within `source`. */
export function lineAt(source: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}
