/**
 * `{#if:destroy}` conditional-block codegen — the one genuinely new codegen
 * surface this feature needs (there is no existing "create/destroy a node"
 * or list-rendering precedent anywhere else in this package). Block
 * *analysis* (id assignment, ancestor tracking, `analyzeTemplateBlocks`/
 * `analyzeConditionalBlocks`/`collectStaticallyPresentIds`) lives in
 * `analysis/conditional-blocks.ts` — this module only consumes that output
 * to emit create/destroy subs. `{#if}` (toggle mode) needs none of this: it
 * compiles to a synthetic `Group` wrapper that's always present in the
 * static XML with an ordinary `visible="{expr}"` binding, reusing
 * `codegen/template-bindings.ts`/`codegen/brs-emitter.ts`'s existing
 * machinery unchanged.
 *
 * See findings/template-conditional-blocks.md for the correctness traps this
 * module's design specifically works around: a destroy-mode block's
 * sibling-insertion index must be a *runtime* expression (a preceding
 * sibling can itself be a destroy-mode block whose own mount state is a
 * runtime fact, not a compile-time constant); an ordinary binding nested
 * inside a destroy-mode subtree must be *guarded* at its cascade site
 * (`emitCascadeLines` in brs-emitter.ts) rather than assumed always-mounted;
 * and teardown must null every id in the torn-down subtree, including a
 * nested block's own id, which is what makes checking only the *nearest*
 * enclosing destroy ancestor (not every ancestor) sufficient.
 */
import { TemplateEachBlock, TemplateIfBlock, TemplateNode } from '../dsl-parser/dsl-ast.js';
import { ScriptBindings } from '../analysis/scope-resolution.js';
import { walkTemplate } from '../analysis/template-walk.js';
import { GlobalBindingsContext } from '../analysis/global-bindings.js';
import { rewriteExpression } from '../analysis/identifier-rewrite.js';
import { isStaticallyDefaultFocusTrue, FocusableElement } from '../analysis/focusable-elements.js';
import type { ConditionalBlock, ConditionalBlockAnalysis } from '../analysis/conditional-blocks.js';
import type { ResolvedBlockTransition } from '../analysis/transitions.js';
import {
  bindChangeHandlerName,
  conditionalCreateSubName,
  conditionalDestroySubName,
  eachReconcileSubName,
  mFieldAccess,
  FOCUSABLE_ATTRIBUTE_NAME,
  DEFAULT_FOCUS_ATTRIBUTE_NAME,
  brsStringLiteral,
  animationNodeId,
  animationStateChangeHandlerName,
  animationFinishCallbackFieldAccess,
  UNMOUNT_FUNCTION_NAME,
} from './naming.js';
import { focusRegisterCall, focusUnregisterCall, emitDynamicFocusableAssignment, staticFocusableRegisterLine, emitFieldAssignments } from './shared-emit.js';
import { globalFieldRef } from './global-fields.js';
import { printArrayAttr } from './animation-emitter.js';
import type { ParsedAnimationStep } from '../analysis/animation-config.js';
import type { EachBlockAnalysis } from './each-block-emitter.js';

const NO_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };

function containerRefExpr(containerId: string | null): string {
  return containerId ? mFieldAccess(containerId) : 'm.top';
}

/**
 * Hand-constructs a subtree's nodes as BRS statements — the same walk shape
 * `codegen/xml-emitter.ts`'s `emitElement` uses for a static tree, but
 * emitting `CreateObject("roSGNode", ...)`/attribute-assignment/
 * `appendChild` statements instead of XML text, since a destroy-mode
 * subtree never exists in the static XML at all. An element with an `id`
 * is cached straight into `m.<id>` (no `findNode` — the node doesn't exist
 * until this very statement creates it); one without an `id` gets a
 * throwaway local variable, since nothing ever needs to reference it again
 * once it's appended.
 */
