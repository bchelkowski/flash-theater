/**
 * Validates a `field`/`state` declaration's default literal beyond what flash-parser itself checks
 * — flash-parser only confirms an array/AA literal's brackets balance (`expectFieldOrStateLiteral`
 * in `token-stream-parser.ts`), the same "capture raw, validate deeply downstream" split
 * `analysis/request-config.ts` already established for `request {}`'s config block (see that
 * module's own header comment). Reuses `analysis/literal-value.ts`'s structural walk rather than
 * writing a second one.
 *
 * Two checks, both `field`-only unless noted:
 * - The literal's own SHAPE (string/number/boolean/invalid/array/assocarray, read straight off
 *   `defaultLiteral`'s raw text — flash-parser's `expectLiteral`/`expectFieldOrStateLiteral` only
 *   ever produce one of these six shapes, so no BrightScript parse is needed to tell them apart)
 *   must match the declared `<Type>`. This closes a real, previously-unenforced gap — before this
 *   module existed, nothing checked that e.g. `field x: node = invalid` really used `invalid`, or
 *   that `field x: string = 5` was wrong (see GRAMMAR.md's "field" section, which always documented
 *   this as the rule). `state`'s `<Type>` stays unrestricted/decorative on purpose (see
 *   `dsl-ast.ts`'s `StateDecl` doc comment) — this check does NOT apply to it.
 * - An array/assocarray-shaped default's CONTENTS (`field` and `state` both) must be pure literals,
 *   recursively — never an identifier, call, or other computed expression (`derived` exists for a
 *   computed value; `field`/`state` defaults are always meant to be static).
 */
import { BsAALiteral, BsArrayLiteral } from 'flash-parser';
import { CompileError, FieldDecl, StateDecl, ThrScriptAst } from '../dsl-parser/dsl-ast.js';
import { parseLiteralRoot, walkLiteralValue } from './literal-value.js';

type LiteralShape = 'string' | 'number' | 'boolean' | 'invalid' | 'array' | 'assocarray';

const SHAPE_DESCRIPTIONS: Record<LiteralShape, string> = {
  string: 'a string literal (e.g. "text")',
  number: 'a numeric literal (e.g. 5)',
  boolean: 'a boolean literal (true/false)',
  invalid: 'the literal "invalid"',
  array: 'an array literal (e.g. [1, 2, 3])',
  assocarray: 'an assocarray literal (e.g. { a: 1 })',
};

/**
 * flash-parser's `expectLiteral`/`expectFieldOrStateLiteral` only ever produce one of these six
 * shapes for a `field`/`state` default — a StringLiteral/NumberLiteral/True/False/Invalid token, or
 * a balanced `[...]`/`{...}` span — so classifying by the raw text's leading character/exact value
 * is exhaustive; no BrightScript parse is needed just to tell them apart.
 */
function classifyLiteralShape(defaultLiteral: string): LiteralShape {
  if (defaultLiteral.startsWith('[')) return 'array';
  if (defaultLiteral.startsWith('{')) return 'assocarray';
  if (defaultLiteral.startsWith('"')) return 'string';
  if (defaultLiteral === 'true' || defaultLiteral === 'false') return 'boolean';
  if (defaultLiteral === 'invalid') return 'invalid';
  return 'number';
}

const EXPECTED_FIELD_SHAPE: Record<FieldDecl['type'], LiteralShape> = {
  string: 'string',
  integer: 'number',
  float: 'number',
  boolean: 'boolean',
  node: 'invalid',
  array: 'array',
  assocarray: 'assocarray',
};

/** Structurally parses an array/AA-shaped default and confirms every leaf inside is a pure literal — throws `code` otherwise. */
function checkLiteralContents(defaultLiteral: string, shape: 'array' | 'assocarray', code: string, contextLabel: string): void {
  const root = parseLiteralRoot(defaultLiteral, code, contextLabel);
  const expectedCtor = shape === 'array' ? BsArrayLiteral : BsAALiteral;
  if (!(root instanceof expectedCtor)) {
    throw new CompileError({ code, message: `${contextLabel} failed to parse as ${SHAPE_DESCRIPTIONS[shape]}.` });
  }
  walkLiteralValue(root, code, contextLabel);
}

function checkFieldDefaults(fields: readonly FieldDecl[]): void {
  for (const f of fields) {
    const shape = classifyLiteralShape(f.defaultLiteral);
    const expected = EXPECTED_FIELD_SHAPE[f.type];
    const contextLabel = `field "${f.name}"'s default value ("${f.defaultLiteral}")`;

    if (shape !== expected) {
      throw new CompileError({
        code: 'dsl/field-default-type-mismatch',
        message: `${contextLabel} doesn't match its declared type "${f.type}" — expected ${SHAPE_DESCRIPTIONS[expected]}.`,
      });
    }

    if (shape === 'array' || shape === 'assocarray') {
      checkLiteralContents(f.defaultLiteral, shape, 'dsl/field-default-not-literal', contextLabel);
    }
  }
}

function checkStateDefaults(state: readonly StateDecl[]): void {
  for (const s of state) {
    const shape = classifyLiteralShape(s.defaultLiteral);
    if (shape !== 'array' && shape !== 'assocarray') continue;
    checkLiteralContents(s.defaultLiteral, shape, 'dsl/state-default-not-literal', `state "${s.name}"'s default value ("${s.defaultLiteral}")`);
  }
}

export function checkFieldStateDefaultLiterals(script: ThrScriptAst): void {
  checkFieldDefaults(script.fields);
  checkStateDefaults(script.state);
}
