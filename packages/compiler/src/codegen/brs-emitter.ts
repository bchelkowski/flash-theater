import {
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
  TernaryAssignmentStatement,
  AnonymousFunctionAssignmentStatement,
  ScaleLocalAssignmentStatement,
  ScaleStateAssignmentStatement,
  RawBrightScriptStatement,
} from 'flash-parser';
import { CompileError, FunctionDecl, ThrScriptAst, ThrTemplateAst, TemplateNode, TemplateEachBlock } from '../dsl-parser/dsl-ast.js';
import { DependencyGraph } from '../analysis/dependency-graph.js';
import { TemplateBindings } from './template-bindings.js';
import { rewriteExpression, rewriteStatement, rewriteStorePathRead, collectAnimationFieldRefreshLines } from '../analysis/identifier-rewrite.js';
import { FunctionScope, NO_FUNCTION_SCOPE, ScriptBindings, buildFunctionScope, extendTemplateScope, emitParamName, resolveIdentifier } from '../analysis/scope-resolution.js';
import { GlobalBindingsContext } from '../analysis/global-bindings.js';
import { BindTarget } from '../analysis/bind-targets.js';
import { GroupedKeyBindings, KeyBindingElement, rewriteKeyHandlerCall } from '../analysis/key-bindings.js';
import { ParsedRequestConfig } from '../analysis/request-config.js';
import { emitRequestInitLine, emitRequestGeneratedFunctions } from './request-emitter.js';
import {
  bindChangeHandlerName,
  externalFieldChangeHandlerName,
  fieldChangeHandlerName,
  privateFunctionName,
  eachReconcileSubName,
  mFieldAccess,
  FOCUSABLE_ATTRIBUTE_NAME,
  brsStringLiteral,
  brsTypeAnnotation,
  TASK_MANAGER_ALERT_TRAMPOLINE_SUB_NAME,
  taskManagerAlertCallbacksFieldAccess,
  TASK_MANAGER_RESULT_TRAMPOLINE_SUB_NAME,
  TASK_MANAGER_RESULT_ERROR_TRAMPOLINE_SUB_NAME,
  taskManagerResultCallbacksFieldAccess,
  TASK_MANAGER_REQUEST_SENT_TRAMPOLINE_SUB_NAME,
  TASK_MANAGER_RESPONSE_RECEIVED_TRAMPOLINE_SUB_NAME,
  taskManagerRequestSentCallbacksFieldAccess,
  taskManagerResponseReceivedCallbacksFieldAccess,
  animationNodeId,
  UNMOUNT_FUNCTION_NAME,
  TIMER_FIRE_TRAMPOLINE_SUB_NAME,
  timerCallbacksFieldAccess,
  routerOutletAnimFieldName,
} from './naming.js';
import { globalFieldRef, GLOBAL_FIELD_NAMES } from './global-fields.js';
import {
  SharedPrintContext,
  INDENT_UNIT,
  printBlockStatements,
  printForStatement,
  printForEachStatement,
  printWhileStatement,
  printTryStatement,
  printAnonymousFunctionAssignment,
  lowerAnonymousFunctionsInText,
  lowerTernaryRhs,
  printTernaryAssignment,
  printScaleLocalAssignment,
  printIfStatement,
  printGenericLeafStatement,
  printRawBrightScriptStatement,
  printRawBrightScriptText,
} from './statement-printer.js';
import { focusRegisterCall, emitDynamicFocusableAssignment, emitFieldAssignments } from './shared-emit.js';
import { FocusableElement } from '../analysis/focusable-elements.js';
import { ConditionalBlock, ConditionalBlockAnalysis, collectStaticallyPresentIds } from '../analysis/conditional-blocks.js';
import { ResolvedBlockTransition } from '../analysis/transitions.js';
import { ResolvedOutletTransition } from '../analysis/router-transitions.js';
import { ResolvedAnimateBinding } from '../analysis/animate-bindings.js';
import { ScaledInterpolatorRef, printArrayAttr } from './animation-emitter.js';
import {
  emitConditionalBlockCascadeCheck,
  emitConditionalBlockSubs,
  wrapWithNearestDestroyGuard,
  emitToggleTransitionCascadeLines,
  emitAnimationStateChangeHandler,
  emitAnimationStateChangeObserverInitLine,
} from './conditional-block-emitter.js';
import { EachBlockAnalysis, EMPTY_EACH_BLOCKS, emitEachBlockSubs, eachBlocksNeedingItemsDict } from './each-block-emitter.js';

const NO_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };
const EMPTY_CONDITIONAL_BLOCKS: ConditionalBlockAnalysis = {
  blocks: [],
  blockIdByNode: new Map(),
  syntheticParentIds: new Map(),
  nearestDestroyAncestorById: new Map(),
  nearestEachAncestorById: new Map(),
};

/**
 * Wraps `text` (an already-rewritten value expression) with the runtime `ft_scale(...)` helper,
 * passing the app's once-computed `m.global.ft_scaleFactor` (seeded at boot by
 * `emitFlashTheaterGlobalsBrs` — see `app-compiler.ts`) as the second argument. Used at every
 * `scale`-flagged declaration/statement's value-producing site — see
 * `runtime-assets/Scale/FlashTheaterScale.brs` for the runtime numeric/array dispatch.
 */
function wrapWithScale(text: string): string {
  return `ft_scale(${text}, ${globalFieldRef('scaleFactor')})`;
}

/** A `sourcesNeedingCascade`/`dependentsOfSource` key is a global composite one (`"store.count"`, `"theme.colors"`) iff it's rooted in one of these — plain field/state names never contain a dot. */
function isGlobalSourceKey(sourceName: string): boolean {
  return sourceName.startsWith('store.') || sourceName.startsWith('theme.');
}

function splitGlobalSourceKey(sourceName: string): { root: 'store' | 'theme'; fieldName: string } {
  const dotIndex = sourceName.indexOf('.');
  return { root: sourceName.slice(0, dotIndex) as 'store' | 'theme', fieldName: sourceName.slice(dotIndex + 1) };
}

/** Every transitioning block (toggle or destroy mode) with a non-null `ResolvedBlockTransition.outConfig`, grouped by the animation NAME that config resolves to — see `codegen/conditional-block-emitter.ts`'s `emitAnimationStateChangeHandler` doc comment for why this is name-keyed, not block-keyed (a generalization shared with `.onFinish()`'s own per-name registration, not a fix for an actual collision — see that doc comment for why one never occurs today). */
function groupExitConsumersByAnimationName(conditionalBlocks: ConditionalBlockAnalysis, blockTransitions: ReadonlyMap<string, ResolvedBlockTransition>): ReadonlyMap<string, readonly ConditionalBlock[]> {
  const byName = new Map<string, ConditionalBlock[]>();
  for (const block of conditionalBlocks.blocks) {
    const transition = blockTransitions.get(block.id);
    if (!transition?.outConfig) continue;
    const name = transition.outConfig.name;
    const consumers = byName.get(name);
    if (consumers) consumers.push(block);
    else byName.set(name, [block]);
  }
  return byName;
}

/** Every animation name needing a shared `state`-change handler/registration at all — the union of `groupExitConsumersByAnimationName`'s keys and every name with a `.onFinish()` registration. */
function allAnimationStateChangeNames(exitConsumersByName: ReadonlyMap<string, readonly ConditionalBlock[]>, animationOnFinishNames: ReadonlySet<string>): readonly string[] {
  return [...new Set([...exitConsumersByName.keys(), ...animationOnFinishNames])];
}

/**
 * Generates .brs: init() (node ref caching + state defaults + initial
 * values for derived and dynamic attributes + `ObserveFieldScoped`
 * registration for every referenced global `store`/`theme` field), one
 * on_<field>Change function per own field that needs a reaction, one
 * on_<root>_<field>Change function per referenced global field that needs
 * one, and private/public functions from the DSL (`private_`-prefix for
 * private, see GRAMMAR.md). Zero vdom/diffing, zero shared runtime — see
 * the plan (the 4MB package limit is knowingly deferred for now).
 */
