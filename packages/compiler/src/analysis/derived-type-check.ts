/**
 * Enforces `derived <name>: <Type> = <expression>`'s declared `<Type>` (see GRAMMAR.md's "derived"
 * section) against a best-effort static inference of the expression's own type — the DSL's `<Type>`
 * has always been required in the grammar, but until this module existed it was purely decorative
 * (parsed, threaded through the AST, never consumed by codegen).
 *
 * This is genuinely "full inference" over everything the DSL itself models (literals, field/state/
 * derived references, arithmetic/string-concat/comparison/relational/boolean operators, a call to a
 * user-declared function OR to a `.flsh` class instance method reached via the
 * `ClassName(...).methodName(...)` shape) — but it has a deliberate, permanent boundary: anything
 * this compiler doesn't itself model the signature of (a BrightScript builtin call, a member/dot
 * access off anything, an array/AA literal's own element types, a class instance held in a local
 * rather than constructed inline) infers as `unknown` and is never flagged. `unknown` is always
 * compatible with any declared type — this module only ever rejects a CONFIRMED mismatch, never an
 * unconfirmed one, matching this DSL's existing "don't reimplement what's already known, and don't
 * guess at what isn't" discipline (see CLAUDE.md's compiler-pipeline table).
 *
 * Reuses flash-parser's own parsed BrightScript expression AST (`parseEmbeddedExpression`, the same
 * memoized call `analysis/expression-region.ts`/`analysis/dependency-graph.ts` already make for this
 * exact expression text) rather than re-parsing or hand-walking source text.
 */
import {
  parseEmbeddedExpression,
  TokenKind,
  BsAstNode,
  BsLiteralExpression,
  BsIdentifierExpression,
  BsBinaryExpression,
  BsComparisonExpression,
  BsSafeNotExpression,
  BsUnaryExpression,
  BsGroupingExpression,
  BsCallExpression,
  BsDotExpression,
  BsIndexExpression,
  BsOptionalChainingExpression,
  BsArrayLiteral,
  BsAALiteral,
} from 'flash-parser';
import { CompileError, ThrScriptAst } from '../dsl-parser/dsl-ast.js';
import { ClassShape } from './class-shape.js';
import { unwrapEmbeddedExpressionRoot } from './literal-value.js';

/**
 * `'unknown'` — genuinely can't be determined (or deliberately not modeled), never flagged as a
 * mismatch against any declared type. `'no-value'` — the expression (or, currently, its OWN root
 * only — see `checkDerivedTypes`'s doc comment on why this doesn't propagate through nested
 * operands) is a call to a function/method with no declared return type (compiles to a BrightScript
 * `sub`, which has no value) — always an error, regardless of the declared type. `'named'` — a
 * concrete inferred type name, checked against the declared type via `typesCompatible`.
 */
type InferredType = { kind: 'unknown' } | { kind: 'no-value'; calleeName: string } | { kind: 'named'; name: string };

const UNKNOWN: InferredType = { kind: 'unknown' };
const BOOLEAN: InferredType = { kind: 'named', name: 'boolean' };

function named(name: string): InferredType {
  return { kind: 'named', name };
}

const NUMERIC_TYPE_NAMES: ReadonlySet<string> = new Set(['integer', 'float', 'double', 'longinteger']);

/** Default for `checkDerivedTypes`'s optional `classShapesByName` param — a standalone compile (no app-wide class context) gets an empty map, so every `ClassName(...).method()` call simply falls back to `unknown` rather than needing an `undefined` check at every lookup site. */
const EMPTY_CLASS_SHAPES: ReadonlyMap<string, ClassShape> = new Map();

function isNumericTypeName(name: string): boolean {
  return NUMERIC_TYPE_NAMES.has(name.trim().toLowerCase());
}

/**
 * `object`/`dynamic` are BrightScript's own explicit "don't check me" escape hatches — a `derived`
 * declaring one of these accepts anything, most notably an array/AA/tuple literal (`derived
 * itemTranslation: object = [(880-300)/2, 60]`, a real shape in apps/sample-app's HomeScreen.thr),
 * since `derived` was deliberately never given `field`'s closed `array`/`assocarray` type set (see
 * GRAMMAR.md's "derived" section). Numeric subtypes (integer/float/double/longinteger) are mutually
 * compatible regardless of exact match, mirroring `ft_equals`'s own numeric leniency
 * (`FlashTheaterSafeCompare.brs`'s `ft_isNumberType`) — `3`/`3.0` isn't a bug here either. Anything
 * else requires an exact (case-insensitive) name match.
 */
