/**
 * Unified identifier resolution — the single place that decides what a bare
 * DSL-source name *means*. Everything that used to ask "is this a field, a
 * derived, a function?" ad hoc (identifier-rewrite.ts, dependency-graph.ts,
 * template-bindings.ts) now goes through `ScriptBindings` here instead, and
 * `resolveIdentifier` is the one function that decides, for any identifier
 * anywhere in the DSL (a `derived` expression, a template binding, a
 * function body), whether it's a known DSL binding (rewritten), a real
 * BrightScript local/parameter (left alone — shadows DSL bindings), a
 * builtin/`m` (left alone), or genuinely unresolved (a hard compile error).
 *
 * Adding a new binding kind later (see docs/features.md's roadmap) means
 * adding one bucket to `ScriptBindings`/`buildScriptBindings` and one branch
 * in `resolveDsl` — every caller (rewriting, dependency-graph, codegen)
 * picks it up automatically through this one module.
 */
// builtinNames is the one remaining live kopytko-brightscript-parser import
// here, deliberately — it's Roku's own platform-documentation catalog (the
// set of real builtin functions), not grammar, so it's never vendored (see
// findings/compiler-architecture.md's refined dependency rule). Everything
// else below (parsing, scope-resolution) is flash-parser's own, owned
// outright.
import { builtinNames } from 'kopytko-brightscript-parser';
import {
  parseBrightScript,
  buildBrightScriptScopes as buildScopes,
  resolveBrightScriptName,
  Block,
  ConstructorFieldInit,
  ElseClause,
  IfStatement,
  ForStatement,
  ForEachStatement,
  WhileStatement,
  TryStatement,
  StateAssignment,
  StatementRegion,
  StoreWriteStatement,
  FocusStatement,
  JumpFocusStatement,
  SuperCallStatement,
  TernaryAssignmentStatement,
  AnonymousFunctionExpression,
  AnonymousFunctionAssignmentStatement,
  ScaleLocalAssignmentStatement,
  ScaleStateAssignmentStatement,
  RawBrightScriptStatement,
  reconstructTernaryText,
} from 'flash-parser';
import type { BrightScriptScope as Scope } from 'flash-parser';
import { CompileError, ConstructorDecl, ThrClassAst, ThrScriptAst } from '../dsl-parser/dsl-ast.js';
import { privateFunctionName, isReservedIdentifier, animationNodeId, mFieldAccess } from '../codegen/naming.js';
import type { RefreshableInterpolatorRef } from '../codegen/animation-emitter.js';
// Type-only — `GlobalBindingsContext` is defined in global-bindings.ts, which itself imports
// `ScriptBindings`/`buildScriptBindings` (runtime values) from this module. `import type` is erased
// at compile time, so this is a type-level-only cycle, not a runtime one.
import type { GlobalBindingsContext } from './global-bindings.js';
import { globalFieldRef } from '../codegen/global-fields.js';

export type BindingKind =
  | 'field'
  | 'derived'
  | 'state'
  | 'read'
  | 'watch'
  | 'stream'
  | 'animation'
  | 'private-function'
  | 'public-function'
  | 'imported-class'
  | 'theme'
  | 'router'
  | 'taskManager'
  | 'local'
  | 'builtin'
  | 'special'
  | 'unresolved';

/** No app-level theme — the default when a caller doesn't have (or care about) global-binding context. */
const NO_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };

export interface ResolvedBinding {
  readonly kind: BindingKind;
  /** Replacement text for a DSL binding read (`m.top.x`/`m.x`/`private_x`) — null for anything left untouched (a real local, a builtin, `m`, or unresolved). */
  readonly replacement: string | null;
}

/**
 * `m` — BrightScript/SceneGraph's component-scope variable. Not a
 * "function", so it isn't in kopytko-brightscript-parser's builtins
 * catalog, but it's always valid. `self` is this codegen's own convention
 * for a class's generated `private_constructor` helper (see
 * `codegen/class-emitter.ts`/`analysis/class-identifier-rewrite.ts`) — by
 * the time a rewritten class-body statement reaches `applyIdentifierRewrite`,
 * `rewriteClassMemberAccesses` has already spliced `m.<name>` into
 * `self.<name>`, so `self` must resolve here the same way `m` does, not as
 * an unresolved bare identifier.
 */
const SPECIAL_NAMES = new Set(['m', 'self']);

function isSpecial(name: string): boolean {
  return SPECIAL_NAMES.has(name);
}