function emitSubtreeConstruction(
  nodes: readonly TemplateNode[],
  parentRefExpr: string,
  depth: number,
  lines: string[],
  scriptBindings: ScriptBindings,
  globalBindings: GlobalBindingsContext,
  blockIdByNode: ReadonlyMap<TemplateIfBlock, string>,
  eachBlockIdByNode: ReadonlyMap<TemplateEachBlock, string>,
  tempCounter: { n: number },
  componentName: string,
  eachItemsDictBlockIds: ReadonlySet<string>,
): void {
  const indent = '  '.repeat(depth);

  for (const node of nodes) {
    if (node.kind === 'element') {
      const varExpr = node.id ? mFieldAccess(node.id) : `ft_n${++tempCounter.n}`;
      lines.push(`${indent}${varExpr} = CreateObject("roSGNode", "${node.tagName}")`);
      if (node.id) lines.push(`${indent}${varExpr}.id = ${brsStringLiteral(node.id)}`);
      // Plain static/dynamic (non-focusable) attribute values are batched into one
      // setFields() call below instead of one dot-assignment per attribute.
      const plainFields: { name: string; value: string }[] = [];
      for (const attr of node.attributes) {
        if (attr.kind === 'static') {
          if (attr.name === FOCUSABLE_ATTRIBUTE_NAME) {
            lines.push(`${indent}${varExpr}.${attr.name} = ${brsStringLiteral(attr.value)}`);
          } else if (attr.name !== DEFAULT_FOCUS_ATTRIBUTE_NAME) {
            // default-focus is a pure compiler-internal/DSL marker with no corresponding native
            // SceneGraph field — never a real field assignment (confirmed live — see
            // findings/router.md), unlike `focusable`, which legitimately is a real native field.
            plainFields.push({ name: attr.name, value: brsStringLiteral(attr.value) });
          }
          // A statically focusable="true" element registers once, unconditionally, the moment
          // it's actually constructed — see codegen/brs-emitter.ts's matching comment for the
          // statically-present case.
          const registerLine = staticFocusableRegisterLine(varExpr, attr.name, attr.value, isStaticallyDefaultFocusTrue(node));
          if (registerLine) lines.push(`${indent}${registerLine}`);
        } else if (attr.kind === 'dynamic') {
          const rewritten = rewriteExpression(attr.expression, scriptBindings, `template ${node.id ?? node.tagName}.${attr.name}`, undefined, globalBindings);
          if (attr.name === FOCUSABLE_ATTRIBUTE_NAME) {
            // Same reactive register/unregister shape as brs-emitter.ts's emitBindingAssignment —
            // this is the *initial* evaluation (construct time), the ordinary reactive cascade
            // (guarded by wrapWithNearestDestroyGuard once this subtree exists) handles every
            // update after that, through the exact same generated code path.
            for (const line of emitDynamicFocusableAssignment(varExpr, `ft_focusable_${node.id}`, rewritten, attr.name)) {
              lines.push(`${indent}${line}`);
            }
          } else {
            plainFields.push({ name: attr.name, value: rewritten });
          }
        } else if (attr.kind === 'bind') {
          // bind: — no push (see GRAMMAR.md's "Two-way binding", one-directional child→state
          // only); registers the reverse observer instead. `node.id` is guaranteed non-null here —
          // flash-parser's hasDynamic check already requires an id on any element with a bind
          // attribute (template/missing-id otherwise).
          lines.push(`${indent}${varExpr}.ObserveFieldScoped(${brsStringLiteral(attr.name)}, ${brsStringLiteral(bindChangeHandlerName(node.id!, attr.name))})`);
        }
        // on:key — no push, no registration here: the generated onKeyEvent reads this element's
        // own id and IsInFocusChain() live at call time (see analysis/key-bindings.ts and
        // brs-emitter.ts's emitOnKeyEventFunction), it never needs anything wired up at
        // construction time.
      }
      for (const line of emitFieldAssignments(varExpr, plainFields)) {
        lines.push(`${indent}${line}`);
      }
      lines.push(`${indent}${parentRefExpr}.appendChild(${varExpr})`);
      emitSubtreeConstruction(node.children, varExpr, depth, lines, scriptBindings, globalBindings, blockIdByNode, eachBlockIdByNode, tempCounter, componentName, eachItemsDictBlockIds);
      continue;
    }

    if (node.kind === 'each') {
      // An {#each} nested inside a {#if:destroy} subtree doesn't exist (its wrapper, and its
      // _keys/_nodes state) until the very moment this construction runs — build it exactly the
      // same way emitInitFunction does for a top-level each block, then immediately reconcile
      // once so the list is populated the instant its ancestor mounts.
      const eachId = eachBlockIdByNode.get(node)!;
      const eachRef = mFieldAccess(eachId);
      lines.push(`${indent}${eachRef} = CreateObject("roSGNode", "Group")`);
      lines.push(`${indent}${parentRefExpr}.appendChild(${eachRef})`);
      lines.push(`${indent}${mFieldAccess(eachId, '_keys')} = []`);
      lines.push(`${indent}${mFieldAccess(eachId, '_nodes')} = {}`);
      if (eachItemsDictBlockIds.has(eachId)) lines.push(`${indent}${mFieldAccess(eachId, '_items')} = {}`);
      lines.push(`${indent}${eachReconcileSubName(componentName, eachId)}()`);
      continue;
    }

    const blockId = blockIdByNode.get(node)!;
    const blockRef = mFieldAccess(blockId);
    const condition = rewriteExpression(node.expression, scriptBindings, `template ${blockId} condition`, undefined, globalBindings);

    if (node.mode === 'toggle') {
      lines.push(`${indent}${blockRef} = CreateObject("roSGNode", "Group")`);
      lines.push(`${indent}${blockRef}.visible = ${condition}`);
      lines.push(`${indent}${parentRefExpr}.appendChild(${blockRef})`);
      emitSubtreeConstruction(node.children, blockRef, depth, lines, scriptBindings, globalBindings, blockIdByNode, eachBlockIdByNode, tempCounter, componentName, eachItemsDictBlockIds);
      continue;
    }

    // A nested destroy-mode block only materializes now if its own condition already holds.
    lines.push(`${indent}if ${condition} then`);
    lines.push(`${indent}  ${blockRef} = CreateObject("roSGNode", "Group")`);
    lines.push(`${indent}  ${parentRefExpr}.appendChild(${blockRef})`);
    emitSubtreeConstruction(node.children, blockRef, depth + 1, lines, scriptBindings, globalBindings, blockIdByNode, eachBlockIdByNode, tempCounter, componentName, eachItemsDictBlockIds);
    lines.push(`${indent}end if`);
  }
}

