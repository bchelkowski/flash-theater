/**
 * Scope analysis over the full BrightScript CST — the grammar-ownership
 * counterpart to `kopytko-brightscript-parser`'s own `buildScopes`/`resolve`
 * (`node_modules/kopytko-brightscript-parser/dist/src/scope.js`). Vendored
 * and adapted with the **same function names and same
 * `Scope`/`Declaration`/`Reference`/`DeclarationKind` shapes** on purpose:
 * `packages/compiler/src/analysis/scope-resolution.ts` already imports
 * `parseBrightScript`/`buildBrightScriptScopes`/`resolveBrightScriptName`
 * from this module (via the `flash-parser` package) instead of from
 * `kopytko-brightscript-parser` — see `findings/compiler-identifier-resolution.md`.
 * The only remaining live `kopytko-brightscript-parser` import in the
 * compiler is `builtinNames` in that same file, kept because it's Roku's own
 * evolving platform catalog, not grammar.
 *
 * BrightScript scoping rules (unchanged from the vendored source):
 * - Functions/subs create their own scope.
 * - Parameters are local to their function scope.
 * - Variables assigned with `=` are local to their function scope.
 * - `for` / `for each` loop variables are local to their function scope.
 * - `catch` variables are local to their function scope.
 * - `m` is always valid (SceneGraph's component-scope variable).
 * - `dim` declares an array variable local to the function scope.
 * - All identifiers are resolved case-insensitively (real BrightScript
 *   semantics — distinct from the DSL layer's own case-sensitive
 *   identifier resolution in `packages/compiler/src/analysis/
 *   scope-resolution.ts`'s `resolveIdentifier`, which is a different,
 *   DSL-level concern layered on top of this).
 *
 * This is BrightScript *language semantics* (how local-variable shadowing
 * works), not platform reference data — unlike the builtin-function/
 * SceneGraph catalogs (deliberately kept as a live dependency, never
 * vendored, since those track Roku's own evolving platform), this doesn't
 * change firmware to firmware, so it's vendored and owned outright like the
 * rest of the grammar.
 */
import { SyntaxNode, isNode, isToken } from './syntaxNode.js';
import { SyntaxKind } from './syntaxKind.js';
import { TokenKind } from './tokenKind.js';

export interface Declaration {
  /** The declared name (original casing). */
  readonly name: string;
  /** The declared name (lowercased for case-insensitive lookup). */
  readonly nameLower: string;
  readonly kind: DeclarationKind;
  /** 0-based line number of the declaration. */
  readonly line: number;
  /** 0-based column of the declaration. */
  readonly column: number;
  /** The CST node that contains this declaration. */
  readonly node: SyntaxNode;
}

export type DeclarationKind = 'function' | 'parameter' | 'variable' | 'for-variable' | 'catch-variable' | 'dim-variable';

export interface Reference {
  /** The referenced name (original casing). */
  readonly name: string;
  readonly nameLower: string;
  readonly line: number;
  readonly column: number;
  readonly node: SyntaxNode;
  /**
   * True when this reference is the sole target of a plain `=` assignment
   * (pure write). False for reads and compound assignments (`+=`, `-=`,
   * ...), which also read the value.
   */
  readonly isWrite: boolean;
}

export interface Scope {
  /** The function/sub that owns this scope, or null for the file scope. */
  readonly owner: SyntaxNode | null;
  /** The name of the owning function (lowercased), or '' for file scope. */
  readonly ownerName: string;
  readonly parent: Scope | null;
  /** All declarations in this scope. */
  readonly declarations: Map<string, Declaration>;
  /** All identifier references in this scope (not in child scopes). */
  readonly references: Reference[];
  /** Child scopes (nested functions). */
  readonly children: Scope[];
}

const ALWAYS_VALID: ReadonlySet<string> = new Set(['m', 'true', 'false', 'invalid', 'line_num']);

/** Builds a scope tree from a parsed source file (a `BsSourceFile` CST node). */
export function buildScopes(root: SyntaxNode): Scope {
  const fileScope: Scope = { owner: null, ownerName: '', parent: null, declarations: new Map(), references: [], children: [] };
  collectFromNode(root, fileScope);
  return fileScope;
}