export function emitBrs(
  script: ThrScriptAst,
  template: ThrTemplateAst | null,
  graph: DependencyGraph,
  bindings: TemplateBindings,
  scriptBindings: ScriptBindings,
  componentName: string,
  bindTargets: readonly BindTarget[] = [],
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
  conditionalBlocks: ConditionalBlockAnalysis = EMPTY_CONDITIONAL_BLOCKS,
  eachBlocks: EachBlockAnalysis = EMPTY_EACH_BLOCKS,
  keyBindings: readonly KeyBindingElement[] = [],
  focusableElements: readonly FocusableElement[] = [],
  componentKeyBindings: GroupedKeyBindings | null = null,
  usesFocusState = false,
  usesTaskManagerAlertCallback = false,
  usesTaskManagerResultCallback = false,
  usesTaskManagerRequestSentCallback = false,
  usesTaskManagerResponseReceivedCallback = false,
  requestConfig: ParsedRequestConfig | null = null,
  blockTransitions: ReadonlyMap<string, ResolvedBlockTransition> = new Map(),
  animateBindings: ReadonlyMap<string, ResolvedAnimateBinding> = new Map(),
  scaledInterpolatorRefs: readonly ScaledInterpolatorRef[] = [],
  usesTimer = false,
  animationOnFinishNames: ReadonlySet<string> = new Set(),
  outletTransitions: ReadonlyMap<string, ResolvedOutletTransition> = new Map(),
): string {
  const sections: string[] = [
    emitInitFunction(
      script,
      template,
      graph,
      bindings,
      scriptBindings,
      componentName,
      bindTargets,
      globalBindings,
      conditionalBlocks,
      eachBlocks,
      focusableElements,
      keyBindings,
      usesFocusState,
      usesTaskManagerAlertCallback,
      usesTaskManagerResultCallback,
      usesTaskManagerRequestSentCallback,
      usesTaskManagerResponseReceivedCallback,
      requestConfig,
      blockTransitions,
      animateBindings,
      scaledInterpolatorRefs,
      usesTimer,
      animationOnFinishNames,
      outletTransitions,
    ),
  ];

  // One trampoline sub per component that ever calls taskManager.onAlertChanged(...) — see
  // naming.ts's TASK_MANAGER_ALERT_TRAMPOLINE_SUB_NAME/taskManagerAlertCallbacksFieldAccess doc
  // comments. The array + the ONE ObserveFieldScoped registration this sub's name is passed to are
  // both set up in emitInitFunction, above, not here.
  if (usesTaskManagerAlertCallback) {
    sections.push(emitTaskManagerAlertTrampoline());
  }

  // Two trampoline subs per component that ever calls taskManager.onResult(...) — see naming.ts's
  // TASK_MANAGER_RESULT_TRAMPOLINE_SUB_NAME/taskManagerResultCallbacksFieldAccess doc comments.
  // Unlike onAlertChanged, the ObserveFieldScoped registration itself happens fresh at EVERY
  // onResult(...) call site (each on a different task node), not once in init() — only the shared
  // callbacks AA is initialized in emitInitFunction, above.
  if (usesTaskManagerResultCallback) {
    sections.push(...emitTaskManagerResultTrampolines());
  }

  // One trampoline sub per component that ever calls taskManager.onRequestSent(...)/
  // onResponseReceived(...) — the global HTTP request/response interceptor hooks, shaped exactly
  // like onAlertChanged (see naming.ts's TASK_MANAGER_REQUEST_SENT_TRAMPOLINE_SUB_NAME/
  // taskManagerRequestSentCallbacksFieldAccess doc comments). The array + the ONE
  // ObserveFieldScoped registration each sub's name is passed to are both set up in
  // emitInitFunction, above, not here.
  if (usesTaskManagerRequestSentCallback) {
    sections.push(emitTaskManagerRequestSentTrampoline());
  }
  if (usesTaskManagerResponseReceivedCallback) {
    sections.push(emitTaskManagerResponseReceivedTrampoline());
  }

  // One shared `on_timerFire` trampoline per component that ever calls setTimeout(...)/
  // setInterval(...) — see naming.ts's TIMER_FIRE_TRAMPOLINE_SUB_NAME/timerCallbacksFieldAccess doc
  // comments. The registry AA itself is initialized in emitInitFunction, above; each call site
  // registers its own ObserveFieldScoped("fire", ...) inline (codegen/statement-printer.ts's
  // lowerTimerStartCallsInText), not here.
  if (usesTimer) {
    sections.push(emitTimerFireTrampoline());
  }

  // The Task-thread work function `request Http {}`'s `functionName` (set in emitInitFunction,
  // above) points at — see codegen/request-emitter.ts.
  if (requestConfig) {
    sections.push(emitRequestGeneratedFunctions(script, requestConfig));
  }

  for (const sourceName of bindings.sourcesNeedingCascade) {
    if (isGlobalSourceKey(sourceName)) {
      sections.push(emitExternalFieldChangeHandler(sourceName, script, graph, bindings, scriptBindings, componentName, globalBindings, conditionalBlocks, blockTransitions, animateBindings));
      continue;
    }
    // A `state`'s cascade is inlined at its own `state x = expr` assignment site (see printStateAssignment)
    // — there's no SceneGraph field observer to hook a private `state` member into, unlike a real `field`.
    if (!scriptBindings.fieldNames.has(sourceName)) continue;
    sections.push(emitFieldChangeHandler(sourceName, script, graph, bindings, scriptBindings, componentName, globalBindings, conditionalBlocks, blockTransitions, animateBindings));
  }

  // One handler sub per bind: target, regardless of whether it's registered in init() (statically
  // present) or inside a {#if:destroy} create sub (see conditional-block-emitter.ts's
  // emitSubtreeConstruction) — only the registration site differs, not the handler body itself.
  for (const target of bindTargets) {
    sections.push(emitBindChangeHandler(target, script, graph, bindings, scriptBindings, componentName, globalBindings, conditionalBlocks, blockTransitions, animateBindings));
  }

  sections.push(...emitConditionalBlockSubs(conditionalBlocks, eachBlocks, scriptBindings, componentName, globalBindings, eachBlocksNeedingItemsDict(keyBindings), blockTransitions));
  sections.push(...emitEachBlockSubs(eachBlocks, conditionalBlocks, scriptBindings, componentName, globalBindings, keyBindings));

  // One `ObserveFieldScoped("state", ...)` handler per ANIMATION NAME (not per block — see
  // conditional-block-emitter.ts's emitAnimationStateChangeHandler for why) with an exit-transition
  // consumer and/or an `.onFinish()` registration. The registration call itself is emitted once in
  // emitInitFunction, below.
  {
    const exitConsumersByName = groupExitConsumersByAnimationName(conditionalBlocks, blockTransitions);
    for (const name of allAnimationStateChangeNames(exitConsumersByName, animationOnFinishNames)) {
      sections.push(emitAnimationStateChangeHandler(name, exitConsumersByName.get(name) ?? [], animationOnFinishNames.has(name), componentName, scriptBindings, globalBindings));
    }
  }

  const onKeyEvent = emitOnKeyEventFunction(template, keyBindings, focusableElements, eachBlocks, scriptBindings, globalBindings, componentKeyBindings);
  if (onKeyEvent) sections.push(onKeyEvent);

  // Component-wide, NOT per-function (unlike ternaryCounter/anonFunctionCounter) — a setTimeout/
  // setInterval temp name doubles as the created Timer node's own `.id`, the key into this
  // component's shared timerCallbacksFieldAccess() registry; two different functions independently
  // minting `ft_timer_1` would silently clobber each other's registry entry if both timers were
  // alive concurrently. See naming.ts's nextTimerTempName doc comment.
  const timerCounter = { value: 0 };
  for (const fn of script.functions) {
    sections.push(emitFunction(fn, script, scriptBindings, graph, bindings, globalBindings, conditionalBlocks, componentName, blockTransitions, animateBindings, timerCounter));
  }

  // Unconditional on every component — see naming.ts's UNMOUNT_FUNCTION_NAME doc comment for why
  // leaf-gating this would be unsound rather than merely leaner.
  sections.push(emitUnmountFunction(collectUnmountCascadeIds(template, conditionalBlocks, eachBlocks), usesTimer));

  return sections.join('\n\n') + '\n';
}

/**
 * The `ObserveFieldScoped` target for `taskManager.onAlertChanged(<callback>)` — reads every
 * callback stashed on `m` by `identifier-rewrite.ts`'s `buildTaskManagerOnAlertChangedReplacement`
 * (one `.Push(...)` per `onAlertChanged(...)` call site this component has) and calls each one with
 * the new alert level (`event.GetData()`, a plain string — "none"/"warning"/"critical"). No
 * `invalid`/empty guard needed: `emitInitFunction`'s own `usesTaskManagerAlertCallback` branch
 * always initializes the array (and registers this very observer) synchronously, strictly before
 * this sub could ever be invoked — a component only gets this sub emitted at all when it calls
 * `onAlertChanged(...)` at least once, so the array is never left empty by the time anything reads
 * it in practice, but iterating a genuinely empty array is harmless either way.
 */
function emitTaskManagerAlertTrampoline(): string {
  return [
    `sub ${TASK_MANAGER_ALERT_TRAMPOLINE_SUB_NAME}(event as object)`,
    '  level = event.GetData()',
    `  for each cb in ${taskManagerAlertCallbacksFieldAccess()}`,
    '    cb(level)',
    '  end for',
    'end sub',
  ].join('\n');
}

/**
 * The two `ObserveFieldScoped` targets `taskManager.onResult(<task>, <onSuccess>, [<onError>])`
 * registers per call site (`identifier-rewrite.ts`'s `buildTaskManagerOnResultReplacement`) — one
 * for `result`, one for `error`. Fire-once "settle": looks up the pending callback pair for the
 * node that just wrote the field (`event.GetRoSGNode().id`, the same key the call site stored
 * under), deletes it and unobserves BOTH fields BEFORE invoking anything (so a callback that
 * somehow re-triggers registration doesn't see a stale pending entry), then calls whichever of
 * `onSuccess`/`onError` matches. A node with no pending entry (already settled, or never actually
 * registered — e.g. this component observing a task some OTHER component created) is a silent
 * no-op, not an error.
 *
 * **Extracts the callback into a local (`cb = entry.onSuccess`) before calling it — never
 * `entry.onSuccess(...)` directly.** Confirmed live (not assumed) that calling a Function value
 * stored as an AA member via dot-call syntax (`someAA.someKey(args)`) REBINDS `m`, inside the
 * called function, to `someAA` itself — not the function's own original closure `m` a plain local
 * variable call (`cb = someAA.someKey : cb(args)`) preserves. The first version of this file called
 * `entry.onSuccess(event.GetData())` directly and crashed on a real device the moment the callback
 * tried to read/write anything on `m` (`"Interface not a member of BrightScript Component"` —
 * `m` inside the callback was the tiny `{onSuccess, onError}` entry AA, not the calling component's
 * real `m`). `onAlertChanged`'s own working trampoline (`for each cb in <array> : cb(level)`)
 * already only ever calls a plain local this same way — never `<array>[i](level)` — which is
 * exactly why that path never hit this. See `findings/task-manager-onresult.md`.
 */
function emitTaskManagerResultTrampolines(): string[] {
  const callbacks = taskManagerResultCallbacksFieldAccess();
  return [
    [
      `sub ${TASK_MANAGER_RESULT_TRAMPOLINE_SUB_NAME}(event as object)`,
      '  node = event.GetRoSGNode()',
      `  entry = ${callbacks}[node.id]`,
      '  if entry <> invalid then',
      `    ${callbacks}.Delete(node.id)`,
      '    node.UnobserveFieldScoped("result")',
      '    node.UnobserveFieldScoped("error")',
      '    cb = entry.onSuccess',
      '    if cb <> invalid then cb(event.GetData())',
      '  end if',
      'end sub',
    ].join('\n'),
    [
      `sub ${TASK_MANAGER_RESULT_ERROR_TRAMPOLINE_SUB_NAME}(event as object)`,
      '  node = event.GetRoSGNode()',
      `  entry = ${callbacks}[node.id]`,
      '  if entry <> invalid then',
      `    ${callbacks}.Delete(node.id)`,
      '    node.UnobserveFieldScoped("result")',
      '    node.UnobserveFieldScoped("error")',
      '    cb = entry.onError',
      '    if cb <> invalid then cb(event.GetData())',
      '  end if',
      'end sub',
    ].join('\n'),
  ];
}

/**
 * The `ObserveFieldScoped` target for `taskManager.onRequestSent(<callback>)` — the global HTTP
 * request interceptor hook (see GRAMMAR.md's "Task manager" section). Shaped exactly like
 * `emitTaskManagerAlertTrampoline`, not `emitTaskManagerResultTrampolines`: reads every callback
 * stashed on `m` by `identifier-rewrite.ts`'s `buildTaskManagerOnRequestSentReplacement` and calls
 * each one with the resolved request options (`event.GetData()`, the `resolvedOptions` AA
 * `FlashTheaterTaskManager.brs`'s `startNode()` wrote to `lastRequestSent`). No `invalid`/empty
 * guard needed for the same reason `onAlertChanged`'s own trampoline doesn't: `emitInitFunction`'s
 * `usesTaskManagerRequestSentCallback` branch always initializes the array (and registers this
 * observer) before this sub could ever be invoked.
 */
function emitTaskManagerRequestSentTrampoline(): string {
  return [
    `sub ${TASK_MANAGER_REQUEST_SENT_TRAMPOLINE_SUB_NAME}(event as object)`,
    '  request = event.GetData()',
    `  for each cb in ${taskManagerRequestSentCallbacksFieldAccess()}`,
    '    cb(request)',
    '  end for',
    'end sub',
  ].join('\n');
}

/** See `emitTaskManagerRequestSentTrampoline`'s own doc comment — identical shape, the response-side hook (`lastResponseReceived`, the raw `ft_httpFetch` response — see `codegen/request-emitter.ts`'s `emitRequestGeneratedFunctions`). */
function emitTaskManagerResponseReceivedTrampoline(): string {
  return [
    `sub ${TASK_MANAGER_RESPONSE_RECEIVED_TRAMPOLINE_SUB_NAME}(event as object)`,
    '  response = event.GetData()',
    `  for each cb in ${taskManagerResponseReceivedCallbacksFieldAccess()}`,
    '    cb(response)',
    '  end for',
    'end sub',
  ].join('\n');
}

/**
 * Every id this component could ever have cached on `m` — the reachable surface for
 * `UNMOUNT_FUNCTION_NAME`'s own generated cascade (see that name's doc comment in `naming.ts` for why
 * this must be unconditional/self-propagating rather than gated). Unions `collectStaticallyPresentIds`
 * (statically-present ids, already `findNode`-cached in `init()`) with every destroy-mode block's own
 * `.id` + `.nestedIds` (covers anything only conditionally live) — both already-computed,
 * single-component-local facts, no new cross-file analysis needed. A headless component (`template
 * === null`, e.g. a plain `<store>`) has nothing to cascade to.
 */
function collectUnmountCascadeIds(template: ThrTemplateAst | null, conditionalBlocks: ConditionalBlockAnalysis, eachBlocks: EachBlockAnalysis): string[] {
  if (!template) return [];
  const staticIds = collectStaticallyPresentIds(template.root, conditionalBlocks, eachBlocks);
  const destroyModeIds = conditionalBlocks.blocks.filter((b) => b.mode === 'destroy').flatMap((b) => [b.id, ...b.nestedIds]);
  return Array.from(new Set([...staticIds, ...destroyModeIds]));
}