/**
 * `sub <componentName>__create_if_N()` — builds the block's subtree from scratch and inserts it
 * into its parent at the correct runtime-computed sibling index. When `transition.inConfig` is
 * set, starts the enter animation as the LAST line, after `insertChild` — the target element
 * (constructed as part of this same subtree, above) must already be attached to the real scene
 * tree before `.control = "start"` runs, matching the ordering constraint this feature's toggle-
 * mode retrofit already established (see `codegen/brs-emitter.ts`'s `emitCascadeLines`).
 */
export function emitConditionalCreateSub(
  block: ConditionalBlock,
  scriptBindings: ScriptBindings,
  globalBindings: GlobalBindingsContext,
  blockIdByNode: ReadonlyMap<TemplateIfBlock, string>,
  eachBlockIdByNode: ReadonlyMap<TemplateEachBlock, string>,
  componentName: string,
  eachItemsDictBlockIds: ReadonlySet<string> = new Set(),
  transition: ResolvedBlockTransition | null = null,
): string {
  const blockRef = mFieldAccess(block.id);
  const lines: string[] = [`sub ${conditionalCreateSubName(componentName, block.id)}()`, `  ${blockRef} = CreateObject("roSGNode", "Group")`];
  const tempCounter = { n: 0 };
  emitSubtreeConstruction(block.children, blockRef, 1, lines, scriptBindings, globalBindings, blockIdByNode, eachBlockIdByNode, tempCounter, componentName, eachItemsDictBlockIds);

  lines.push('  ft_idx = 0');
  for (const sibling of block.precedingSiblings) {
    if (sibling.kind === 'always-present') {
      lines.push('  ft_idx = ft_idx + 1');
    } else {
      lines.push(`  if ${mFieldAccess(sibling.id)} <> invalid then`);
      lines.push('    ft_idx = ft_idx + 1');
      lines.push('  end if');
    }
  }
  lines.push(`  ${containerRefExpr(block.containerId)}.insertChild(${blockRef}, ft_idx)`);
  if (transition?.inConfig) {
    lines.push(...emitInitialKeyframeSnapLines(transition.inConfig.step, null, 1));
    lines.push(...emitFieldToInterpRefreshLines(transition.inRefreshRefs, 1));
    lines.push(`  ${mFieldAccess(animationNodeId(transition.inConfig.name))}.control = "start"`);
  }
  lines.push('end sub');
  return lines.join('\n');
}

/**
 * One `m.<targetId>.<field> = <literal>` line per interpolator anywhere in an `in:` transition's
 * own step tree (recursing through `sequential`/`parallel` composition), setting each target field
 * to that interpolator's OWN first keyframe value (`keyValue.items[0]`) — run immediately before
 * the `in:` animation's own `.control = "start"` line, in ADDITION to (not instead of) Roku's own
 * automatic "snap to key[0] when an Animation starts" behavior.
 *
 * Exists to close a real, perceptible visual race: a freshly `CreateObject`'d node (destroy mode)
 * or a node whose field was never explicitly initialized to match `key[0]` (toggle mode, first-ever
 * show) is visible at Roku's own bare field default — e.g. `scale = [1, 1]`, full size — for
 * whatever window exists between `insertChild`/`visible = true` and the interpolator's own
 * automatic key[0] snap actually applying. SceneGraph's render thread runs independently of the
 * script thread, so even purely-synchronous BrightScript statements with no explicit yield between
 * them are not guaranteed immune to the render thread sampling scene state in between — a `scale:
 * [0.5, 1]` pop-in could render one frame at the bare-default full size, THEN visibly snap down to
 * 0.5, THEN grow back to 1.0, which reads to a viewer as "the animation played twice" (a
 * shrink-then-grow, immediately preceded by an unexplained flash to full size). Setting the target
 * field explicitly, in the SAME script-thread statement batch that constructs/shows the block,
 * removes the bare-default window entirely — the node is never observably at any value other than
 * `key[0]` before the animation takes over. Only ever applied to the `in:` side: the `out:` side's
 * own first-applied value (via `reverse`) is whatever the target ALREADY visibly has, so there is
 * no bare-default window to close there.
 */
