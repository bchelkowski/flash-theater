import {
  findGlobalPathAccesses,
  findComparisonExpressions,
  findSafeNotExpressions,
  findChainAccesses,
  findStreamSubscribeBoundReferences,
  findAnimationControlCalls,
  findAnimationOnFinishCalls,
  findGlobalFunctionCalls,
  findAll,
  SyntaxKind,
  parseEmbeddedExpression,
  parseEmbeddedStatements,
} from 'flash-parser';
import type { GlobalPathAccess, ComparisonAccess, SafeNotAccess, ChainAccess, AnimationControlCallMatch, AnimationOnFinishCallMatch, GlobalFunctionCallMatch } from 'flash-parser';
import { CompileError } from '../dsl-parser/dsl-ast.js';
import { ExpressionIdentifier, parseExpression, parseStatements } from './expression-region.js';
import { FunctionScope, NO_FUNCTION_SCOPE, ScriptBindings, resolveIdentifier } from './scope-resolution.js';
import { GlobalBindingsContext, RouterActionMethod, TaskManagerCallFuncMethod, TASK_MANAGER_RUNTIME_METHOD_NAMES, resolveGlobalPath } from './global-bindings.js';
import { GLOBAL_FIELD_NAMES, globalFieldRef, GlobalAccessRoot } from '../codegen/global-fields.js';
import {
  taskManagerAlertCallbacksFieldAccess,
  taskManagerResultCallbacksFieldAccess,
  taskManagerRequestSentCallbacksFieldAccess,
  taskManagerResponseReceivedCallbacksFieldAccess,
  TASK_MANAGER_RESULT_TRAMPOLINE_SUB_NAME,
  TASK_MANAGER_RESULT_ERROR_TRAMPOLINE_SUB_NAME,
  animationNodeId,
  animationFinishCallbackFieldAccess,
  mFieldAccess,
  timerCallbacksFieldAccess,
  ROUTE_READY_FIELD_NAME,
} from '../codegen/naming.js';

const NO_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };
const GLOBAL_ROOT_NAMES = ['theme', 'router', 'taskManager', 'env'] as const;

/**
 * Splices `replacements` into `text` from the end backward (descending
 * `start`) so earlier offsets stay valid after each replacement — shared by
 * `applyIdentifierRewrite` and `validateAndRewriteGlobalPaths`, the two
 * splice sites in this file, plus `codegen/brs-emitter.ts`'s Tier-2
 * anonymous-function hoisting (`lowerAnonymousFunctionsInText`), which needs
 * the exact same "splice a temp-var name back into arbitrary text" shape.
 * Exported for that reuse rather than duplicated. Sorts its own input, so
 * callers don't need to.
 */
