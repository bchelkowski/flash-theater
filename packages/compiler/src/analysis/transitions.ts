/**
 * `transition:<name>`/`in:<name>`/`out:<name>` — collection + validation + resolution of every
 * `{#if}`/`{#if:destroy}` block's own enter/exit transition, keyed by BLOCK id (not element id):
 * a block's deferred-visibility/deferred-removal codegen (`codegen/conditional-block-emitter.ts`)
 * operates on the block as a whole, so at most one direct child of a given block may carry a
 * transition-family attribute — see `resolveBlockTransitions`'s own doc comment for why.
 */
import { CompileError, TemplateAttribute, TemplateElement } from '../dsl-parser/dsl-ast.js';
import { ConditionalBlockAnalysis } from './conditional-blocks.js';
import { walkTemplate } from './template-walk.js';
import { ParsedAnimationConfig, ParsedAnimationStep } from './animation-config.js';
import { resolveTransitionAnimation } from './animation-presets.js';
import { transitionAnimationName } from '../codegen/naming.js';
import { RefreshableInterpolatorRef } from '../codegen/animation-emitter.js';

type TransitionAttribute = Extract<TemplateAttribute, { kind: 'transition' }>;

export interface ResolvedBlockTransition {
  /** The one direct child of this block carrying a transition:/in:/out: attribute. */
  readonly targetElementId: string;
  /** `null` when this block has no enter animation (an `out:`-only block still shows instantly). */
  readonly inConfig: ParsedAnimationConfig | null;
  /** `null` when this block has no exit animation (an `in:`-only block still hides instantly). */
  readonly outConfig: ParsedAnimationConfig | null;
  /**
   * `true` for `{#if:destroy}`, `false` for `{#if}` — determines whether `inConfig`/`outConfig`'s
   * own interpolators need a `fieldToInterp` refresh before every `.control = "start"` (see
   * `codegen/animation-emitter.ts`'s `RefreshableInterpolatorRef` doc comment) or not. A toggle-mode
   * block's target element is NEVER destroyed/recreated (the same node for the block's whole
   * lifetime, only `visible` toggles), so its interpolators' `fieldToInterp` binding, once resolved
   * on first use, stays correctly bound forever — no refresh needed there.
   */
  readonly isDestroyMode: boolean;
  /**
   * Populated by `compile.ts`, AFTER `codegen/animation-emitter.ts`'s `emitAnimationXml` has
   * assigned each interpolator's own id (empty at `resolveBlockTransitions` time, since that's a
   * pure analysis pass with no codegen/id-assignment involvement yet) — always empty when
   * `isDestroyMode` is `false`. See `codegen/conditional-block-emitter.ts`'s `emitConditionalCreateSub`/
   * `emitConditionalBlockCascadeCheck`, the two call sites that actually emit the refresh lines.
   */
  readonly inRefreshRefs: readonly RefreshableInterpolatorRef[];
  readonly outRefreshRefs: readonly RefreshableInterpolatorRef[];
}

/** Every id anywhere in the template that IS a direct child of some `{#if}`/`{#if:destroy}` block — the only ids a transition-family attribute is legal on (see `resolveBlockTransitions`'s own doc comment on why it's scanned this way, not a whole-template walk). */
function directBlockChildIds(conditionalBlocks: ConditionalBlockAnalysis): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const block of conditionalBlocks.blocks) {
    for (const child of block.children) {
      if (child.kind === 'element' && child.id) ids.add(child.id);
    }
  }
  return ids;
}

/**
 * `true` if `repeat: true` is set anywhere in `step`'s own tree — the outermost node itself, or any
 * nested `sequential`/`parallel` composition step, at any depth. A composed animation's own `state`
 * never reaches `"stopped"` until every one of its child steps has, so a `repeat: true` buried
 * arbitrarily deep is just as fatal to the deferred-hide mechanism as one on the outermost node —
 * see `resolveBlockTransitions`'s own `animation/repeat-not-supported-for-exit-animation` check.
 * Exported for `compile.ts`'s own `animation/repeat-not-supported-with-onfinish` check, which needs
 * the exact same reasoning for a Layer 1 declaration's `.onFinish()` registration — `state` never
 * reports `"stopped"` for a looping animation, so an `onFinish` callback would provably never fire.
 */