function emitInitialKeyframeSnapLines(step: ParsedAnimationStep, inheritedTargetId: string | null, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const effectiveTargetId = step.targetId ?? inheritedTargetId;
  if (step.composition !== null) {
    return step.composition.steps.flatMap((child) => emitInitialKeyframeSnapLines(child, effectiveTargetId, depth));
  }
  return step.interpolators.map((interp) => {
    // Non-null by construction — analysis/animation-config.ts's parseAnimationConfig runs
    // validateEffectiveTargets over the whole step tree before this module ever sees it.
    const targetId = interp.targetId ?? effectiveTargetId;
    const firstValue = interp.keyValue.kind === 'array' ? interp.keyValue.items[0] : interp.keyValue;
    return `${indent}${mFieldAccess(targetId!)}.${interp.fieldName} = ${printArrayAttr(firstValue)}`;
  });
}

/**
 * Two `m["$$<id>"].fieldToInterp = ...` lines per ref (blank it, then set it back), run
 * immediately before an `in:`/`out:` animation's own `.control = "start"` — see
 * `codegen/animation-emitter.ts`'s `RefreshableInterpolatorRef` doc comment for why this is needed
 * EVERY time (not just once, unlike a `scaled: true` interpolator's one-time `init()` override): a
 * `{#if:destroy}` block's target node is destroyed and recreated on every show/hide cycle, and
 * Roku's own `fieldToInterp` resolution caches the FIRST resolved target, silently going stale on
 * every subsequent cycle without this. Empty (a no-op) for a toggle-mode block's transition, which
 * never needs it.
 *
 * **Confirmed live, the hard way, that a single re-assignment to the SAME string value does NOT
 * work**: `SetField` with a value that's identical to the field's current value appears to be a
 * silent no-op on Roku (no field-change side effect at all, cached resolution untouched) — a
 * single `fieldToInterp = "card.opacity"` line, when the field was already `"card.opacity"` from
 * the previous cycle, left the interpolator bound to the stale, already-destroyed target exactly
 * as before. Blanking it to `""` FIRST, then setting it back to the real value, forces two
 * genuinely different assignments — confirmed live this actually re-resolves the target on every
 * cycle, including the first (setting an already-`""` field to `""` is itself a no-op, but the XML
 * default is the REAL fieldToInterp string, never `""`, so the very first cycle's blank IS a real
 * change too).
 */
function emitFieldToInterpRefreshLines(refs: readonly { readonly id: string; readonly fieldToInterp: string }[], depth: number): string[] {
  const indent = '  '.repeat(depth);
  // Reuses the same `m["$$<id>"]` cached reference `emitInitFunction`'s own findNode-caching loop
  // already populates for every such ref (once, at init()) — no need to re-findNode() on every
  // create/hide cycle.
  return refs.flatMap((ref) => [`${indent}${mFieldAccess(ref.id)}.fieldToInterp = ""`, `${indent}${mFieldAccess(ref.id)}.fieldToInterp = "${ref.fieldToInterp}"`]);
}

/**
 * Unregisters every focusable element in `block`'s subtree from the focus manager, then calls
 * `recoverFocusFor` once (if any were actually unregistered) — the exact lines
 * `emitConditionalDestroySub` normally bundles into its own single sub, extracted here so a
 * TRANSITIONING destroy-mode block's cascade can run them immediately (node still attached, exit
 * animation about to start) instead of deferred to match the delayed `removeChild` — see
 * `emitConditionalBlockCascadeCheck`'s own doc comment. Returned lines are pre-indented to `depth`.
 */
function emitFocusPrepareLines(block: ConditionalBlock, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const nestedFocusableIds = collectNestedFocusableIds(block.children);
  const unregisterLines = nestedFocusableIds.flatMap((elementId) => {
    const ref = mFieldAccess(elementId);
    return [`${indent}if ${ref} <> invalid then`, `${indent}  ${focusUnregisterCall(ref)}`, `${indent}end if`];
  });
  return [...unregisterLines, ...(nestedFocusableIds.length > 0 ? [`${indent}${globalFieldRef('focus')}.callFunc("recoverFocusFor", m.top)`] : [])];
}

/**
 * `sub <componentName>__destroy_if_N()` — removes the block's wrapper from
 * its parent and nulls every cached ref in its subtree (including a nested
 * `{#if}`/`{#if:destroy}` block's own id, and — three slots each — every
 * nested `{#each}` block's own id/keys/nodes), so the next construction
 * always starts from a clean slate. A nested `{#each}` block's own rendered
 * items need no explicit teardown of their own here: `removeChild` above
 * detaches the whole subtree (including every item `Group` the each ever
 * created) at once, and BrightScript garbage-collects it once nothing
 * references it — only the *flat* bookkeeping slots this destroy sub itself
 * owns need nulling.
 *
 * `skipFocusHandling` (true only for a block with a resolved exit-animation transition) omits the
 * unregister/`recoverFocusFor` lines this sub would otherwise bundle in — for a transitioning
 * block, `emitFocusPrepareLines` above already ran those at cascade time (exit-animation-start),
 * and this sub itself doesn't run until the exit animation reports `state="stopped"` (see
 * `emitExitAnimationStateChangeHandler`) — by which point the focusable content was already
 * unregistered, so re-running it here would double-call `unregister`/`recoverFocusFor` (harmless,
 * since both are idempotent/no-op-safe, but pointless and confusing to read).
 */