export function applySplices(text: string, replacements: readonly { start: number; end: number; replacement: string }[]): string {
  let result = text;
  for (const { start, end, replacement } of [...replacements].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

/**
 * Text-splice rewriting from end to start, so earlier offsets stay valid.
 * Every identifier is resolved via `resolveIdentifier` (see
 * scope-resolution.ts): a real local/parameter or a DSL binding is either
 * left alone or replaced per its resolution; anything genuinely unresolved
 * (not a declared field/derived/state/function, not a local, not a
 * builtin/`m`) is a hard `CompileError` — there's no such thing as a silent
 * pass-through name in this DSL.
 */
export function applyIdentifierRewrite(
  text: string,
  identifiers: ExpressionIdentifier[],
  bindings: ScriptBindings,
  functionScope: FunctionScope,
  contextLabel: string,
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
): string {
  const replacements = identifiers
    .map((id) => {
      const resolved = resolveIdentifier(id.name, bindings, functionScope, globalBindings);
      if (resolved.kind === 'unresolved') {
        throw new CompileError({
          code: 'expression/unresolved-identifier',
          message: `Unresolved identifier "${id.name}" in ${contextLabel} — not a declared field/derived/state/function, a local variable, or a BrightScript builtin.`,
        });
      }
      return { ...id, replacement: resolved.replacement };
    })
    .filter((id): id is ExpressionIdentifier & { replacement: string } => id.replacement !== null);

  return applySplices(text, replacements);
}

/**
 * Validates and rewrites every `theme.`/`router.`/`taskManager.`/`env.`-rooted dot-chain in `text`
 * (found via flash-parser's `findGlobalPathAccesses`, which sees the real
 * `DotExpression`/`CallExpression` shape — unlike `findTopLevelIdentifiers`,
 * which deliberately skips `.member`) — runs *before* the normal
 * `applyIdentifierRewrite` splice, since it needs the chain's shape, not
 * just each identifier's name. A `theme.a.b` read splices only the root
 * token (`theme.colors.primary` → `m.global.ft_theme.colors.primary`,
 * leaving the validated member chain untouched); a `router.a.b` read does
 * the same but against `m.global.ft_router.activatedRoute` (see
 * `resolveGlobalPath`'s `router-data` case); a `router.<action>(...)` call
 * (`router-action`) replaces the WHOLE access span, `(...)` included, with a
 * composed `m.global.ft_router.callFunc(...)` — see
 * `buildRouterActionReplacement`. Once spliced, the root name no longer
 * appears as a top-level identifier for that occurrence (it's now a
 * `.member`/argument of `m.global`), so `applyIdentifierRewrite`'s later
 * pass over the same (already-rewritten) text never re-processes it — no
 * double handling. A *bare* `theme`/`router` reference (no `.member`/`(...)`
 * at all) never reaches this function at all (`findGlobalPathAccesses` only
 * fires on dot-chains/calls) and is instead resolved by `resolveIdentifier`'s
 * own `globalBindings` check.
 *
 * `store` is deliberately NOT in `GLOBAL_ROOT_NAMES` — it's no longer a
 * generic dot-chain scanned out of arbitrary expression text at all.
 * `store(<path>)` is a fixed, three-production grammar form (`read`/
 * `watch`'s RHS, or a write statement's target), parsed structurally by
 * flash-parser and handled directly by `rewriteStorePathRead` below (a
 * write statement's own target is handled by `codegen/brs-emitter.ts`'s
 * `printStoreWriteStatement` instead — that one needs `depth`/hoisting for a
 * Tier-2 anonymous function nested in its RHS, a printing concern this
 * analysis-layer file doesn't otherwise have) — never by this generic
 * scanner.
 *
 * A `router.<action>(...)` call's own arguments can themselves contain
 * *another* global-path access (`router.navigate(x, {from: router.path})`)
 * — `findGlobalPathAccesses`'s own generic walk finds that nested access
 * independently too (it always continues into a matched call's arguments;
 * see that function's own doc comment), which would otherwise produce two
 * overlapping `{start, end}` replacement spans for the same stretch of text
 * (the nested one strictly inside the outer call's `[rootStart, chainEnd)`)
 * — `applySplices`'s end-to-start ordering has no well-defined result for
 * that. `buildRouterActionReplacement` below already recursively re-runs the
 * FULL rewrite pipeline (this function included) over each of its own
 * argument spans, so it fully handles any access nested inside it on its
 * own — `dropNestedAccesses` filters those out of the top-level list before
 * replacements are built, so each stretch of text is only ever rewritten
 * once. `theme` never had this concern (a theme access is never a call
 * target, so two theme accesses can never overlap) — this filter is a no-op
 * whenever no `router-action` access is present.
 *
 * `router.<action>(...)`'s use as a plain expression (inside a `derived` RHS
 * or a template `{expr}` binding, both of which recompute reactively, as a
 * side effect of some unrelated change) is NOT rejected here — this DSL
 * doesn't police `derived`/template purity in general (nothing stops an
 * ordinary side-effecting BrightScript call there either), so a router
 * action landing in one of those spots is the author's own responsibility,
 * not a compiler-enforced restriction.
 */
export function validateAndRewriteGlobalPaths(
  text: string,
  mode: 'expression' | 'statement',
  bindings: ScriptBindings,
  functionScope: FunctionScope,
  globalBindings: GlobalBindingsContext,
  contextLabel: string,
  rewriteArg: (argText: string) => string = (t) => rewriteExpressionWithoutChainOptionalization(t, bindings, contextLabel, functionScope, globalBindings),
): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by parseExpression/parseStatements right after this returns

  const accesses = findGlobalPathAccesses(parsed, GLOBAL_ROOT_NAMES, text);
  if (accesses.length === 0) return text;

  const topLevelAccesses = dropNestedAccesses(accesses);
  const accessRoot = globalBindings.accessRoot ?? 'm.global';

  const replacements = topLevelAccesses.map((access) => {
    const resolution = resolveGlobalPath(access.root, access.segments, access.isCallTarget, globalBindings);

    if (resolution.kind === 'invalid') {
      throw new CompileError({ code: resolution.code, message: `Invalid ${access.root} reference in ${contextLabel}: ${resolution.reason}` });
    }

    if (resolution.kind === 'theme-leaf' || resolution.kind === 'theme-group') {
      if (access.isCallTarget) {
        throw new CompileError({
          code: 'expression/unknown-theme-member',
          message: `Invalid theme reference in ${contextLabel}: "theme.${access.segments.join('.')}(...)" is not callable — theme has no functions.`,
        });
      }
      return { start: access.rootStart, end: access.rootEnd, replacement: globalFieldRef('theme', accessRoot) };
    }

    if (resolution.kind === 'env-data') {
      if (access.isCallTarget) {
        throw new CompileError({
          code: 'expression/env-not-callable',
          message: `Invalid env reference in ${contextLabel}: "env.${access.segments.join('.')}(...)" is not callable — env variables are plain strings.`,
        });
      }
      // Splices only the root token, same as a theme-leaf read — the original ".apiBaseUrl" member
      // text that follows "env" in the source is left untouched, so it doesn't need to be repeated
      // in `replacement` (resolution.name === access.segments[0] === that same trailing text).
      return { start: access.rootStart, end: access.rootEnd, replacement: globalFieldRef('env', accessRoot) };
    }

    if (resolution.kind === 'router-data') {
      return { start: access.rootStart, end: access.rootEnd, replacement: `${globalFieldRef('router', accessRoot)}.activatedRoute` };
    }

    if (resolution.kind === 'task-manager-data') {
      // Splices only the root token — `taskManager.runningCount` → `m.global.ft_taskManager.runningCount`.
      // Unlike router-data (nested under `.activatedRoute`), the two counters are plain top-level
      // fields on the singleton itself, so no suffix is added.
      return { start: access.rootStart, end: access.rootEnd, replacement: globalFieldRef('taskManager', accessRoot) };
    }

    if (resolution.kind === 'task-manager-action') {
      if (resolution.method === 'onAlertChanged') {
        checkTaskManagerOnAlertChangedSupported(accessRoot, contextLabel);
        checkTaskManagerOnAlertChangedNotInReactiveExpression(mode, contextLabel);
        const replacement = buildTaskManagerOnAlertChangedReplacement(access, text, contextLabel, rewriteArg);
        return { start: access.rootStart, end: access.chainEnd, replacement };
      }
      if (resolution.method === 'onResult') {
        checkTaskManagerOnResultSupported(accessRoot, contextLabel);
        checkTaskManagerOnResultNotInReactiveExpression(mode, contextLabel);
        const replacement = buildTaskManagerOnResultReplacement(access, text, contextLabel, rewriteArg);
        return { start: access.rootStart, end: access.chainEnd, replacement };
      }
      if (resolution.method === 'onRequestSent') {
        checkTaskManagerOnRequestSentSupported(accessRoot, contextLabel);
        checkTaskManagerOnRequestSentNotInReactiveExpression(mode, contextLabel);
        const replacement = buildTaskManagerOnRequestSentReplacement(access, text, contextLabel, rewriteArg);
        return { start: access.rootStart, end: access.chainEnd, replacement };
      }
      if (resolution.method === 'onResponseReceived') {
        checkTaskManagerOnResponseReceivedSupported(accessRoot, contextLabel);
        checkTaskManagerOnResponseReceivedNotInReactiveExpression(mode, contextLabel);
        const replacement = buildTaskManagerOnResponseReceivedReplacement(access, text, contextLabel, rewriteArg);
        return { start: access.rootStart, end: access.chainEnd, replacement };
      }
      const replacement = buildTaskManagerActionReplacement(resolution.method, access, text, contextLabel, accessRoot, rewriteArg);
      return { start: access.rootStart, end: access.chainEnd, replacement };
    }

    // resolution.kind === 'router-action'
    if (resolution.method === 'markReady') {
      checkRouterMarkReadySupported(accessRoot, contextLabel);
    }
    checkRouterActionIsStandaloneStatement(resolution.method, access, text, mode, contextLabel);
    const replacement = buildRouterActionReplacement(resolution.method, access, text, contextLabel, accessRoot, rewriteArg);
    return { start: access.rootStart, end: access.chainEnd, replacement };
  });

  return applySplices(text, replacements);
}

/**
 * The router actions that actually change the active route, and therefore
 * mount new components — the only ones needing the compiler's shallow
 * `applyPendingFocus()` follow-up (see `routerNavigationFollowUpCall` and
 * `runtime-assets/FocusManager`'s "Deferred focus application" section).
 * `setRouting`/`appendBackJourneyData`/`updateBackJourneyData` mount nothing
 * and need no follow-up.
 */
const ROUTER_NAVIGATION_METHODS: ReadonlySet<string> = new Set(['navigate', 'back']);

/**
 * A `router.<action>(...)` call must be a statement of its own — never
 * nested inside a larger expression (`if (router.back())`, `x =
 * router.navigate(...)`), and never inside a `derived` RHS or a template
 * `{expr}` binding (`mode === 'expression'`).
 *
 * This is a deliberate, narrow restriction rather than a silent gap. A
 * route change has to be followed by a shallow `applyPendingFocus()` call
 * emitted as a *sibling statement* — Roku will not establish real key-event
 * routing for a `SetFocus()` reached via 2+ nested `callFunc` hops
 * (confirmed live; see `findings/focus-system.md`), so the follow-up cannot
 * live inside the router runtime and there is nowhere to put it when the
 * call is buried in an expression. Allowing those forms would compile
 * cleanly and mount the route, but leave focus unable to receive real key
 * presses — exactly the class of bug this restriction exists to make
 * impossible. `router.path`/`router.params.x` *reads* are unaffected and
 * stay legal anywhere, including `derived`/template bindings.
 */
/**
 * `router.markReady()` needs this exact same "standalone statement" restriction as `navigate`/`back`
 * above, but for an unrelated reason: `buildRouterActionReplacement` compiles it to a plain
 * assignment (`m.top.ft_routeReady = true`), not a `callFunc(...)` expression — an assignment is not
 * a valid BrightScript expression TERM, so splicing it anywhere but a statement's own line would
 * produce invalid generated code, not just lose a follow-up call the way navigate/back would.
 * Deliberately kept as its own boolean check rather than folded into `ROUTER_NAVIGATION_METHODS`
 * itself — that set is also used elsewhere (`emittedRouterNavigationMatcher`/`withRouterFocusHandoff`)
 * to find already-emitted route-change calls needing a focus-handoff follow-up line, which
 * `markReady()` must never get.
 */
function checkRouterActionIsStandaloneStatement(
  method: RouterActionMethod,
  access: GlobalPathAccess,
  text: string,
  mode: 'expression' | 'statement',
  contextLabel: string,
): void {
  const isMarkReady = method === 'markReady';
  if (!ROUTER_NAVIGATION_METHODS.has(method) && !isMarkReady) return;
  if (mode === 'statement' && spansItsOwnLine(text, access)) return;

  if (isMarkReady) {
    throw new CompileError({
      code: 'expression/router-mark-ready-must-be-statement',
      message:
        `router.markReady() in ${contextLabel} must be a statement of its own — it cannot be nested inside a larger expression, ` +
        `a derived, or a template binding. It compiles to a plain field assignment, which is not a valid expression term.`,
    });
  }

  throw new CompileError({
    code: 'expression/router-action-must-be-statement',
    message:
      `router.${method}(...) in ${contextLabel} must be a statement of its own — it cannot be nested inside a larger expression, ` +
      `a derived, or a template binding. A route change is always followed by a generated focus hand-off that has to sit next to the call itself.`,
  });
}

/**
 * Whether `access` occupies its own line within `text` — nothing but
 * whitespace before it on that line, nothing but whitespace or a trailing
 * `'` comment after it. A `StatementRegion`'s text is NOT always a single
 * statement (two consecutive calls in one `.thr` function body arrive as one
 * multi-line region), so "is this a statement of its own" has to be answered
 * per line rather than against the whole region.
 */
function spansItsOwnLine(text: string, access: GlobalPathAccess): boolean {
  const lineStart = text.lastIndexOf('\n', access.rootStart - 1) + 1;
  const newlineAfter = text.indexOf('\n', access.chainEnd);
  const lineEnd = newlineAfter === -1 ? text.length : newlineAfter;

  if (text.slice(lineStart, access.rootStart).trim() !== '') return false;

  const trailing = text.slice(access.chainEnd, lineEnd).trim();
  return trailing === '' || trailing.startsWith("'");
}

/**
 * `taskManager.onAlertChanged(...)` is not supported from a `.flsh` class body — deliberately, not
 * a gap left to fill in later. Three open problems, none safe to resolve by guessing:
 *
 * 1. `ObserveFieldScoped`'s callback-scoping semantics when the *call site* is a class method (a
 *    plain closure with no SceneGraph node of its own) are unverified on a real device — exactly
 *    the kind of platform claim this codebase requires live confirmation for, not intuition (see
 *    findings/class-pipeline-global-singleton-access.md's own `GetGlobalAA()` history).
 * 2. `ObserveFieldScoped`'s second argument is a STRING naming a real, *top-level* `sub`/`function`
 *    — never an AA-member method — so a class-side trampoline could not be `prototype.<name>` the
 *    way every other method is. It would have to be a genuine top-level declaration in the class's
 *    own `.brs` file, and — unlike the class's own `function ClassName(...)` factory (already
 *    unique per file since a `.flsh` file's base name must match its class name) — a *fixed* generic
 *    trampoline name (mirroring `.thr`'s own `on_taskManagerAlertChange`) would collide the moment a
 *    SECOND class needing the same trampoline is imported into the same component, since multiple
 *    `.brs` files loaded via separate `<script>` tags onto one component still share ONE combined
 *    top-level BrightScript scope (confirmed via a real multi-class-import fixture — see
 *    `apps/sample-app/src/components/FavoriteCounter`). This is exactly the scenario the "no collision
 *    risk today" audit above does not cover: it holds only because no class currently emits a
 *    top-level function at all (methods are AA members, `private_constructor` is a local var) — an
 *    `onAlertChanged`-style trampoline would be the first thing to break that property, and would
 *    need a class-name-qualified name (`<ClassName>_on_taskManagerAlertChange` or similar) to stay
 *    safe.
 * 3. Even with (1) and (2) solved, `GetGlobalAA()` is one table shared by the *whole app* — storing
 *    a callbacks array there needs a genuinely unique key per subscribing instance, and a class
 *    instance has no stable identity and no destroy hook (unlike a `.thr` component instance, whose
 *    own `m` scope is already correctly per-instance — see `taskManagerAlertCallbacksFieldAccess`'s
 *    own doc comment in `codegen/naming.ts`).
 *
 * Every other `theme`/`router`/`taskManager` action/read IS supported from a class body via
 * `GetGlobalAA().global` — see `accessRoot` threading throughout this file. Detected here (rather
 * than a blanket class/global-singleton rejection) so the other actions aren't caught by mistake.
 */
/**
 * `router.markReady()` is not supported from a `.flsh` class body. Unlike every other `router.*`
 * action (which all reach the router SINGLETON — reachable from a class body via
 * `GetGlobalAA().global`, same as `theme`/`taskManager`), `markReady()` compiles to a field
 * assignment on the CALLING component's own top node (`m.top.ft_routeReady = true` — see
 * `buildRouterActionReplacement`), not a call into any singleton. A `.flsh` class instance is a
 * plain BrightScript object with no SceneGraph node of its own — there is no "its own top" for a
 * class method to mean, structurally, not just an unimplemented convenience. Call
 * `router.markReady()` from the owning `.thr` component instead (e.g. from inside a callback the
 * class instance invokes back into the component).
 */
function checkRouterMarkReadySupported(accessRoot: GlobalAccessRoot, contextLabel: string): void {
  if (accessRoot === 'm.global') return;

  throw new CompileError({
    code: 'class/router-mark-ready-not-supported',
    message: `router.markReady() is not supported in ${contextLabel} — a .flsh class instance has no SceneGraph node of its own for "its own top" to mean. Call router.markReady() from the owning .thr component instead.`,
  });
}

function checkTaskManagerOnAlertChangedSupported(accessRoot: GlobalAccessRoot, contextLabel: string): void {
  if (accessRoot === 'm.global') return;

  throw new CompileError({
    code: 'class/task-manager-on-alert-changed-not-supported',
    message:
      `taskManager.onAlertChanged(...) is not supported in ${contextLabel} — a .flsh class instance has no stable identity and no ` +
      `destroy hook to safely back a callback subscription. Call taskManager.onAlertChanged(...) from the owning .thr component instead, ` +
      `and pass the class instance a plain method it can call back into.`,
  });
}

/**
 * `taskManager.onAlertChanged(<callback>)` may only be called from a function body — never from a
 * `derived` expression or a template `{expr}` binding (both `mode === 'expression'`). This is no
 * longer a codegen necessity (the call now expands to a single, self-contained
 * `<callbacks>.Push(<callback>)` line — see `buildTaskManagerOnAlertChangedReplacement` — so it
 * would technically fit anywhere an expression can), but it's still a real semantic guard: a
 * `derived`/binding recomputes every time one of its own dependencies changes, so calling
 * `onAlertChanged(...)` from one would re-subscribe (and grow the callbacks array) on every single
 * recompute — an unbounded leak, and eventually every stored callback firing many times over for
 * one real alert change. A function body only ever runs `onAlertChanged(...)` as many times as the
 * author's own code actually calls it (typically once, from `setup()`).
 */
function checkTaskManagerOnAlertChangedNotInReactiveExpression(mode: 'expression' | 'statement', contextLabel: string): void {
  if (mode === 'statement') return;

  throw new CompileError({
    code: 'expression/task-manager-on-alert-changed-in-reactive-expression',
    message:
      `taskManager.onAlertChanged(...) in ${contextLabel} cannot be used inside a derived expression or a template binding — both recompute ` +
      `repeatedly, which would re-subscribe the same callback over and over. Call it once from a function body instead (typically setup()).`,
  });
}

/**
 * `taskManager.onResult(<task>, ...)` is excluded from `.flsh` class bodies too, for the SAME
 * underlying reason as `onAlertChanged` (a genuinely unverified `ObserveFieldScoped`-from-a-
 * class-method scoping question, plus a class-name-collision risk for the two fixed trampoline sub
 * names — see `checkTaskManagerOnAlertChangedSupported`'s own doc comment) — this one does NOT
 * additionally need a `GetGlobalAA()`-unique-storage-key argument the way `onAlertChanged` does
 * (its own callback storage is per-task-id, already unique, not per-subscribing-instance), but the
 * other two blockers are identical and equally unverified, so it stays excluded until they are.
 */
function checkTaskManagerOnResultSupported(accessRoot: GlobalAccessRoot, contextLabel: string): void {
  if (accessRoot === 'm.global') return;

  throw new CompileError({
    code: 'class/task-manager-on-result-not-supported',
    message:
      `taskManager.onResult(...) is not supported in ${contextLabel} — whether ObserveFieldScoped's callback-scoping semantics even work when ` +
      `the call site is a class method is unverified, and this feature's two fixed trampoline sub names would collide the moment a second ` +
      `class needing them is imported into the same component. Call taskManager.onResult(...) from the owning .thr component instead.`,
  });
}

/**
 * `taskManager.onResult(<task>, ...)` may only be called from a function body — never from a
 * `derived` expression or a template `{expr}` binding. Unlike `onAlertChanged`, a repeat call for
 * the SAME task is actually self-healing here (a single overwritable `m` slot per task id, not an
 * accumulating array — see `taskManagerResultCallbacksFieldAccess`'s own doc comment), but calling
 * it from a reactive expression is still nonsensical: `<task>` would have to be freshly created
 * (and re-`run()`) on every recompute for a fresh registration to mean anything, which is not a
 * realistic reactive-expression shape at all. Kept as a hard restriction rather than "technically
 * allowed but pointless," matching `onAlertChanged`'s own stance.
 */
function checkTaskManagerOnResultNotInReactiveExpression(mode: 'expression' | 'statement', contextLabel: string): void {
  if (mode === 'statement') return;

  throw new CompileError({
    code: 'expression/task-manager-on-result-in-reactive-expression',
    message:
      `taskManager.onResult(...) in ${contextLabel} cannot be used inside a derived expression or a template binding — both recompute ` +
      `repeatedly. Call it once from a function body instead, immediately after taskManager.run(...).`,
  });
}

/**
 * `taskManager.onRequestSent(...)`/`taskManager.onResponseReceived(...)` (the global HTTP
 * request/response interceptor hooks — see GRAMMAR.md's "Task manager" section) are excluded from
 * `.flsh` class bodies for the SAME underlying reason as `onAlertChanged`
 * (`checkTaskManagerOnAlertChangedSupported`'s own doc comment) — genuinely closer in shape to
 * `onAlertChanged` than to `onResult`: both are global, register-once subscriptions with no
 * per-task identity (every subscriber gets every event, backed by an accumulating `m`-scoped
 * array), not a per-task callback pairing. The same three unresolved platform questions apply
 * unchanged: unverified `ObserveFieldScoped`-from-a-class-method scoping, the fixed-trampoline-
 * name collision risk once a second class needing one is imported into the same component, and
 * `GetGlobalAA()` being one table shared by the whole app with no stable per-instance key a class
 * instance could safely provide.
 */
function checkTaskManagerOnRequestSentSupported(accessRoot: GlobalAccessRoot, contextLabel: string): void {
  if (accessRoot === 'm.global') return;

  throw new CompileError({
    code: 'class/task-manager-on-request-sent-not-supported',
    message:
      `taskManager.onRequestSent(...) is not supported in ${contextLabel} — a .flsh class instance has no stable identity and no ` +
      `destroy hook to safely back a callback subscription. Call taskManager.onRequestSent(...) from the owning .thr component instead.`,
  });
}

/** See `checkTaskManagerOnRequestSentSupported`'s own doc comment — identical rationale, the response-side hook. */
function checkTaskManagerOnResponseReceivedSupported(accessRoot: GlobalAccessRoot, contextLabel: string): void {
  if (accessRoot === 'm.global') return;

  throw new CompileError({
    code: 'class/task-manager-on-response-received-not-supported',
    message:
      `taskManager.onResponseReceived(...) is not supported in ${contextLabel} — a .flsh class instance has no stable identity and no ` +
      `destroy hook to safely back a callback subscription. Call taskManager.onResponseReceived(...) from the owning .thr component instead.`,
  });
}

/**
 * `taskManager.onRequestSent(<callback>)`/`taskManager.onResponseReceived(<callback>)` may only be
 * called from a function body — never from a `derived` expression or a template `{expr}` binding —
 * same rationale as `checkTaskManagerOnAlertChangedNotInReactiveExpression`: both hooks accumulate
 * into an array, so calling from a reactive expression would re-subscribe (and grow the array) on
 * every recompute.
 */
function checkTaskManagerOnRequestSentNotInReactiveExpression(mode: 'expression' | 'statement', contextLabel: string): void {
  if (mode === 'statement') return;

  throw new CompileError({
    code: 'expression/task-manager-on-request-sent-in-reactive-expression',
    message:
      `taskManager.onRequestSent(...) in ${contextLabel} cannot be used inside a derived expression or a template binding — both recompute ` +
      `repeatedly, which would re-subscribe the same callback over and over. Call it once from a function body instead (typically setup()).`,
  });
}

/** See `checkTaskManagerOnRequestSentNotInReactiveExpression`'s own doc comment — identical rationale, the response-side hook. */
function checkTaskManagerOnResponseReceivedNotInReactiveExpression(mode: 'expression' | 'statement', contextLabel: string): void {
  if (mode === 'statement') return;

  throw new CompileError({
    code: 'expression/task-manager-on-response-received-in-reactive-expression',
    message:
      `taskManager.onResponseReceived(...) in ${contextLabel} cannot be used inside a derived expression or a template binding — both ` +
      `recompute repeatedly, which would re-subscribe the same callback over and over. Call it once from a function body instead (typically setup()).`,
  });
}

/**
 * The shallow, sibling-statement focus hand-off the compiler emits directly
 * after every `router.navigate(...)`/`router.back()` statement. It must be
 * emitted at the *call site*, not inside the router/outlet runtime: Roku
 * will not establish real key-event routing for a `SetFocus()` reached via
 * 2+ nested `callFunc` hops, and the whole mount cascade sits well past
 * that limit — so the cascade only *records* where focus should go, and
 * this call, one hop from whatever handler is actually executing, applies
 * it. See `runtime-assets/FocusManager`'s "Deferred focus application"
 * section and `findings/focus-system.md`.
 *
 * Runtime-guarded on `ft_focus`, since a router-using app doesn't
 * necessarily use the focus system at all (independently gated features —
 * see `compile.ts`).
 */
export function routerNavigationFollowUpCall(accessRoot: GlobalAccessRoot = 'm.global'): string {
  return `if ${accessRoot}.hasField("${GLOBAL_FIELD_NAMES.focus}") then ${globalFieldRef('focus', accessRoot)}.callFunc("applyPendingFocus")`;
}

/**
 * Whether `statementText` contains a `router.navigate(...)`/`router.back()`
 * call — used by `codegen/brs-emitter.ts` only to decide whether a
 * single-line `if (<cond>) then <stmt>` has to be printed in block form
 * instead (the mandatory follow-up statement needs a line of its own).
 * `checkRouterActionIsStandaloneStatement` has, by the time this runs,
 * already rejected every form where the call isn't a statement on its own
 * line.
 */
export function isRouterNavigationStatement(statementText: string): boolean {
  const parsed = parseEmbeddedStatements(statementText);
  if (parsed.result.diagnostics.length > 0) return false;
  return findGlobalPathAccesses(parsed, GLOBAL_ROOT_NAMES, statementText).some(
    (access) => access.root === 'router' && access.isCallTarget && access.segments.length === 1 && ROUTER_NAVIGATION_METHODS.has(access.segments[0]),
  );
}

/** Escapes every regex metacharacter in `text` so it can be embedded literally inside a larger `RegExp` pattern — needed once `GlobalAccessRoot` can be `'GetGlobalAA().global'`, whose `(`/`)` are regex-special (a bare `.`-only escape, as this file used before, silently turns `()` into an empty capture group instead of matching the literal two characters — confirmed to make `emittedRouterNavigationMatcher` never match real GetGlobalAA()-rooted text at all). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches an already-emitted route-change call for a given access root — the exact text `buildRouterActionReplacement` produces for `navigate`/`back`. Built per-call (not once at module load) since the text differs between `.thr` (`m.global...`) and class (`GetGlobalAA().global...`) codegen. */
function emittedRouterNavigationMatcher(accessRoot: GlobalAccessRoot): RegExp {
  return new RegExp(`${escapeRegExp(globalFieldRef('router', accessRoot))}\\.callFunc\\("(?:${[...ROUTER_NAVIGATION_METHODS].join('|')})"`);
}

/**
 * Inserts `routerNavigationFollowUpCall()` after every emitted route-change
 * line in `emittedLines`, matching that line's own indentation. Operates on
 * already-emitted, already-indented BrightScript rather than on DSL source,
 * which is what keeps it correct for a multi-statement `StatementRegion`
 * (two route changes in one region each get their own follow-up, each
 * correctly placed and indented) instead of appending one at the end.
 *
 * `accessRoot` must match whatever root `emittedLines` was itself printed with — pure text
 * matching, no re-resolution. Defaults to `'m.global'` (every existing `.thr`-side call site is
 * unaffected); `codegen/class-emitter.ts` passes `'GetGlobalAA().global'` for class-body statements.
 */
export function withRouterFocusHandoff(emittedLines: string, accessRoot: GlobalAccessRoot = 'm.global'): string {
  const matcher = emittedRouterNavigationMatcher(accessRoot);
  if (!matcher.test(emittedLines)) return emittedLines;

  return emittedLines
    .split('\n')
    .flatMap((line) => {
      if (!emittedRouterNavigationMatcher(accessRoot).test(line)) return [line];
      const indent = line.slice(0, line.length - line.trimStart().length);
      return [line, `${indent}${routerNavigationFollowUpCall(accessRoot)}`];
    })
    .join('\n');
}

/**
 * Whether `statementText` contains a `taskManager.onAlertChanged(...)` call — used by `compile.ts`'s
 * `scriptUsesTaskManagerAlertCallback` to decide whether a component needs the ONE `init()`-time
 * callbacks-array + `ObserveFieldScoped` registration and the trampoline sub at all (see
 * `codegen/brs-emitter.ts`'s `emitInitFunction`/`emitTaskManagerAlertTrampoline`) — purely a
 * detection helper now, not tied to any statement-vs-expression placement decision (unlike
 * `isRouterNavigationStatement`, which brs-emitter.ts also uses to force block-form printing; this one's DSL callers
 * are already restricted to statement position by `checkTaskManagerOnAlertChangedNotInReactiveExpression`, but the single-line
 * `.Push(...)` replacement it now produces needs no block-form forcing of its own).
 */
export function isTaskManagerOnAlertChangedStatement(statementText: string): boolean {
  const parsed = parseEmbeddedStatements(statementText);
  if (parsed.result.diagnostics.length > 0) return false;
  return findGlobalPathAccesses(parsed, GLOBAL_ROOT_NAMES, statementText).some(
    (access) => access.root === 'taskManager' && access.isCallTarget && access.segments.length === 1 && access.segments[0] === 'onAlertChanged',
  );
}

/**
 * Whether `statementText` contains a `taskManager.onResult(...)` call — used by `compile.ts`'s
 * `scriptUsesTaskManagerResultCallback` to decide whether a component needs the two generated
 * trampoline subs at all (see `codegen/brs-emitter.ts`'s `emitTaskManagerResultTrampolines`).
 */
export function isTaskManagerOnResultStatement(statementText: string): boolean {
  const parsed = parseEmbeddedStatements(statementText);
  if (parsed.result.diagnostics.length > 0) return false;
  return findGlobalPathAccesses(parsed, GLOBAL_ROOT_NAMES, statementText).some(
    (access) => access.root === 'taskManager' && access.isCallTarget && access.segments.length === 1 && access.segments[0] === 'onResult',
  );
}

const TIMER_ALL_FUNCTION_NAMES = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'];

/**
 * Whether `statementText` contains a bare call to any of `setTimeout`/`setInterval`/`clearTimeout`/
 * `clearInterval` — used by `compile.ts`'s `scriptUsesTimer` to decide whether a component needs the
 * shared registry (`codegen/naming.ts`'s `timerCallbacksFieldAccess`) + trampoline
 * (`codegen/brs-emitter.ts`'s `emitTimerFireTrampoline`) + unmount-time force-stop loop
 * (`emitUnmountFunction`'s own `usesTimer` branch) at all. Same shape as
 * `isTaskManagerOnAlertChangedStatement`/`isTaskManagerOnResultStatement`, mechanically mirrored for
 * a bare-call pattern instead of a dot-chain one.
 */
export function isTimerCallStatement(statementText: string): boolean {
  const parsed = parseEmbeddedStatements(statementText);
  if (parsed.result.diagnostics.length > 0) return false;
  return findGlobalFunctionCalls(parsed, TIMER_ALL_FUNCTION_NAMES, statementText).length > 0;
}

/**
 * Whether `statementText` contains a `taskManager.onRequestSent(...)` call — used by `compile.ts`'s
 * `scriptUsesTaskManagerRequestSentCallback` to decide whether a component needs the `init()`-time
 * callbacks-array + `ObserveFieldScoped` registration and the trampoline sub at all (see
 * `codegen/brs-emitter.ts`'s `emitTaskManagerRequestSentTrampoline`). Mirrors
 * `isTaskManagerOnAlertChangedStatement` exactly.
 */
export function isTaskManagerOnRequestSentStatement(statementText: string): boolean {
  const parsed = parseEmbeddedStatements(statementText);
  if (parsed.result.diagnostics.length > 0) return false;
  return findGlobalPathAccesses(parsed, GLOBAL_ROOT_NAMES, statementText).some(
    (access) => access.root === 'taskManager' && access.isCallTarget && access.segments.length === 1 && access.segments[0] === 'onRequestSent',
  );
}

/** See `isTaskManagerOnRequestSentStatement`'s own doc comment — identical shape, the response-side hook. */
export function isTaskManagerOnResponseReceivedStatement(statementText: string): boolean {
  const parsed = parseEmbeddedStatements(statementText);
  if (parsed.result.diagnostics.length > 0) return false;
  return findGlobalPathAccesses(parsed, GLOBAL_ROOT_NAMES, statementText).some(
    (access) => access.root === 'taskManager' && access.isCallTarget && access.segments.length === 1 && access.segments[0] === 'onResponseReceived',
  );
}

/**
 * Drops any access whose whole span sits strictly inside another access's
 * own call span — see `validateAndRewriteGlobalPaths`'s own doc comment for
 * why this is necessary once a global root (`router`) can be a call target
 * with its own arguments. `theme` never triggers this (never a call target),
 * so this is a no-op whenever no `router-action`-shaped access is present.
 */
function dropNestedAccesses(accesses: readonly GlobalPathAccess[]): GlobalPathAccess[] {
  return accesses.filter(
    (access) => !accesses.some((other) => other !== access && other.isCallTarget && access.rootStart >= other.rootStart && access.chainEnd <= other.chainEnd),
  );
}

/**
 * Builds the full replacement text for a validated `router.<method>(...)`
 * call — the whole `[rootStart, chainEnd)` span, `(...)` included, not just
 * the root token (unlike a theme/router-data read, which only ever splices
 * the root). Each of the call's own arguments is sliced from the ORIGINAL
 * text (`access.callArgSpans`, each independently safe to re-parse — see
 * that field's own doc comment in flash-parser's `embedded.ts`) and put
 * through the FULL rewrite pipeline again (`rewriteExpression`, not just
 * this file's own global-path splice) so a plain identifier inside an
 * argument (a `field`/`state`/local, or another nested `theme.`/`router.`
 * access) is resolved exactly like anywhere else in this DSL.
 *
 * `navigate` is the one action whose DSL call shape doesn't match its
 * runtime `callFunc` shape 1:1: `router.navigate(<path>)`/
 * `router.navigate(<path>, <params>)` (1-2 positional DSL arguments) packs
 * into the runtime's own single-AA-argument `navigate(routeData as object)`
 * (see `packages/compiler/runtime-assets/Router/FlashTheaterRouter.brs`) —
 * every other action's DSL arguments pass straight through positionally,
 * since their runtime functions already take them directly.
 */
function buildRouterActionReplacement(
  method: RouterActionMethod,
  access: GlobalPathAccess,
  originalText: string,
  contextLabel: string,
  accessRoot: GlobalAccessRoot,
  rewriteArg: (argText: string) => string,
): string {
  const args = access.callArgSpans.map((span) => rewriteArg(originalText.slice(span.start, span.end)));

  const callFunc = (callArgs: readonly string[]): string => {
    const argsText = callArgs.length > 0 ? `, ${callArgs.join(', ')}` : '';
    return `${globalFieldRef('router', accessRoot)}.callFunc("${method}"${argsText})`;
  };

  // `markReady` never goes through `callFunc` at all — see this file's own `checkRouterMarkReadySupported`
  // doc comment for why (`accessRoot` is guaranteed 'm.global' by that check having already run, so
  // `m.top` here is always the calling .thr component's own node).
  if (method === 'markReady') {
    if (args.length !== 0) {
      throw new CompileError({
        code: 'expression/invalid-router-mark-ready-arguments',
        message: `Invalid router.markReady(...) call in ${contextLabel} — markReady() takes no arguments.`,
      });
    }
    return `m.top.${ROUTE_READY_FIELD_NAME} = true`;
  }

  if (method === 'navigate') {
    if (args.length < 1 || args.length > 3) {
      throw new CompileError({
        code: 'expression/invalid-router-navigate-arguments',
        message: `Invalid router.navigate(...) call in ${contextLabel} — expected router.navigate(<path>), router.navigate(<path>, <params>), or router.navigate(<path>, <params>, <skipInHistory>), got ${args.length} argument(s).`,
      });
    }
    const params = args.length >= 2 ? args[1] : '{}';
    const skipInHistory = args.length === 3 ? args[2] : 'false';
    return callFunc([`{path: ${args[0]}, params: ${params}, skipInHistory: ${skipInHistory}}`]);
  }

  if (method === 'back') {
    if (args.length !== 0) {
      throw new CompileError({ code: 'expression/invalid-router-back-arguments', message: `Invalid router.back() call in ${contextLabel} — back() takes no arguments.` });
    }
    return callFunc([]);
  }

  if (method === 'resetHistory') {
    if (args.length > 1) {
      throw new CompileError({
        code: 'expression/invalid-router-resetHistory-arguments',
        message: `Invalid router.resetHistory(...) call in ${contextLabel} — expected router.resetHistory() or router.resetHistory(<rootPath>), got ${args.length} argument(s).`,
      });
    }
    return callFunc([args.length === 1 ? args[0] : '""']);
  }

  // 'setRouting' | 'appendBackJourneyData' | 'updateBackJourneyData' — exactly one argument, passed straight through.
  if (args.length !== 1) {
    throw new CompileError({
      code: 'expression/invalid-router-action-arguments',
      message: `Invalid router.${method}(...) call in ${contextLabel} — expected exactly one argument, got ${args.length}.`,
    });
  }
  return callFunc([args[0]]);
}

/**
 * Builds the full replacement text for a validated `taskManager.<method>(...)` call — mirrors
 * `buildRouterActionReplacement`'s shape (each argument independently put through the full
 * `rewriteExpression` pipeline). `run` is the one method with a variable DSL argument count (1 or
 * 2 — a required node, and an optional `"low"`/`"normal"`/`"high"` priority, defaulting to the
 * literal `"normal"` when omitted, mirroring `router.navigate`'s own optional-trailing-argument
 * shape); `cancel`/`setMaxConcurrent`/`setAlertThresholds` each take exactly one DSL argument,
 * passed straight through positionally — no `navigate`-style repacking for any of them. `run`'s
 * return value needs no special handling — `callFunc` already returns whatever the target function
 * returns, so an assignment like `taskId = taskManager.run(myTaskNode)` just works once the call
 * itself is spliced. The `callFunc(...)` target string comes from `TASK_MANAGER_RUNTIME_METHOD_NAMES`,
 * not `method` directly — `run`'s actual runtime function is named `runTask` (see that constant's
 * own doc comment for why).
 */
function buildTaskManagerActionReplacement(
  method: TaskManagerCallFuncMethod,
  access: GlobalPathAccess,
  originalText: string,
  contextLabel: string,
  accessRoot: GlobalAccessRoot,
  rewriteArg: (argText: string) => string,
): string {
  const args = access.callArgSpans.map((span) => rewriteArg(originalText.slice(span.start, span.end)));
  const runtimeMethod = TASK_MANAGER_RUNTIME_METHOD_NAMES[method];

  if (method === 'run') {
    if (args.length < 1 || args.length > 2) {
      throw new CompileError({
        code: 'expression/invalid-task-manager-run-arguments',
        message: `Invalid taskManager.run(...) call in ${contextLabel} — expected taskManager.run(<node>) or taskManager.run(<node>, <priority>), got ${args.length} argument(s).`,
      });
    }
    const priority = args.length === 2 ? args[1] : '"normal"';
    // `owner` is the CALLING .thr component's own top node — the runtime manager stores it per
    // task so a since-destroyed component's own generated ft_unmount() can auto-cancel everything
    // IT started (`cancelOwnedBy`, see FlashTheaterTaskManager.brs) without this compiler having to
    // track arbitrary call-argument dataflow. A .flsh class instance has no node of its own to be an
    // owner (see accessRoot's own doc comment) — `invalid` there never matches any real owner.
    const owner = accessRoot === 'm.global' ? 'm.top' : 'invalid';
    return `${globalFieldRef('taskManager', accessRoot)}.callFunc("${runtimeMethod}", ${args[0]}, ${priority}, ${owner})`;
  }

  if (args.length !== 1) {
    throw new CompileError({
      code: 'expression/invalid-task-manager-action-arguments',
      message: `Invalid taskManager.${method}(...) call in ${contextLabel} — expected exactly one argument, got ${args.length}.`,
    });
  }

  return `${globalFieldRef('taskManager', accessRoot)}.callFunc("${runtimeMethod}", ${args[0]})`;
}

/**
 * Builds the replacement for `taskManager.onResult(<task>, <onSuccess>, [<onError>])` — the
 * promise-style consumption sugar (see GRAMMAR.md's "Task manager" section). **`<task>` is the
 * TASK NODE itself** (the same value already handed to `taskManager.run(...)`), not its id —
 * unlike every other `taskManager.*` action, this is NOT a `callFunc` splice at all: it registers
 * `ObserveFieldScoped` directly, from THIS calling component's own script, on the task node it
 * already holds a live reference to. Confirmed live that the original design (registering on the
 * MANAGER via `callFunc`, keyed by task id) cannot work: a Function value placed in a `callFunc`
 * AA argument arrives as `invalid` on the other side of a cross-node `callFunc` call — see
 * `findings/task-manager-onresult.md`. Storing the callback pair on THIS component's own `m` (like
 * `onAlertChanged`'s array) and attaching the observer locally needs no such crossing at all.
 *
 * Expands to FOUR colon-chained statements in one spliced position (confirmed parses cleanly via
 * `kopytko-brightscript-parser`, not assumed):
 *   ft_task = <task> : m["$$ft_taskManagerResultCallbacks"][ft_task.id] = {onSuccess: ..., onError: ...} : ft_task.ObserveFieldScoped("result", "on_taskManagerResult") : ft_task.ObserveFieldScoped("error", "on_taskManagerResultError")
 * `<task>` is hoisted into a fixed `ft_task` local first (a reserved name — `checkReservedIdentifierPrefix`
 * guarantees no real DSL identifier can ever collide with it) so it's only ever EVALUATED once,
 * regardless of how many times its value is referenced in the expansion — matters if a future
 * caller ever passes something more than a bare variable reference (a call with side effects,
 * however unlikely for a "the task I just created" argument, would otherwise run multiple times).
 * Keyed by `ft_task.id` — already set by the time `run(...)` returned, which is the required call
 * order (see GRAMMAR.md's own timing note).
 *
 * `onError` defaults to the literal `invalid` when omitted — the trampoline treats an `invalid`
 * `onError` as "no-op on failure," mirroring how `parseError` is optional in `request Http {}`
 * itself.
 */
function buildTaskManagerOnResultReplacement(access: GlobalPathAccess, originalText: string, contextLabel: string, rewriteArg: (argText: string) => string): string {
  const args = access.callArgSpans.map((span) => rewriteArg(originalText.slice(span.start, span.end)));

  if (args.length < 2 || args.length > 3) {
    throw new CompileError({
      code: 'expression/invalid-task-manager-on-result-arguments',
      message: `Invalid taskManager.onResult(...) call in ${contextLabel} — expected taskManager.onResult(<task>, <onSuccess>) or taskManager.onResult(<task>, <onSuccess>, <onError>), got ${args.length} argument(s).`,
    });
  }

  const [task, onSuccess] = args;
  const onError = args.length === 3 ? args[2] : 'invalid';
  const callbacks = taskManagerResultCallbacksFieldAccess();
  return (
    `ft_task = ${task} : ${callbacks}[ft_task.id] = { onSuccess: ${onSuccess}, onError: ${onError} } : ` +
    `ft_task.ObserveFieldScoped("result", "${TASK_MANAGER_RESULT_TRAMPOLINE_SUB_NAME}") : ` +
    `ft_task.ObserveFieldScoped("error", "${TASK_MANAGER_RESULT_ERROR_TRAMPOLINE_SUB_NAME}")`
  );
}

/**
 * Builds the replacement for `taskManager.onAlertChanged(<callback>)` — unlike every other
 * task-manager action, this is NOT a `callFunc` splice. It replaces the whole call span with a
 * single `.Push(...)` call, appending the rewritten callback expression onto this subscribing
 * component's own callbacks array (`taskManagerAlertCallbacksFieldAccess()` — a reserved,
 * `$$ft_`-bracket bookkeeping field, never a DSL-author-visible name), e.g.:
 *
 *   m["$$ft_taskManagerAlertCallbacks"].Push(ft_anon_1)
 *
 * The array itself, and the ONE `ObserveFieldScoped("alertLevel", ...)` registration that backs it,
 * are set up once in `init()` (`codegen/brs-emitter.ts`'s `emitInitFunction`, gated on
 * `usesTaskManagerAlertCallback`) — never per call site. This is what lets a component call
 * `onAlertChanged(...)` more than once (two independent subscribers) without either silently
 * losing the first callback (a single overwritable slot would) or double-registering the field
 * observer (which would make the trampoline sub fire once per registration instead of once per
 * real change) — see `findings/task-manager-alerting.md`.
 *
 * `callback` is evaluated exactly like any other argument — an anonymous function expression
 * lowers to a hoisted local holding a function value (see `codegen/brs-emitter.ts`'s
 * `lowerAnonymousFunctionsInText`), and a bare reference to an already-declared `private`/`public`
 * function resolves to its rewritten name via the ordinary identifier-rewrite path (a function name
 * is just another identifier to `resolveDsl` — nothing here special-cases "used as a value" vs.
 * "called").
 */
function buildTaskManagerOnAlertChangedReplacement(
  access: GlobalPathAccess,
  originalText: string,
  contextLabel: string,
  rewriteArg: (argText: string) => string,
): string {
  const args = access.callArgSpans.map((span) => rewriteArg(originalText.slice(span.start, span.end)));

  if (args.length !== 1) {
    throw new CompileError({
      code: 'expression/invalid-task-manager-on-alert-changed-arguments',
      message: `Invalid taskManager.onAlertChanged(...) call in ${contextLabel} — expected exactly one argument (the callback), got ${args.length}.`,
    });
  }

  return `${taskManagerAlertCallbacksFieldAccess()}.Push(${args[0]})`;
}

/**
 * Builds the replacement for `taskManager.onRequestSent(<callback>)` — the global HTTP request
 * interceptor hook (see GRAMMAR.md's "Task manager" section). Shaped exactly like
 * `buildTaskManagerOnAlertChangedReplacement`, not `buildTaskManagerOnResultReplacement`: replaces
 * the whole call span with a single `.Push(...)` onto this subscribing component's own callbacks
 * array (`taskManagerRequestSentCallbacksFieldAccess()`), e.g.:
 *
 *   m["$$ft_taskManagerRequestSentCallbacks"].Push(ft_anon_1)
 *
 * The array itself, and the ONE `ObserveFieldScoped("lastRequestSent", ...)` registration that
 * backs it, are set up once in `init()` (`codegen/brs-emitter.ts`'s `emitInitFunction`, gated on
 * `usesTaskManagerRequestSentCallback`) — never per call site, for the identical reason
 * `onAlertChanged` already established (supports calling this more than once in one component
 * without either losing a callback or double-firing the observer).
 */
function buildTaskManagerOnRequestSentReplacement(
  access: GlobalPathAccess,
  originalText: string,
  contextLabel: string,
  rewriteArg: (argText: string) => string,
): string {
  const args = access.callArgSpans.map((span) => rewriteArg(originalText.slice(span.start, span.end)));

  if (args.length !== 1) {
    throw new CompileError({
      code: 'expression/invalid-task-manager-on-request-sent-arguments',
      message: `Invalid taskManager.onRequestSent(...) call in ${contextLabel} — expected exactly one argument (the callback), got ${args.length}.`,
    });
  }

  return `${taskManagerRequestSentCallbacksFieldAccess()}.Push(${args[0]})`;
}

/** See `buildTaskManagerOnRequestSentReplacement`'s own doc comment — identical shape, the response-side hook (`lastResponseReceived`). */
function buildTaskManagerOnResponseReceivedReplacement(
  access: GlobalPathAccess,
  originalText: string,
  contextLabel: string,
  rewriteArg: (argText: string) => string,
): string {
  const args = access.callArgSpans.map((span) => rewriteArg(originalText.slice(span.start, span.end)));

  if (args.length !== 1) {
    throw new CompileError({
      code: 'expression/invalid-task-manager-on-response-received-arguments',
      message: `Invalid taskManager.onResponseReceived(...) call in ${contextLabel} — expected exactly one argument (the callback), got ${args.length}.`,
    });
  }

  return `${taskManagerResponseReceivedCallbacksFieldAccess()}.Push(${args[0]})`;
}

/**
 * `store(<path>)` read → a plain BrightScript dot-chain read on the fixed
 * runtime Store node (`m.global.store.<path>`). Unchecked past segment 1 by
 * design — the store is schemaless from the compiler's point of view (it's
 * a built-in runtime primitive, never declared in the DSL); reading a
 * never-written key is a runtime `invalid`, matching real `roSGNode` field
 * semantics, not a compile-time concern.
 */
export function rewriteStorePathRead(path: readonly string[]): string {
  return `${globalFieldRef('store')}.${path.join('.')}`;
}

/**
 * Drops any comparison whose whole `[start, end)` span sits strictly inside
 * another comparison's own span — mirrors `dropNestedAccesses`'s reasoning.
 * A nested comparison (`(a == b) == c`) is never rewritten at this level;
 * `rewriteComparisons`'s own recursive `rewriteExpression` call on the
 * outer comparison's operand text finds and lowers it independently, the
 * same "each stretch of text is only ever rewritten once" invariant
 * `validateAndRewriteGlobalPaths` already relies on for a nested
 * `router.<action>(...)` argument.
 */
export function dropNestedComparisons(accesses: readonly ComparisonAccess[]): ComparisonAccess[] {
  return accesses.filter((access) => !accesses.some((other) => other !== access && access.start >= other.start && access.end <= other.end));
}

/**
 * Drops any safe-NOT whose whole `[start, end)` span sits strictly inside
 * another safe-NOT's own span — same reasoning as `dropNestedComparisons`. A
 * nested safe-NOT (`!!a`) is never rewritten at this level; `rewriteSafeNots`'s
 * own recursive `rewriteExpression` call on the outer safe-NOT's operand text
 * finds and lowers it independently.
 */
export function dropNestedSafeNots(accesses: readonly SafeNotAccess[]): SafeNotAccess[] {
  return accesses.filter((access) => !accesses.some((other) => other !== access && access.start >= other.start && access.end <= other.end));
}

/**
 * Splices every top-level `<left> == <right>` / `<left> != <right>` /
 * `<left> < <right>` / `<left> > <right>` / `<left> <= <right>` / `<left> >=
 * <right>` DSL comparison/relational in `text` (found via flash-parser's
 * `findComparisonExpressions`, which sees the real `BsComparisonExpression`
 * shape flash-parser's own grammar parses all six operators into — see that
 * node's own doc comment) into a crash-safe helper call, branching on
 * `access.operator`: `==`/`!=` become `ft_equals(<left>, <right>)`/
 * `Not ft_equals(<left>, <right>)` (`runtime-assets/SafeCompare/
 * FlashTheaterSafeCompare.brs`); `<`/`>`/`<=`/`>=` become
 * `ft_relationalGuard(<left>, <right>, "<op>")`
 * (`runtime-assets/SafeRelational/FlashTheaterSafeRelational.brs`). Both
 * helpers type-check via `Type(Box(...))` before falling through to a real
 * comparison, so a genuinely type-mismatched operand pair never hits a bare
 * BrightScript `=`/`<>`/`<`/`>`/`<=`/`>=` (which crashes on mismatched
 * types — the whole reason this sugar exists at all): `ft_equals` returns
 * `false` on a mismatch (equality has an obviously-safe fallback value),
 * while `ft_relationalGuard` THROWS a structured `{code, message}` error
 * instead (there's no obviously-correct fallback VALUE for an incompatible
 * *ordering* comparison — see that file's own doc comment). Numeric operands
 * of *different* boxed subtypes (Integer vs Float, ...) are NOT treated as a
 * type mismatch by either helper — they compare by value; `ft_equals`
 * additionally treats an roArray/roAssociativeArray/roSGNode operand as
 * comparing by reference identity, never by deep content equality.
 *
 * Runs BEFORE `validateAndRewriteGlobalPaths` in `rewriteExpression`/
 * `rewriteStatement`, since each operand is independently, recursively put
 * through the FULL `rewriteExpression` pipeline (global-path rewriting,
 * nested comparisons, and identifier rewriting all included) on its own
 * sliced text — by the time the outer pass's `validateAndRewriteGlobalPaths`
 * and `applyIdentifierRewrite` run over the resulting text, every
 * `theme`/`router` access and identifier that started out *inside* a
 * comparison has already been resolved once, exactly the same
 * resolve-nested-fragments-first shape `codegen/brs-emitter.ts`'s ternary
 * `TernaryOperand` reassembly already relies on (see `lowerTernaryRhs`'s own
 * doc comment) — `ft_equals`/`ft_relationalGuard` themselves resolve as an
 * already-valid local via `resolveIdentifier`'s reserved-prefix (`ft_`)
 * short-circuit when the assembled text is rewritten a second time, the same
 * way `ft_ternary_N` does.
 */
/**
 * Sugar for the `stream` primitive: `<receiver>.subscribe(<target>.<action>)` — where the sole
 * argument is a BARE method reference, no call parens — splices in a
 * `{ target: <rewritten target>, action: "<action>" }` dispatch descriptor instead of passing the
 * bound reference through as a plain Function value. See GRAMMAR.md's "`stream`" section and
 * `findings/streams.md` for why: a Function value's own `m` binding does not reliably survive
 * being stored in the stream's own subscriber list and invoked later, once detached from a real
 * SceneGraph node — confirmed live on a real Roku device three different ways, all failing
 * identically (see that finding's full writeup). The descriptor form sidesteps the problem
 * entirely, since only DATA (an object reference and a method-name string) needs to survive the
 * store/invoke boundary, dispatched back to a real `target.action(value)` call at invocation time.
 *
 * `<target>` (everything before the final `.`) goes through the FULL `rewriteExpression` pipeline,
 * recursively — same "slice, recurse through the whole pipeline, splice" shape `rewriteComparisons`
 * already uses for its own operands, and safe for the identical reason: `applyIdentifierRewrite`
 * is idempotent on already-rewritten text, so the outer pass re-scanning the spliced-in target text
 * a second time (e.g. seeing a bare `m` inside the object literal) is a harmless no-op.
 * `<action>` is used as a plain string literal, never itself rewritten — it's a BrightScript AA
 * key/method name, not a DSL identifier.
 *
 * Runs BEFORE `rewriteComparisons`/`validateAndRewriteGlobalPaths` in `rewriteExpression`/
 * `rewriteStatement` — order between this and comparisons doesn't matter (disjoint syntax shapes),
 * but it must run before `applyIdentifierRewrite`'s own top-level-identifier scan, since after this
 * splice the receiver/callee portion of the `.subscribe(...)` call (e.g. `dataLoaded`,
 * `publisher.onChanged`) still needs that ordinary rewriting pass.
 */
function rewriteStreamSubscribeBoundReferences(
  text: string,
  mode: 'expression' | 'statement',
  bindings: ScriptBindings,
  functionScope: FunctionScope,
  globalBindings: GlobalBindingsContext,
  contextLabel: string,
): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by parseExpression/parseStatements right after this returns

  const matches = findStreamSubscribeBoundReferences(parsed, text);
  if (matches.length === 0) return text;

  const replacements = matches.map((match) => {
    const targetText = text.slice(match.targetStart, match.targetEnd);
    const rewrittenTarget = rewriteExpressionWithoutChainOptionalization(targetText, bindings, contextLabel, functionScope, globalBindings);
    return { start: match.argStart, end: match.argEnd, replacement: `{ target: ${rewrittenTarget}, action: "${match.action}" }` };
  });

  return applySplices(text, replacements);
}

