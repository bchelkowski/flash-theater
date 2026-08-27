import {
  findTopLevelIdentifiers,
  findAnonymousFunctionExpressions,
  parseEmbeddedExpression,
  parseEmbeddedStatements,
  Block as FlashBlock,
  IfStatement,
  ForStatement,
  ForEachStatement,
  WhileStatement,
  TryStatement,
  StateAssignment,
  StoreWriteStatement,
  FocusStatement,
  JumpFocusStatement,
  TernaryAssignmentStatement,
  AnonymousFunctionExpression,
  AnonymousFunctionAssignmentStatement,
  ScaleLocalAssignmentStatement,
  ScaleStateAssignmentStatement,
  reconstructTernaryText,
} from 'flash-parser';
import { CompileError, FieldDecl, TemplateNode, ThrScriptAst } from '../dsl-parser/dsl-ast.js';

/**
 * The two reactive focus-state names a component can read. They are
 * *reserved*, not declared: a component that mentions either one gets it
 * synthesized as an ordinary `field` (see `synthesizeFocusStateFields`),
 * which is what makes them work with `derived`, template `{expr}` bindings
 * and `{#if}`/`{#each}` conditions through the existing reactive machinery,
 * with no new grammar anywhere.
 *
 * - `isFocused` — focus is *directly* in this component: this component
 *   owns the focused element itself.
 * - `isInFocusChain` — the focused element is anywhere inside this
 *   component's subtree, **including** inside a nested child component.
 *
 * Both are maintained by `FlashTheaterFocusManager` from its single
 * `m.focusedNode` value, recomputed for every subscriber in one pass on
 * every real focus move — which is what guarantees two components can never
 * simultaneously report `isFocused = true`.
 */
export const FOCUS_STATE_FIELD_NAMES = ['isFocused', 'isInFocusChain'] as const;

const FOCUS_STATE_NAME_SET: ReadonlySet<string> = new Set(FOCUS_STATE_FIELD_NAMES);

/**
 * Rejects a `field`/`derived`/`state`/`read`/`watch`/function that would
 * shadow one of the reserved focus-state names. Same treatment `store` and
 * `focus` already get: a name the compiler owns cannot also be an author's
 * own binding, because the two would silently fight over the same generated
 * `m.<name>` slot.
 */
export function checkReservedFocusStateNames(script: ThrScriptAst): void {
  const declared: { name: string; what: string }[] = [
    ...script.fields.map((d) => ({ name: d.name, what: 'field' })),
    ...script.derived.map((d) => ({ name: d.name, what: 'derived' })),
    ...script.state.map((d) => ({ name: d.name, what: 'state' })),
    ...script.reads.map((d) => ({ name: d.name, what: 'read' })),
    ...script.watches.map((d) => ({ name: d.name, what: 'watch' })),
    ...script.functions.map((d) => ({ name: d.name, what: 'function' })),
  ];

  for (const { name, what } of declared) {
    if (FOCUS_STATE_NAME_SET.has(name)) {
      throw new CompileError({
        code: 'dsl/reserved-focus-state-name',
        message: `"${name}" is a reserved focus-state name and cannot be declared as a ${what} — the compiler synthesizes it as a read-only field whenever a component reads it. See GRAMMAR.md's "Focus system" section.`,
      });
    }
  }
}

/**
 * Which focus-state names this component actually reads, anywhere: a
 * `derived` expression, a function body (including nested `if`/`else`
 * bodies and a `state`/`store(...)`/`focus(...)` statement's own
 * right-hand side), a dynamic template attribute, or an
 * `{#if}`/`{#each}` block's own condition/collection/key expression.
 *
 * A component that reads neither gets nothing — no synthesized fields, no
 * `registerFocusState` call, no runtime bookkeeping. That is the whole
 * point of scanning rather than emitting unconditionally: a simple
 * presentational component should not carry focus-state machinery it never
 * asked for.
 *
 * Same best-effort, re-parse-each-raw-text-surface approach as
 * `compile.ts`'s `usesRouterAnywhere` (cheap — flash-parser's
 * `parseEmbeddedExpression`/`parseEmbeddedStatements` are memoized by exact
 * text), and for the same reason: unlike `store`/`focus`, these names have
 * no dedicated statement kind to walk, they are ordinary identifiers.
 */
export function collectUsedFocusStateNames(script: ThrScriptAst, templateRoot: TemplateNode): string[] {
  const used = new Set<string>();

  for (const d of script.derived) collectFrom(d.expression, 'expression', used);
  for (const f of script.functions) scanBlock(f.block, used);
  scanTemplate(templateRoot, used);

  return FOCUS_STATE_FIELD_NAMES.filter((name) => used.has(name));
}

/**
 * Walks the template for every raw expression an author can write:
 * dynamic/`bind:`/`on:key` attribute values, and `{#if}`/`{#each}` block
 * headers. Deliberately walks the template AST directly rather than
 * consuming the already-analyzed `TemplateAttributeBinding[]`, because this
 * scan has to run *before* scope resolution — its whole purpose is to
 * decide which fields exist in the first place.
 */
function scanTemplate(node: TemplateNode, used: Set<string>): void {
  if (node.kind === 'element') {
    for (const attribute of node.attributes) {
      if (attribute.kind === 'dynamic' || attribute.kind === 'bind' || attribute.kind === 'onKey') {
        collectFrom(attribute.expression, 'expression', used);
      }
    }
  } else if (node.kind === 'if') {
    collectFrom(node.expression, 'expression', used);
  } else {
    collectFrom(node.collectionExpression, 'expression', used);
    collectFrom(node.keyExpression, 'expression', used);
  }

  for (const child of node.children) scanTemplate(child, used);
}