/** BrightScript builtins are matched case-insensitively (BrightScript itself is case-insensitive), unlike this DSL's own names — see GRAMMAR.md's case-sensitivity rule. */
function isBuiltin(name: string): boolean {
  return builtinNames.has(name.toLowerCase());
}

/** The DSL-level binding table for one script — field/derived/state/read/watch/function names, built once per `.thr` file and reused by every resolution. */
export interface ScriptBindings {
  readonly fieldNames: ReadonlySet<string>;
  readonly derivedNames: ReadonlySet<string>;
  readonly stateNames: ReadonlySet<string>;
  readonly readNames: ReadonlySet<string>;
  readonly watchNames: ReadonlySet<string>;
  /**
   * `stream` names — deliberately kept OUT of `reactiveSourceNames` and
   * every other set `analysis/dependency-graph.ts` reads: a stream is a
   * purely imperative pub-sub value, never part of the `derived`/`watch`
   * cascade graph. Reading `someStream.value` inside a `derived` expression
   * is a plain, non-reactive snapshot — structurally identical to reading
   * any other object's member field — never a tracked dependency, by
   * construction (this set is disjoint from every set that graph consults).
   */
  readonly streamNames: ReadonlySet<string>;
  /**
   * `animation` names — deliberately kept OUT of `reactiveSourceNames` and every other set
   * `analysis/dependency-graph.ts` reads, same reasoning as `streamNames`: an animation's own
   * trigger (`.start()`/`.stop()`/`.pause()`/`.resume()`/`.finish()`, see
   * `identifier-rewrite.ts`'s `rewriteAnimationControlCalls`) is a purely imperative side effect,
   * never a tracked reactive dependency.
   */
  readonly animationNames: ReadonlySet<string>;
  readonly privateFunctionNames: ReadonlySet<string>;
  readonly publicFunctionNames: ReadonlySet<string>;
  /** Names brought into scope by `import <ClassName> from "..."` — resolves as `replacement: null` (the generated class function name is used verbatim, `x = MyClass("a", 1)`, no rewriting needed), same treatment as a builtin. */
  readonly importedClassNames: ReadonlySet<string>;
  /** field ∪ state — anything a `derived`/template binding can depend on and be notified about (dependency-graph.ts, template-bindings.ts). A `watch` is deliberately NOT in this set: its own reactivity is driven by the store's top-level key changing, not by something else depending on the `watch` name being notified the way a field/state change is — a `watch`, like a `derived`, is only ever something else *reads*. A `stream` is likewise NOT in this set — see `streamNames`'s own doc comment. */
  readonly reactiveSourceNames: ReadonlySet<string>;
  /**
   * Layer 1 `animation {}` declaration name → the `RefreshableInterpolatorRef[]` for every
   * interpolator in ITS OWN step tree whose effective target lives inside a `{#if:destroy}` block
   * — see `codegen/animation-emitter.ts`'s `RefreshableInterpolatorRef` doc comment for the
   * underlying Roku `fieldToInterp` staleness bug, and `identifier-rewrite.ts`'s
   * `rewriteAnimationControlCalls` for the call site that actually emits the refresh lines before
   * every `.start()` for an animation with a non-empty entry here. Absent key (or an empty array)
   * for an animation with no destroy-mode target at all — the ordinary case, unchanged from before
   * this existed. Always an empty map from `buildScriptBindings`/`buildClassScriptBindings` below —
   * neither has the template/conditional-block analysis this needs; `compile.ts` computes the real
   * map (once the template has been analyzed) and overrides it via a plain object spread before
   * `emitBrs` ever sees it, the only field in this interface built outside this file.
   */
  readonly animationFieldRefreshByName: ReadonlyMap<string, readonly RefreshableInterpolatorRef[]>;
  /** Resolves a name against only the DSL tables above — no locals, no builtins. Null if `name` isn't any of them. */
  resolveDsl(name: string): ResolvedBinding | null;
}