/**
 * The compiler-manufactured "this component is about to be removed" hook, emitted UNCONDITIONALLY on
 * every compiled component (see `naming.ts`'s `UNMOUNT_FUNCTION_NAME` doc comment for why leaf-gating
 * this the way every other trampoline in this file IS gated would be unsound, not just leaner) —
 * called by `FlashTheaterRouterOutlet`'s `_teardownCurrentChild()` on the outgoing screen, and by
 * `{#if:destroy}`'s own generated destroy sub (`conditional-block-emitter.ts`'s
 * `emitConditionalDestroySub`) on every nested id it's about to null. For a leaf component with no
 * local cleanup need and no nested-component ids to cascade to, this is just an empty
 * `sub ft_unmount()\nend sub` — cheap, harmless, always valid.
 *
 * `usesTimer` forces every still-pending `setTimeout`/`setInterval` timer to stop before the registry
 * is cleared — this is what actually closes the "does a running timer keep firing after its owning
 * component is destroyed" gap: without it, an unmounted component's Timer nodes would otherwise only
 * stop once nothing references them anymore (ordinary BrightScript refcounting), a weaker, unverified
 * guarantee for a still-running SceneGraph node (see findings/component-unmount-hook.md).
 */
function emitUnmountFunction(cascadeIds: readonly string[], usesTimer: boolean): string {
  const lines = [`sub ${UNMOUNT_FUNCTION_NAME}()`];
  if (usesTimer) {
    const callbacks = timerCallbacksFieldAccess();
    lines.push(`  for each ft_key in ${callbacks}`);
    lines.push(`    ft_entry = ${callbacks}[ft_key]`);
    lines.push('    if ft_entry.node <> invalid then ft_entry.node.control = "stop"');
    lines.push('  end for');
    lines.push(`  ${callbacks} = {}`);
  }
  for (const id of cascadeIds) {
    const ref = mFieldAccess(id);
    lines.push(`  if ${ref} <> invalid then ${ref}.callFunc("${UNMOUNT_FUNCTION_NAME}")`);
  }
  lines.push('end sub');
  return lines.join('\n');
}

/**
 * The `ObserveFieldScoped("fire", ...)` trampoline backing BOTH `setTimeout`/`setInterval` — see
 * `naming.ts`'s `TIMER_FIRE_TRAMPOLINE_SUB_NAME`/`timerCallbacksFieldAccess` doc comments. Looks up
 * the pending entry for the node that just fired (`event.GetRoSGNode().id`, the same key
 * `codegen/statement-printer.ts`'s `lowerTimerStartCallsInText` registered it under); a one-shot entry
 * (`repeat = false`) is deleted BEFORE invoking its callback — same "settle" discipline as
 * `emitTaskManagerResultTrampolines` (closes the stale-event-after-`clearTimeout` race: by the time a
 * `fire` event already in flight at the moment of cancellation actually reaches here, `clearTimeout`
 * has already deleted the entry, so this is a silent no-op). A `setInterval` entry stays registered
 * (repeat = true), so its callback runs again on every subsequent fire.
 *
 * **Extracts the callback into a local (`cb = entry.callback`) before calling it — never
 * `entry.callback(...)` directly.** Same live-confirmed reason as `emitTaskManagerResultTrampolines`'s
 * own doc comment: calling a Function value stored as an AA member via dot-call syntax rebinds `m`,
 * inside the called function, to the AA itself. A `setInterval` callback is invoked with ZERO
 * arguments (`cb()`), not the raw SceneGraph event — new sugar, not a re-export of the hand-wired
 * escape hatch's `onLoadTimerFire(event)` convention.
 */
function emitTimerFireTrampoline(): string {
  const callbacks = timerCallbacksFieldAccess();
  return [
    `sub ${TIMER_FIRE_TRAMPOLINE_SUB_NAME}(event as object)`,
    '  node = event.GetRoSGNode()',
    `  entry = ${callbacks}[node.id]`,
    '  if entry <> invalid then',
    '    if entry.repeat = false then',
    `      ${callbacks}.Delete(node.id)`,
    '    end if',
    '    cb = entry.callback',
    '    if cb <> invalid then cb()',
    '  end if',
    'end sub',
  ].join('\n');
}