export function emitConditionalDestroySub(block: ConditionalBlock, componentName: string, skipFocusHandling = false): string {
  const blockRef = mFieldAccess(block.id);
  const eachSlotResets = block.nestedEachIds.flatMap((id) => [`    ${mFieldAccess(id)} = invalid`, `    ${mFieldAccess(id, '_keys')} = invalid`, `    ${mFieldAccess(id, '_nodes')} = invalid`]);
  // Unregister every bind: observer anywhere in this subtree, including one belonging to a nested
  // destroy block that's still mounted right now (removeChild below takes the whole subtree with
  // it). Each check is individually guarded — unlike the plain m.<id> = invalid nulling below, a
  // nested destroy block may have already torn itself down independently earlier, leaving that
  // inner id already invalid; calling a method on invalid crashes, a plain assignment doesn't.
  const unobserveLines = collectNestedBindAttributes(block.children).flatMap(({ elementId, fieldName }) => {
    const ref = mFieldAccess(elementId);
    return [`    if ${ref} <> invalid then`, `      ${ref}.UnobserveFieldScoped(${brsStringLiteral(fieldName)})`, `    end if`];
  });
  // Unregister every focusable element anywhere in this subtree from the focus manager before
  // removeChild, so IsInFocusChain() is still valid when unregister() checks it — same ordering
  // requirement, and same "guard individually" reasoning, as the bind: unobserve lines above.
  // Skipped entirely for a transitioning block — see this function's own doc comment.
  const nestedFocusableIds = skipFocusHandling ? [] : collectNestedFocusableIds(block.children);
  const unregisterLines = nestedFocusableIds.flatMap((elementId) => {
    const ref = mFieldAccess(elementId);
    return [`    if ${ref} <> invalid then`, `      ${focusUnregisterCall(ref)}`, `    end if`];
  });
  // Cascade the component-unmount hook (see naming.ts's UNMOUNT_FUNCTION_NAME doc comment) to every
  // id in this subtree before removeChild — a native primitive silently no-ops (an undeclared
  // interface function), a nested `.thr`-compiled custom component's own generated ft_unmount() runs
  // its own local cleanup (e.g. force-stopping any pending setTimeout/setInterval it created) and
  // forwards the cascade to ITS OWN nested children, one level at a time. Same individually-guarded
  // shape as unobserveLines/unregisterLines above — a nested destroy block may have already torn
  // itself down independently, leaving that inner id already invalid.
  const unmountLines = block.nestedIds.flatMap((id) => {
    const ref = mFieldAccess(id);
    return [`    if ${ref} <> invalid then`, `      ${ref}.callFunc("${UNMOUNT_FUNCTION_NAME}")`, `    end if`];
  });
  const lines: string[] = [
    `sub ${conditionalDestroySubName(componentName, block.id)}()`,
    `  if ${blockRef} <> invalid then`,
    ...unobserveLines,
    ...unregisterLines,
    ...unmountLines,
    `    ${containerRefExpr(block.containerId)}.removeChild(${blockRef})`,
    ...block.nestedIds.map((id) => `    ${mFieldAccess(id)} = invalid`),
    ...eachSlotResets,
    `    ${blockRef} = invalid`,
    // Called once, after removeChild — and scoped to THIS component (`m.top`): recoverFocusFor()
    // acts only when this very component is the one that just lost the focused node, so a teardown
    // that never held focus is a cheap no-op and can never grab focus belonging to someone else.
    // Calling it here (rather than trying to reassign focus at unregister() time) is what survives
    // this destroy sub being followed by yet more tree mutations elsewhere in the same cascade —
    // see runtime-assets/FocusManager's own doc comment on `recoverFocusFor` and
    // findings/focus-runtime-bugs.md.
    ...(nestedFocusableIds.length > 0 ? [`    ${globalFieldRef('focus')}.callFunc("recoverFocusFor", m.top)`] : []),
    '  end if',
    'end sub',
  ];
  return lines.join('\n');
}

/**
 * Every `bind:` attribute anywhere in `nodes` — recurses into elements and
 * nested `{#if}`/`{#if:destroy}` blocks (mirrors `collectNestedIds`'s
 * element/if-only recursion), never into an `{#each}` body (a bind target
 * can't live there, see `analysis/bind-targets.ts`'s `template/bind-inside-each`).
 * Used by `emitConditionalDestroySub` to unobserve every bind target in a
 * torn-down subtree.
 */
function collectNestedBindAttributes(nodes: readonly TemplateNode[]): Array<{ elementId: string; fieldName: string }> {
  const out: Array<{ elementId: string; fieldName: string }> = [];
  for (const node of nodes) {
    walkTemplate(node, {
      recurseIntoEach: false,
      onElement: (element) => {
        for (const attr of element.attributes) {
          if (attr.kind === 'bind') out.push({ elementId: element.id!, fieldName: attr.name });
        }
      },
    });
  }
  return out;
}