export function buildScriptBindings(script: ThrScriptAst): ScriptBindings {
  const fieldNames = new Set(script.fields.map((f) => f.name));
  const derivedNames = new Set(script.derived.map((d) => d.name));
  const stateNames = new Set(script.state.map((s) => s.name));
  const readNames = new Set(script.reads.map((r) => r.name));
  const watchNames = new Set(script.watches.map((d) => d.name));
  const streamNames = new Set(script.streams.map((s) => s.name));
  const animationNames = new Set(script.animations.map((a) => a.name));
  const privateFunctionNames = new Set(script.functions.filter((f) => f.visibility === 'private').map((f) => f.name));
  const publicFunctionNames = new Set(script.functions.filter((f) => f.visibility === 'public').map((f) => f.name));
  const importedClassNames = new Set(script.imports.map((i) => i.className));
  const reactiveSourceNames = new Set([...fieldNames, ...stateNames]);

  function resolveDsl(name: string): ResolvedBinding | null {
    if (fieldNames.has(name)) return { kind: 'field', replacement: `m.top.${name}` };
    if (stateNames.has(name)) return { kind: 'state', replacement: `m.${name}` };
    if (derivedNames.has(name)) return { kind: 'derived', replacement: `m.${name}` };
    if (readNames.has(name)) return { kind: 'read', replacement: `m.${name}` };
    if (watchNames.has(name)) return { kind: 'watch', replacement: `m.${name}` };
    if (streamNames.has(name)) return { kind: 'stream', replacement: `m.${name}` };
    // A bare `bounce` (no trailing `.start()`/etc.) resolves to the raw generated Animation node —
    // an escape hatch for reading Roku's own AnimationBase fields directly (`bounce.state`, an
    // `ObserveField` on it, ...) beyond the five sugar methods `rewriteAnimationControlCalls`
    // handles. That rewrite runs BEFORE this generic scan and splices the whole `bounce.start()`
    // call away entirely, so this branch never actually fires for a real trigger-sugar call site —
    // only for a genuinely bare reference to the animation itself.
    if (animationNames.has(name)) return { kind: 'animation', replacement: mFieldAccess(animationNodeId(name)) };
    if (privateFunctionNames.has(name)) return { kind: 'private-function', replacement: privateFunctionName(name) };
    if (publicFunctionNames.has(name)) return { kind: 'public-function', replacement: name };
    if (importedClassNames.has(name)) return { kind: 'imported-class', replacement: null };
    // Recognizes an ALREADY-rewritten private-function name, left alone (replacement: null). Unlike
    // a field/derived/state (whose replacement is always `m.`-prefixed, so a re-scan only ever sees
    // the harmless top-level `m`/`special` — see resolveIdentifier's own doc comment), a private
    // function's replacement (`private_<name>`) is a bare top-level identifier — indistinguishable
    // from ordinary DSL source to a second identifier-rewrite pass. This matters whenever a
    // bare/called private-function reference sits inside an expression that itself gets rewritten
    // TWICE: once by a nested `rewriteExpression` call over just that argument's own span (e.g.
    // `identifier-rewrite.ts`'s `buildRouterActionReplacement`/`buildTaskManagerOnAlertChangedReplacement`,
    // both of which pre-rewrite each call argument before splicing it into their own composed
    // replacement text), and once again by the OUTER `applyIdentifierRewrite` pass over the final
    // assembled statement/expression text (which the pre-rewritten argument is now part of).
    // Confirmed as a real, reproducible bug before this fix (not hypothetical): a plain
    // `router.navigate(getPath())`, where `getPath` is a `private function`, threw
    // `expression/unresolved-identifier` on `private_getPath` — the SAME re-scan trap
    // `taskManager.onAlertChanged(<a private function used as a value>)` hits too. Checked strictly
    // AFTER the exact-name check above, so a component that happens to declare a private function
    // *literally* named `private_<x>` still resolves to its own real name first, never this
    // fallback — this branch only ever fires when `private_<x>` is NOT itself a declared name, which
    // is only possible as the resolved form of some other declared function `<x>`.
    if (name.startsWith('private_') && privateFunctionNames.has(name.slice('private_'.length))) {
      return { kind: 'private-function', replacement: null };
    }
    return null;
  }

  return {
    fieldNames,
    derivedNames,
    stateNames,
    readNames,
    watchNames,
    streamNames,
    animationNames,
    privateFunctionNames,
    publicFunctionNames,
    importedClassNames,
    reactiveSourceNames,
    animationFieldRefreshByName: new Map(),
    resolveDsl,
  };
}

/**
 * A `.flsh` class body's own binding table — much smaller than a `.thr`
 * component's `ScriptBindings`: a class has no field/derived/state/read/
 * watch, and its own fields/methods are never resolved from a *bare* name
 * (see `analysis/class-identifier-rewrite.ts` — that's always explicit
 * `m.<name>`, a completely separate mechanism). The only thing a bare
 * identifier inside a class method/constructor body can resolve to, beyond
 * a real local/param/builtin, is one of this class's own `import`ed class
 * names (e.g. instantiating another class: `x = Helper(1, 2)`).
 */