/** `spansItsOwnLine`'s same "is this the only non-trivial content on its line" check, generalized to a plain `[start, end)` range instead of a `GlobalPathAccess`-shaped one — `AnimationControlCallMatch` has no `rootStart`/`chainEnd`. */
function spansItsOwnLineRange(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newlineAfter = text.indexOf('\n', end);
  const lineEnd = newlineAfter === -1 ? text.length : newlineAfter;

  if (text.slice(lineStart, start).trim() !== '') return false;

  const trailing = text.slice(end, lineEnd).trim();
  return trailing === '' || trailing.startsWith("'");
}

/**
 * A `<name>.start()`/`.stop()`/`.pause()`/`.resume()`/`.finish()` trigger call must be a statement
 * of its own — never nested inside a larger expression (`if (bounce.start())`, `x = bounce.start()`),
 * and never inside a `derived` RHS or a template `{expr}` binding (`mode === 'expression'`). Same
 * restriction, and the same reasoning, as `checkRouterActionIsStandaloneStatement`: Roku's
 * `AnimationBase.control` is a FIELD you WRITE, not a method with a return value — this sugar
 * lowers to a plain `m["$$ft_anim_<name>"].control = "<method>"` assignment, which is syntactically
 * a statement and has no value to embed in a surrounding expression at all.
 */