function typesCompatible(declaredType: string, inferred: InferredType): boolean {
  if (inferred.kind !== 'named') return true;
  const declared = declaredType.trim().toLowerCase();
  if (declared === 'object' || declared === 'dynamic') return true;
  const inferredName = inferred.name.trim().toLowerCase();
  if (isNumericTypeName(declared) && isNumericTypeName(inferredName)) return true;
  return declared === inferredName;
}

interface InferContext {
  readonly typeTable: ReadonlyMap<string, InferredType>;
  readonly functionReturnTypes: ReadonlyMap<string, string | null>;
  readonly classShapesByName: ReadonlyMap<string, ClassShape>;
}

/** `field`/`state`/(other) `derived` names resolve to their own DECLARED type (never re-inferred — sidesteps needing dependency-graph ordering inside this pass; a declared type is already the contract this module enforces). `read`/`watch`/`stream`/`animation` names, and imported class names used bare, resolve to `unknown` — none of those carry a statically-known scalar type from this compiler's point of view (the store is schemaless; a stream/animation/class-import name is never itself a scalar value). */
function buildTypeTable(script: ThrScriptAst): ReadonlyMap<string, InferredType> {
  const table = new Map<string, InferredType>();
  for (const f of script.fields) table.set(f.name, named(f.type));
  for (const s of script.state) table.set(s.name, named(s.type));
  for (const d of script.derived) table.set(d.name, named(d.type));
  for (const r of script.reads) table.set(r.name, UNKNOWN);
  for (const w of script.watches) table.set(w.name, UNKNOWN);
  for (const s of script.streams) table.set(s.name, UNKNOWN);
  for (const a of script.animations) table.set(a.name, UNKNOWN);
  return table;
}

function inferLiteralType(node: BsLiteralExpression): InferredType {
  const token = node.token;
  if (!token) return UNKNOWN;
  switch (token.kind) {
    case TokenKind.StringLiteral:
      return named('string');
    case TokenKind.IntegerLiteral:
      return named('integer');
    case TokenKind.LongIntegerLiteral:
      return named('longinteger');
    case TokenKind.FloatLiteral:
      return named('float');
    case TokenKind.DoubleLiteral:
      return named('double');
    case TokenKind.True:
    case TokenKind.False:
      return BOOLEAN;
    default:
      // Invalid (nil) — compatible with any declared type by construction (never a real mismatch
      // worth flagging), and anything else this parser wouldn't produce for a literal token anyway.
      return UNKNOWN;
  }
}

/**
 * `+` is string concatenation when either operand is a `string`, otherwise (like every other
 * arithmetic operator) numeric-result when both operands are numeric — float/double wins over
 * integer/longinteger (an approximate promotion rule; good enough since the declared side is
 * already numeric-family-lenient). Anything else (a non-numeric, non-string operand on a numeric
 * op; a `+` between two non-string, non-numeric operands) infers `unknown` rather than guessing.
 */
function inferArithmeticResult(left: InferredType, right: InferredType, operator: string): InferredType {
  if (operator.trim() === '+') {
    if (left.kind === 'named' && left.name.trim().toLowerCase() === 'string') return named('string');
    if (right.kind === 'named' && right.name.trim().toLowerCase() === 'string') return named('string');
  }
  if (left.kind === 'named' && right.kind === 'named' && isNumericTypeName(left.name) && isNumericTypeName(right.name)) {
    const eitherFloaty = [left.name, right.name].some((n) => ['float', 'double'].includes(n.trim().toLowerCase()));
    return named(eitherFloaty ? 'float' : 'integer');
  }
  return UNKNOWN;
}

function isConfirmedBoolean(t: InferredType): boolean {
  return t.kind === 'named' && t.name.trim().toLowerCase() === 'boolean';
}

/**
 * `AND`/`OR`/`NOT` are real, deliberately-unguarded BrightScript keywords with a genuine DUAL
 * meaning — a Boolean logical op when every operand is Boolean, but ALSO a bitwise op on Integer
 * operands (`flags AND mask`, `NOT mask`) — unlike this DSL's own crash-safe sugar
 * (`==`/`!=`/`<`/`>`/`<=`/`>=`/`!`), which always produces a real Boolean with no such overload.
 * Inferring these as unconditionally `boolean` would be a genuine false positive: `derived combined:
 * integer = flagsA AND flagsB` is valid BrightScript this checker must not reject. So: `boolean`
 * only when every operand is CONFIRMED boolean; `unknown` for a confirmed-numeric operand (or
 * anything else) rather than guessing the bitwise result's exact numeric subtype — unlike
 * `inferArithmeticResult`, which IS confident about arithmetic's result type, this module has no
 * documented, Roku-confirmed rule for the bitwise result's subtype to fall back on (see
 * `findings/operators-comparison.md`'s own note on never guessing undocumented runtime behavior in
 * a checker like this).
 */