export function buildClassScriptBindings(classAst: ThrClassAst): ScriptBindings {
  const empty = new Set<string>();
  const importedClassNames = new Set(classAst.imports.map((i) => i.className));

  return {
    fieldNames: empty,
    derivedNames: empty,
    stateNames: empty,
    readNames: empty,
    watchNames: empty,
    streamNames: empty,
    animationNames: empty,
    privateFunctionNames: empty,
    publicFunctionNames: empty,
    importedClassNames,
    reactiveSourceNames: empty,
    animationFieldRefreshByName: new Map(),
    resolveDsl: (name) => (importedClassNames.has(name) ? { kind: 'imported-class', replacement: null } : null),
  };
}

/** A single expression's worth of scope — no BrightScript locals are possible (a `derived` RHS or a template `{expr}` is one expression, not a function body), so this is the only implementation needed for those contexts. */
export const NO_FUNCTION_SCOPE: FunctionScope = { hasLocal: () => false, isUnused: () => false };

/**
 * A `{#each items as item (key)}` block's own scope — `item` shadows any
 * same-named DSL binding, exactly like a real BrightScript local/parameter
 * already does via `resolveIdentifier`'s existing priority order (a
 * `FunctionScope` is checked first, before any DSL binding). `parent` lets
 * nested `{#each}` scopes compose: an inner block's scope is built with the
 * outer block's own `TemplateScope` (or `NO_FUNCTION_SCOPE` at the
 * outermost level) as `parent`, so `hasLocal` checks the innermost alias
 * first and delegates outward — an inner alias shadows a same-named outer
 * one, and a differently-named outer alias still resolves through. `item`
 * is never considered "unused" (no `_`-prefix pruning concept applies to a
 * loop item the way it does to a function parameter).
 */
export interface TemplateScope extends FunctionScope {
  readonly aliasName: string;
}

export function extendTemplateScope(aliasName: string, parent: FunctionScope = NO_FUNCTION_SCOPE): TemplateScope {
  return {
    aliasName,
    hasLocal: (name: string) => name === aliasName || parent.hasLocal(name),
    isUnused: () => false,
  };
}

export interface FunctionScope {
  /** True if `name` resolves to a real BrightScript local (parameter, plain assignment, `for`/`for each` variable, `catch` variable) within this function. Locals always shadow DSL bindings, matching ordinary lexical scoping. */
  hasLocal(name: string): boolean;
  /**
   * True if `name` is a declared parameter/local in this function with zero
   * non-write references anywhere in its scope subtree (case-insensitive,
   * matching BrightScript's own resolution) — used by
   * `codegen/brs-emitter.ts` to `_`-prefix an unused parameter and to elide
   * an unused local's assignment statement. A compound-assigned name
   * (`x += 1`) is never "unused": flash-parser's own brightscript-scope.ts's
   * `Reference.isWrite` is `false` for compound assignments since they also
   * read the current value. Recurses into child scopes (e.g. an inline
   * anonymous function's own body) rather than just this function's direct
   * `references` — a conservative choice so a name only read inside a
   * nested closure isn't wrongly flagged unused.
   */
  isUnused(name: string): boolean;
}

function countNonWriteReferences(scope: Scope, nameLower: string): number {
  let count = scope.references.filter((r) => r.nameLower === nameLower && !r.isWrite).length;
  for (const child of scope.children) count += countNonWriteReferences(child, nameLower);
  return count;
}

/**
 * The minimal shape `buildFunctionScope` actually needs — deliberately
 * narrower than `FunctionDecl` so a `ClassMethodDecl` (whose `visibility`
 * includes `protected`, which `FunctionDecl.visibility` doesn't) can reuse
 * this without a cast; `FunctionDecl` already structurally satisfies it.
 */
export interface ScopedFunctionLike {
  readonly name: string;
  readonly params: readonly { readonly name: string; readonly type: string }[];
  readonly block: Block;
}

/**
 * Builds a `FunctionScope` for one function by reconstructing a
 * BrightScript-*shaped* (not this DSL's JS-shaped) rendering of its body —
 * the same `if`/`else if`/`else` → `then`/`end if` flattening
 * `codegen/brs-emitter.ts` uses for real codegen, but with every identifier
 * left exactly as written (this reconstruction is for scope analysis only,
 * run *before* any rewriting, and is never emitted) — then running
 * flash-parser's own brightscript-scope.ts's `buildScopes`/`resolve` on it. Real
 * local variables are tracked by that existing scope analysis exactly as
 * BrightScript defines them (see its `scope.ts` docstring) — this repo
 * doesn't reimplement that tracking, matching the same "never reimplement
 * BrightScript" rule used everywhere else.
 *
 * Built once per function (in `emitFunction`) and reused for every
 * statement inside it, not rebuilt per identifier.
 */