/** Finds the innermost scope that contains the given line. */
export function findScopeAtLine(scope: Scope, line: number): Scope {
  for (const child of scope.children) {
    if (child.owner) {
      const ownerStart = getNodeLine(child.owner);
      const ownerEnd = getNodeEndLine(child.owner);
      if (line >= ownerStart && line <= ownerEnd) return findScopeAtLine(child, line);
    }
  }
  return scope;
}

/** Resolves a name in the given scope, searching up the scope chain (case-insensitively). Returns the declaration or `undefined` if not found. */
export function resolve(name: string, scope: Scope): Declaration | undefined {
  const lower = name.toLowerCase();
  if (ALWAYS_VALID.has(lower)) return undefined; // implicitly valid
  let current: Scope | null = scope;
  while (current) {
    const decl = current.declarations.get(lower);
    if (decl) return decl;
    current = current.parent;
  }
  return undefined;
}

// ─── Internal ──────────────────────────────────────────────────────────────
function collectFromNode(node: SyntaxNode, scope: Scope): void {
  switch (node.kind) {
    case SyntaxKind.BsFunctionDeclaration:
      collectFunctionDeclaration(node, scope);
      return; // don't recurse — child scope handles body
    case SyntaxKind.BsFunctionExpression:
      collectFunctionExpression(node, scope);
      return;
    case SyntaxKind.AnonymousFunctionExpression:
      collectAnonymousFunctionExpression(node, scope);
      return; // don't recurse — child scope handles body, same as BsFunctionExpression above
    case SyntaxKind.BsAssignmentStatement: {
      collectAssignment(node, scope);
      // Add the LHS reference with the correct isWrite flag, then recurse only into
      // non-LHS children so the LHS identifier isn't double-counted.
      const lhsNode = node.childNodes[0];
      if (lhsNode?.kind === SyntaxKind.BsIdentifierExpression) {
        // Plain `=` is a pure write; compound operators (`+=`, `-=`, etc.) also read.
        const opToken = node.children.find(isToken);
        const nameToken = lhsNode.findToken(TokenKind.Identifier);
        if (nameToken) {
          scope.references.push({
            name: nameToken.text,
            nameLower: nameToken.text.toLowerCase(),
            line: nameToken.line,
            column: nameToken.column,
            node: lhsNode,
            isWrite: opToken?.kind === TokenKind.Equals,
          });
        }
        for (const child of node.children) {
          if (isNode(child) && child !== lhsNode) collectFromNode(child, scope);
        }
      } else {
        // Non-identifier LHS (index access, dot access) — all its refs are reads.
        for (const child of node.children) {
          if (isNode(child)) collectFromNode(child, scope);
        }
      }
      return;
    }
    case SyntaxKind.BsForStatement:
      collectForVariable(node, scope);
      break;
    case SyntaxKind.BsForEachStatement:
      collectForEachVariable(node, scope);
      break;
    case SyntaxKind.BsCatchClause:
      collectCatchVariable(node, scope);
      break;
    case SyntaxKind.BsDimStatement:
      collectDimVariable(node, scope);
      break;
    case SyntaxKind.BsConditionalCompilation:
      // Process body statements inside #if blocks (real BrightScript) but
      // skip the condition expression (manifest constants like RALE, DEBUG).
      collectConditionalBody(node, scope);
      return;
    case SyntaxKind.BsHashConstStatement:
    case SyntaxKind.BsHashErrorStatement:
      // #const and #error don't contain BrightScript code.
      return;
    case SyntaxKind.BsCallExpression:
    case SyntaxKind.BsIdentifierExpression:
      collectReferences(node, scope);
      break;
    default:
      break;
  }
  for (const child of node.children) {
    if (isNode(child)) collectFromNode(child, scope);
  }
}

/** Processes a `BsConditionalCompilation` node: skips condition identifiers (`#if RALE`, `#else if FLAG`) but analyzes body statements normally. */
function collectConditionalBody(node: SyntaxNode, scope: Scope): void {
  let skipNextExpression = false;
  for (const child of node.children) {
    if (isToken(child)) {
      skipNextExpression = child.kind === TokenKind.HashIf || child.kind === TokenKind.HashElseIf;
      continue;
    }
    if (isNode(child)) {
      if (skipNextExpression) {
        skipNextExpression = false;
        continue;
      }
      collectFromNode(child, scope);
    }
  }
}