function checkAnimationControlCallIsStandaloneStatement(match: AnimationControlCallMatch, text: string, mode: 'expression' | 'statement', contextLabel: string): void {
  if (mode === 'statement' && spansItsOwnLineRange(text, match.calleeStart, match.calleeEnd)) return;

  throw new CompileError({
    code: 'expression/animation-control-call-must-be-statement',
    message:
      `${match.animationName}.${match.method}() in ${contextLabel} must be a statement of its own — it cannot be nested inside a larger expression, ` +
      `a derived, or a template binding. Roku's Animation "control" field is written, not called, so this sugar only makes sense as its own line.`,
  });
}

/**
 * Splices `<name>.<method>()` into `m["$$ft_anim_<name>"].control = "<method>"` — `<method>` maps
 * 1:1 onto Roku's own `AnimationBase.control` field values, so no further translation is needed.
 * Filtered against `bindings.animationNames` first (same "trust the shape, don't try to type-check
 * it" discipline `findStreamSubscribeBoundReferences`'s own doc comment documents — the compiler
 * has no cross-object type information, so an unrelated `x.start()` call on some other object is
 * left completely untouched). Unlike `rewriteStreamSubscribeBoundReferences`, there is no nested
 * sub-expression to recurse into — `<name>` is always a bare identifier by construction (see
 * `findAnimationControlCalls`'s own doc comment), never a general expression.
 *
 * Always a plain 1:1 single-line replacement — a `"start"` call for an animation that ALSO needs a
 * `fieldToInterp` refresh (see `collectAnimationFieldRefreshLines` below) does NOT get that refresh
 * spliced in here. This module works on raw statement/expression text with no notion of print
 * depth/indentation (that's `codegen/brs-emitter.ts`'s job) — an earlier version of this function
 * tried embedding the two extra refresh lines directly into this replacement's own text, unindented,
 * relying on the caller to prefix the WHOLE multi-line blob with one `indent` — but the caller
 * (`printStatement`'s fallback) only ever prefixes the FIRST line, by design, since some OTHER
 * multi-line `rewrittenText` shapes (an already fully, correctly self-indented hoisted anon-function
 * literal, a raw multi-statement blob preserving the author's own original relative indentation)
 * must NEVER be re-indented again. See `collectAnimationFieldRefreshLines`'s own doc comment for
 * where the refresh lines actually come from instead.
 */