function collectFrom(text: string, mode: 'expression' | 'statement', used: Set<string>): void {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  // An unparseable fragment is surfaced properly, later, by the normal rewrite pipeline — this
  // scan is best-effort detection only.
  if (parsed.result.diagnostics.length > 0) return;

  for (const identifier of findTopLevelIdentifiers(parsed, text)) {
    if (FOCUS_STATE_NAME_SET.has(identifier.name)) used.add(identifier.name);
  }

  // `findTopLevelIdentifiers` doesn't descend into a nested function's own scope — a Tier-2
  // anonymous function (nested inside a call argument, a condition, ...) needs its own body
  // scanned explicitly, the same way `AnonymousFunctionAssignmentStatement`'s Tier-1 host does
  // below.
  for (const access of findAnonymousFunctionExpressions(parsed, text)) {
    scanBlock(new AnonymousFunctionExpression(access.node).block, used);
  }
}

/** Walks a function body's own statements, including nested `if`/`else if`/`else` bodies — mirrors `compile.ts`'s `blockHasRouterAccess`/`ifHasRouterAccess` exactly. */
function scanBlock(block: FlashBlock, used: Set<string>): void {
  for (const statement of block.statements) {
    if (statement instanceof IfStatement) {
      scanIf(statement, used);
    } else if (statement instanceof ForStatement) {
      collectFrom(statement.startExpr.text, 'expression', used);
      collectFrom(statement.endExpr.text, 'expression', used);
      if (statement.stepExpr) collectFrom(statement.stepExpr.text, 'expression', used);
      scanBlock(statement.body, used);
    } else if (statement instanceof ForEachStatement) {
      collectFrom(statement.collectionExpr.text, 'expression', used);
      scanBlock(statement.body, used);
    } else if (statement instanceof WhileStatement) {
      collectFrom(statement.condition.text, 'expression', used);
      scanBlock(statement.body, used);
    } else if (statement instanceof TryStatement) {
      scanBlock(statement.tryBlock, used);
      scanBlock(statement.catchClause.body, used);
    } else if (statement instanceof StateAssignment) {
      // `reconstructTernaryText` degrades to `.expression` unchanged for a ternary-free RHS, so
      // one call covers both shapes — a ternary-bearing `state` write's `.expression` getter
      // throws (see ast.ts), so it can't be used directly here. An anonymous-function RHS has no
      // text of its own to scan; recurse into its body instead.
      if (statement.rhs instanceof AnonymousFunctionExpression) scanBlock(statement.rhs.block, used);
      else collectFrom(reconstructTernaryText(statement.rhs), 'expression', used);
    } else if (statement instanceof StoreWriteStatement || statement instanceof FocusStatement) {
      collectFrom(statement.expression, 'expression', used);
    } else if (statement instanceof JumpFocusStatement) {
      collectFrom(statement.directionExpression, 'expression', used);
      collectFrom(statement.countExpression, 'expression', used);
      collectFrom(statement.pressExpression, 'expression', used);
    } else if (statement instanceof TernaryAssignmentStatement) {
      collectFrom(reconstructTernaryText(statement.rhs), 'expression', used);
    } else if (statement instanceof AnonymousFunctionAssignmentStatement) {
      scanBlock(statement.value.block, used);
    } else if (statement instanceof ScaleLocalAssignmentStatement || statement instanceof ScaleStateAssignmentStatement) {
      if (statement.rhs instanceof AnonymousFunctionExpression) scanBlock(statement.rhs.block, used);
      else collectFrom(reconstructTernaryText(statement.rhs), 'expression', used);
    } else {
      collectFrom(statement.text, 'statement', used);
    }
  }
}

function scanIf(statement: IfStatement, used: Set<string>): void {
  collectFrom(statement.condition.text, 'expression', used);
  if (statement.thenBlock) scanBlock(statement.thenBlock, used);
  if (statement.thenStatement) collectFrom(statement.thenStatement.text, 'statement', used);

  const clause = statement.elseClause;
  if (!clause) return;
  if (clause.block) scanBlock(clause.block, used);
  if (clause.statement) collectFrom(clause.statement.text, 'statement', used);
  if (clause.elseIf) scanIf(clause.elseIf, used);
}

/**
 * Returns `script` with a synthesized boolean `field` for each focus-state
 * name the component actually reads, so every downstream stage — scope
 * resolution, the `derived` dependency graph, the XML `<field>` list, the
 * generated `on<Name>Change` cascade — treats them as ordinary fields with
 * no special-casing anywhere. Returns `script` unchanged when none are
 * read.
 *
 * They are written only by `FlashTheaterFocusManager` (never by the
 * component itself, and there is deliberately no DSL syntax to assign one),
 * which is exactly the same shape as a `bind:`-populated field: an ordinary
 * field whose value happens to arrive from outside.
 */
export function synthesizeFocusStateFields(script: ThrScriptAst, usedNames: readonly string[]): ThrScriptAst {
  if (usedNames.length === 0) return script;

  const synthesized: FieldDecl[] = usedNames.map((name) => ({
    kind: 'field',
    name,
    type: 'boolean',
    defaultLiteral: 'false',
    scale: false,
    span: { line: 0 },
  }));

  return { ...script, fields: [...script.fields, ...synthesized] };
}