function emitInitFunction(
  script: ThrScriptAst,
  template: ThrTemplateAst | null,
  graph: DependencyGraph,
  bindings: TemplateBindings,
  scriptBindings: ScriptBindings,
  componentName: string,
  bindTargets: readonly BindTarget[],
  globalBindings: GlobalBindingsContext,
  conditionalBlocks: ConditionalBlockAnalysis,
  eachBlocks: EachBlockAnalysis,
  focusableElements: readonly FocusableElement[],
  keyBindings: readonly KeyBindingElement[],
  usesFocusState: boolean,
  usesTaskManagerAlertCallback: boolean,
  usesTaskManagerResultCallback: boolean,
  usesTaskManagerRequestSentCallback: boolean,
  usesTaskManagerResponseReceivedCallback: boolean,
  requestConfig: ParsedRequestConfig | null = null,
  blockTransitions: ReadonlyMap<string, ResolvedBlockTransition> = new Map(),
  animateBindings: ReadonlyMap<string, ResolvedAnimateBinding> = new Map(),
  scaledInterpolatorRefs: readonly ScaledInterpolatorRef[] = [],
  usesTimer = false,
  animationOnFinishNames: ReadonlySet<string> = new Set(),
  outletTransitions: ReadonlyMap<string, ResolvedOutletTransition> = new Map(),
): string {
  const lines = ['sub init()'];

  // `request Http {}` wires this Task's functionName to the generated ft_runRequest() work
  // function — see codegen/request-emitter.ts. Placed first: SlowTask.thr's own hand-written
  // convention sets functionName before anything else touches the node too.
  const requestInitLine = emitRequestInitLine(requestConfig);
  if (requestInitLine) lines.push(requestInitLine);

  // A headless `<store>` has no template — nothing to findNode() at all. Anything living inside a
  // `{#if:destroy}` subtree is deliberately excluded here — it doesn't exist until its own
  // generated create sub runs (see the conditional-block cascade checks below), so findNode()
  // would just fail to resolve it.
  for (const id of template ? collectStaticallyPresentIds(template.root, conditionalBlocks, eachBlocks) : []) {
    lines.push(`  ${mFieldAccess(id)} = m.top.findNode("${id}")`);
  }

  // Every top-level {#each} block's own _keys/_nodes/_items dicts, initialized here — deliberately
  // BEFORE any field default gets written below (in particular the `array`/`assocarray` field
  // literal-default writes a few dozen lines down), not just before this each block's own explicit
  // reconcile() call later in this function. A `field`'s `onChange` handler (SceneGraph's own
  // declarative `<field onChange="...">` wiring — see xml-emitter.ts) fires SYNCHRONOUSLY the
  // moment that field is written, and an `{#each}` bound directly to a `field: array`/
  // `field: assocarray`'s own collection reacts to exactly that write — its reconcile sub runs
  // immediately, reading `m.<id>_keys`/`m.<id>_nodes` unconditionally in its remove-stale pass.
  // Live-device-caught: `apps/reactive-state-demo`'s `ArrayAndAssocArrayDemo.thr` crashed with
  // `'Dot' Operator attempted with invalid BrightScript Component or interface reference` the
  // instant `m.top.tags = [...]` (the array field's own literal-default write, later in this
  // function) synchronously triggered its `onChange` handler before this dict existed at all — see
  // findings/template-each-blocks.md for the full writeup. An each nested inside a {#if:destroy}
  // subtree is excluded here for the same reason ordinary bindings are excluded elsewhere in this
  // function — it doesn't exist yet; its own create sub initializes its dicts when constructed.
  for (const block of eachBlocks.blocks) {
    if (eachBlocks.nearestDestroyAncestorById.has(block.id)) continue;

    if (eachBlocks.nearestEachAncestorById.has(block.id)) {
      // Nested inside another each: chain-keyed by every enclosing item's own key (see
      // each-block-emitter.ts's class doc comment) — the first item that ever needs an entry
      // indexes straight into these without a "does the outer dict itself exist" check.
      lines.push(`  ${mFieldAccess(block.id, '_keys')} = {}`, `  ${mFieldAccess(block.id, '_nodes')} = {}`);
      continue;
    }

    const itemsInit = eachBlocksNeedingItemsDict(keyBindings).has(block.id) ? [`  ${mFieldAccess(block.id, '_items')} = {}`] : [];
    lines.push(`  ${mFieldAccess(block.id, '_keys')} = []`, `  ${mFieldAccess(block.id, '_nodes')} = {}`, ...itemsInit);
  }

  // Every `animation {}` declaration's own generated node, plus every resolved block transition's
  // synthesized in/out node — all of these are emitted as static XML siblings of the template root
  // (`xml-emitter.ts`'s `extraChildrenXml`, via `codegen/animation-emitter.ts`), unconditionally
  // present regardless of whether the target element they act on is itself statically present or
  // lives inside a `{#if:destroy}` subtree (an Animation node's `fieldToInterp` is a lazily-resolved
  // string, only actually looked up when `.control = "start"` runs — by which point, for a
  // destroy-mode transition, the target has already been constructed). Cached here exactly like any
  // other statically-present id — omitted, this would leave every `m["$$ft_anim_<name>"]` reference
  // permanently `invalid`.
  for (const a of script.animations) {
    lines.push(`  ${mFieldAccess(animationNodeId(a.name))} = m.top.findNode("${animationNodeId(a.name)}")`);
  }
  // A Layer 1 `animation {}` declaration whose own target lives inside a `{#if:destroy}` block gets
  // the SAME refresh-ref treatment a block's Layer 2 in:/out: transition does (see
  // `scriptBindings.animationFieldRefreshByName`'s own doc comment and `identifier-rewrite.ts`'s
  // `rewriteAnimationControlCalls`, which reads this exact map to emit the reset lines at every
  // `.start()` call site) — cached once here, same "the interpolator NODE never gets
  // destroyed/recreated, only its TARGET does" reasoning the blockTransitions loop below uses.
  for (const refs of scriptBindings.animationFieldRefreshByName.values()) {
    for (const ref of refs) {
      lines.push(`  ${mFieldAccess(ref.id)} = m.top.findNode("${ref.id}")`);
    }
  }
  for (const transition of blockTransitions.values()) {
    for (const config of [transition.inConfig, transition.outConfig]) {
      if (config) lines.push(`  ${mFieldAccess(animationNodeId(config.name))} = m.top.findNode("${animationNodeId(config.name)}")`);
    }
    // A `{#if:destroy}` block's own `in:`/`out:` interpolators (only ever non-empty when
    // `isDestroyMode` — see `ResolvedBlockTransition`'s own doc comment) get the SAME treatment,
    // cached once here even though `conditional-block-emitter.ts` reads them on every create/hide
    // cycle, not just once — the interpolator NODE itself (unlike its `fieldToInterp` TARGET) is
    // never destroyed/recreated, so one findNode() in init() is enough for its whole lifetime.
    for (const ref of [...transition.inRefreshRefs, ...transition.outRefreshRefs]) {
      lines.push(`  ${mFieldAccess(ref.id)} = m.top.findNode("${ref.id}")`);
    }
  }
  // A `<FlashTheaterRouterOutlet>`'s own `navigate-out:`/`navigate-in:`/`back-out:`/`back-in:`
  // transitions — same "cache the animation node once in init()" treatment as blockTransitions
  // above, but never destroy-mode (the outlet itself is never destroyed/recreated by this feature —
  // see analysis/router-transitions.ts's own doc comment), so no refresh-ref caching is needed.
  // After caching, each resolved animation node reference is handed to the OUTLET's own field
  // (`ft_navigateOutAnim`/... — see naming.ts's `routerOutletAnimFieldName`), the one genuinely new
  // codegen shape this feature needs: wiring a synthesized node reference onto a field on a CHILD
  // component instance, not just consuming it inside this same generated .brs. The outlet's own id
  // is assumed statically present (cached by the `collectStaticallyPresentIds` loop above) — an
  // outlet nested inside a `{#if:destroy}` block isn't handled by this feature (see GRAMMAR.md's
  // "Router" section, Known limitations).
  for (const [outletId, t] of outletTransitions) {
    for (const config of [t.navigateOut, t.navigateIn, t.backOut, t.backIn]) {
      if (config) lines.push(`  ${mFieldAccess(animationNodeId(config.name))} = m.top.findNode("${animationNodeId(config.name)}")`);
    }
    const wiring: readonly [typeof t.navigateOut, 'navigate' | 'back', 'in' | 'out'][] = [
      [t.navigateOut, 'navigate', 'out'],
      [t.navigateIn, 'navigate', 'in'],
      [t.backOut, 'back', 'out'],
      [t.backIn, 'back', 'in'],
    ];
    for (const [config, navDirection, phase] of wiring) {
      if (!config) continue;
      lines.push(`  ${mFieldAccess(outletId)}.${routerOutletAnimFieldName(navDirection, phase)} = ${mFieldAccess(animationNodeId(config.name))}`);
    }
  }
  // Same caching, for every animate:<field>'s own synthesized per-site animation node.
  for (const binding of animateBindings.values()) {
    lines.push(`  ${mFieldAccess(animationNodeId(binding.config.name))} = m.top.findNode("${animationNodeId(binding.config.name)}")`);
  }

  // Every `scaled: true` interpolator (see analysis/animation-config.ts) gets its own runtime
  // `keyValue` here, overwriting the unscaled literal `animation-emitter.ts` printed into the XML —
  // exactly the same "XML can't call a function, so init() overrides the raw default" pattern
  // `scale field`'s own defaults already use. `printArrayAttr`'s bracket-syntax output (`[x, y]`/
  // `10`) is valid BrightScript array-literal source text as-is, so each keyValue entry is wrapped
  // in one `wrapWithScale(...)` call and the whole array reprinted — `ft_scale` on a `[x, y]` pair
  // scales x and y element-wise (one level deep, matching FlashTheaterScale.brs's own contract), so
  // no per-component (x vs y) unwrapping is needed here.
  for (const ref of scaledInterpolatorRefs) {
    const items = ref.keyValue.kind === 'array' ? ref.keyValue.items : [ref.keyValue];
    const scaledItems = items.map((item) => wrapWithScale(printArrayAttr(item)));
    lines.push(`  m.top.findNode("${ref.id}").keyValue = [${scaledItems.join(', ')}]`);
  }

  // `field` defaults come from the XML `value=` attribute (SceneGraph sets them, no .brs needed);
  // `state` has no XML entry at all, so its default is set here explicitly.
  for (const s of script.state) {
    lines.push(`  m.${s.name} = ${s.scale ? wrapWithScale(s.defaultLiteral) : s.defaultLiteral}`);
  }

  // `scale field` can't be scaled in the XML `value=` attribute (XML can't call a function) — the
  // raw, unscaled literal is what SceneGraph sets before init() runs; overwrite it here, exactly
  // once, before anything else reads it. `array`/`assocarray` fields need the same override
  // UNCONDITIONALLY (scaled or not) — XML has no representable literal for either type at all (see
  // xml-emitter.ts's `FIELD_TYPES_WITH_NO_XML_DEFAULT`), so there's no XML-set default to leave
  // alone the way an ordinary unscaled scalar field has.
  for (const f of script.fields) {
    if (!f.scale && f.type !== 'array' && f.type !== 'assocarray') continue;
    lines.push(`  m.top.${f.name} = ${f.scale ? wrapWithScale(f.defaultLiteral) : f.defaultLiteral}`);
  }

  // `stream` has no XML entry and no literal default — every declared stream gets a fresh
  // BehaviorSubject-like value here, exactly once, same timing as `state`'s own default. Positioned
  // before the `graph.order` derived-assignment loop below, since a `derived` could read
  // `someStream.value` at its own initial computation.
  for (const s of script.streams) {
    lines.push(`  m.${s.name} = ft_createStream()`);
  }

  // `read` is a one-time snapshot — assigned once here, exactly like a `state` default, and never
  // recomputed (it's deliberately not in `graph.order`/`watches`, see dependency-graph.ts).
  for (const r of script.reads) {
    const rewritten = rewriteStorePathRead(r.path);
    lines.push(`  m.${r.name} = ${r.scale ? wrapWithScale(rewritten) : rewritten}`);
  }

  for (const sourceName of bindings.sourcesNeedingCascade) {
    if (!isGlobalSourceKey(sourceName)) continue;
    const { root, fieldName } = splitGlobalSourceKey(sourceName);
    lines.push(`  ${globalFieldRef(root)}.observeFieldScoped("${fieldName}", "${externalFieldChangeHandlerName(root, fieldName)}")`);
  }

  // taskManager.onAlertChanged(...)'s own array + the ONE ObserveFieldScoped registration that
  // backs every call site this component has — set up here exactly once, mirroring the store/theme
  // cascade registration right above, regardless of how many separate onAlertChanged(...) calls
  // this component makes (each one only ever .Push()es onto the array — see
  // identifier-rewrite.ts's buildTaskManagerOnAlertChangedReplacement). This is what lets more than
  // one subscriber coexist in the same component without either silently losing an earlier
  // callback (a single overwritable slot would) or double-registering the observer (which would
  // make the trampoline fire once per registration instead of once per real change).
  if (usesTaskManagerAlertCallback) {
    lines.push(`  ${taskManagerAlertCallbacksFieldAccess()} = []`);
    lines.push(`  ${globalFieldRef('taskManager')}.ObserveFieldScoped("alertLevel", "${TASK_MANAGER_ALERT_TRAMPOLINE_SUB_NAME}")`);
  }

  // taskManager.onResult(...)'s own callbacks AA — initialized once here, exactly like
  // onAlertChanged's array above, so every onResult(...) call site (see
  // identifier-rewrite.ts's buildTaskManagerOnResultReplacement) can safely index into it without
  // an invalid-base runtime error. Unlike onAlertChanged, there is no ObserveFieldScoped
  // registration here — each onResult(...) call attaches its own, on the specific task node it's
  // for, at the call site itself.
  if (usesTaskManagerResultCallback) {
    lines.push(`  ${taskManagerResultCallbacksFieldAccess()} = {}`);
  }

  // taskManager.onRequestSent(...)/onResponseReceived(...)'s own callbacks arrays — the global HTTP
  // request/response interceptor hooks, initialized once here and registered with exactly ONE
  // ObserveFieldScoped each, mirroring onAlertChanged's array above (not onResult's per-call-site
  // registration): every subscriber gets every event, backed by an accumulating array, not a
  // per-task lookup. See naming.ts's taskManagerRequestSentCallbacksFieldAccess/
  // taskManagerResponseReceivedCallbacksFieldAccess doc comments and
  // runtime-assets/TaskManager/FlashTheaterTaskManager.brs's own `lastRequestSent`/
  // `lastResponseReceived` doc comment for why these are never hysteresis-gated the way `alertLevel`
  // is.
  if (usesTaskManagerRequestSentCallback) {
    lines.push(`  ${taskManagerRequestSentCallbacksFieldAccess()} = []`);
    lines.push(`  ${globalFieldRef('taskManager')}.ObserveFieldScoped("lastRequestSent", "${TASK_MANAGER_REQUEST_SENT_TRAMPOLINE_SUB_NAME}")`);
  }
  if (usesTaskManagerResponseReceivedCallback) {
    lines.push(`  ${taskManagerResponseReceivedCallbacksFieldAccess()} = []`);
    lines.push(`  ${globalFieldRef('taskManager')}.ObserveFieldScoped("lastResponseReceived", "${TASK_MANAGER_RESPONSE_RECEIVED_TRAMPOLINE_SUB_NAME}")`);
  }

  // setTimeout(...)/setInterval(...)'s own registry AA — initialized once here, exactly like
  // onResult's callbacks AA above, so every call site (codegen/statement-printer.ts's
  // lowerTimerStartCallsInText) can safely index into it. Unlike onResult, there is no
  // ObserveFieldScoped registration here — each call site attaches its own, on the Timer node it
  // just created, at the call site itself.
  if (usesTimer) {
    lines.push(`  ${timerCallbacksFieldAccess()} = {}`);
  }

  // A bind: target nested inside a {#if:destroy} subtree is registered inline at the point its
  // node is actually constructed instead (conditional-block-emitter.ts's emitSubtreeConstruction)
  // — it doesn't exist here yet, same reasoning as the findNode loop above.
  for (const target of bindTargets) {
    if (conditionalBlocks.nearestDestroyAncestorById.has(target.elementId)) continue;
    lines.push(`  ${mFieldAccess(target.elementId)}.ObserveFieldScoped("${target.fieldName}", "${bindChangeHandlerName(target.elementId, target.fieldName)}")`);
  }

  // A statically `focusable="true"` element registers once, unconditionally, here (or in a
  // {#if:destroy} subtree's own create sub — see conditional-block-emitter.ts) — it never
  // toggles. A *dynamic* focusable="{expr}" element registers reactively instead, via
  // emitBindingAssignment's special case, reached through the ordinary `bindings.all`/cascade
  // loops below (dynamic attributes, focusable included, are already collected there — nothing
  // extra needed for that case).
  for (const el of focusableElements) {
    if (!el.isStaticTrue) continue;
    if (conditionalBlocks.nearestDestroyAncestorById.has(el.elementId)) continue;
    // An element inside an {#each} body has no static m.<id> slot at all — it's never findNode()'d
    // here (see collectStaticallyPresentIds above); codegen/each-block-emitter.ts's
    // emitItemConstruct registers it per-item instead.
    if (eachBlocks.nearestEachAncestorById.has(el.elementId)) continue;
    lines.push(`  ${focusRegisterCall(mFieldAccess(el.elementId), el.isDefault)}`);
  }

  // Subscribes this component to isFocused/isInFocusChain updates — emitted ONLY when the .thr
  // actually reads one of those names (see analysis/focus-state.ts), so a component that never
  // mentions them carries no subscription and no runtime cost. The manager writes both fields on
  // every real focus move, recomputed for all subscribers from its single focused-node value.
  if (usesFocusState) {
    lines.push(`  ${globalFieldRef('focus')}.callFunc("registerFocusState", m.top)`);
  }

  for (const derivedName of graph.order) {
    lines.push(`  ${emitDerivedAssignment(derivedName, script, scriptBindings, globalBindings)}`);
  }

  // Excludes anything nested inside a `{#if:destroy}` subtree — same reasoning as the findNode
  // loop above, the target node doesn't exist yet; its own create sub sets these values instead.
  // `collectBindings` (template-bindings.ts) walks one element's attributes to completion before
  // moving to the next, so entries sharing `elementId` are already adjacent here — plain (non-
  // focusable) ones in a run are batched into one `setFields()` call instead of one dot-assignment
  // per attribute; a `focusable` entry keeps its own register/unregister shape and flushes whatever
  // plain run preceded it first, to keep relative statement order intuitive.
  {
    let i = 0;
    while (i < bindings.all.length) {
      const elementId = bindings.all[i].elementId;
      if (conditionalBlocks.nearestDestroyAncestorById.has(elementId)) {
        i++;
        continue;
      }
      const nodeRef = mFieldAccess(elementId);
      let plainFields: { name: string; value: string }[] = [];
      while (i < bindings.all.length && bindings.all[i].elementId === elementId) {
        const binding = bindings.all[i];
        if (binding.attributeName === FOCUSABLE_ATTRIBUTE_NAME) {
          for (const line of emitFieldAssignments(nodeRef, plainFields)) lines.push(`  ${line}`);
          plainFields = [];
          for (const line of emitBindingAssignment(binding.elementId, binding.attributeName, binding.expression, scriptBindings, globalBindings)) {
            lines.push(`  ${line}`);
          }
        } else {
          plainFields.push({ name: binding.attributeName, value: rewriteBindingExpression(binding.elementId, binding.attributeName, binding.expression, scriptBindings, globalBindings) });
        }
        i++;
      }
      for (const line of emitFieldAssignments(nodeRef, plainFields)) lines.push(`  ${line}`);
    }
  }

  // A `{#if:destroy}` block nested inside another one, or inside an `{#each}`'s body, is
  // constructed transitively by whatever encloses it (the ancestor's own create sub, or the
  // enclosing each's own per-item construction) — only a block with neither kind of ancestor
  // needs its own independent initial evaluation here.
  for (const block of conditionalBlocks.blocks) {
    if (block.mode !== 'destroy' || conditionalBlocks.nearestDestroyAncestorById.has(block.id)) continue;
    if (conditionalBlocks.nearestEachAncestorById.has(block.id)) continue;
    lines.push(...emitConditionalBlockCascadeCheck(block, scriptBindings, globalBindings, conditionalBlocks.nearestDestroyAncestorById, 1, componentName, blockTransitions.get(block.id) ?? null));
  }

  // One ObserveFieldScoped("state", ...) registration per ANIMATION NAME (not per block — see
  // conditional-block-emitter.ts's emitAnimationStateChangeObserverInitLine/
  // emitAnimationStateChangeHandler for why) with an exit-transition consumer and/or an `.onFinish()`
  // registration — exactly once, here, regardless of how many times a consuming block's own cascade
  // runs later.
  {
    const exitConsumersByName = groupExitConsumersByAnimationName(conditionalBlocks, blockTransitions);
    for (const name of allAnimationStateChangeNames(exitConsumersByName, animationOnFinishNames)) {
      lines.push(emitAnimationStateChangeObserverInitLine(name));
    }
  }

  // Populates each top-level {#each} block's initial rendered list — its wrapper Group starts
  // empty in the static XML (see codegen/xml-emitter.ts), so this is what actually fills it in
  // for the very first render. The _keys/_nodes/_items dicts themselves are already initialized
  // much earlier in this function (see the early each-block-state pass right after the findNode
  // loop above) — this pass only issues the actual reconcile() call, now that everything else
  // reconcile/item-construction could possibly touch (bindings, focus registration, derived
  // values) is set up. An each nested inside a {#if:destroy} subtree is excluded here for the same
  // reason ordinary bindings are excluded above — it doesn't exist yet (no wrapper, no state)
  // unless its ancestor's initial condition already holds, in which case the ancestor's own
  // initial cascade check (below) already constructed and reconciled it via
  // conditional-block-emitter.ts's emitSubtreeConstruction. A nested-inside-another-each block has
  // no top-level reconcile of its own either — its wrapper and items are constructed as part of
  // its enclosing each's own per-item construction instead (see codegen/each-block-emitter.ts).
  for (const block of eachBlocks.blocks) {
    if (eachBlocks.nearestDestroyAncestorById.has(block.id)) continue;
    if (eachBlocks.nearestEachAncestorById.has(block.id)) continue;
    lines.push(`  ${eachReconcileSubName(componentName, block.id)}()`);
  }

  // Top-level `' flash-theater:raw` ... `' flash-theater:end-raw` blocks (declaration-level, a
  // sibling of field/derived/function in <script>) — appended in source order, last, after every
  // other reactive/binding/focus setup above, so they run once everything else is already
  // initialized (the same "runs after setup" timing an onMounted-style hook would have). Never
  // identifier-rewritten, unlike everything else in this function — see GRAMMAR.md's "Raw
  // BrightScript passthrough" section.
  for (const rawBlock of script.rawBlocks) {
    lines.push(printRawBrightScriptText(rawBlock.text, 1));
  }

  lines.push('end sub');
  return lines.join('\n');
}

