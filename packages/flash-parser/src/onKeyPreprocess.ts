/**
 * `on:key[Key1,Key2,...]={expression}` is not legal XML — `[`, `]`, and `,`
 * are not legal XML `Name` characters, and the template region is otherwise
 * always handed to the real, unmodified `parseXml` (`kopytko-brightscript-parser`)
 * with zero DSL-specific special-casing (see `parser.ts`'s own doc comments
 * and `findings/compiler-parser-architecture.md`). This is the one deliberate
 * exception: a same-length, position-preserving transliteration pass, run
 * once over the raw template text before `parseEmbeddedTemplate`/`parseXml`
 * ever sees it, that swaps every illegal character inside an `on:key[...]`
 * attribute-name span for a legal one — `[`/`]`/comma/whitespace -> `_`,
 * the `*` wildcard marker -> `-` — leaving every other character (including
 * every key name's own letters) untouched. Because the substitution is
 * always exactly one character for one character, the output is always
 * exactly the same length as the input, so no position ever shifts and no
 * diagnostic offset remapping is ever needed downstream — every position in
 * the rewritten text still means the same real source location it always
 * did. `parser.ts`'s `classifyAttribute` reverses this by splitting the
 * transliterated `on:key_...` suffix back on `_`.
 *
 * Comma and whitespace deliberately transliterate to *different* filler
 * characters (`_` and `.` respectively) even though both are separators —
 * `on:key[OK, play]` (comma-space) must parse identically to `on:key[OK,play]`
 * (comma only), but `on:key[OK,,play]` (doubled comma, no real key between)
 * must be rejected. Using one filler for both would make a legitimate
 * "comma then whitespace" indistinguishable from an erroneous "comma then
 * comma" — both collapse to the same repeated character. `classifyAttribute`
 * strips every `.` before splitting on `_`, so a real key's own text always
 * survives between two `_`s and only a truly *empty* gap (nothing but
 * whitespace, or nothing at all, between two commas) reads as empty.
 */
import { ParseDiagnostic } from './diagnostics.js';
import { lineAt } from './text-scan.js';

const ON_KEY_MARKER = 'on:key[';
const ON_KEY_NAME_PREFIX = 'on:key'; // length up to (not including) the '['

export interface OnKeyPreprocessResult {
  readonly text: string;
  readonly diagnostics: ParseDiagnostic[];
}

/** Transliterates every `on:key[...]` attribute-name span found in `markup`, leaving everything else byte-for-byte identical. `markup` is the already-trimmed template text, 0-based. */
export function preprocessOnKeyAttributes(markup: string): OnKeyPreprocessResult {
  const chars = markup.split('');
  const diagnostics: ParseDiagnostic[] = [];

  let i = 0;
  let inQuote: '"' | "'" | null = null;
  let inTag = false;

  while (i < markup.length) {
    if (inQuote) {
      if (markup[i] === inQuote) inQuote = null;
      i++;
      continue;
    }

    if (inTag) {
      const ch = markup[i];
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        i++;
        continue;
      }
      if (ch === '>') {
        inTag = false;
        i++;
        continue;
      }

      const precededByBoundary = i === 0 || /\s/.test(markup[i - 1]);
      if (precededByBoundary && markup.startsWith(ON_KEY_MARKER, i)) {
        const bracketStart = i + ON_KEY_NAME_PREFIX.length; // index of '['
        const closeIndex = findAttributeNameBracketClose(markup, bracketStart);
        if (closeIndex === -1) {
          diagnostics.push({
            code: 'template/on-key-invalid-syntax',
            message: '"on:key[..." has no matching "]" — expected on:key[Key1,Key2,...]={expression}.',
            pos: i,
            end: markup.length,
            line: lineAt(markup, i),
          });
          i++;
          continue;
        }
        for (let j = bracketStart; j <= closeIndex; j++) {
          const c = markup[j];
          if (c === '[' || c === ']' || c === ',') chars[j] = '_';
          else if (/\s/.test(c)) chars[j] = '.';
          else if (c === '*') chars[j] = '-';
        }
        i = closeIndex + 1;
        continue;
      }

      i++;
      continue;
    }

    const ch = markup[i];
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      i++;
      continue;
    }
    if (ch === '<') {
      inTag = true;
      i++;
      continue;
    }
    i++;
  }

  return { text: chars.join(''), diagnostics };
}

/** From `bracketStart` (the `[` itself), finds the matching `]` — a flat, non-nested scan that stops at the first `]`, or -1 if the tag/quote/text ends first. */
function findAttributeNameBracketClose(markup: string, bracketStart: number): number {
  for (let k = bracketStart + 1; k < markup.length; k++) {
    const c = markup[k];
    if (c === ']') return k;
    if (c === '>' || c === '"' || c === "'" || c === '<') return -1;
  }
  return -1;
}