export function buildFunctionScope(fn: ScopedFunctionLike): FunctionScope {
  const paramsText = fn.params.map((p) => `${p.name} as ${p.type}`).join(', ');
  const reconstructed = `function ${fn.name}(${paramsText})\n${reconstructBlockForScope(fn.block)}\nend function`;
  const parsed = parseBrightScript(reconstructed);
  const fileScope = buildScopes(parsed.root);
  const functionScope: Scope = fileScope.children[0] ?? fileScope;

  return {
    hasLocal: (name: string) => resolveBrightScriptName(name, functionScope) !== undefined,
    isUnused: (name: string) => {
      if (resolveBrightScriptName(name, functionScope) === undefined) return false;
      return countNonWriteReferences(functionScope, name.toLowerCase()) === 0;
    },
  };
}

/**
 * `buildFunctionScope`'s counterpart for an anonymous function expression —
 * built as a **fully independent** scope, never chained to the enclosing
 * function's own locals: a real BrightScript anonymous `function`/`sub`
 * literal does not close over its enclosing function's local variables (only
 * `m` is shared), so an unresolved name inside the anonymous body that
 * would've matched an outer *local* correctly resolves as `unresolved` here,
 * not silently treated as available. Reuses `buildFunctionScope` directly —
 * an `AnonymousFunctionExpression`'s `parameters`/`block` already structurally
 * satisfy `ScopedFunctionLike` once given a synthetic name (never emitted,
 * scope analysis only).
 */
export function buildAnonymousFunctionScope(fn: AnonymousFunctionExpression): FunctionScope {
  return buildFunctionScope({ name: 'ft_anon', params: fn.parameters, block: fn.block });
}

/**
 * `buildFunctionScope`'s counterpart for a class's constructor — a
 * constructor body isn't a plain `Block` (see flash-parser's
 * `SyntaxKind.ConstructorBody` doc comment for why), so it needs its own
 * small reconstruction rather than reusing `reconstructBlockForScope`
 * directly. Same technique otherwise: build a real BrightScript-shaped
 * rendering with every identifier left exactly as written, then run
 * flash-parser's own brightscript-scope.ts scope analysis on it — never emitted,
 * scope analysis only.
 */
export function buildConstructorScope(ctor: ConstructorDecl): FunctionScope {
  const paramsText = ctor.params.map((p) => `${p.name} as ${p.type}`).join(', ');
  const bodyText = ctor.body.statements.map((s) => reconstructConstructorStatementForScope(s)).join('\n');
  const reconstructed = `sub ft_constructor(${paramsText})\n${bodyText}\nend sub`;
  const parsed = parseBrightScript(reconstructed);
  const fileScope = buildScopes(parsed.root);
  const functionScope: Scope = fileScope.children[0] ?? fileScope;

  return {
    hasLocal: (name: string) => resolveBrightScriptName(name, functionScope) !== undefined,
    isUnused: (name: string) => {
      if (resolveBrightScriptName(name, functionScope) === undefined) return false;
      return countNonWriteReferences(functionScope, name.toLowerCase()) === 0;
    },
  };
}

/**
 * `_` is the established Roku/BrightScript convention for an intentionally
 * unused parameter (see GRAMMAR.md/findings/compiler-codegen-conventions.md) — a
 * parameter with zero non-write references anywhere in its owning
 * function/method/constructor's body gets it added automatically in the
 * generated signature only (DSL source is never touched). Already-prefixed
 * names are left alone (no double `__x`). Since an unused parameter by
 * definition has no references to rewrite elsewhere in the body, only the
 * signature's own name needs this. Shared by `codegen/brs-emitter.ts` (an
 * ordinary `.thr` function) and `codegen/class-emitter.ts` (a `.flsh`
 * constructor/method) — the `FunctionScope`s are built differently, but the
 * naming rule is identical either way. `ownerLabel` is the already-formatted
 * description used in the collision error (`function "foo"`, `constructor`,
 * `method "bar"`).
 */
export function emitParamName(paramName: string, functionScope: FunctionScope, ownerLabel: string): string {
  if (paramName.startsWith('_') || !functionScope.isUnused(paramName)) return paramName;
  const prefixed = `_${paramName}`;
  if (functionScope.hasLocal(prefixed)) {
    throw new CompileError({
      code: 'dsl/param-prefix-collision',
      message: `Cannot mark unused parameter "${paramName}" in ${ownerLabel} with a "_" prefix — "${prefixed}" is already a parameter/local in the same scope.`,
    });
  }
  return prefixed;
}