/**
 * Every `focusable`-bearing (static or dynamic) element anywhere in `nodes`, WITH its own
 * `isDefault` flag — mirrors `collectNestedBindAttributes`'s element/if-only recursion. `{#each}`-
 * nested focusable elements are excluded for the same reason `bind:` targets are — a nested each's
 * own item construction/teardown owns that registration lifecycle instead (see
 * `codegen/each-block-emitter.ts`).
 */
function collectNestedFocusableElements(nodes: readonly TemplateNode[]): FocusableElement[] {
  const out: FocusableElement[] = [];
  for (const node of nodes) {
    walkTemplate(node, {
      recurseIntoEach: false,
      onElement: (element) => {
        const focusableAttr = element.attributes.find((a) => (a.kind === 'static' || a.kind === 'dynamic') && a.name === FOCUSABLE_ATTRIBUTE_NAME);
        if (focusableAttr) {
          out.push({ elementId: element.id!, isStaticTrue: focusableAttr.kind === 'static' && focusableAttr.value === 'true', isDefault: isStaticallyDefaultFocusTrue(element) });
        }
      },
    });
  }
  return out;
}

/** Every `focusable`-bearing (static or dynamic) element id anywhere in `nodes` — thin id-only wrapper over `collectNestedFocusableElements`. Used by `emitConditionalDestroySub` to unregister every focusable element in a torn-down subtree from the focus manager, regardless of whether it was ever actually registered (a static `focusable="false"` element is never registered in the first place — `unregister` is a safe no-op against a node it never saw). */
function collectNestedFocusableIds(nodes: readonly TemplateNode[]): string[] {
  return collectNestedFocusableElements(nodes).map((e) => e.elementId);
}

/** Every destroy-mode block's create+destroy sub pair — toggle-mode blocks need neither, they're plain `visible` bindings on an always-present node. `eachItemsDictBlockIds` (each-block id -> needs the `_items` companion dict, see `codegen/each-block-emitter.ts`'s `eachBlocksNeedingItemsDict`) is threaded through purely so a top-level `{#each}` nested inside a destroy-mode subtree initializes its `_items` dict at construction time, same as one that's statically present already does in `brs-emitter.ts`'s `emitInitFunction` — computed by the caller (not re-derived here) to avoid a circular value-import between this module and each-block-emitter.ts (which already imports *this* module's own `analyzeTemplateBlocks`/`brsStringLiteral`). */
export function emitConditionalBlockSubs(
  analysis: ConditionalBlockAnalysis,
  eachAnalysis: EachBlockAnalysis,
  scriptBindings: ScriptBindings,
  componentName: string,
  globalBindings: GlobalBindingsContext = NO_GLOBAL_BINDINGS,
  eachItemsDictBlockIds: ReadonlySet<string> = new Set(),
  blockTransitions: ReadonlyMap<string, ResolvedBlockTransition> = new Map(),
): string[] {
  const sections: string[] = [];
  for (const block of analysis.blocks) {
    if (block.mode !== 'destroy') continue;
    // A destroy-mode block nested inside an {#each}'s body never gets its own top-level
    // create/destroy subs — its whole lifecycle is inlined into its enclosing each's own
    // per-item construct/update code instead (see codegen/each-block-emitter.ts).
    if (analysis.nearestEachAncestorById.has(block.id)) continue;
    const transition = blockTransitions.get(block.id) ?? null;
    sections.push(
      emitConditionalCreateSub(block, scriptBindings, globalBindings, analysis.blockIdByNode, eachAnalysis.blockIdByNode, componentName, eachItemsDictBlockIds, transition),
    );
    sections.push(emitConditionalDestroySub(block, componentName, transition?.outConfig != null));
  }
  return sections;
}

/** Wraps `lines` in `if m.<nearestDestroyAncestor> <> invalid then ... end if` when `id` lives inside a destroy-mode subtree — a no-op passthrough otherwise. Shared by both an ordinary/toggle binding's cascade line (brs-emitter.ts) and a nested block's own create/destroy check below. */
export function wrapWithNearestDestroyGuard(id: string, lines: readonly string[], nearestDestroyAncestorById: ReadonlyMap<string, string>, depth: number): string[] {
  const ancestorId = nearestDestroyAncestorById.get(id);
  if (!ancestorId) return [...lines];
  const indent = '  '.repeat(depth);
  return [`${indent}if ${mFieldAccess(ancestorId)} <> invalid then`, ...lines, `${indent}end if`];
}

/**
 * The guarded, idempotent create/destroy resolution for one destroy-mode
 * block, run whenever a source its condition depends on changes (see
 * `emitCascadeLines` in brs-emitter.ts) or once at `init()` for the block's
 * initial condition value. Idempotent via the `m.<id> = invalid`/`<> invalid`
 * checks: re-running this when the condition's truthiness hasn't actually
 * flipped is a no-op either way.
 */