function newChildScope(owner: SyntaxNode, ownerName: string, parent: Scope): Scope {
  const childScope: Scope = { owner, ownerName, parent, declarations: new Map(), references: [], children: [] };
  parent.children.push(childScope);
  return childScope;
}

function collectParams(node: SyntaxNode, childScope: Scope): void {
  const paramList = node.findChild(SyntaxKind.BsParameterList);
  if (!paramList) return;
  for (const param of paramList.findAllChildren(SyntaxKind.BsParameter)) {
    const pName = param.findToken(TokenKind.Identifier);
    if (pName) {
      childScope.declarations.set(pName.text.toLowerCase(), {
        name: pName.text,
        nameLower: pName.text.toLowerCase(),
        kind: 'parameter',
        line: pName.line,
        column: pName.column,
        node: param,
      });
    }
  }
}

function collectBody(node: SyntaxNode, childScope: Scope): void {
  for (const child of node.children) {
    if (isNode(child) && child.kind !== SyntaxKind.BsParameterList && child.kind !== SyntaxKind.BsReturnTypeClause) {
      collectFromNode(child, childScope);
    }
  }
}

function collectFunctionDeclaration(node: SyntaxNode, parentScope: Scope): void {
  const nameToken = node.findToken(TokenKind.Identifier);
  const name = nameToken?.text ?? '';
  if (name && nameToken) {
    parentScope.declarations.set(name.toLowerCase(), {
      name,
      nameLower: name.toLowerCase(),
      kind: 'function',
      line: nameToken.line,
      column: nameToken.column,
      node,
    });
  }
  const childScope = newChildScope(node, name.toLowerCase(), parentScope);
  collectParams(node, childScope);
  collectBody(node, childScope);
}

function collectFunctionExpression(node: SyntaxNode, parentScope: Scope): void {
  const childScope = newChildScope(node, '', parentScope);
  collectParams(node, childScope);
  collectBody(node, childScope);
}

/**
 * A Tier-2 DSL anonymous function (`SyntaxKind.AnonymousFunctionExpression`) nested inside an
 * otherwise all-`Bs`-prefixed tree — reached whenever `scope-resolution.ts` reconstructs an
 * enclosing statement's raw text (verbatim, DSL sugar included) and re-parses it via
 * `parseBrightScript` for `hasLocal`/`isUnused` queries (a plain `ExpressionRegion`/
 * `StatementRegion`'s reconstruction fallback is the statement's own original text, so a Tier-2
 * anon function's literal `function (...) { }` source survives into that re-parse verbatim).
 * Mirrors `collectFunctionExpression`'s shape (own independent child scope, own parameters
 * declared there) but reads the DSL's own `SyntaxKind.ParameterList`/`Parameter` — not
 * `BsParameterList`/`BsParameter` — since a Tier-2 anon function's header is parsed by
 * `token-stream-parser.ts`'s DSL grammar (`brightscript-parser.ts`'s Tier-2 dispatch hands off
 * to it), never this file's own BrightScript-only function-expression production. Without this
 * case, the anon function's own parameter names would fall through to the generic per-child
 * recursion at the bottom of `collectFromNode` and leak into the *enclosing* scope instead of
 * being scoped to the anon function itself — a soft correctness bug (wrong `isUnused`/`hasLocal`
 * answers for a name colliding with an anon function's own parameter), not a crash.
 */
function collectAnonymousFunctionExpression(node: SyntaxNode, parentScope: Scope): void {
  const childScope = newChildScope(node, '', parentScope);
  const paramList = node.findChild(SyntaxKind.ParameterList);
  if (paramList) {
    for (const param of paramList.findAllChildren(SyntaxKind.Parameter)) {
      const pName = param.findToken(TokenKind.Identifier);
      if (pName) {
        childScope.declarations.set(pName.text.toLowerCase(), {
          name: pName.text,
          nameLower: pName.text.toLowerCase(),
          kind: 'parameter',
          line: pName.line,
          column: pName.column,
          node: param,
        });
      }
    }
  }
  const block = node.findChild(SyntaxKind.Block);
  if (block) {
    for (const child of block.children) {
      if (isNode(child)) collectFromNode(child, childScope);
    }
  }
}