function rewriteAnimationControlCalls(text: string, mode: 'expression' | 'statement', bindings: ScriptBindings, contextLabel: string): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by parseExpression/parseStatements right after this returns

  const matches = findAnimationControlCalls(parsed, text).filter((m) => bindings.animationNames.has(m.animationName));
  if (matches.length === 0) return text;

  const replacements = matches.map((match) => {
    checkAnimationControlCallIsStandaloneStatement(match, text, mode, contextLabel);
    return { start: match.calleeStart, end: match.calleeEnd, replacement: `${mFieldAccess(animationNodeId(match.animationName))}.control = "${match.method}"` };
  });

  return applySplices(text, replacements);
}

/**
 * A `<name>.onFinish(<callback>)` registration must be a statement of its own — never nested inside
 * a larger expression, and never inside a `derived` RHS or a template `{expr}` binding
 * (`mode === 'expression'`). Same restriction, and the same reasoning, as
 * `checkAnimationControlCallIsStandaloneStatement`: this sugar lowers to a plain
 * `m["$$ft_animFinish_<name>"] = <callback>` assignment, which is syntactically a statement and has
 * no value to embed in a surrounding expression at all.
 */
function checkAnimationOnFinishCallIsStandaloneStatement(match: AnimationOnFinishCallMatch, text: string, mode: 'expression' | 'statement', contextLabel: string): void {
  if (mode === 'statement' && spansItsOwnLineRange(text, match.calleeStart, match.calleeEnd)) return;

  throw new CompileError({
    code: 'expression/animation-onfinish-call-must-be-statement',
    message:
      `${match.animationName}.onFinish(...) in ${contextLabel} must be a statement of its own — it cannot be nested inside a larger expression, ` +
      `a derived, or a template binding. It registers a callback (a field write), not a value-producing call, so this sugar only makes sense as its own line.`,
  });
}