/**
 * `transition` is non-null only for a destroy-mode block with a resolved `ResolvedBlockTransition`
 * (see `analysis/transitions.ts`) — a block with none keeps today's exact create/destroy shape,
 * strictly additive (per GRAMMAR.md's "animation" section). When `transition.outConfig` is set, the
 * "hide" branch no longer calls the destroy sub directly: it runs the same focus-prepare lines
 * `emitFocusPrepareLines` returns for toggle mode (unregister every focusable element in this
 * subtree, then `recoverFocusFor` — while the subtree is still fully attached, so
 * `IsInFocusChain()`/`BoundingRect()` stay valid), then starts the exit animation. The actual
 * `removeChild`/nulling is deferred to `emitExitAnimationStateChangeHandler`, which calls
 * `emitConditionalDestroySub`'s own sub with `skipFocusHandling: true` once the exit animation
 * reports `state="stopped"` (and the block's condition is still false — see that function's own
 * doc comment for the stale-completion guard). `transition.inConfig`, if set, is handled entirely
 * inside `emitConditionalCreateSub` itself (started as the last line, after `insertChild`) — this
 * function's own "create" branch is unchanged either way.
 */
export function emitConditionalBlockCascadeCheck(
  block: ConditionalBlock,
  scriptBindings: ScriptBindings,
  globalBindings: GlobalBindingsContext,
  nearestDestroyAncestorById: ReadonlyMap<string, string>,
  depth: number,
  componentName: string,
  transition: ResolvedBlockTransition | null = null,
): string[] {
  const indent = '  '.repeat(depth);
  const condition = rewriteExpression(block.expression, scriptBindings, `template ${block.id} condition`, undefined, globalBindings);
  const blockRef = mFieldAccess(block.id);
  const hideLines =
    transition?.outConfig != null
      ? [
          ...emitFocusPrepareLines(block, depth + 1),
          ...emitFieldToInterpRefreshLines(transition.outRefreshRefs, depth + 1),
          `${indent}  ${mFieldAccess(animationNodeId(transition.outConfig.name))}.control = "start"`,
        ]
      : [`${indent}  ${conditionalDestroySubName(componentName, block.id)}()`];
  const inner = [
    `${indent}if ${condition} and ${blockRef} = invalid then`,
    `${indent}  ${conditionalCreateSubName(componentName, block.id)}()`,
    `${indent}else if not (${condition}) and ${blockRef} <> invalid then`,
    ...hideLines,
    `${indent}end if`,
  ];
  return wrapWithNearestDestroyGuard(block.id, inner, nearestDestroyAncestorById, depth);
}

/**
 * The transition-aware replacement for a toggle-mode block's plain `m.<id>.visible = <bool>`
 * cascade line, used only when this block has a `ResolvedBlockTransition` (see
 * `analysis/transitions.ts`) — a block with none keeps the ordinary, untouched assignment via
 * `emitBindingAssignment`; this function is never called for it (strictly additive, per
 * GRAMMAR.md's "animation" section).
 *
 * Show: cancels any still-in-flight exit (`control = "stop"` on the out-animation, if one exists —
 * re-entering before a prior exit finished must not let that stale run's eventual "stopped" event
 * hide the now-re-shown block; see `emitExitAnimationStateChangeHandler`'s own condition re-check
 * for the other half of that guard), sets `visible = true`, re-registers this block's own focusable
 * content (a cheap no-op via the focus manager's idempotent `register` if it was never unregistered
 * — see below), then starts the enter animation.
 *
 * Hide: when an exit animation exists, unregisters every focusable element in this block's subtree
 * and calls `recoverFocusFor` BEFORE starting the exit animation — while the node is still
 * `visible=true` and attached, so `IsInFocusChain()`/`BoundingRect()` stay valid (same ordering
 * constraint `emitConditionalDestroySub`'s own `unregister`-before-`removeChild` already relies on)
 * — not deferred to match the delayed `visible=false`, since nothing here gates candidate/focus
 * scoring on `visible` (confirmed: `FlashTheaterFocusManager.brs`'s `absoluteRect()`/`bestCandidate()`
 * have no such check). `visible=false` itself IS deferred — to `emitExitAnimationStateChangeHandler`,
 * once the exit animation actually reports `state="stopped"`. Without an exit animation, hides
 * instantly with no unregister step at all — unchanged from this block's pre-transition behavior.
 */