/**
 * Generated `function onKeyEvent(key as string, press as boolean) as boolean`
 * — the whole point of this generated function is to simulate, inside one
 * component's own template, the ancestor-chain bubbling Roku's real
 * `onKeyEvent` delivery only ever does automatically *across* custom
 * component boundaries (a nested `<ChildComponent>` gets its own,
 * independently generated `onKeyEvent` for free — nothing to simulate
 * there). Within *this* component's own template, every element is a
 * built-in node with no `onKeyEvent` of its own, so the simulation is a
 * static, compile-time-known, **deepest-first** (post-order) list of every
 * `on:key`-bearing element, each gated by a live `.IsInFocusChain()` check
 * — true for the actually-focused node *and* every one of its ancestors, so
 * checking deepest-first and returning `true` on the first match correctly
 * reproduces "bubble from the focused leaf up through my own on:key
 * ancestors, stop at the first handler." See GRAMMAR.md's "on:key event
 * binding" section and findings/focus-system.md for the full
 * bubbling-boundary design.
 *
 * `{#each}`-scoped `on:key` (an element inside a *top-level* `{#each}` item
 * body — `analysis/key-bindings.ts` rejects a nested-each case entirely,
 * `template/on-key-inside-nested-each`) has no static `id`/`m.<id>` slot at
 * all (the each may render any number of item copies), so it gets its own
 * dispatch shape instead, inserted into this same priority chain at the
 * each-block's own document position: iterate the block's `_nodes` dict,
 * `findNode` each on:key-bearing element within that item via the same
 * unique per-item id scheme `codegen/each-block-emitter.ts` already
 * establishes (`"<id>_" + <key>`), and check *that* node's own
 * `IsInFocusChain()`. The item's own raw value (needed for the handler
 * call's extra argument) is recovered from the block's `_items` companion
 * dict, assigned to a real local variable named after the block's own item
 * alias right before the dispatch — so `rewriteKeyHandlerCall`'s ordinary
 * "leave a local alone" resolution for that alias (via `extendTemplateScope`)
 * makes the generated call reference a genuinely valid BrightScript local,
 * no text-splicing needed.
 *
 * A component with at least one *focusable* element (non-each, own or
 * inherited registration aside) also gets the directional-nav fallthrough —
 * `up`/`down`/`left`/`right` delegated to `FlashTheaterFocusManager`'s
 * `navigate(key)`, which searches the whole app-wide registry (not just this
 * component's own elements) for the nearest focusable neighbor. This is
 * always safe to call once this component has any focusable element at all,
 * since that alone guarantees the app-wide focus system is wired up (see
 * `compile.ts`'s `usesFocusSystem`/`app-compiler.ts`'s tally, mirroring how
 * `usesStore` already works). On `press`, a successful `navigate()` also
 * arms hold-to-repeat via `startRepeat(key)` — Roku does not itself
 * auto-repeat `onKeyEvent` while a button stays held, it fires exactly once
 * per press and once per release, so continuous navigation while held is
 * `FlashTheaterFocusManager`'s own responsibility, not something this
 * fallthrough gets for free. The release (`not press`) branch always calls
 * `stopRepeat()` and returns `true`, whether or not a repeat was actually
 * running — see `findings/focus-system.md`.
 *
 * Returns `null` (no function emitted at all) when there's nothing for this
 * component's `onKeyEvent` to do — an unused generated function would just
 * be dead code.
 */
function emitOnKeyEventFunction(
  template: ThrTemplateAst | null,
  keyBindings: readonly KeyBindingElement[],
  focusableElements: readonly FocusableElement[],
  eachBlocks: EachBlockAnalysis,
  scriptBindings: ScriptBindings,
  globalBindings: GlobalBindingsContext,
  componentKeyBindings: GroupedKeyBindings | null,
): string | null {
  const nonEachBindings = keyBindings.filter((k) => !k.insideEach);
  const eachScopedBindings = keyBindings.filter((k) => k.insideEach);
  const hasFocusable = focusableElements.length > 0;
  // A Scene-rooted component always gets an onKeyEvent, even with zero on:key/focusable content
  // of its own — it's the one place the automatic back-key fallthrough below can go (Roku bubbles
  // every unhandled key up to the Scene regardless of where focus sits, so one copy suffices; see
  // that fallthrough's own comment). Whether the app actually uses the router at all is runtime-
  // guarded (`m.global.hasField("ft_router")`), not known here at per-component codegen time, so
  // this emits unconditionally for a Scene root — a router-less app just gets a function that
  // always falls through to `return false`, harmless dead code, not a real difference.
  const isSceneRoot = template?.extends === 'Scene';
  if (!template || (nonEachBindings.length === 0 && eachScopedBindings.length === 0 && !hasFocusable && !componentKeyBindings && !isSceneRoot)) return null;

  const byElementId = new Map(nonEachBindings.map((k) => [k.elementId, k]));
  const eachScopedByBlockId = new Map<string, KeyBindingElement[]>();
  for (const k of eachScopedBindings) {
    const list = eachScopedByBlockId.get(k.nearestEachAncestorId!) ?? [];
    list.push(k);
    eachScopedByBlockId.set(k.nearestEachAncestorId!, list);
  }
  const eachBlockById = new Map(eachBlocks.blocks.map((b) => [b.id, b]));

  const order = collectOnKeyEmissionOrder(template.root, new Set(byElementId.keys()), eachBlocks.blockIdByNode, new Set(eachScopedByBlockId.keys()));

  const lines = ['function onKeyEvent(key as string, press as boolean) as boolean'];
  for (const entry of order) {
    if (entry.kind === 'element') {
      const grouped = byElementId.get(entry.id)!;
      const nodeRef = mFieldAccess(entry.id);
      lines.push(`  if ${nodeRef} <> invalid and ${nodeRef}.IsInFocusChain() then`);
      lines.push(...emitKeyDispatch(grouped, `"${entry.id}"`, scriptBindings, NO_FUNCTION_SCOPE, globalBindings, 2));
      lines.push('  end if');
      continue;
    }

    // entry.kind === 'each' — see this function's own doc comment for the per-item findNode/
    // IsInFocusChain()/_items-recovery mechanism.
    const block = eachBlockById.get(entry.id)!;
    const elementsInBlock = eachScopedByBlockId.get(entry.id)!;
    const nodesVar = mFieldAccess(entry.id, '_nodes');
    const itemsVar = mFieldAccess(entry.id, '_items');
    const itemScope = extendTemplateScope(block.itemAlias, NO_FUNCTION_SCOPE);

    lines.push(`  for each ft_focusKey in ${nodesVar}`);
    lines.push(`    ft_focusItem = ${nodesVar}[ft_focusKey]`);
    for (const grouped of elementsInBlock) {
      lines.push(`    ft_focusTarget = ft_focusItem.findNode(${brsStringLiteral(`${grouped.elementId}_`)} + ft_focusKey)`);
      lines.push(`    if ft_focusTarget <> invalid and ft_focusTarget.IsInFocusChain() then`);
      lines.push(`      ${block.itemAlias} = ${itemsVar}[ft_focusKey]`);
      lines.push(...emitKeyDispatch(grouped, `"${grouped.elementId}"`, scriptBindings, itemScope, globalBindings, 3));
      lines.push('    end if');
    }
    lines.push('  end for');
  }

  if (hasFocusable) {
    lines.push('  if key = "up" or key = "down" or key = "left" or key = "right" then');
    lines.push('    if press then');
    lines.push(`      if ${globalFieldRef('focus')}.callFunc("navigate", key) then`);
    lines.push(`        ${globalFieldRef('focus')}.callFunc("startRepeat", key)`);
    lines.push('        return true');
    lines.push('      end if');
    lines.push('    else');
    lines.push(`      ${globalFieldRef('focus')}.callFunc("stopRepeat")`);
    lines.push('      return true');
    lines.push('    end if');
    lines.push('  end if');
  }

  if (componentKeyBindings) {
    // Unconditional — no IsInFocusChain() guard, unlike every branch above. <component>'s own
    // on:key[...] isn't tied to any specific descendant's focus state; it IS this component
    // (m.top). Reached only once nothing more specific already matched and returned above,
    // mirroring real Roku bubbling: a component's own onKeyEvent only ever runs when nothing
    // deeper already consumed the event first.
    lines.push(...emitKeyDispatch(componentKeyBindings, '<component>', scriptBindings, NO_FUNCTION_SCOPE, globalBindings, 1));
  }

  if (isSceneRoot) {
    // Automatic "back always returns to the previous route" — reached only once nothing more
    // specific already matched and returned above, so an author's own explicit on:key[back]
    // handler (on any descendant, or on <component> itself) always wins/can preempt this, exactly
    // the same priority rule the LRUD fallthrough above already establishes for arrow keys.
    // Runtime-guarded (`hasField`) since a router-less app never wires `ft_router` into
    // `m.global` at all — see codegen/global-fields.ts. `back()` returns `false` when history is
    // empty; this deliberately does NOT `return true` in that case, so the key stays unconsumed
    // and reaches Roku's own default unhandled-"back"-at-the-Scene behavior, which exits the app —
    // see GRAMMAR.md's "Router" section.
    // The `applyPendingFocus` follow-up is the same shallow, sibling-statement call the compiler
    // emits after every author-written router.navigate(...)/router.back() — it must sit HERE, one
    // callFunc hop from this executing onKeyEvent, not inside the router/outlet runtime, because
    // Roku will not establish real key-event routing for a SetFocus() reached via 2+ nested
    // callFunc hops (confirmed live; see findings/focus-system.md and
    // runtime-assets/FocusManager's "Deferred focus application" section).
    lines.push('  if key = "back" and press then');
    lines.push(`    if m.global.hasField("${GLOBAL_FIELD_NAMES.router}") then`);
    lines.push(`      if ${globalFieldRef('router')}.callFunc("back") then`);
    lines.push(`        if m.global.hasField("${GLOBAL_FIELD_NAMES.focus}") then ${globalFieldRef('focus')}.callFunc("applyPendingFocus")`);
    lines.push('        return true');
    lines.push('      end if');
    lines.push('    end if');
    lines.push('  end if');
  }

  lines.push('  return false');
  lines.push('end function');
  return lines.join('\n');
}