/**
 * Splices `<name>.onFinish(<callback>)` into `m["$$ft_animFinish_<name>"] = <rewritten callback>` —
 * unlike `rewriteAnimationControlCalls`'s simple 1:1 method-name splice, the callback argument may
 * itself be an arbitrary expression (a bound function reference, an inline anonymous function
 * literal, ...) that can reference other script identifiers, so it's recursively re-run through the
 * full `rewriteExpression` pipeline before being spliced in — the same "slice, recurse, splice" shape
 * `rewriteStreamSubscribeBoundReferences` already uses for its own `.subscribe(...)` argument.
 * Filtered against `bindings.animationNames` first, same discipline as `rewriteAnimationControlCalls`.
 * Registering `.onFinish()` more than once for the same name is legal — ordinary last-write-wins
 * assignment semantics, no diagnostic needed (the merged handler this feeds — see
 * `codegen/conditional-block-emitter.ts`'s `emitAnimationStateChangeHandler` — always just reads
 * whatever `m["$$ft_animFinish_<name>"]` currently holds at the moment the animation stops).
 */
function rewriteAnimationOnFinishCalls(
  text: string,
  mode: 'expression' | 'statement',
  bindings: ScriptBindings,
  functionScope: FunctionScope,
  globalBindings: GlobalBindingsContext,
  contextLabel: string,
): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by parseExpression/parseStatements right after this returns

  const matches = findAnimationOnFinishCalls(parsed, text).filter((m) => bindings.animationNames.has(m.animationName));
  if (matches.length === 0) return text;

  const replacements = matches.map((match) => {
    checkAnimationOnFinishCallIsStandaloneStatement(match, text, mode, contextLabel);
    const callbackText = text.slice(match.argStart, match.argEnd);
    const rewrittenCallback = rewriteExpressionWithoutChainOptionalization(callbackText, bindings, contextLabel, functionScope, globalBindings);
    return { start: match.calleeStart, end: match.calleeEnd, replacement: `${animationFinishCallbackFieldAccess(match.animationName)} = ${rewrittenCallback}` };
  });

  return applySplices(text, replacements);
}