function inferBooleanOrBitwiseBinaryResult(left: InferredType, right: InferredType): InferredType {
  return isConfirmedBoolean(left) && isConfirmedBoolean(right) ? BOOLEAN : UNKNOWN;
}

function inferBooleanOrBitwiseUnaryResult(operand: InferredType): InferredType {
  return isConfirmedBoolean(operand) ? BOOLEAN : UNKNOWN;
}

/**
 * The core of "full inference": a call to a bare name resolves against this script's own
 * `private|public function` declarations (return type looked up directly — `null` becomes the
 * `'no-value'` case, a genuine error, not `unknown`); a call shaped `ClassName(...).methodName(...)`
 * — a `.flsh` class constructed inline and a method called directly off the result, the real shape
 * `apps/sample-app`'s `FavoriteCounter.thr` uses (`LabeledCounter(favoriteCount, "...").describe()`)
 * — resolves against that class's own `ClassShape.allMembers` (walked once for the whole app by
 * `app-compiler.ts` before any `.thr` component compiles, see `compile.ts`'s `classShapesByName` param).
 * Everything else a call could target (a BrightScript builtin, an arbitrary dot-chain method call, a
 * class instance held in a local variable rather than constructed inline, an unresolved name) infers
 * `unknown` — a deliberate boundary, not a gap: this compiler doesn't model BrightScript's own
 * stdlib signatures, and resolving a local variable's own type is a much bigger undertaking this
 * module doesn't attempt.
 */
function inferCallType(node: BsCallExpression, ctx: InferContext): InferredType {
  const callee = node.callee;

  if (callee instanceof BsIdentifierExpression) {
    if (!ctx.functionReturnTypes.has(callee.name)) return UNKNOWN;
    const returnType = ctx.functionReturnTypes.get(callee.name)!;
    return returnType === null ? { kind: 'no-value', calleeName: callee.name } : named(returnType);
  }

  if (callee instanceof BsDotExpression) {
    const target = callee.object;
    if (target instanceof BsCallExpression && target.callee instanceof BsIdentifierExpression) {
      const shape = ctx.classShapesByName.get(target.callee.name);
      const member = shape?.allMembers.get(callee.member);
      if (member && member.kind === 'method') {
        const calleeName = `${target.callee.name}.${callee.member}`;
        return member.returnType === null ? { kind: 'no-value', calleeName } : named(member.returnType);
      }
    }
    return UNKNOWN;
  }

  return UNKNOWN;
}

/**
 * Dispatches on flash-parser's own wrapper-class hierarchy for the parsed expression node — see
 * this file's own top doc comment for the full node-by-node rule table. A `'no-value'` result from
 * a nested operand (e.g. inside a larger arithmetic expression) is NOT specially propagated here —
 * every compound branch below only pattern-matches `kind === 'named'` operands, so a `'no-value'`
 * operand simply falls through to the same `unknown` result a genuinely unknown operand would;
 * `checkDerivedTypes` only ever observes `'no-value'` when it's the expression's own ROOT node. This
 * is a deliberate, bounded scope (the common, worth-catching case — `derived x: T = someSub()` —
 * not an exhaustive one), not an oversight.
 */
function inferExpressionType(node: BsAstNode, ctx: InferContext): InferredType {
  if (node instanceof BsLiteralExpression) return inferLiteralType(node);

  if (node instanceof BsIdentifierExpression) return ctx.typeTable.get(node.name) ?? UNKNOWN;

  // `==`/`!=`/`<`/`>`/`<=`/`>=` — all now DSL-guarded sugar (see `brightscript-ast.ts`'s
  // `BsComparisonExpression`), always boolean regardless of operand types.
  if (node instanceof BsComparisonExpression) return BOOLEAN;

  if (node instanceof BsBinaryExpression) {
    const op = node.operator.trim().toUpperCase();
    // Real, deliberately-unguarded `=`/`<>` (still real BrightScript equality, see GRAMMAR.md's
    // "Comparison" section) are always boolean, regardless of operand types.
    if (op === '=' || op === '<>') return BOOLEAN;
    const left = node.left ? inferExpressionType(node.left, ctx) : UNKNOWN;
    const right = node.right ? inferExpressionType(node.right, ctx) : UNKNOWN;
    // `AND`/`OR` have a dual Boolean/bitwise-Integer meaning — see `inferBooleanOrBitwiseBinaryResult`'s doc comment.
    if (op === 'AND' || op === 'OR') return inferBooleanOrBitwiseBinaryResult(left, right);
    return inferArithmeticResult(left, right, node.operator);
  }

  if (node instanceof BsUnaryExpression) {
    const op = node.operator.trim().toUpperCase();
    // Unary -/+ passes the operand's own type through unchanged.
    if (op !== 'NOT') return node.operand ? inferExpressionType(node.operand, ctx) : UNKNOWN;
    // `Not` has the same dual Boolean/bitwise-Integer meaning as `AND`/`OR` above — see
    // `inferBooleanOrBitwiseUnaryResult`'s doc comment (unlike this DSL's own `!` sugar below, which is always boolean).
    return inferBooleanOrBitwiseUnaryResult(node.operand ? inferExpressionType(node.operand, ctx) : UNKNOWN);
  }

  // `!<operand>` — always boolean, same as `Not`.
  if (node instanceof BsSafeNotExpression) return BOOLEAN;

  if (node instanceof BsGroupingExpression) return node.expression ? inferExpressionType(node.expression, ctx) : UNKNOWN;

  // An array/AA literal's own element types are never checked — the declared side is always
  // `object`/`dynamic`-compatible for these anyway (see `typesCompatible`'s own doc comment).
  if (node instanceof BsArrayLiteral || node instanceof BsAALiteral) return UNKNOWN;

  if (node instanceof BsCallExpression) return inferCallType(node, ctx);

  // Member/index/optional-chain access off anything — no statically-known member type exists
  // anywhere in this compiler (a `theme.*`/`router.*` global, a `.flsh` instance field, a
  // schemaless assocarray all reach here identically).
  if (node instanceof BsDotExpression || node instanceof BsIndexExpression || node instanceof BsOptionalChainingExpression) return UNKNOWN;

  return UNKNOWN;
}