/** Specific-then-wildcard dispatch body for one `on:key`-bearing owner (an element, an `{#each}` item, or `<component>` itself), at `depth` indent levels — shared by every `emitOnKeyEventFunction` case above (only `functionScope`, `ownerLabel`, and which node was already confirmed `IsInFocusChain()` — or, for `<component>`, no such check at all — differ between them). */
function emitKeyDispatch(
  grouped: GroupedKeyBindings,
  ownerLabel: string,
  scriptBindings: ScriptBindings,
  functionScope: FunctionScope,
  globalBindings: GlobalBindingsContext,
  depth: number,
): string[] {
  const indent = INDENT_UNIT.repeat(depth);
  const lines: string[] = [];

  for (const [keyName, expression] of grouped.specific) {
    const call = rewriteKeyHandlerCall(expression, scriptBindings, `on:key[${keyName}] on ${ownerLabel}`, functionScope, globalBindings);
    lines.push(`${indent}if key = ${brsStringLiteral(keyName)} then`);
    lines.push(`${indent}  ${call}`);
    lines.push(`${indent}  return true`);
    lines.push(`${indent}end if`);
  }

  if (grouped.wildcard !== null) {
    // Reached only when none of this element's own specific keys matched above — exactly
    // "any key not otherwise matched on this element", the wildcard's own documented semantics.
    const call = rewriteKeyHandlerCall(grouped.wildcard, scriptBindings, `on:key[*] on ${ownerLabel}`, functionScope, globalBindings);
    lines.push(`${indent}${call}`);
    lines.push(`${indent}return true`);
  }

  return lines;
}

type OnKeyEmissionEntry = { readonly kind: 'element'; readonly id: string } | { readonly kind: 'each'; readonly id: string };

/**
 * Post-order (children before self) walk producing one combined, correctly-
 * ordered sequence of every on:key-relevant position — a plain element
 * (filtered to `targetElementIds`) or a top-level `{#each}` block that has
 * on:key content of its own (filtered to `eachScopedBlockIds`) — see
 * `emitOnKeyEventFunction`'s own doc comment for why "deepest first" is
 * exactly what makes the generated `onKeyEvent`'s static priority chain
 * correct: any genuine ancestor/descendant relationship (including an
 * `{#each}` block containing, or contained by, an on:key-bearing element)
 * always has the descendant emitted first.
 */
function collectOnKeyEmissionOrder(
  node: TemplateNode,
  targetElementIds: ReadonlySet<string>,
  eachBlockIdByNode: ReadonlyMap<TemplateEachBlock, string>,
  eachScopedBlockIds: ReadonlySet<string>,
): OnKeyEmissionEntry[] {
  const out: OnKeyEmissionEntry[] = [];
  walk(node);
  return out;

  function walk(n: TemplateNode): void {
    for (const child of n.children) walk(child);
    if (n.kind === 'element' && n.id && targetElementIds.has(n.id)) out.push({ kind: 'element', id: n.id });
    if (n.kind === 'each') {
      const blockId = eachBlockIdByNode.get(n)!;
      if (eachScopedBlockIds.has(blockId)) out.push({ kind: 'each', id: blockId });
    }
  }
}

/**
 * `sub on_bind_<elementId>_<fieldName>Change(event as object)` — a `bind:`
 * target's reverse handler. Deliberately the same shape as
 * `printStateAssignment`'s inline write (`m.<state> = <value>` + the shared
 * cascade), no equality guard: `bind:` never pushes a value back into the
 * child (see GRAMMAR.md's "Two-way binding" section), so there's no
 * compiler-introduced feedback loop to guard against here, unlike an earlier
 * draft of this design that fused push+pull into one mechanism.
 */
function emitBindChangeHandler(
  target: BindTarget,
  script: ThrScriptAst,
  graph: DependencyGraph,
  bindings: TemplateBindings,
  scriptBindings: ScriptBindings,
  componentName: string,
  globalBindings: GlobalBindingsContext,
  conditionalBlocks: ConditionalBlockAnalysis,
  blockTransitions: ReadonlyMap<string, ResolvedBlockTransition>,
  animateBindings: ReadonlyMap<string, ResolvedAnimateBinding>,
): string {
  const lines = [
    `sub ${bindChangeHandlerName(target.elementId, target.fieldName)}(event as object)`,
    `  m.${target.stateName} = event.GetData()`,
    ...emitCascadeLines(target.stateName, script, graph, bindings, scriptBindings, componentName, globalBindings, conditionalBlocks, 1, blockTransitions, animateBindings),
    'end sub',
  ];
  return lines.join('\n');
}

/**
 * Whether a synthesized handler's generated `event as object` parameter is actually
 * referenced anywhere in its body — used to decide whether to emit `_event` instead
 * (see `emitParamName`'s "unused parameter gets a `_` prefix" rule, and
 * `findings/compiler-codegen-conventions.md`'s note that a Roku-interface-required callback
 * signature still needs this even though the parameter can't be removed). `bodyLines`
 * is already fully known generated text at this point (not a DSL `Block` AST), so a
 * direct text check stands in for a full `buildFunctionScope` reconstruction. The
 * negative lookbehind excludes `m.event`/`x.event` member access — a DSL author's own
 * `field`/`state`/`derived`/global source literally named `event` would otherwise read
 * as a false "used" match, which only costs a missed (cosmetic) prefix, never a bug.
 */
function isEventReferenced(bodyLines: readonly string[]): boolean {
  return bodyLines.some((line) => /(?<!\.)\bevent\b/i.test(line));
}

function emitFieldChangeHandler(
  fieldName: string,
  script: ThrScriptAst,
  graph: DependencyGraph,
  bindings: TemplateBindings,
  scriptBindings: ScriptBindings,
  componentName: string,
  globalBindings: GlobalBindingsContext,
  conditionalBlocks: ConditionalBlockAnalysis,
  blockTransitions: ReadonlyMap<string, ResolvedBlockTransition>,
  animateBindings: ReadonlyMap<string, ResolvedAnimateBinding>,
): string {
  const cascadeLines = emitCascadeLines(fieldName, script, graph, bindings, scriptBindings, componentName, globalBindings, conditionalBlocks, 1, blockTransitions, animateBindings);
  const paramName = isEventReferenced(cascadeLines) ? 'event' : '_event';
  const lines = [
    `sub ${fieldChangeHandlerName(fieldName)}(${paramName} as object)`,
    ...cascadeLines,
    'end sub',
  ];
  return lines.join('\n');
}

/** Counterpart to `emitFieldChangeHandler` for a referenced global `store`/`theme` field — same cascade body, generated name (`externalFieldChangeHandlerName`), and registered via `init()`'s `ObserveFieldScoped` instead of the XML `onChange=` attribute a component's own field uses. */
function emitExternalFieldChangeHandler(
  sourceName: string,
  script: ThrScriptAst,
  graph: DependencyGraph,
  bindings: TemplateBindings,
  scriptBindings: ScriptBindings,
  componentName: string,
  globalBindings: GlobalBindingsContext,
  conditionalBlocks: ConditionalBlockAnalysis,
  blockTransitions: ReadonlyMap<string, ResolvedBlockTransition>,
  animateBindings: ReadonlyMap<string, ResolvedAnimateBinding>,
): string {
  const { root, fieldName } = splitGlobalSourceKey(sourceName);
  const cascadeLines = emitCascadeLines(sourceName, script, graph, bindings, scriptBindings, componentName, globalBindings, conditionalBlocks, 1, blockTransitions, animateBindings);
  const paramName = isEventReferenced(cascadeLines) ? 'event' : '_event';
  const lines = [
    `sub ${externalFieldChangeHandlerName(root, fieldName)}(${paramName} as object)`,
    ...cascadeLines,
    'end sub',
  ];
  return lines.join('\n');
}

/**
 * The reactive cascade for one source (`field`, `state`, or a global
 * `store`/`theme` composite key) changing, in a fixed three-step order: (1)
 * recompute every `derived`/`watch` that depends on it (topological order),
 * (2) resolve create/destroy for every `{#if:destroy}` block whose condition
 * references it, (3) update every ordinary/toggle-mode template binding
 * affected by it — guard-wrapped when the binding's element lives inside a
 * `{#if:destroy}` subtree, since that subtree may or may not currently be
 * attached (see `wrapWithNearestDestroyGuard`). Step 2 before step 3 matters:
 * a block that just got (re)constructed this same cascade pass already had
 * its own initial values set during construction, so an unguarded step-3
 * line running against a stale pre-update mount state would either be
 * redundant (harmless) or, if ordered before step 2, could run against a
 * node that doesn't exist yet. Shared by `emitFieldChangeHandler`/
 * `emitExternalFieldChangeHandler` (wrapped in a generated change-handler
 * sub) and `printStateAssignment` (inlined right at the `state x = expr`
 * site) — same cascade, different triggers.
 */
