import { findMemberAccesses, findComparisonExpressions, findSafeNotExpressions, findStreamSubscribeBoundReferences, findGlobalFunctionCalls, parseEmbeddedExpression, parseEmbeddedStatements } from 'flash-parser';
import { CompileError } from '../dsl-parser/dsl-ast.js';
import { privateFunctionName } from '../codegen/naming.js';
import { applyIdentifierRewrite, dropNestedComparisons, dropNestedSafeNots, validateAndRewriteGlobalPaths, rewriteOptionalChains, checkNoHandWrittenOptionalChaining } from './identifier-rewrite.js';
import { parseExpression, parseStatements } from './expression-region.js';
import { FunctionScope, NO_FUNCTION_SCOPE, ScriptBindings } from './scope-resolution.js';
import { GlobalBindingsContext, ThemeShape } from './global-bindings.js';
import { GlobalAccessRoot } from '../codegen/global-fields.js';
import { CLASS_GLOBAL_AA_LOCAL_NAME } from '../codegen/naming.js';
import { ClassShape } from './class-shape.js';

/**
 * The fixed access root every `.flsh` class body reaches a global singleton through — `m` inside a
 * class method is BrightScript-auto-bound to the class INSTANCE (its own plain associative array),
 * never any SceneGraph node, so `m.global` has no meaning there. `GetGlobalAA()` is confirmed live
 * (real device, both a `.thr` component and a `.flsh` class method — see
 * findings/class-pipeline-global-singleton-access.md) to return one `roAssociativeArray` shared app-wide that
 * SceneGraph automatically populates with a `"global"` key aliasing the exact same content node
 * `m.global` points at, with zero manual wiring — so `GetGlobalAA().global` reaches the same
 * `store`/`theme`/`router`/`taskManager` singletons a `.thr` component reaches via `m.global`.
 * Rooted at `ft_globalAA` (a hoisted local, see `codegen/naming.ts`'s `CLASS_GLOBAL_AA_LOCAL_NAME`),
 * never a literal inline `GetGlobalAA()` call — also confirmed live: a bare, return-discarding
 * statement chained directly off `GetGlobalAA()`'s own call result fails to compile on a real
 * device (`router.navigate(...)`/`router.back()` are ALWAYS emitted this way), while the identical
 * chain off a local variable holding that same result works. `codegen/class-emitter.ts`'s
 * `hoistGlobalAAIfNeeded` emits the actual `ft_globalAA = GetGlobalAA()` line this root assumes is
 * already in scope. Baked in here (never threaded as a parameter) so no class-pipeline call site
 * can accidentally pass the `.thr`-side `'m.global'` root — see `codegen/global-fields.ts`'s
 * `GlobalAccessRoot`.
 */
export const CLASS_GLOBAL_ACCESS_ROOT: GlobalAccessRoot = `${CLASS_GLOBAL_AA_LOCAL_NAME}.global`;

/**
 * `'m'` for an ordinary method body (BrightScript auto-binds `m` to the
 * instance when a function stored as an AA member is called via
 * `instance.method()` — `m.<name>` in DSL source maps directly). `'self'`
 * for the generated `private_constructor` helper: unlike an ordinary
 * method, it's invoked as a **plain function call**
 * (`private_constructor(prototype, a, b)`, never `prototype.private_constructor(...)`),
 * so BrightScript's automatic `m`-binding does NOT apply inside it — every
 * member reference there must go through its own explicit `self` parameter
 * instead. Getting this switch right is the single most important
 * correctness detail in the whole class feature: swapping it produces a
 * silent wrong-`m` runtime bug, not a compile error. See
 * `codegen/class-emitter.ts` and `findings/class-pipeline-global-singleton-access.md`.
 */
export type SelfExpr = 'm' | 'self';

/**
 * Rewrites every `m.<name>` member access in `text` to
 * `<selfExpr>.private_<name>` for a declared private field/method, or
 * `<selfExpr>.<name>` for public/protected (a no-op splice when
 * `selfExpr === 'm'`, since the text already reads `m.<name>`). Unlike
 * `.thr` field/derived/state, class-member access is always explicit in DSL
 * source (`m.<name>`, never a bare `<name>`) — so there is no bare-identifier
 * auto-rewrite step for class bodies at all; this is the whole story.
 * Unresolved names are a hard `CompileError`, matching this DSL's "no silent
 * pass-through" philosophy everywhere else (`identifier-rewrite.ts`).
 */