export function emitToggleTransitionCascadeLines(block: ConditionalBlock, transition: ResolvedBlockTransition, condition: string, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const blockRef = mFieldAccess(block.id);
  const focusable = transition.outConfig !== null ? collectNestedFocusableElements(block.children) : [];

  const showLines: string[] = [];
  if (transition.outConfig !== null) {
    showLines.push(`${indent}  ${mFieldAccess(animationNodeId(transition.outConfig.name))}.control = "stop"`);
  }
  showLines.push(`${indent}  ${blockRef}.visible = true`);
  for (const el of focusable) {
    showLines.push(`${indent}  ${focusRegisterCall(mFieldAccess(el.elementId), el.isDefault)}`);
  }
  if (transition.inConfig !== null) {
    showLines.push(...emitInitialKeyframeSnapLines(transition.inConfig.step, null, depth + 1));
    showLines.push(`${indent}  ${mFieldAccess(animationNodeId(transition.inConfig.name))}.control = "start"`);
  }

  const hideLines: string[] = [];
  if (transition.outConfig !== null) {
    hideLines.push(...emitFocusPrepareLines(block, depth + 1));
    hideLines.push(`${indent}  ${mFieldAccess(animationNodeId(transition.outConfig.name))}.control = "start"`);
  } else {
    hideLines.push(`${indent}  ${blockRef}.visible = false`);
  }

  return [`${indent}if ${condition} then`, ...showLines, `${indent}else`, ...hideLines, `${indent}end if`];
}

/**
 * Generated `ObserveFieldScoped("state", ...)` handler for ONE ANIMATION NODE (by name) — registered
 * exactly once, in `init()` (see `emitAnimationStateChangeObserverInitLine`), for every animation name
 * with at least one "consumer": a transitioning block (toggle OR destroy mode) whose
 * `ResolvedBlockTransition.outConfig` resolves to this name, and/or a `.onFinish(callback)`
 * registration for this name.
 *
 * Keyed by animation name rather than block id purely as a generalization — see `naming.ts`'s
 * `animationStateChangeHandlerName` doc comment for why this is NOT resolving an actual collision: a
 * `.onFinish()` registration and a Layer 2 `out:`/`transition:` attribute referencing the SAME
 * declared name always end up on two distinct nodes in practice (Layer 2 always synthesizes its own
 * per-block-direction copy), and `transitionAnimationName`'s own per-block synthesis means two
 * different blocks can never collide on one synthetic name either — `exitConsumers` is always
 * length-0-or-1 for every name the current feature set can actually produce. The loop below still
 * handles a longer list correctly (each consumer gets its own re-checked `if`), so this stays
 * generalized rather than hard-coded to "at most one", but nothing today exercises more than one.
 *
 * Each exit consumer re-checks ITS OWN block's condition before actually finishing the hide: an exit
 * animation that reports "stopped" AFTER its block has since been re-shown (condition flipped back to
 * true, cancelling — but not un-firing the eventual "stopped" event of — the old exit run, see
 * `emitToggleTransitionCascadeLines`'s/`emitConditionalBlockCascadeCheck`'s own "stop" line) must not
 * finish hiding a block that's supposed to be visible right now. The "finish" action itself differs by
 * mode: toggle mode just defers `visible = false` (the node was never detached); destroy mode calls
 * the block's own destroy sub (`skipFocusHandling: true` — the unregister/`recoverFocusFor` pair
 * already ran at exit-start, see `emitFocusPrepareLines`), which actually detaches and nulls the whole
 * subtree. Guarded by `blockRef <> invalid` for destroy mode only — toggle mode's wrapper is always
 * present, nothing to guard against.
 *
 * The `onFinish` callback (if `hasOnFinishCallback`) runs last, after every exit consumer's own check
 * — always extracted to a local (`cb = ...`) before being invoked, never called via direct AA
 * dot-access, per `naming.ts`'s `animationFinishCallbackFieldAccess` doc comment.
 */
export function emitAnimationStateChangeHandler(
  name: string,
  exitConsumers: readonly ConditionalBlock[],
  hasOnFinishCallback: boolean,
  componentName: string,
  scriptBindings: ScriptBindings,
  globalBindings: GlobalBindingsContext,
): string {
  const body: string[] = [];
  for (const block of exitConsumers) {
    const condition = rewriteExpression(block.expression, scriptBindings, `template ${block.id} condition`, undefined, globalBindings);
    const finishLines =
      block.mode === 'toggle'
        ? [`      ${mFieldAccess(block.id)}.visible = false`]
        : [`      if ${mFieldAccess(block.id)} <> invalid then`, `        ${conditionalDestroySubName(componentName, block.id)}()`, '      end if'];
    body.push(`    if not (${condition}) then`, ...finishLines, '    end if');
  }
  if (hasOnFinishCallback) {
    body.push(`    cb = ${animationFinishCallbackFieldAccess(name)}`, '    if cb <> invalid then cb()');
  }
  return [`sub ${animationStateChangeHandlerName(name)}(event as object)`, '  if event.GetData() = "stopped" then', ...body, '  end if', 'end sub'].join('\n');
}

/** `m["$$ft_anim_<name>"].ObserveFieldScoped("state", "on_<name>_StateChange")` — one line per animation name with at least one consumer (an `out:`/`transition:` block, and/or an `.onFinish()` registration), emitted once in `init()`. */
export function emitAnimationStateChangeObserverInitLine(name: string): string {
  return `  ${mFieldAccess(animationNodeId(name))}.ObserveFieldScoped("state", "${animationStateChangeHandlerName(name)}")`;
}