function emitCascadeLines(
  sourceName: string,
  script: ThrScriptAst,
  graph: DependencyGraph,
  bindings: TemplateBindings,
  scriptBindings: ScriptBindings,
  componentName: string,
  globalBindings: GlobalBindingsContext,
  conditionalBlocks: ConditionalBlockAnalysis,
  depth: number,
  blockTransitions: ReadonlyMap<string, ResolvedBlockTransition> = new Map(),
  animateBindings: ReadonlyMap<string, ResolvedAnimateBinding> = new Map(),
): string[] {
  const indent = INDENT_UNIT.repeat(depth);
  const lines: string[] = [];

  for (const derivedName of graph.dependentsOfSource.get(sourceName) ?? []) {
    lines.push(`${indent}${emitDerivedAssignment(derivedName, script, scriptBindings, globalBindings)}`);
  }

  for (const block of bindings.affectedBySourceBlocks.get(sourceName) ?? []) {
    lines.push(...emitConditionalBlockCascadeCheck(block, scriptBindings, globalBindings, conditionalBlocks.nearestDestroyAncestorById, depth, componentName, blockTransitions.get(block.id) ?? null));
  }

  // An {#each} block's collection expression changing (directly or via a derived) always
  // triggers a full reconcile — guard-wrapped exactly like an ordinary binding when the each
  // block itself lives inside a {#if:destroy} subtree (its wrapper, and its _keys/_nodes state,
  // may or may not currently exist).
  for (const block of bindings.affectedByEachSourceBlocks.get(sourceName) ?? []) {
    const line = `${indent}${eachReconcileSubName(componentName, block.id)}()`;
    lines.push(...wrapWithNearestDestroyGuard(block.id, [line], conditionalBlocks.nearestDestroyAncestorById, depth));
  }

  for (const binding of bindings.affectedBySource.get(sourceName) ?? []) {
    // The synthetic `visible` push for a toggle-mode block (see template-bindings.ts's
    // analyzeTemplateBindings) is the ONE binding whose elementId is a BLOCK id rather than an
    // ordinary template element id — the only shape blockTransitions is ever keyed by. A block
    // with no resolved transition falls through to the exact same plain assignment as before this
    // feature existed (strictly additive, see conditional-block-emitter.ts's own doc comment).
    const transition = binding.attributeName === 'visible' ? blockTransitions.get(binding.elementId) : undefined;
    if (transition) {
      const block = conditionalBlocks.blocks.find((b) => b.id === binding.elementId)!;
      const condition = rewriteExpression(block.expression, scriptBindings, `template ${block.id} condition`, undefined, globalBindings);
      const transitionLines = emitToggleTransitionCascadeLines(block, transition, condition, depth);
      lines.push(...wrapWithNearestDestroyGuard(binding.elementId, transitionLines, conditionalBlocks.nearestDestroyAncestorById, depth));
      continue;
    }

    const animateBinding = animateBindings.get(`${binding.elementId}.${binding.attributeName}`) ?? null;
    const assignmentLines = emitBindingAssignment(binding.elementId, binding.attributeName, binding.expression, scriptBindings, globalBindings, animateBinding).map(
      (l) => `${indent}${l}`,
    );
    lines.push(...wrapWithNearestDestroyGuard(binding.elementId, assignmentLines, conditionalBlocks.nearestDestroyAncestorById, depth));
  }

  return lines;
}

/** Emits the recompute line for a `graph.order` name — either a `derived` (its own expression, rewritten) or a `watch` (a fixed `store(<path>)` read, no expression to rewrite). Both print as `m.<name> = <rhs>`; only the RHS's derivation differs. */
function emitDerivedAssignment(name: string, script: ThrScriptAst, scriptBindings: ScriptBindings, globalBindings: GlobalBindingsContext): string {
  const decl = script.derived.find((d) => d.name === name);
  if (decl) {
    const rewritten = rewriteExpression(decl.expression, scriptBindings, `derived ${name}`, NO_FUNCTION_SCOPE, globalBindings);
    return `m.${name} = ${decl.scale ? wrapWithScale(rewritten) : rewritten}`;
  }

  const watch = script.watches.find((d) => d.name === name);
  if (watch) {
    const rewritten = rewriteStorePathRead(watch.path);
    return `m.${name} = ${watch.scale ? wrapWithScale(rewritten) : rewritten}`;
  }

  throw new Error(`internal: derived/watch "${name}" not found in script AST`);
}

/**
 * One or more generated lines assigning a dynamic attribute's value —
 * ordinarily just `m.<id>.<attr> = <rewritten expr>`, one line. A dynamic
 * `focusable="{expr}"` is special-cased into a temp-var + field-assign +
 * conditional register/unregister-with-the-focus-manager shape instead (see
 * `naming.ts`'s `emitDynamicFocusableAssignment`, shared with
 * `conditional-block-emitter.ts`/`each-block-emitter.ts`): this is what makes
 * a reactive parent→child focus-handoff (drill-down) pattern actually work at
 * runtime, not just at the type level — flipping the parent's `focusable`
 * expression to `false` in the same handler that hands focus to a child
 * unregisters the parent (via this same generated assignment, re-run by the
 * ordinary reactive cascade whenever the expression's own dependencies
 * change) so the two are never simultaneously registered, matching
 * `analysis/focusable-elements.ts`'s compile-time nested-focusable check
 * (which only rejects two *static* `focusable="true"` elements, precisely
 * because a dynamic one resolves this way at runtime).
 * `FlashTheaterFocusManager.brs`'s `register` is idempotent, since this can
 * legitimately re-fire "still true" more than once without the value itself
 * changing (some other dependency of the same expression re-triggering the
 * cascade).
 */
function rewriteBindingExpression(elementId: string, attributeName: string, expression: string, scriptBindings: ScriptBindings, globalBindings: GlobalBindingsContext): string {
  return rewriteExpression(expression, scriptBindings, `template ${elementId}.${attributeName}`, NO_FUNCTION_SCOPE, globalBindings);
}

/**
 * `animateBinding`, when set (Layer 3's `animate:<field>` — see `analysis/animate-bindings.ts`),
 * replaces the plain `nodeRef.<attr> = <rewritten>` snap with a runtime-computed interpolated
 * write — the ONE place in this whole feature where an animation's `keyValue` is computed at
 * runtime rather than baked into static XML/generated literals at compile time. Reads the field's
 * CURRENT live value as the animation's start point, sets it on the synthesized per-site
 * animation's own (sole, unnamed — reached via `GetChild(0)`, always exactly one interpolator by
 * construction) interpolator's `keyValue`, then starts it, instead of ever writing `<attr>`
 * directly — the interpolator itself performs the actual field write, frame by frame, as it plays.
 * Never used for the element's INITIAL value at `init()` time (see `emitInitFunction`'s own plain
 * `bindings.all` loop, which never passes an `animateBinding`) — only a SUBSEQUENT cascade-
 * triggered write animates; the first render still snaps instantly, matching Layer 2's own
 * "no animation on initial mount" convention.
 */
function emitBindingAssignment(
  elementId: string,
  attributeName: string,
  expression: string,
  scriptBindings: ScriptBindings,
  globalBindings: GlobalBindingsContext,
  animateBinding: ResolvedAnimateBinding | null = null,
): string[] {
  const rewritten = rewriteBindingExpression(elementId, attributeName, expression, scriptBindings, globalBindings);
  const nodeRef = mFieldAccess(elementId);

  if (animateBinding) {
    const animRef = mFieldAccess(animationNodeId(animateBinding.config.name));
    return [
      `ft_animate_from_${elementId}_${attributeName} = ${nodeRef}.${attributeName}`,
      `${animRef}.GetChild(0).keyValue = [ft_animate_from_${elementId}_${attributeName}, ${rewritten}]`,
      `${animRef}.control = "start"`,
    ];
  }

  if (attributeName !== FOCUSABLE_ATTRIBUTE_NAME) {
    return [`${nodeRef}.${attributeName} = ${rewritten}`];
  }

  return emitDynamicFocusableAssignment(nodeRef, `ft_focusable_${elementId}`, rewritten, attributeName);
}

/**
 * Everything a function body's statement-printing needs — bundled so adding a new statement kind
 * later doesn't mean widening every print function's parameter list again. Satisfies
 * `codegen/statement-printer.ts`'s `SharedPrintContext` (the `globalAccessRoot`/closure fields
 * below) so every shared print function can be called directly with a plain `FunctionPrintContext`
 * — see that module's own doc comment for why the closures are bound once, in `emitFunction`, and
 * never rebuilt when entering a nested anonymous function's own scope.
 */
interface FunctionPrintContext extends SharedPrintContext {
  readonly script: ThrScriptAst;
  readonly scriptBindings: ScriptBindings;
  readonly graph: DependencyGraph;
  readonly bindings: TemplateBindings;
  readonly functionScope: FunctionScope;
  readonly contextLabel: string;
  readonly globalBindings: GlobalBindingsContext;
  readonly conditionalBlocks: ConditionalBlockAnalysis;
  readonly componentName: string;
  /** Fresh-name counter for this function's own ternary temp vars (`ft_ternary_1`, ...) — see `naming.ts`'s `nextTernaryTempName`. One per `emitFunction` call, never shared across functions. */
  readonly ternaryCounter: { value: number };
  /** Fresh-name counter for this function's own hoisted Tier-2 anonymous-function temp vars (`ft_anon_1`, ...) — see `naming.ts`'s `nextAnonFunctionTempName`. One per `emitFunction` call, never shared across functions. */
  readonly anonFunctionCounter: { value: number };
  readonly blockTransitions: ReadonlyMap<string, ResolvedBlockTransition>;
  readonly animateBindings: ReadonlyMap<string, ResolvedAnimateBinding>;
}

/** A function with no return-type clause (`fn.returnType === null` — there is no `void` type in this DSL, see GRAMMAR.md) compiles to a real BrightScript `sub`; one with a return type compiles to `function ... as <Type>`, unchanged from before. */
function emitFunction(
  fn: FunctionDecl,
  script: ThrScriptAst,
  scriptBindings: ScriptBindings,
  graph: DependencyGraph,
  bindings: TemplateBindings,
  globalBindings: GlobalBindingsContext,
  conditionalBlocks: ConditionalBlockAnalysis,
  componentName: string,
  blockTransitions: ReadonlyMap<string, ResolvedBlockTransition> = new Map(),
  animateBindings: ReadonlyMap<string, ResolvedAnimateBinding> = new Map(),
  timerCounter: { value: number } | null = null,
): string {
  const name = fn.visibility === 'private' ? privateFunctionName(fn.name) : fn.name;
  const functionScope = buildFunctionScope(fn);
  const paramsText = fn.params.map((p) => `${emitParamName(p.name, functionScope, `function "${fn.name}"`)} as ${brsTypeAnnotation(p.type)}`).join(', ');
  const isSub = fn.returnType === null;
  const header = isSub ? `sub ${name}(${paramsText})` : `function ${name}(${paramsText}) as ${brsTypeAnnotation(fn.returnType!)}`;
  const ctx: FunctionPrintContext = {
    script,
    scriptBindings,
    graph,
    bindings,
    functionScope,
    blockTransitions,
    animateBindings,
    contextLabel: fn.name,
    globalBindings,
    conditionalBlocks,
    componentName,
    ternaryCounter: { value: 0 },
    anonFunctionCounter: { value: 0 },
    timerCounter,
    globalAccessRoot: 'm.global',
    rewriteText: (text, mode, contextLabel, functionScope) =>
      mode === 'expression'
        ? rewriteExpression(text, scriptBindings, contextLabel, functionScope, globalBindings)
        : rewriteStatement(text, scriptBindings, contextLabel, functionScope, globalBindings),
    describeContext: (suffix) => (suffix ? `function ${fn.name} ${suffix}` : `function ${fn.name}`),
    resolveAssignmentTarget: (target, contextLabel, functionScope) => {
      const resolved = resolveIdentifier(target, scriptBindings, functionScope, globalBindings);
      if (resolved.kind === 'unresolved') {
        throw new CompileError({
          code: 'expression/unresolved-identifier',
          message: `Unresolved identifier "${target}" in ${contextLabel} — not a declared field/derived/state/function, a local variable, or a BrightScript builtin.`,
        });
      }
      return resolved.replacement ?? target;
    },
    printStatement,
    hoistIfNeeded: (body) => body,
    collectExtraHoistedLines: (text, mode, indent) =>
      mode === 'statement' ? collectAnimationFieldRefreshLines(text, scriptBindings).map((line) => `${indent}${line}`) : [],
  };
  const body = printBlockStatements(fn.block, 1, ctx);
  return [header, body, isSub ? 'end sub' : 'end function'].join('\n');
}