function collectAssignment(node: SyntaxNode, scope: Scope): void {
  const firstChild = node.childNodes[0];
  if (firstChild && firstChild.kind === SyntaxKind.BsIdentifierExpression) {
    const nameToken = firstChild.findToken(TokenKind.Identifier);
    if (nameToken && !scope.declarations.has(nameToken.text.toLowerCase())) {
      scope.declarations.set(nameToken.text.toLowerCase(), {
        name: nameToken.text,
        nameLower: nameToken.text.toLowerCase(),
        kind: 'variable',
        line: nameToken.line,
        column: nameToken.column,
        node: firstChild,
      });
    }
  }
}

function collectForVariable(node: SyntaxNode, scope: Scope): void {
  const nameToken = node.findToken(TokenKind.Identifier);
  if (!nameToken) return;
  if (!scope.declarations.has(nameToken.text.toLowerCase())) {
    scope.declarations.set(nameToken.text.toLowerCase(), {
      name: nameToken.text,
      nameLower: nameToken.text.toLowerCase(),
      kind: 'for-variable',
      line: nameToken.line,
      column: nameToken.column,
      node,
    });
  }
  // The for-counter is assigned at the start of every loop run — record as a write.
  scope.references.push({
    name: nameToken.text,
    nameLower: nameToken.text.toLowerCase(),
    line: nameToken.line,
    column: nameToken.column,
    node,
    isWrite: true,
  });
}

function collectForEachVariable(node: SyntaxNode, scope: Scope): void {
  let foundEach = false;
  for (const child of node.children) {
    if (isToken(child) && child.kind === TokenKind.Each) {
      foundEach = true;
      continue;
    }
    if (foundEach && isToken(child) && child.kind === TokenKind.Identifier) {
      if (!scope.declarations.has(child.text.toLowerCase())) {
        scope.declarations.set(child.text.toLowerCase(), {
          name: child.text,
          nameLower: child.text.toLowerCase(),
          kind: 'for-variable',
          line: child.line,
          column: child.column,
          node,
        });
      }
      scope.references.push({
        name: child.text,
        nameLower: child.text.toLowerCase(),
        line: child.line,
        column: child.column,
        node,
        isWrite: true,
      });
      break;
    }
  }
}

function collectCatchVariable(node: SyntaxNode, scope: Scope): void {
  const nameToken = node.findToken(TokenKind.Identifier);
  if (nameToken && !scope.declarations.has(nameToken.text.toLowerCase())) {
    scope.declarations.set(nameToken.text.toLowerCase(), {
      name: nameToken.text,
      nameLower: nameToken.text.toLowerCase(),
      kind: 'catch-variable',
      line: nameToken.line,
      column: nameToken.column,
      node,
    });
  }
}

function collectDimVariable(node: SyntaxNode, scope: Scope): void {
  const nameToken = node.findToken(TokenKind.Identifier);
  if (nameToken && !scope.declarations.has(nameToken.text.toLowerCase())) {
    scope.declarations.set(nameToken.text.toLowerCase(), {
      name: nameToken.text,
      nameLower: nameToken.text.toLowerCase(),
      kind: 'dim-variable',
      line: nameToken.line,
      column: nameToken.column,
      node,
    });
  }
}

function collectReferences(node: SyntaxNode, scope: Scope): void {
  if (node.kind === SyntaxKind.BsIdentifierExpression) {
    const token = node.findToken(TokenKind.Identifier);
    if (token) {
      scope.references.push({ name: token.text, nameLower: token.text.toLowerCase(), line: token.line, column: token.column, node, isWrite: false });
    }
  }
  if (node.kind === SyntaxKind.BsCallExpression) {
    const callee = node.childNodes[0];
    if (callee && callee.kind === SyntaxKind.BsIdentifierExpression) {
      const token = callee.findToken(TokenKind.Identifier);
      if (token) {
        scope.references.push({ name: token.text, nameLower: token.text.toLowerCase(), line: token.line, column: token.column, node: callee, isWrite: false });
      }
    }
  }
}

function getNodeLine(node: SyntaxNode): number {
  for (const child of node.children) {
    if (isToken(child)) return child.line;
    if (isNode(child)) return getNodeLine(child);
  }
  return 0;
}

function getNodeEndLine(node: SyntaxNode): number {
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    if (isToken(child)) return child.line;
    if (isNode(child)) return getNodeEndLine(child);
  }
  return 0;
}
