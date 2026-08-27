/**
 * Elides an unused local variable's assignment statement from generated
 * `.brs` output — "if there is any unused variable it is simply not
 * needed." Operates on a `StatementRegion`'s raw text line by line (a
 * region can bundle several physical lines of passthrough BrightScript
 * between two `if`/`state` boundaries — see flash-parser's `ast.ts`): a
 * line is dropped only when it is EXACTLY one non-compound `x = <expr>`
 * assignment to a bare identifier that `FunctionScope.isUnused` reports as
 * never read, AND `<expr>` contains no `CallExpression` anywhere in its
 * subtree.
 *
 * That last check is a deliberate, conservative safety net: dropping the
 * statement also drops evaluation of its right-hand side. A dead literal/
 * arithmetic store (`total = 0`) is safe to lose, but a call
 * (`total = SomeFunc()`) might have a side effect worth keeping even though
 * its result is discarded — this DSL has no purity annotations to lean on,
 * so "no call anywhere in the RHS" is the cheapest static proxy for "safe to
 * drop" available. Multiple dead writes to the same never-read name are
 * each elided independently (the variable really is entirely unneeded, not
 * partially).
 *
 * **The target must also not resolve to a declared DSL binding** (`field`/
 * `derived`/`state`/`read`/`watch`/function) — `functionScope.isUnused`'s
 * scope analysis has no idea `focusRequest = "x"` isn't a throwaway local;
 * it just sees an assignment target never read again *within this
 * function*, exactly what a real dead local looks like. But a `field`
 * write is never dead even when nothing in the same function reads it back
 * — it's a real SceneGraph field, externally observable by any parent's
 * `ObserveFieldScoped`/`bind:`, so writing it always has an effect outside
 * this function's own scope. Confirmed live as a real bug: a component
 * setting its own outbound `field` to signal a parent (the same shape
 * `bind:` itself relies on) had that assignment silently vanish from the
 * generated `.brs` entirely. `bindings.resolveDsl(name)` is checked first
 * for exactly this reason — a real local was never entered into `bindings`
 * in the first place, so this adds no false negatives for genuine dead
 * locals.
 *
 * A line that fails to parse standalone, or isn't exactly one such
 * assignment (a compound assignment, an indexed/dotted target, more than
 * one statement on the line), is left untouched.
 */
import {
  parseEmbeddedStatements,
  BsAssignmentStatement as AssignmentStatement,
  BsFunctionDeclaration,
  BsIdentifierExpression as IdentifierExpression,
  SyntaxKind as BsSyntaxKind,
  SyntaxNode as BsSyntaxNode,
  findAll,
} from 'flash-parser';
import { FunctionScope, ScriptBindings } from './scope-resolution.js';

export function elideUnusedLocalAssignments(text: string, functionScope: FunctionScope, bindings: ScriptBindings): string {
  return text
    .split('\n')
    .filter((line) => !isElidableUnusedLocalAssignment(line, functionScope, bindings))
    .join('\n');
}

function isElidableUnusedLocalAssignment(line: string, functionScope: FunctionScope, bindings: ScriptBindings): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;

  const parsed = parseEmbeddedStatements(trimmed);
  if (parsed.result.diagnostics.length > 0) return false;

  const wrapperSub = findAll(parsed.result.root, BsSyntaxKind.BsFunctionDeclaration, (n) => new BsFunctionDeclaration(n))[0];
  if (!wrapperSub) return false;

  const statements = wrapperSub.body;
  if (statements.length !== 1) return false;

  const [statement] = statements;
  if (statement.syntax.kind !== BsSyntaxKind.BsAssignmentStatement) return false;

  const assignment = new AssignmentStatement(statement.syntax);
  if (assignment.isCompound) return false;

  const target = assignment.target;
  if (!target || target.syntax.kind !== BsSyntaxKind.BsIdentifierExpression) return false;

  const targetName = new IdentifierExpression(target.syntax).name;
  if (bindings.resolveDsl(targetName)) return false;
  if (!functionScope.isUnused(targetName)) return false;

  const value = assignment.value;
  if (!value) return false;

  return !containsCallExpression(value.syntax);
}

/** Any `BsCallExpression` anywhere in `node`'s subtree (including `node` itself). */
function containsCallExpression(node: BsSyntaxNode): boolean {
  return findAll(node, BsSyntaxKind.BsCallExpression, () => true).length > 0;
}