/**
 * Parses `expressionText` (a `derived`'s raw RHS text) and returns its root expression node —
 * `null` on a genuine parse error. Unlike `analysis/literal-value.ts`'s `parseLiteralRoot` (which
 * THROWS on a parse error), this returns `null` and lets the caller skip silently: `derived`'s
 * expression text is independently parsed again, moments later in the same compile pass, by
 * `analysis/dependency-graph.ts`'s own `parseExpression` call — which already throws the real
 * `expression/parse-error` diagnostic. Duplicating that here would just be two copies of the same
 * check drifting apart over time (the same reasoning `expression-region.ts`'s own doc comment gives
 * for not duplicating global-path validation). Shares `literal-value.ts`'s
 * `unwrapEmbeddedExpressionRoot` for the actual root-extraction, rather than re-deriving it.
 */
function parseDerivedExpressionRoot(expressionText: string): BsAstNode | null {
  const parsed = parseEmbeddedExpression(expressionText);
  if (parsed.result.diagnostics.length > 0) return null;

  return unwrapEmbeddedExpressionRoot(parsed);
}

function describeInferred(inferred: InferredType): string {
  return inferred.kind === 'named' ? inferred.name : 'unknown';
}

/**
 * Checks every `derived <name>: <Type> = <expression>` in `script` against a best-effort static
 * inference of `<expression>`'s own type — see this file's own top doc comment for the full
 * rationale and boundary. `classShapesByName` (the whole app's `.flsh` class member table, already
 * keyed by class name — see `app-compiler.ts`'s `compileFlshClasses`, which also excludes a genuine
 * class-name collision from the map entirely rather than picking a winner) is optional: absent when
 * this script is compiled standalone (a unit test with no app-wide class context), in which case a
 * `ClassName(...).methodName(...)` call in a `derived` expression simply infers as `unknown`
 * (unchecked) rather than being resolved — the same fallback an unresolvable call already gets.
 *
 * Called from `compile.ts` right after `checkDuplicateBindingNames`, before `buildDependencyGraph` —
 * needs only `script`'s own data (every name this module cares about is already visible on `script`
 * itself).
 */
export function checkDerivedTypes(script: ThrScriptAst, classShapesByName: ReadonlyMap<string, ClassShape> = EMPTY_CLASS_SHAPES): void {
  if (script.derived.length === 0) return;

  const typeTable = buildTypeTable(script);
  const functionReturnTypes = new Map<string, string | null>(script.functions.map((f) => [f.name, f.returnType]));

  const ctx: InferContext = { typeTable, functionReturnTypes, classShapesByName };

  for (const d of script.derived) {
    const root = parseDerivedExpressionRoot(d.expression);
    if (!root) continue;

    const inferred = inferExpressionType(root, ctx);

    if (inferred.kind === 'no-value') {
      throw new CompileError({
        code: 'derived/no-value-call',
        message: `derived "${d.name}"'s expression calls "${inferred.calleeName}", which has no return type (compiles to a BrightScript "sub" with no value) — it cannot be used as an expression here.`,
        span: d.span,
      });
    }

    if (!typesCompatible(d.type, inferred)) {
      throw new CompileError({
        code: 'derived/type-mismatch',
        message: `derived "${d.name}" declares type "${d.type}" but its expression evaluates to "${describeInferred(inferred)}" — these are not compatible.`,
        span: d.span,
      });
    }
  }
}