export function rewriteClassMemberAccesses(text: string, mode: 'expression' | 'statement', classShape: ClassShape, selfExpr: SelfExpr, contextLabel: string): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by the caller's own parse step right after this returns

  const accesses = findMemberAccesses(parsed, 'm', text);
  if (accesses.length === 0) return text;

  const replacements = accesses.flatMap((access) => {
    const member = classShape.allMembers.get(access.name);
    if (!member) {
      throw new CompileError({
        code: 'class/unresolved-member',
        message: `Unresolved member "m.${access.name}" in ${contextLabel} — not a declared field/method of class "${classShape.className}" (own or inherited).`,
      });
    }

    const memberName = member.visibility === 'private' ? privateFunctionName(access.name) : access.name;
    const nameReplacement = { start: access.nameStart, end: access.nameEnd, replacement: memberName };
    if (selfExpr === 'm') return [nameReplacement];
    return [nameReplacement, { start: access.rootStart, end: access.rootEnd, replacement: selfExpr }];
  });

  let result = text;
  for (const { start, end, replacement } of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

/**
 * Class-body counterpart to `identifier-rewrite.ts`'s `rewriteStreamSubscribeBoundReferences` —
 * same `{ target: <target>, action: "<name>" }` sugar for `<receiver>.subscribe(<target>.<name>)`,
 * where the sole argument is a bare (uncalled) method reference. See that function's own doc
 * comment, and GRAMMAR.md's "`stream`" section / `findings/streams.md`, for the full rationale.
 *
 * Unlike the `.thr`-side version, `<target>` needs NO further rewriting here — it's a pure
 * text-splice, run AFTER `rewriteClassMemberAccesses` in `rewriteClassExpression`/
 * `rewriteClassStatement`, so by the time this runs, a `m.<name>`-shaped target has ALREADY been
 * correctly rewritten to `m.private_<name>`/`self.private_<name>` (member-access rewriting only
 * ever touches the FIRST hop after a bare `m`, so `m.someHelper.methodName`'s `.methodName` second
 * hop is untouched either way — exactly what this function wants: `someHelper` resolved, `methodName`
 * left as the literal action string) — and anything that ISN'T a `m.<name>` chain (a local variable,
 * an imported class name) was never touched by any class-body rewriting pass in the first place and
 * needs none here either. Running this AFTER member-access rewriting, rather than recursing through
 * a reduced pipeline the way `rewriteClassComparisons` does, is deliberately simpler: there is no
 * idempotency hazard to dodge, since the target text is sliced from ALREADY-fully-rewritten text and
 * never re-scanned by `rewriteClassMemberAccesses` again.
 */
function rewriteClassStreamSubscribeBoundReferences(text: string, mode: 'expression' | 'statement'): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by the caller's own parse step right after this returns

  const matches = findStreamSubscribeBoundReferences(parsed, text);
  if (matches.length === 0) return text;

  const replacements = matches.map((match) => {
    const targetText = text.slice(match.targetStart, match.targetEnd);
    return { start: match.argStart, end: match.argEnd, replacement: `{ target: ${targetText}, action: "${match.action}" }` };
  });

  let result = text;
  for (const { start, end, replacement } of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

/**
 * Class-body counterpart to `identifier-rewrite.ts`'s `rewriteComparisons` —
 * same `ft_equals(<left>, <right>)`/`Not ft_equals(<left>, <right>)` splice
 * for every top-level `==`/`!=` `BsComparisonExpression`, now also branching
 * to `ft_relationalGuard(<left>, <right>, "<op>")` for `<`/`>`/`<=`/`>=`
 * (see that function's own doc comment for the full rationale — the same
 * `BsComparisonExpression` node now carries all six operators). Unlike the
 * `.thr` side, each operand is recursively put through THIS function only (not the
 * full `rewriteClassExpression` pipeline) — just far enough to lower any
 * comparison nested inside it (`(a == b) == c`). Member-access and
 * bare-identifier rewriting are deliberately left for the single outer pass
 * in `rewriteClassExpression`/`rewriteClassStatement` to handle, over the
 * whole assembled text, exactly once.
 *
 * That's a deliberate difference from `.thr`'s `rewriteComparisons`: there,
 * recursing through the FULL pipeline is safe because
 * `validateAndRewriteGlobalPaths`/`applyIdentifierRewrite` are idempotent on
 * already-rewritten text (a rewritten `theme.*`/field access is no longer
 * shaped like a bare identifier or global path, so a second pass is a
 * no-op). `rewriteClassMemberAccesses` has no such idempotency:
 * `findMemberAccesses(parsed, 'm', text)` matches ANY `m.<name>` dot-chain,
 * so re-running it on an already-rewritten `m.private_count` would look up
 * `"private_count"` in `classShape.allMembers` — which only knows the
 * source-level name `"count"` — and hard-fail with `class/unresolved-member`.
 * Recursing through this function alone sidesteps that: operand text stays
 * un-rewritten (still `m.count`, not `m.private_count`) until the single
 * outer `rewriteClassMemberAccesses` call sees it.
 */
const RELATIONAL_OPERATORS: ReadonlySet<string> = new Set(['<', '>', '<=', '>=']);

function rewriteClassComparisons(
  text: string,
  mode: 'expression' | 'statement',
  classShape: ClassShape,
  classBindings: ScriptBindings,
  selfExpr: SelfExpr,
  contextLabel: string,
  functionScope: FunctionScope,
): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by the caller's own parse step right after this returns

  const accesses = findComparisonExpressions(parsed, text);
  if (accesses.length === 0) return text;

  const topLevelAccesses = dropNestedComparisons(accesses);

  const replacements = topLevelAccesses.map((access) => {
    if (!access.leftSpan || !access.rightSpan) {
      throw new CompileError({
        code: 'expression/parse-error',
        message: `Malformed comparison in ${contextLabel} — "${access.operator || '==/!=/</>/<=/>='}" requires a left-hand and right-hand operand.`,
      });
    }
    const left = rewriteClassComparisons(text.slice(access.leftSpan.start, access.leftSpan.end), 'expression', classShape, classBindings, selfExpr, contextLabel, functionScope);
    const right = rewriteClassComparisons(text.slice(access.rightSpan.start, access.rightSpan.end), 'expression', classShape, classBindings, selfExpr, contextLabel, functionScope);
    const replacement = RELATIONAL_OPERATORS.has(access.operator)
      ? `ft_relationalGuard(${left}, ${right}, "${access.operator}")`
      : access.isNegated
        ? `Not ft_equals(${left}, ${right})`
        : `ft_equals(${left}, ${right})`;
    return { start: access.start, end: access.end, replacement };
  });

  let result = text;
  for (const { start, end, replacement } of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

/**
 * Class-body counterpart to `identifier-rewrite.ts`'s `rewriteSafeNots` —
 * same `ft_not(<operand>)` splice for every top-level `!` `BsSafeNotExpression`.
 * Recurses each operand through THIS function only, never the full
 * `rewriteClassExpression` pipeline — the exact same idempotency hazard
 * `rewriteClassComparisons`'s own doc comment documents for
 * `rewriteClassMemberAccesses` applies identically here, since both splice
 * ahead of it in the same pipeline.
 */
function rewriteClassSafeNots(
  text: string,
  mode: 'expression' | 'statement',
  classShape: ClassShape,
  classBindings: ScriptBindings,
  selfExpr: SelfExpr,
  contextLabel: string,
  functionScope: FunctionScope,
): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by the caller's own parse step right after this returns

  const accesses = findSafeNotExpressions(parsed, text);
  if (accesses.length === 0) return text;

  const topLevelAccesses = dropNestedSafeNots(accesses);

  const replacements = topLevelAccesses.map((access) => {
    if (!access.operandSpan) {
      throw new CompileError({
        code: 'expression/parse-error',
        message: `Malformed safe NOT in ${contextLabel} — "!" requires an operand.`,
      });
    }
    const operand = rewriteClassSafeNots(text.slice(access.operandSpan.start, access.operandSpan.end), 'expression', classShape, classBindings, selfExpr, contextLabel, functionScope);
    return { start: access.start, end: access.end, replacement: `ft_not(${operand})` };
  });

  let result = text;
  for (const { start, end, replacement } of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

const ALL_TIMER_FUNCTION_NAMES = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'];

/**
 * All four Timer functions are unsupported from a `.flsh` class body — for the same three reasons
 * `identifier-rewrite.ts`'s `checkTaskManagerOnAlertChangedSupported`/`checkTaskManagerOnResultSupported`
 * already document (an unverified `ObserveFieldScoped`-from-a-class-method scoping question; a fixed,
 * non-class-qualified trampoline sub name — `on_timerFire` — that would collide the moment a second
 * class needing it is imported into the same component; the registry needs a real component `m`,
 * which a class instance's own plain-AA `m` isn't). `setTimeout`/`setInterval` are ALSO caught
 * structurally, one layer down, via `codegen/statement-printer.ts`'s `SharedPrintContext.timerCounter`
 * being `null` on the class side (`codegen/class-emitter.ts`'s two `ClassPrintContext`-construction
 * sites) — but `clearTimeout`/`clearInterval` go through this file's own SEPARATE
 * `rewriteClassExpression`/`rewriteClassStatement` pipeline, never `lowerAnonymousFunctionsInText`,
 * so they need this explicit guard here or they'd otherwise fall through to a confusing generic
 * `class/unresolved-member`-shaped error instead of a clear one. Checked here, up front, for ALL FOUR
 * names (not just the two clearTimeout/clearInterval genuinely needs it for) so every Timer function
 * gets the identical, clear diagnostic from a class body, regardless of which of the two independent
 * mechanisms would otherwise have caught it.
 */
function checkNoTimerCallInClassBody(text: string, mode: 'expression' | 'statement', contextLabel: string): void {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return; // surfaced as expression/parse-error by the caller's own parse step right after this returns

  const matches = findGlobalFunctionCalls(parsed, ALL_TIMER_FUNCTION_NAMES, text);
  if (matches.length === 0) return;

  throw new CompileError({
    code: 'class/timer-not-supported',
    message: `${matches[0].name}(...) is not supported in ${contextLabel} — a .flsh class instance has no stable SceneGraph identity of its own to hang a Timer node's callback registry off of. Call ${matches[0].name}(...) from the owning .thr component instead.`,
  });
}

/**
 * Full rewrite pipeline for one piece of class-body expression text (a
 * constructor field-init's RHS, a `super(...)` argument, a method's `if`
 * condition, ...): `rewriteClassComparisons` (`==`/`!=` DSL sugar) then
 * `rewriteClassSafeNots` (`!` DSL sugar) FIRST, then `rewriteClassMemberAccesses`
 * (explicit `m.<name>`/`self.<name>` class-member access), then the ordinary bare-identifier rewrite
 * (locals/params/this class's own `import`ed class names — `classBindings`,
 * from `buildClassScriptBindings`) over the already-rewritten text. That
 * order matters for the same reason `rewriteExpression`'s own
 * comparisons-then-theme-then-bare-identifier ordering matters (see
 * identifier-rewrite.ts): running member-access rewriting AFTER the
 * bare-identifier pass could see text a *previous* replacement introduced
 * and misinterpret it.
 *
 * Runs `validateAndRewriteGlobalPaths` (theme/router/taskManager) right after member-access
 * rewriting — same comparisons → global-paths → bare-identifier ordering `.thr`'s own
 * `rewriteExpression`/`rewriteStatement` use, with member-access as the one class-only extra step
 * inserted before it (so a `m.<name>` reference is already resolved to `self.<name>`/
 * `m.private_<name>` by the time global-path scanning runs — the two never collide, since a global
 * singleton is always accessed root-first, `theme.x`/`router.navigate(...)`, never through `m`).
 * `globalBindings.accessRoot` is always `CLASS_GLOBAL_ACCESS_ROOT` here — `GetGlobalAA().global`,
 * never `m.global` — confirmed live to alias the exact same content node (see
 * findings/class-pipeline-global-singleton-access.md). `taskManager.onAlertChanged(...)` is the one action still
 * rejected from a class body — see `identifier-rewrite.ts`'s `checkTaskManagerOnAlertChangedSupported`
 * for why (an unverified `ObserveFieldScoped`-from-a-class-method scoping question, and no safe
 * per-instance storage key — a class instance has no destroy hook).
 *
 * The `rewriteArg` callback passed to `validateAndRewriteGlobalPaths` for a router/taskManager
 * action's own call arguments (`router.navigate(path, {from: m.someField})`) recurses into
 * `rewriteClassGlobalPathsAndIdentifiers` below — deliberately NOT back into this whole function
 * (comparisons + member-access + global-paths + identifiers). Reason, mirroring
 * `rewriteClassComparisons`'s own doc comment on the exact same hazard: `rewriteClassMemberAccesses`
 * has no idempotency — `m.someField` is already rewritten to `m.private_someField`/
 * `self.private_someField` by THIS call's own member-access pass (which runs over the whole text,
 * argument spans included, before global-path scanning even starts) — running it a SECOND time over
 * just the sliced argument text would look up `"private_someField"` in `classShape.allMembers`
 * (which only knows the source-level name `"someField"`) and hard-fail with
 * `class/unresolved-member`. Recursing through the reduced pipeline sidesteps that: an argument's
 * already-member-rewritten text only ever gets global-path + bare-identifier resolution, never a
 * second member-access pass.
 */
export function rewriteClassExpression(
  text: string,
  classShape: ClassShape,
  classBindings: ScriptBindings,
  selfExpr: SelfExpr,
  contextLabel: string,
  functionScope: FunctionScope = NO_FUNCTION_SCOPE,
  themeShape: ThemeShape | null = null,
): string {
  checkNoTimerCallInClassBody(text, 'expression', contextLabel);
  checkNoHandWrittenOptionalChaining(text, 'expression', contextLabel);
  const comparisonsRewritten = rewriteClassComparisons(text, 'expression', classShape, classBindings, selfExpr, contextLabel, functionScope);
  const safeNotsRewritten = rewriteClassSafeNots(comparisonsRewritten, 'expression', classShape, classBindings, selfExpr, contextLabel, functionScope);
  const memberRewritten = rewriteClassMemberAccesses(safeNotsRewritten, 'expression', classShape, selfExpr, contextLabel);
  const streamSubscribeRewritten = rewriteClassStreamSubscribeBoundReferences(memberRewritten, 'expression');
  return rewriteClassGlobalPathsAndIdentifiers(streamSubscribeRewritten, 'expression', classBindings, contextLabel, functionScope, themeShape);
}

/** Statement-text counterpart to `rewriteClassExpression`, for a class method/constructor body's `StatementRegion`. See that function's own doc comment for the full pipeline ordering and the `GetGlobalAA()`-based access root. */
export function rewriteClassStatement(
  text: string,
  classShape: ClassShape,
  classBindings: ScriptBindings,
  selfExpr: SelfExpr,
  contextLabel: string,
  functionScope: FunctionScope = NO_FUNCTION_SCOPE,
  themeShape: ThemeShape | null = null,
): string {
  checkNoTimerCallInClassBody(text, 'statement', contextLabel);
  checkNoHandWrittenOptionalChaining(text, 'statement', contextLabel);
  const comparisonsRewritten = rewriteClassComparisons(text, 'statement', classShape, classBindings, selfExpr, contextLabel, functionScope);
  const safeNotsRewritten = rewriteClassSafeNots(comparisonsRewritten, 'statement', classShape, classBindings, selfExpr, contextLabel, functionScope);
  const memberRewritten = rewriteClassMemberAccesses(safeNotsRewritten, 'statement', classShape, selfExpr, contextLabel);
  const streamSubscribeRewritten = rewriteClassStreamSubscribeBoundReferences(memberRewritten, 'statement');
  return rewriteClassGlobalPathsAndIdentifiers(streamSubscribeRewritten, 'statement', classBindings, contextLabel, functionScope, themeShape);
}

/**
 * The global-paths + bare-identifier tail end of `rewriteClassExpression`/`rewriteClassStatement`,
 * split out so a router/taskManager action's own call-argument text (already member-access-rewritten
 * by the OUTER call before this ever runs) can be recursively rewritten without re-running
 * `rewriteClassMemberAccesses` a second time — see `rewriteClassExpression`'s own doc comment for why
 * that would be wrong. Argument text is always treated as `'expression'` mode here, regardless of the
 * outer `mode`, matching `.thr`'s own `buildRouterActionReplacement`/`buildTaskManagerActionReplacement`
 * (an argument is always used in expression position, never itself "the whole statement").
 */
function rewriteClassGlobalPathsAndIdentifiers(
  memberRewrittenText: string,
  mode: 'expression' | 'statement',
  classBindings: ScriptBindings,
  contextLabel: string,
  functionScope: FunctionScope,
  themeShape: ThemeShape | null,
): string {
  const globalBindings: GlobalBindingsContext = { theme: themeShape, accessRoot: CLASS_GLOBAL_ACCESS_ROOT };
  const globalRewritten = validateAndRewriteGlobalPaths(memberRewrittenText, mode, classBindings, functionScope, globalBindings, contextLabel, (t) =>
    rewriteClassGlobalPathsAndIdentifiers(t, 'expression', classBindings, contextLabel, functionScope, themeShape),
  );
  const { identifiers } = mode === 'expression' ? parseExpression(globalRewritten, contextLabel) : parseStatements(globalRewritten, contextLabel);
  const identifiersRewritten = applyIdentifierRewrite(globalRewritten, identifiers, classBindings, functionScope, contextLabel, globalBindings);
  return rewriteOptionalChains(identifiersRewritten, mode);
}