export function stepHasRepeat(step: ParsedAnimationStep): boolean {
  if (step.repeat === true) return true;
  if (step.composition !== null) return step.composition.steps.some(stepHasRepeat);
  return false;
}

/** Every `transition:`/`in:`/`out:` attribute anywhere in the whole template (including nested inside an `{#each}` body, matched by `bind:`'s own precedent — a misplaced one must still be found so it can be rejected), each tagged with the element it's on. */
function collectAllTransitionAttributes(root: TemplateElement): { readonly elementId: string; readonly attr: TransitionAttribute }[] {
  const out: { elementId: string; attr: TransitionAttribute }[] = [];
  walkTemplate(root, {
    recurseIntoEach: true,
    onElement: (element) => {
      for (const attr of element.attributes) {
        if (attr.kind === 'transition') out.push({ elementId: element.id!, attr });
      }
    },
  });
  return out;
}

/**
 * Resolves every block's enter/exit transition, validating along the way:
 * - a `transition:`/`in:`/`out:` attribute must live on a DIRECT CHILD of an `{#if}`/`{#if:destroy}`
 *   block — `codegen/conditional-block-emitter.ts`'s deferred-visibility mechanism defers the
 *   BLOCK's own show/hide, so the transitioning element has to be something that block directly
 *   owns, not an arbitrarily-nested descendant (which could itself be behind its own nested
 *   conditional, with no single well-defined "this block's own mount moment" to hook the animation
 *   to).
 * - at most ONE direct child per block may carry any transition-family attribute — the block has
 *   exactly one deferred-visibility flag, so two independently-transitioning children would have no
 *   defined "whose animation gates the block's own visible/removeChild" answer.
 * - `transition:X` and `in:`/`out:` are mutually exclusive on the same element (the former already
 *   implies both directions) and at most one `in:`/one `out:`/one `transition:` per element.
 *
 * Returns a map keyed by block id — `codegen/conditional-block-emitter.ts`'s toggle/destroy-mode
 * retrofit looks up its own block's entry (if any) to decide whether to defer at all.
 */