function reconstructConstructorStatementForScope(
  statement:
    | SuperCallStatement
    | ConstructorFieldInit
    | IfStatement
    | ForStatement
    | ForEachStatement
    | WhileStatement
    | TryStatement
    | RawBrightScriptStatement
    | StatementRegion,
): string {
  if (statement instanceof IfStatement) return reconstructIfForScope(statement);
  if (statement instanceof ForStatement) return reconstructForForScope(statement);
  if (statement instanceof ForEachStatement) return reconstructForEachForScope(statement);
  if (statement instanceof WhileStatement) return reconstructWhileForScope(statement);
  if (statement instanceof TryStatement) return reconstructTryForScope(statement);
  // Same reasoning as `StateAssignment`'s reconstruction below: the declared
  // field name is never itself a local, only the RHS expression might
  // reference real locals/params — discard the target, keep the expression.
  if (statement instanceof ConstructorFieldInit) return `ft_discard = ${statement.expression}`;
  // `super(...)`'s own callee is never a local either; keep its args live in
  // the reconstructed tree (as an array literal, so any number of args is
  // valid syntax) so any locals/params they reference are still resolvable.
  if (statement instanceof SuperCallStatement) return `ft_discard = [${statement.args.join(', ')}]`;
  // A raw block's own `.text` IS real, unrewritten BrightScript — falls through to the same `.text`
  // fallback as an ordinary StatementRegion (no dedicated branch needed), so a local it declares
  // (`result = ...`) is visible to buildScopes exactly like one declared in ordinary DSL code.
  return statement.text;
}

function reconstructBlockForScope(block: Block): string {
  return block.statements.map((s) => reconstructStatementForScope(s)).join('\n');
}

/**
 * `for`/`for each`/`while`/`try`-`catch` counterparts to `reconstructIfForScope`
 * — real, unrewritten BrightScript text (never emitted, scope analysis only)
 * so flash-parser's own `brightscript-scope.ts` declares the loop/catch
 * variable as a real local scoped to its own body, exactly the way it
 * already does for hand-written passthrough `for`/`for each`/`try`/`catch`
 * text (see `resolveIdentifier`'s doc comment — this groundwork already
 * existed before this DSL had bracketed sugar for these constructs).
 */
function reconstructForForScope(statement: ForStatement): string {
  const step = statement.stepExpr ? ` step ${statement.stepExpr.text}` : '';
  return `for ${statement.loopVariable} = ${statement.startExpr.text} to ${statement.endExpr.text}${step}\n${reconstructBlockForScope(statement.body)}\nend for`;
}

function reconstructForEachForScope(statement: ForEachStatement): string {
  return `for each ${statement.itemVariable} in ${statement.collectionExpr.text}\n${reconstructBlockForScope(statement.body)}\nend for`;
}

function reconstructWhileForScope(statement: WhileStatement): string {
  return `while ${statement.condition.text}\n${reconstructBlockForScope(statement.body)}\nend while`;
}

function reconstructTryForScope(statement: TryStatement): string {
  return `try\n${reconstructBlockForScope(statement.tryBlock)}\ncatch ${statement.catchClause.variableName}\n${reconstructBlockForScope(statement.catchClause.body)}\nend try`;
}

/**
 * Raw, unrewritten real-BrightScript-shaped reconstruction of an anonymous
 * function expression — never emitted, scope analysis only. Mirrors
 * `buildFunctionScope`'s own reconstruction shape so a real local/param
 * referenced inside the anonymous body (which `buildAnonymousFunctionScope`
 * resolves independently — see its own doc comment) is still visible to
 * whichever *outer* scope reconstruction is walking past this statement
 * (e.g. so the outer function doesn't wrongly treat the anonymous body's own
 * parameter as an outer unresolved reference).
 */
function reconstructAnonymousFunctionForScope(fn: AnonymousFunctionExpression): string {
  const paramsText = fn.parameters.map((p) => `${p.name} as ${p.type}`).join(', ');
  return `function(${paramsText})\n${reconstructBlockForScope(fn.block)}\nend function`;
}