/**
 * Every `fieldToInterp` blank-then-reset line pair needed for a Layer 1 `.start()` trigger call
 * anywhere in `text`, as plain UNindented text — the caller (`codegen/brs-emitter.ts`'s
 * `lowerAnonymousFunctionsInText`, the one place print `depth` is genuinely known) hoists these as
 * ordinary `${indent}`-prefixed sibling lines immediately before the statement, the exact same
 * mechanism a hoisted ternary temp-var assignment or an extracted anon-function literal already
 * uses — see that function's own doc comment. `text` itself is never spliced here; the actual
 * `<name>.start()` → `.control = "start"` conversion still happens separately, in the ordinary
 * `rewriteAnimationControlCalls` pass above, unaffected by this function's own existence.
 *
 * Only ever produces lines for a `"start"` call — see `codegen/animation-emitter.ts`'s
 * `RefreshableInterpolatorRef` doc comment for why only `.start()` needs this (every other method
 * acts on an already-established target, never re-triggers Roku's own one-time `fieldToInterp`
 * resolution). Empty for a `mode: 'expression'` caller — `checkAnimationControlCallIsStandaloneStatement`
 * already rejects any `.start()`/etc. call outside statement position with a hard compile error, so
 * a refresh-needing call can never legally reach an expression-mode text span in the first place;
 * `text` is still parsed as STATEMENTS regardless of what an expression-mode caller passes, purely
 * as a defensive no-crash fallback (an expression can never parse as a valid standalone
 * `<name>.start()` statement anyway, so this simply finds nothing).
 */
export function collectAnimationFieldRefreshLines(text: string, bindings: ScriptBindings): string[] {
  const parsed = parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return [];

  const matches = findAnimationControlCalls(parsed, text).filter((m) => m.method === 'start' && bindings.animationNames.has(m.animationName));
  return matches.flatMap((m) => {
    const refs = bindings.animationFieldRefreshByName.get(m.animationName);
    if (!refs || refs.length === 0) return [];
    return refs.flatMap((ref) => [`${mFieldAccess(ref.id)}.fieldToInterp = ""`, `${mFieldAccess(ref.id)}.fieldToInterp = "${ref.fieldToInterp}"`]);
  });
}

const TIMER_START_FUNCTION_NAMES = ['setTimeout', 'setInterval'] as const;
const TIMER_CLEAR_FUNCTION_NAMES = ['clearTimeout', 'clearInterval'] as const;

/**
 * Rejects a bare `setTimeout(...)`/`setInterval(...)` reached through THIS module's own
 * `rewriteExpression` — the code path a `derived` RHS, a dynamic template `{expr}` attribute, a
 * `{#if}`/`{#if:destroy}` condition, or a `{#each}` collection/key expression all funnel through,
 * none of which ever touch `codegen/statement-printer.ts`'s `lowerTimerStartCallsInText` (that one is
 * only reachable from an ordinary FUNCTION BODY, via the shared statement-printing engine). Without
 * this, a `derived x = setTimeout(onFire, 500)` would fall through to ordinary bare-identifier
 * resolution and fail with a generic `expression/unresolved-identifier` instead of a clear, specific
 * diagnostic — functionally still rejected either way, but this gives the real reason (a `derived`/
 * binding/block-condition recomputes repeatedly, which would leak a new Timer node every recompute —
 * same reasoning as `checkTaskManagerOnAlertChangedNotInReactiveExpression`) instead of a misleading
 * "not declared" message. `setTimeout`/`setInterval` never legitimately reach `rewriteStatement`
 * still-unlowered (the shared engine's own `lowerTimerStartCallsInText` already spliced them away by
 * the time `ctx.rewriteText` runs on the remaining text), so this check is `rewriteExpression`-only.
 */
function checkNoTimerStartCallInExpression(text: string, contextLabel: string): void {
  const parsed = parseEmbeddedExpression(text);
  if (parsed.result.diagnostics.length > 0) return; // surfaced as expression/parse-error right after this returns

  const matches = findGlobalFunctionCalls(parsed, TIMER_START_FUNCTION_NAMES, text);
  if (matches.length === 0) return;

  throw new CompileError({
    code: 'expression/timer-call-in-reactive-expression',
    message: `${matches[0].name}(...) in ${contextLabel} cannot be used inside a derived expression or a template binding — both recompute repeatedly, which would create a new Timer node every time. Call it once from a function body instead.`,
  });
}

/**
 * `clearTimeout(<handle>)`/`clearInterval(<handle>)` must be a statement of its own — never nested
 * inside a larger expression (`if (clearTimeout(t))`, `x = clearTimeout(t)`). Same restriction, and
 * the same reasoning, as `checkAnimationControlCallIsStandaloneStatement`: the lowered form ends in a
 * field WRITE (`.control = "stop"`), not a value-producing call, so there's no value to embed in a
 * surrounding expression anyway.
 */
function checkTimerClearCallIsStandaloneStatement(match: GlobalFunctionCallMatch, text: string, mode: 'expression' | 'statement', contextLabel: string): void {
  if (mode === 'statement' && spansItsOwnLineRange(text, match.start, match.end)) return;

  throw new CompileError({
    code: 'expression/timer-clear-call-must-be-statement',
    message: `${match.name}(...) in ${contextLabel} must be a statement of its own — it cannot be nested inside a larger expression, a derived, or a template binding.`,
  });
}

/**
 * Splices a bare `clearTimeout(<handle>)`/`clearInterval(<handle>)` call into
 * `ft_timerHandle = <rewrittenHandle> : m["$$ft_timerCallbacks"].Delete(ft_timerHandle.id) :
 * ft_timerHandle.control = "stop"` — deleting the pending registry entry BEFORE stopping the node
 * closes the same stale-event-after-cancel race `findings/task-manager-onresult.md` already solved
 * for `onResult` ("delete pending entry BEFORE invoking, no pending entry = silent no-op"): by the
 * time a `fire` event already in flight when this runs actually reaches `on_timerFire`
 * (`codegen/brs-emitter.ts`'s `emitTimerFireTrampoline`), the registry entry is already gone, so that
 * trampoline simply no-ops.
 *
 * `<handle>` is hoisted into a fixed local (`ft_timerHandle`) rather than repeated inline, evaluating
 * it exactly once — same reasoning as `buildTaskManagerOnResultReplacement`'s own `ft_task = <task>`
 * hoist. Unlike `rewriteAnimationControlCalls`'s bare-identifier splice, `<handle>` is an ARBITRARY
 * expression (a local variable, `m.pollHandle`, a function call returning a handle, ...), not
 * guaranteed to be a bare identifier by construction — so it's recursed through `rewriteExpression`
 * itself before splicing, the same way `rewriteStreamSubscribeBoundReferences`'s own target
 * expression is.
 */
function rewriteTimerClearCalls(
  text: string,
  mode: 'expression' | 'statement',
  bindings: ScriptBindings,
  functionScope: FunctionScope,
  globalBindings: GlobalBindingsContext,
  contextLabel: string,
): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by parseExpression/parseStatements right after this returns

  const matches = findGlobalFunctionCalls(parsed, TIMER_CLEAR_FUNCTION_NAMES, text);
  if (matches.length === 0) return text;

  // A `derived`/template binding recomputes repeatedly — clearing a timer is a one-time action with
  // no value to produce, same reasoning as `checkTaskManagerOnAlertChangedNotInReactiveExpression`.
  if (mode === 'expression') {
    throw new CompileError({
      code: 'expression/timer-clear-call-in-reactive-expression',
      message: `${matches[0].name}(...) in ${contextLabel} cannot be used inside a derived expression or a template binding — both recompute repeatedly, and clearing a timer is a one-time action.`,
    });
  }

  const replacements = matches.map((match) => {
    checkTimerClearCallIsStandaloneStatement(match, text, mode, contextLabel);
    if (match.argSpans.length !== 1) {
      throw new CompileError({
        code: match.name === 'clearTimeout' ? 'expression/invalid-clear-timeout-arguments' : 'expression/invalid-clear-interval-arguments',
        message: `Invalid ${match.name}(...) call in ${contextLabel} — expected exactly one argument (the handle), got ${match.argSpans.length}.`,
      });
    }
    const handleText = text.slice(match.argSpans[0].start, match.argSpans[0].end);
    const handle = rewriteExpressionWithoutChainOptionalization(handleText, bindings, contextLabel, functionScope, globalBindings);
    const callbacks = timerCallbacksFieldAccess();
    return { start: match.start, end: match.end, replacement: `ft_timerHandle = ${handle} : ${callbacks}.Delete(ft_timerHandle.id) : ft_timerHandle.control = "stop"` };
  });

  return applySplices(text, replacements);
}

const RELATIONAL_OPERATORS: ReadonlySet<string> = new Set(['<', '>', '<=', '>=']);

function rewriteComparisons(
  text: string,
  mode: 'expression' | 'statement',
  bindings: ScriptBindings,
  functionScope: FunctionScope,
  globalBindings: GlobalBindingsContext,
  contextLabel: string,
): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by parseExpression/parseStatements right after this returns

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
    const left = rewriteExpressionWithoutChainOptionalization(text.slice(access.leftSpan.start, access.leftSpan.end), bindings, contextLabel, functionScope, globalBindings);
    const right = rewriteExpressionWithoutChainOptionalization(text.slice(access.rightSpan.start, access.rightSpan.end), bindings, contextLabel, functionScope, globalBindings);
    const replacement = RELATIONAL_OPERATORS.has(access.operator)
      ? `ft_relationalGuard(${left}, ${right}, "${access.operator}")`
      : access.isNegated
        ? `Not ft_equals(${left}, ${right})`
        : `ft_equals(${left}, ${right})`;
    return { start: access.start, end: access.end, replacement };
  });

  return applySplices(text, replacements);
}