export function resolveBlockTransitions(
  root: TemplateElement,
  conditionalBlocks: ConditionalBlockAnalysis,
  animationConfigsByName: ReadonlyMap<string, ParsedAnimationConfig>,
): ReadonlyMap<string, ResolvedBlockTransition> {
  const directChildIds = directBlockChildIds(conditionalBlocks);
  for (const { elementId } of collectAllTransitionAttributes(root)) {
    if (!directChildIds.has(elementId)) {
      throw new CompileError({
        code: 'animation/transition-outside-conditional-block',
        message: `transition:/in:/out: on element "${elementId}" is only valid on a DIRECT child of an {#if}/{#if:destroy} block — it has no enclosing block to defer show/hide for.`,
      });
    }
  }

  const result = new Map<string, ResolvedBlockTransition>();

  for (const block of conditionalBlocks.blocks) {
    const transitioningChildren = block.children.filter(
      (c): c is Extract<typeof c, { kind: 'element' }> => c.kind === 'element' && c.attributes.some((a) => a.kind === 'transition'),
    );
    if (transitioningChildren.length === 0) continue;
    if (transitioningChildren.length > 1) {
      throw new CompileError({
        code: 'animation/multiple-transitioning-children',
        message: `{#if${block.mode === 'destroy' ? ':destroy' : ''} ${block.expression}} (block ${block.id}) has more than one direct child with a transition:/in:/out: attribute — only one transitioning child is supported per block.`,
      });
    }

    const target = transitioningChildren[0];
    const elementId = target.id!;
    const attrs = target.attributes.filter((a): a is TransitionAttribute => a.kind === 'transition');
    const both = attrs.filter((a) => a.direction === 'both');
    const ins = attrs.filter((a) => a.direction === 'in');
    const outs = attrs.filter((a) => a.direction === 'out');

    if (both.length > 0 && (ins.length > 0 || outs.length > 0)) {
      throw new CompileError({
        code: 'animation/transition-both-and-directional-conflict',
        message: `Element "${elementId}" combines transition: with in:/out: — transition:<name> already sets both directions; use either transition: alone or in:/out: separately, not both.`,
      });
    }
    if (both.length > 1 || ins.length > 1 || outs.length > 1) {
      throw new CompileError({
        code: 'animation/duplicate-transition-attribute',
        message: `Element "${elementId}" declares more than one transition:/in:/out: attribute of the same direction.`,
      });
    }

    let inConfig: ParsedAnimationConfig | null = null;
    let outConfig: ParsedAnimationConfig | null = null;

    if (both.length === 1) {
      const attr = both[0];
      const contextLabel = `transition:${attr.animationRef} on element "${elementId}"`;
      inConfig = resolveTransitionAnimation(attr.animationRef, attr.overrideConfigText, target, 'in', transitionAnimationName(block.id, 'in'), animationConfigsByName, contextLabel);
      outConfig = resolveTransitionAnimation(attr.animationRef, attr.overrideConfigText, target, 'out', transitionAnimationName(block.id, 'out'), animationConfigsByName, contextLabel);
    } else {
      if (ins.length === 1) {
        const attr = ins[0];
        const contextLabel = `in:${attr.animationRef} on element "${elementId}"`;
        inConfig = resolveTransitionAnimation(attr.animationRef, attr.overrideConfigText, target, 'in', transitionAnimationName(block.id, 'in'), animationConfigsByName, contextLabel);
      }
      if (outs.length === 1) {
        const attr = outs[0];
        const contextLabel = `out:${attr.animationRef} on element "${elementId}"`;
        outConfig = resolveTransitionAnimation(attr.animationRef, attr.overrideConfigText, target, 'out', transitionAnimationName(block.id, 'out'), animationConfigsByName, contextLabel);
      }
    }

    // The deferred hide/removeChild mechanism (`codegen/conditional-block-emitter.ts`'s
    // `emitExitAnimationStateChangeHandler`) ONLY fires once the exit animation's own `state` field
    // reports `"stopped"` — which a `repeat: true` animation, by Roku's own design, never reports on
    // its own (it loops indefinitely until explicitly `control = "stop"`'d, which nothing here ever
    // does). `repeat: true` ANYWHERE in the out: config's step tree — not just the outermost node,
    // since a `sequential`/`parallel` composition also never completes if one of its own child steps
    // never completes — would leave the block PERMANENTLY visible/never-removed, stuck animating
    // forever with no way to recover short of navigating away and back. Caught here, at analysis
    // time, rather than left as a silent runtime hang a device pass would have to discover the hard
    // way (found by static reasoning, not live-reproduced — see findings/animation.md).
    if (outConfig && stepHasRepeat(outConfig.step)) {
      throw new CompileError({
        code: 'animation/repeat-not-supported-for-exit-animation',
        message: `The exit (out:) animation for element "${elementId}" declares "repeat: true" somewhere in its own step tree — an exit animation must actually finish (report state="stopped") for this block's deferred hide/removeChild to ever run, and a repeating animation never does on its own. Remove "repeat: true" from the animation used as this block's "out:"/"transition:" side.`,
      });
    }

    result.set(block.id, { targetElementId: elementId, inConfig, outConfig, isDestroyMode: block.mode === 'destroy', inRefreshRefs: [], outRefreshRefs: [] });
  }

  return result;
}