function reconstructStatementForScope(
  statement:
    | IfStatement
    | ForStatement
    | ForEachStatement
    | WhileStatement
    | TryStatement
    | StateAssignment
    | StoreWriteStatement
    | FocusStatement
    | JumpFocusStatement
    | TernaryAssignmentStatement
    | AnonymousFunctionAssignmentStatement
    | ScaleLocalAssignmentStatement
    | ScaleStateAssignmentStatement
    | RawBrightScriptStatement
    | StatementRegion,
): string {
  if (statement instanceof IfStatement) return reconstructIfForScope(statement);
  if (statement instanceof ForStatement) return reconstructForForScope(statement);
  if (statement instanceof ForEachStatement) return reconstructForEachForScope(statement);
  if (statement instanceof WhileStatement) return reconstructWhileForScope(statement);
  if (statement instanceof TryStatement) return reconstructTryForScope(statement);
  // A `state` write's own target name is never a local — reconstructing it as
  // a real assignment (`name = expr`) would make the *state name itself*
  // look like a local declaration to buildScopes, which would then wrongly
  // shadow every later read of that same state name in this function.
  // Assigning the RHS to a throwaway name keeps its own identifiers (which
  // may reference real locals) in the reconstructed tree without declaring
  // the state name as one. `reconstructTernaryText` degrades to `.text`
  // unchanged for a ternary-free RHS, so this one call covers both shapes;
  // an anonymous-function RHS needs its own reconstruction instead (its DSL-
  // shaped `: Type`/`{ }` syntax isn't real BrightScript on its own).
  if (statement instanceof StateAssignment) {
    const rhs = statement.rhs;
    if (rhs instanceof AnonymousFunctionExpression) return `ft_discard = ${reconstructAnonymousFunctionForScope(rhs)}`;
    return `ft_discard = ${reconstructTernaryText(rhs)}`;
  }
  // Same reasoning as `StateAssignment` above: `store(<key>)`'s literal key
  // string is never a DSL binding or a local, only the RHS expression might
  // reference real locals — discard the target, keep the expression.
  if (statement instanceof StoreWriteStatement) return `ft_discard = ${statement.expression}`;
  // `focus(<expr>)` has no target at all, just a single argument expression — same discard-into-a-
  // throwaway-local trick, needed only because a bare expression isn't a valid standalone
  // BrightScript statement on its own (unlike a call statement).
  if (statement instanceof FocusStatement) return `ft_discard = ${statement.expression}`;
  // `jumpFocus(<direction>, <count>, <press>)` has three independent argument expressions and no
  // target either — same discard trick, three times over, since scope reconstruction only cares
  // about which real locals/identifiers each expression references, not that they came from one
  // DSL statement.
  if (statement instanceof JumpFocusStatement) {
    return [
      `ft_discard = ${statement.directionExpression}`,
      `ft_discard = ${statement.countExpression}`,
      `ft_discard = ${statement.pressExpression}`,
    ].join('\n');
  }
  // Unlike every case above, a `TernaryAssignmentStatement`'s target genuinely IS a real local
  // (the DSL's own bare-assignment shadowing rule — see the "assigning to a name that shadows a
  // field" finding in findings/reactivity-state.md) — so this reconstructs as a real
  // declaring assignment, not a discard, exactly mirroring how a plain `x = expr` StatementRegion
  // (the `.text` fallback below) already declares `x` as a local by virtue of being real
  // BrightScript-shaped text fed straight into `buildScopes`.
  if (statement instanceof TernaryAssignmentStatement) return `${statement.target} = ${reconstructTernaryText(statement.rhs)}`;
  // Same "bare assignment target is always a real local" reasoning as `TernaryAssignmentStatement`
  // above — the only difference is the RHS's own reconstruction (a real BrightScript function
  // literal, never text-identical to DSL source).
  if (statement instanceof AnonymousFunctionAssignmentStatement) return `${statement.target} = ${reconstructAnonymousFunctionForScope(statement.value)}`;
  // `scale <local> = <expr>` — a bare assignment target, exactly like `TernaryAssignmentStatement`
  // above: it genuinely IS a real local, so reconstruct as a real declaring assignment.
  if (statement instanceof ScaleLocalAssignmentStatement) {
    const rhs = statement.rhs;
    if (rhs instanceof AnonymousFunctionExpression) return `${statement.target} = ${reconstructAnonymousFunctionForScope(rhs)}`;
    return `${statement.target} = ${reconstructTernaryText(rhs)}`;
  }
  // `scale state <name> = <expr>` — same "state's own target name is never a local" reasoning as
  // `StateAssignment` above.
  if (statement instanceof ScaleStateAssignmentStatement) {
    const rhs = statement.rhs;
    if (rhs instanceof AnonymousFunctionExpression) return `ft_discard = ${reconstructAnonymousFunctionForScope(rhs)}`;
    return `ft_discard = ${reconstructTernaryText(rhs)}`;
  }
  // A raw block's own `.text` IS real, unrewritten BrightScript (same fallback a plain StatementRegion
  // already uses) — a local it declares stays visible to buildScopes for the rest of the function,
  // exactly like one declared in ordinary DSL code.
  return statement.text;
}