/**
 * Splices every top-level `!<operand>` DSL safe-NOT sugar in `text` (found via
 * flash-parser's `findSafeNotExpressions`, which sees the real
 * `BsSafeNotExpression` shape flash-parser's own grammar parses bare `!`
 * into — see that node's own doc comment) into a crash-safe
 * `ft_not(<operand>)` call — `ft_not` is
 * `runtime-assets/SafeNot/FlashTheaterSafeNot.brs`'s exported function,
 * which checks the operand's `Type(Box(...))` is `roBoolean` before falling
 * through to a real `Not`, so a non-boolean operand returns `false` at
 * runtime instead of crashing the app (a bare BrightScript `Not` on a
 * non-boolean does crash — the whole reason this sugar exists instead of
 * just lowering to `Not` directly). Same "recurse each operand through the
 * full `rewriteExpression` pipeline" shape as `rewriteComparisons` — safe
 * here for the identical reason: every later pass in that pipeline is
 * idempotent on already-rewritten text.
 */
function rewriteSafeNots(
  text: string,
  mode: 'expression' | 'statement',
  bindings: ScriptBindings,
  functionScope: FunctionScope,
  globalBindings: GlobalBindingsContext,
  contextLabel: string,
): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error by parseExpression/parseStatements right after this returns

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
    const operand = rewriteExpressionWithoutChainOptionalization(text.slice(access.operandSpan.start, access.operandSpan.end), bindings, contextLabel, functionScope, globalBindings);
    return { start: access.start, end: access.end, replacement: `ft_not(${operand})` };
  });

  return applySplices(text, replacements);
}

/**
 * Rejects `?.`/`?[`/`?(`/`?@` written directly in `.thr`/`.flsh` source, found via flash-parser's own
 * `BsOptionalChainingExpression` node. The grammar already parses these operators — vendored ahead of
 * this codegen feature — but a DSL author never legitimately writes them: `rewriteOptionalChains`
 * (below) inserts them automatically, everywhere, in generated output, so hand-writing one would be
 * redundant at best and, since nothing downstream expects to find one in DSL-authored text, silently
 * wrong at worst. Mirrors `checkNoTimerStartCallInExpression`'s shape: parse, bail out early on a
 * parse error (already surfaced elsewhere as `expression/parse-error`), scan for the offending node.
 */
export function checkNoHandWrittenOptionalChaining(text: string, mode: 'expression' | 'statement', contextLabel: string): void {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return; // surfaced as expression/parse-error right after this returns

  const offset = parsed.wrapperPrefixLength;
  const nodes = findAll(parsed.result.root, SyntaxKind.BsOptionalChainingExpression, (n) => n);
  for (const node of nodes) {
    const start = node.pos - offset;
    const end = node.end - offset;
    if (start < 0 || end > text.length) continue; // wrapper-only content

    throw new CompileError({
      code: 'expression/optional-chaining-not-allowed-in-source',
      message: `Optional chaining ("?.", "?[", "?(", "?@") in ${contextLabel} is not allowed in .thr/.flsh source — the compiler already inserts it automatically everywhere it's needed in generated output, so it's never necessary (or usable) in DSL source.`,
    });
  }
}

/**
 * Splices `?` immediately before every `.`/`@`/`[`/`(` postfix-access operator found by flash-parser's
 * `findChainAccesses` — see that function's own doc comment for exactly which operators are excluded
 * (assignment targets, increment/decrement operands, bare void-context call statements) and why.
 *
 * This MUST run as the true LAST step of `rewriteExpression`/`rewriteStatement` (and
 * `class-identifier-rewrite.ts`'s equivalent tail) — every earlier pass in this pipeline
 * (`validateAndRewriteGlobalPaths`, `rewriteComparisons`, `rewriteSafeNots`,
 * `rewriteAnimationControlCalls`, `rewriteStreamSubscribeBoundReferences`, `applyIdentifierRewrite`)
 * pattern-matches the PLAIN `BsDotExpression`/`BsIndexExpression`/`BsCallExpression` shapes; `?.`/
 * `?[`/`?(` parse into a distinct `BsOptionalChainingExpression` node none of them recognize. Running
 * this pass any earlier would silently break every one of those structural finders the moment a chain
 * they depend on had already been partially optional-ized.
 *
 * Running it last also means it protects chains the COMPILER ITSELF assembles during those earlier
 * passes (`m.global.ft_theme.colors.primary`, `ft_equals(left, right)`, `m.top.<field>`) — not just
 * literal characters a DSL author typed. That's the intended, uniform scope: every member/index/call
 * access gets `?`, even a lone non-chained one — see findings/operators-optional-chaining.md.
 *
 * No runtime helper/asset needed, unlike `rewriteComparisons`/`rewriteSafeNots` — this is a pure
 * syntactic transform (Roku's own `?.`/`?[`/`?(` operators, OS 11.0+; the generated-output validator
 * already supports them).
 *
 * Idempotent: text already containing `?.`/`?[`/`?(` never re-matches `BsDotExpression`/
 * `BsCallExpression`/`BsIndexExpression` on a later pass, so re-running this over already-chained text
 * (e.g. a nested router/taskManager action argument, independently rewritten through the full pipeline
 * before the outer call assembles around it) is safe.
 */
export function rewriteOptionalChains(text: string, mode: 'expression' | 'statement'): string {
  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) return text; // surfaced as expression/parse-error elsewhere

  const accesses: ChainAccess[] = findChainAccesses(parsed, text);
  if (accesses.length === 0) return text;

  const replacements = accesses.map((a) => ({ start: a.operatorStart, end: a.operatorStart, replacement: '?' }));
  return applySplices(text, replacements);
}

/**
 * `rewriteExpression`'s full pipeline MINUS the final optional-chain pass. Exported so
 * `key-bindings.ts`'s `rewriteKeyHandlerCall` can use it for a callee's own text — that callee forms
 * the spine of a void-context call assembled OUTSIDE this module (the `on:key` trampoline always
 * discards the call's result) and must stay excluded from chain-optionalization the same way an
 * AST-detected bare void-call statement already is inside `rewriteOptionalChains` — but because the
 * reassembly happens after this function returns, `findChainAccesses`'s own detection can never see it
 * as part of a real statement.
 *
 * Just as important: EVERY internal pass in this module that recurses into a SUB-SPAN of the text
 * it's currently rewriting (`validateAndRewriteGlobalPaths`'s default `rewriteArg`,
 * `rewriteStreamSubscribeBoundReferences`'s target, `rewriteAnimationOnFinishCalls`'s callback,
 * `rewriteTimerClearCalls`'s handle, `rewriteComparisons`'s/`rewriteSafeNots`'s operands) MUST call
 * this function, never the public `rewriteExpression` — if any of them called the public version,
 * their own sub-fragment would get chain-optionalized immediately, before being spliced back into the
 * text a LATER sibling pass in the SAME outer call still has to parse (e.g. `rewriteSafeNots` running
 * after `rewriteComparisons`, over text `rewriteComparisons` already spliced `?`-containing operands
 * into). That later pass's own recursive call would then see literal `?` characters in what looks
 * like fresh input and — since `checkNoHandWrittenOptionalChaining` runs at the top of THIS function
 * — wrongly reject them as hand-written DSL source, when they were actually inserted by an earlier
 * step of the very same compile. Deferring every `?`-insertion to the single, truly outermost
 * `rewriteExpression`/`rewriteStatement` call (via this function) is what keeps that guard sound.
 */
export function rewriteExpressionWithoutChainOptionalization(
  expressionText: string,
  bindings: ScriptBindings,
  contextLabel: string,
  functionScope: FunctionScope = NO_FUNCTION_SCOPE,
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
): string {
  checkNoTimerStartCallInExpression(expressionText, contextLabel);
  checkNoHandWrittenOptionalChaining(expressionText, 'expression', contextLabel);
  const animationControlRewritten = rewriteAnimationControlCalls(expressionText, 'expression', bindings, contextLabel);
  const animationOnFinishRewritten = rewriteAnimationOnFinishCalls(animationControlRewritten, 'expression', bindings, functionScope, globalBindings, contextLabel);
  const timerClearRewritten = rewriteTimerClearCalls(animationOnFinishRewritten, 'expression', bindings, functionScope, globalBindings, contextLabel);
  const streamSubscribeRewritten = rewriteStreamSubscribeBoundReferences(timerClearRewritten, 'expression', bindings, functionScope, globalBindings, contextLabel);
  const comparisonsRewritten = rewriteComparisons(streamSubscribeRewritten, 'expression', bindings, functionScope, globalBindings, contextLabel);
  const safeNotsRewritten = rewriteSafeNots(comparisonsRewritten, 'expression', bindings, functionScope, globalBindings, contextLabel);
  const globalRewritten = validateAndRewriteGlobalPaths(safeNotsRewritten, 'expression', bindings, functionScope, globalBindings, contextLabel);
  const { identifiers } = parseExpression(globalRewritten, contextLabel);
  return applyIdentifierRewrite(globalRewritten, identifiers, bindings, functionScope, contextLabel, globalBindings);
}

/**
 * Convenience wrapper combining `rewriteComparisons` +
 * `validateAndRewriteGlobalPaths` + `parseExpression` +
 * `applyIdentifierRewrite` + `rewriteOptionalChains` for a single DSL
 * expression (a `derived` RHS or a template `{expr}` binding — both single
 * expressions, so no `functionScope` is needed there; omit it or pass
 * `NO_FUNCTION_SCOPE` explicitly). A function-body `if` condition also goes
 * through this, passing its own function's real scope.
 */
export function rewriteExpression(
  expressionText: string,
  bindings: ScriptBindings,
  contextLabel: string,
  functionScope: FunctionScope = NO_FUNCTION_SCOPE,
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
): string {
  const rewritten = rewriteExpressionWithoutChainOptionalization(expressionText, bindings, contextLabel, functionScope, globalBindings);
  return rewriteOptionalChains(rewritten, 'expression');
}

/** Statement-text counterpart to `rewriteExpression`, for a function-body `StatementRegion`. */
export function rewriteStatement(
  statementText: string,
  bindings: ScriptBindings,
  contextLabel: string,
  functionScope: FunctionScope = NO_FUNCTION_SCOPE,
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
): string {
  checkNoHandWrittenOptionalChaining(statementText, 'statement', contextLabel);
  const animationControlRewritten = rewriteAnimationControlCalls(statementText, 'statement', bindings, contextLabel);
  const animationOnFinishRewritten = rewriteAnimationOnFinishCalls(animationControlRewritten, 'statement', bindings, functionScope, globalBindings, contextLabel);
  const timerClearRewritten = rewriteTimerClearCalls(animationOnFinishRewritten, 'statement', bindings, functionScope, globalBindings, contextLabel);
  const streamSubscribeRewritten = rewriteStreamSubscribeBoundReferences(timerClearRewritten, 'statement', bindings, functionScope, globalBindings, contextLabel);
  const comparisonsRewritten = rewriteComparisons(streamSubscribeRewritten, 'statement', bindings, functionScope, globalBindings, contextLabel);
  const safeNotsRewritten = rewriteSafeNots(comparisonsRewritten, 'statement', bindings, functionScope, globalBindings, contextLabel);
  const globalRewritten = validateAndRewriteGlobalPaths(safeNotsRewritten, 'statement', bindings, functionScope, globalBindings, contextLabel);
  const { identifiers } = parseStatements(globalRewritten, contextLabel);
  const identifiersRewritten = applyIdentifierRewrite(globalRewritten, identifiers, bindings, functionScope, contextLabel, globalBindings);
  return rewriteOptionalChains(identifiersRewritten, 'statement');
}