/**
 * Prints a function body from flash-parser's structured `Block` — a JS-shaped
 * `if (cond) { }` becomes BrightScript's `if (cond) then ... end if`, at a
 * fixed 2-space indent per nesting depth (not the original .thr
 * whitespace — codegen.ts/if-statement-rewrite.ts used to text-splice and
 * preserve original formatting; walking a real AST means printing it
 * instead, see findings/compiler-codegen-conventions.md). A `state x = expr`
 * statement prints its own reactive cascade inline (see
 * `printStateAssignment`); everything else (assignments, return, calls) is
 * a `StatementRegion` leaf, printed by the shared engine's
 * `printGenericLeafStatement` — see `codegen/statement-printer.ts`. The `if`
 * condition and every leaf statement go through the same identifier-rewrite
 * as `derived`/template expressions (`field`→`m.top.x`, `derived`/`state`→
 * `m.x`, `private fn`→`private_x`) — `ctx.functionScope` (the function's own
 * real BrightScript locals and parameters) shadows those bindings, matching
 * ordinary lexical scoping.
 *
 * Returns `''` (never a bare indent) when a top-level `StatementRegion`
 * elides to nothing — see `elideUnusedLocalAssignments`/
 * `printGenericLeafStatement`. `printBlockStatements` filters those out so no
 * stray blank line appears in the generated `.brs`. Elision only ever runs on
 * that catch-all, block-level branch: an empty result there just leaves a
 * block's body empty (valid BrightScript), but the inline single-statement
 * forms (`if (c) then <stmt>`, `else <stmt>` — see `printBranchBody`/the
 * inline branch in `printIfStatement`) structurally require a statement
 * immediately after `then`/`else` on the same line, so eliding there would
 * produce invalid syntax; those are deliberately left unelided.
 */
function printStatement(
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
  depth: number,
  ctx: FunctionPrintContext,
): string {
  if (statement instanceof RawBrightScriptStatement) return printRawBrightScriptStatement(statement, depth);
  if (statement instanceof ForStatement) return printForStatement(statement, depth, ctx);
  if (statement instanceof ForEachStatement) return printForEachStatement(statement, depth, ctx);
  if (statement instanceof WhileStatement) return printWhileStatement(statement, depth, ctx);
  if (statement instanceof TryStatement) return printTryStatement(statement, depth, ctx);
  if (statement instanceof AnonymousFunctionAssignmentStatement) return printAnonymousFunctionAssignment(statement, depth, ctx);
  if (statement instanceof ScaleLocalAssignmentStatement) return printScaleLocalAssignment(statement, depth, ctx);
  if (statement instanceof ScaleStateAssignmentStatement) return printScaleStateAssignment(statement, depth, ctx);
  if (statement instanceof IfStatement) return printIfStatement(statement, depth, ctx);
  if (statement instanceof StateAssignment) return printStateAssignment(statement, depth, ctx);
  if (statement instanceof StoreWriteStatement) return printStoreWriteStatement(statement, depth, ctx);
  if (statement instanceof FocusStatement) return printFocusStatement(statement, depth, ctx);
  if (statement instanceof JumpFocusStatement) return printJumpFocusStatement(statement, depth, ctx);
  if (statement instanceof TernaryAssignmentStatement) return printTernaryAssignment(statement, depth, ctx);

  return printGenericLeafStatement(statement, depth, ctx);
}

/**
 * Prints `store(<key>) = <expr>` as a plain `m.global.ft_store.callFunc("set",
 * "<key>", <rewritten expr>)` call — no cascade is emitted at the write
 * site itself. The cascade fires in whichever *other* component(s) have a
 * `watch` observing that key, via the generated `ObserveFieldScoped`/
 * `on_store_<key>Change` handler — exactly like today's field-change model
 * (see `emitExternalFieldChangeHandler`), reused unchanged. `<expr>` goes
 * through `lowerAnonymousFunctionsInText` (not a bare `rewriteExpression`
 * call) so a Tier-2 anonymous function nested anywhere inside it hoists
 * correctly, same as every other `ExpressionRegion` consumer in this file.
 */
function printStoreWriteStatement(statement: StoreWriteStatement, depth: number, ctx: FunctionPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const contextLabel = `function ${ctx.contextLabel}`;
  const { hoistedLines, rewrittenText } = lowerAnonymousFunctionsInText(statement.expression, 'expression', depth, ctx, contextLabel);
  const rewritten = `${globalFieldRef('store')}.callFunc("set", "${statement.topLevelKey}", ${rewrittenText})`;
  return [...hoistedLines, `${indent}${rewritten}`].join('\n');
}

/**
 * Prints `focus(<expr>)` as a plain `m.global.ft_focus.callFunc("focusComponent",
 * m.top.findNode(<rewritten expr>))` call, calling the built-in
 * `FlashTheaterFocusManager` singleton's `focusComponent` function (see
 * `packages/compiler/runtime-assets/FocusManager`). `<expr>` must be a string
 * — the id of one of *this component's own descendants* — and is
 * deliberately always wrapped in `m.top.findNode(...)`, never resolved
 * against the whole scene: `findNode` only ever searches the calling node's
 * own subtree, so a component can move focus into one of its own
 * children/descendants (including a nested custom component's own root, if
 * that root was given an id), but can never reach a sibling or an unrelated
 * branch of the app. Reaching a sibling component is deliberately NOT
 * expressible this way — that has to go through the same parent-mediated
 * flow every other piece of data in this framework already uses: the child
 * sets an outbound `field` the parent observes (`bind:` in a compiled `.thr`
 * parent, hand-wired `ObserveFieldScoped` for a hand-composed root), and the
 * parent — which DOES have the sibling as its own child — calls
 * `focus(<siblingId>)` itself. See `findings/focus-system.md` for the
 * real-world case this restriction was introduced for. `<expr>` goes through
 * `lowerAnonymousFunctionsInText` for the same Tier-2-hoisting reason as
 * `printStoreWriteStatement` above.
 */
function printFocusStatement(statement: FocusStatement, depth: number, ctx: FunctionPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const contextLabel = `function ${ctx.contextLabel}`;
  const { hoistedLines, rewrittenText } = lowerAnonymousFunctionsInText(statement.expression, 'expression', depth, ctx, contextLabel);
  const rewritten = `${globalFieldRef('focus')}.callFunc("focusComponent", m.top.findNode(${rewrittenText}))`;
  return [...hoistedLines, `${indent}${rewritten}`].join('\n');
}

/**
 * Prints `jumpFocus(<direction>, <count>, <press>)` as:
 * ```
 * if <press> then
 *   if m.global.ft_focus.callFunc("navigateBy", <direction>, <count>) then
 *     m.global.ft_focus.callFunc("startRepeat", <direction>, <count>)
 *   end if
 * else
 *   m.global.ft_focus.callFunc("stopRepeat")
 * end if
 * ```
 * calling the built-in `FlashTheaterFocusManager` singleton's `navigateBy`/`startRepeat`/
 * `stopRepeat` functions (see `packages/compiler/runtime-assets/FocusManager`). Real multi-line
 * codegen for one DSL statement already has a direct precedent — ternary's own hoisted temp-var +
 * `if`/`else` (`statement-printer.ts`'s `lowerTernaryRhs`) — so this isn't a new shape for this
 * emitter. Unlike `focus(<id>)`, this branches on the caller's own `<press>` value: a press jumps
 * focus and arms the SAME hold-to-repeat `Timer` machinery `startRepeat`/`onRepeatTimerFire`
 * already use for arrow-key repeat (generalized to accept an optional jump count — see
 * `FlashTheaterFocusManager.brs`), a release stops it — mirroring what the automatically-generated
 * LRUD fallthrough above already does structurally for up/down/left/right. This can't equally be
 * an automatic fallthrough for `jumpFocus` the way arrow keys are — see GRAMMAR.md's "Focus
 * system" section (`jumpFocus`) for why. All three arguments go through
 * `lowerAnonymousFunctionsInText` for the same Tier-2-hoisting reason `printFocusStatement` above
 * does; their hoisted lines are spliced in before the branch, at the statement's own depth, the
 * same way `lowerTernaryRhs` hoists a ternary's condition/branch lines before its own temp-var
 * assignment.
 */
function printJumpFocusStatement(statement: JumpFocusStatement, depth: number, ctx: FunctionPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const innerIndent = INDENT_UNIT.repeat(depth + 1);
  const innerInnerIndent = INDENT_UNIT.repeat(depth + 2);
  const contextLabel = `function ${ctx.contextLabel}`;

  const direction = lowerAnonymousFunctionsInText(statement.directionExpression, 'expression', depth, ctx, contextLabel);
  const count = lowerAnonymousFunctionsInText(statement.countExpression, 'expression', depth, ctx, contextLabel);
  const press = lowerAnonymousFunctionsInText(statement.pressExpression, 'expression', depth, ctx, contextLabel);
  const focusRef = globalFieldRef('focus');

  return [
    ...direction.hoistedLines,
    ...count.hoistedLines,
    ...press.hoistedLines,
    `${indent}if ${press.rewrittenText} then`,
    `${innerIndent}if ${focusRef}.callFunc("navigateBy", ${direction.rewrittenText}, ${count.rewrittenText}) then`,
    `${innerInnerIndent}${focusRef}.callFunc("startRepeat", ${direction.rewrittenText}, ${count.rewrittenText})`,
    `${innerIndent}end if`,
    `${indent}else`,
    `${innerIndent}${focusRef}.callFunc("stopRepeat")`,
    `${indent}end if`,
  ].join('\n');
}

/**
 * Prints `state x = expr` as `m.x = <rewritten expr>` (possibly preceded by hoisted ternary
 * temp-var/`if`/`else` lines — see `lowerTernaryRhs` — when the RHS contains one) followed
 * immediately by the same reactive cascade a field's `on_<field>Change` runs (see
 * `emitCascadeLines`) — inlined here rather than in a generated sub, since a `state` write has no
 * SceneGraph observer to trigger it from; the cascade has to happen at the assignment site itself,
 * wherever in the function that is.
 */
function printStateAssignment(statement: StateAssignment, depth: number, ctx: FunctionPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const stateName = statement.name;

  if (!ctx.scriptBindings.stateNames.has(stateName)) {
    const reason = ctx.scriptBindings.fieldNames.has(stateName)
      ? `"${stateName}" is a field, not a state — state assignment can only target a declared state.`
      : `"${stateName}" is not a declared state.`;
    throw new CompileError({ code: 'statement/unknown-state', message: `Invalid state assignment in function ${ctx.contextLabel}: ${reason}` });
  }

  const { hoistedLines, rewrittenText } = lowerTernaryRhs(statement.rhs, depth, ctx, `function ${ctx.contextLabel} state assignment`);
  const lines = [
    ...hoistedLines,
    `${indent}m.${stateName} = ${rewrittenText}`,
    ...emitCascadeLines(stateName, ctx.script, ctx.graph, ctx.bindings, ctx.scriptBindings, ctx.componentName, ctx.globalBindings, ctx.conditionalBlocks, depth, ctx.blockTransitions, ctx.animateBindings),
  ];
  return lines.join('\n');
}

/**
 * Prints `scale state <name> = <expr>` — identical to `printStateAssignment` except the assigned
 * value is `ft_scale(...)`-wrapped before the reactive cascade fires, so every dependent
 * derived/watch/template binding recomputes off the already-scaled value.
 */
function printScaleStateAssignment(statement: ScaleStateAssignmentStatement, depth: number, ctx: FunctionPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const stateName = statement.name;

  if (!ctx.scriptBindings.stateNames.has(stateName)) {
    const reason = ctx.scriptBindings.fieldNames.has(stateName)
      ? `"${stateName}" is a field, not a state — state assignment can only target a declared state.`
      : `"${stateName}" is not a declared state.`;
    throw new CompileError({ code: 'statement/unknown-state', message: `Invalid scale state assignment in function ${ctx.contextLabel}: ${reason}` });
  }

  const { hoistedLines, rewrittenText } = lowerTernaryRhs(statement.rhs, depth, ctx, `function ${ctx.contextLabel} scale state assignment`);
  const lines = [
    ...hoistedLines,
    `${indent}m.${stateName} = ${wrapWithScale(rewrittenText)}`,
    ...emitCascadeLines(stateName, ctx.script, ctx.graph, ctx.bindings, ctx.scriptBindings, ctx.componentName, ctx.globalBindings, ctx.conditionalBlocks, depth, ctx.blockTransitions, ctx.animateBindings),
  ];
  return lines.join('\n');
}