function reconstructIfForScope(first: IfStatement): string {
  const lines: string[] = [];
  let current: IfStatement | null = first;
  let keyword = 'if';

  while (current) {
    lines.push(`${keyword} (${current.condition.text}) then`);
    lines.push(current.thenBlock ? reconstructBlockForScope(current.thenBlock) : current.thenStatement!.text);

    const clause: ElseClause | null = current.elseClause;
    if (!clause) {
      current = null;
      break;
    }
    if (clause.elseIf) {
      current = clause.elseIf;
      keyword = 'else if';
      continue;
    }
    lines.push('else');
    lines.push(clause.block ? reconstructBlockForScope(clause.block) : clause.statement!.text);
    current = null;
  }

  lines.push('end if');
  return lines.join('\n');
}

/**
 * Resolves one identifier in context — the single decision point every
 * caller (rewriting, validation) uses. Priority order: a real local/param
 * always shadows a DSL binding (ordinary lexical scoping); then a DSL
 * binding; then the app-global `theme`/`router` singletons (so a
 * component's own field/derived/state/function literally named `theme`/
 * `router` still wins — no silent breaking change to any existing
 * component); then a builtin/`m`; anything left is `unresolved` (a hard
 * error at the call site — see `analysis/identifier-rewrite.ts`).
 *
 * `store` is a reserved keyword now (see GRAMMAR.md's "Global store"
 * section) — it has no meaning as a bare identifier at all, so there is no
 * `store` branch here; a bare `store` reference falls through to
 * `unresolved` like any other unrecognized name. This resolves only the
 * bare `theme`/`router` root token to `m.global.ft_theme`/`m.global.ft_router`
 * — it doesn't know or care whether a following `.member`/`(...)` chain is
 * valid. Path-shape validation is a separate, deeper concern handled by
 * `identifier-rewrite.ts`'s `validateAndRewriteGlobalPaths`, which runs
 * first; by the time this function ever sees `theme`/`router` as a
 * standalone top-level identifier, either there was no `.member` chain at
 * all (a bare reference, valid on its own — the whole global node), or the
 * chain was already validated and spliced away. Unlike `theme` (gated on
 * `globalBindings.theme` — a bare `theme` reference is only meaningful once
 * an app actually declares a `<theme-template>`), `router` has no such
 * precondition: there's no separate router *declaration* an app must author
 * first (see GRAMMAR.md's "Router" section) — using `router.*` anywhere is
 * itself the whole signal the compiler needs to wire the runtime singleton
 * in at all (`compile.ts`'s `usesRouter`), so the bare-reference branch
 * below is unconditional.
 */
export function resolveIdentifier(
  name: string,
  bindings: ScriptBindings,
  functionScope: FunctionScope,
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
): ResolvedBinding {
  // A compiler-synthesized temp name (e.g. `ft_ternary_1` — see `codegen/brs-emitter.ts`'s
  // `lowerTernaryRhs`) can never appear in the DSL source `buildFunctionScope`'s reconstruction is
  // built from, so `functionScope.hasLocal` below would never know about it — checked first so a
  // ternary's own hoisted temp var, spliced back into text that gets a second identifier-rewrite
  // pass (a `TernaryOperand`'s reassembled text), resolves as an already-valid local instead of a
  // false `unresolved` error. `isReservedIdentifier` can never match a real DSL-authored name
  // either way (`analysis/binding-collisions.ts`'s `dsl/reserved-identifier-prefix` check).
  if (isReservedIdentifier(name)) return { kind: 'local', replacement: null };

  if (functionScope.hasLocal(name)) return { kind: 'local', replacement: null };

  const dsl = bindings.resolveDsl(name);
  if (dsl) return dsl;

  const accessRoot = globalBindings.accessRoot ?? 'm.global';
  if (name === 'theme' && globalBindings.theme) return { kind: 'theme', replacement: globalFieldRef('theme', accessRoot) };
  if (name === 'router') return { kind: 'router', replacement: globalFieldRef('router', accessRoot) };
  if (name === 'taskManager') return { kind: 'taskManager', replacement: globalFieldRef('taskManager', accessRoot) };

  if (isSpecial(name)) return { kind: 'special', replacement: null };
  if (isBuiltin(name)) return { kind: 'builtin', replacement: null };

  return { kind: 'unresolved', replacement: null };
}
