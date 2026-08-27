/**
 * `navigate-out:<name>`/`navigate-in:<name>`/`back-out:<name>`/`back-in:<name>` — collection +
 * validation + resolution of a `<FlashTheaterRouterOutlet>`'s own router-driven mount/unmount
 * transitions, keyed by OUTLET ELEMENT id. Mirrors `analysis/transitions.ts`'s `resolveBlockTransitions`
 * shape (same `resolveTransitionAnimation` resolution, same duplicate-attribute validation), with one
 * addition that Layer 2 doesn't need: every resolved animation's own effective target(s) must be the
 * outlet ELEMENT ITSELF, never anything else. `FlashTheaterRouterOutlet.brs`'s runtime teleport/snap
 * mechanism (`_snapToFirstKeyframe`) is generic — it reads whichever animation is wired in and writes
 * straight to `m.top` (the outlet's own node), so it can only be safe if every wired-in animation's
 * own target is guaranteed, at compile time, to always BE the outlet — unlike a Layer 2 `in:`/`out:`
 * attribute, which is emitted per-target at compile time and never needs this generic runtime
 * indirection. See findings/router-transitions.md.
 */
import { CompileError, TemplateElement } from '../dsl-parser/dsl-ast.js';
import { walkTemplate } from './template-walk.js';
import { ParsedAnimationConfig, collectEffectiveTargetIds } from './animation-config.js';
import { resolveTransitionAnimation } from './animation-presets.js';
import { stepHasRepeat } from './transitions.js';
import { routerOutletTransitionName } from '../codegen/naming.js';

type RouterTransitionAttribute = Extract<import('../dsl-parser/dsl-ast.js').TemplateAttribute, { kind: 'routerTransition' }>;

/**
 * Fixed tag name of the built-in runtime router-outlet component — kept in sync BY HAND with
 * `app-compiler.ts`'s own `FLASH_THEATER_ROUTER_OUTLET_COMPONENT_NAME` (not imported: `app-compiler.ts`
 * sits above `analysis/`, importing it here would invert the module layering — see this repo's own
 * "Compiler pipeline — module responsibilities" table in CLAUDE.md).
 */
const ROUTER_OUTLET_TAG_NAME = 'FlashTheaterRouterOutlet';

export interface ResolvedOutletTransition {
  readonly navigateIn: ParsedAnimationConfig | null;
  readonly navigateOut: ParsedAnimationConfig | null;
  readonly backIn: ParsedAnimationConfig | null;
  readonly backOut: ParsedAnimationConfig | null;
}

/** Every `navigate-out:`/`navigate-in:`/`back-out:`/`back-in:` attribute anywhere in the whole template (including nested inside an `{#each}` body, so a misplaced one can still be found and rejected — same precedent as `transitions.ts`'s own `collectAllTransitionAttributes`), each tagged with the element it's on. */
function collectAllRouterTransitionAttributes(root: TemplateElement): { readonly element: TemplateElement; readonly attr: RouterTransitionAttribute }[] {
  const out: { element: TemplateElement; attr: RouterTransitionAttribute }[] = [];
  walkTemplate(root, {
    recurseIntoEach: true,
    onElement: (element) => {
      for (const attr of element.attributes) {
        if (attr.kind === 'routerTransition') out.push({ element, attr });
      }
    },
  });
  return out;
}

function attributeLabel(navDirection: 'navigate' | 'back', phase: 'in' | 'out'): string {
  return `${navDirection}-${phase}:`;
}

/**
 * Resolves every `<FlashTheaterRouterOutlet>`'s own `navigate-out:`/`navigate-in:`/`back-out:`/
 * `back-in:` attributes, validating along the way:
 * - a router-transition attribute is only valid on a `<FlashTheaterRouterOutlet>` element.
 * - at most one attribute per (direction, phase) pair per outlet.
 * - every resolved animation's own effective target(s) must be the outlet's own id — see this
 *   module's own doc comment for why.
 *
 * Returns a map keyed by outlet element id — `compile.ts` looks up each outlet's own entry (if any)
 * to decide what to wire into `emitInitFunction`'s field-wiring lines.
 */
export function resolveOutletTransitions(root: TemplateElement, animationConfigsByName: ReadonlyMap<string, ParsedAnimationConfig>): ReadonlyMap<string, ResolvedOutletTransition> {
  const byOutletId = new Map<string, { element: TemplateElement; attrs: RouterTransitionAttribute[] }>();

  for (const { element, attr } of collectAllRouterTransitionAttributes(root)) {
    if (element.tagName !== ROUTER_OUTLET_TAG_NAME) {
      throw new CompileError({
        code: 'router/transition-outside-outlet',
        message: `"${attributeLabel(attr.navDirection, attr.phase)}${attr.animationRef}" on element "${element.id ?? element.tagName}" is only valid on a <${ROUTER_OUTLET_TAG_NAME}> element.`,
      });
    }
    const elementId = element.id!;
    const entry = byOutletId.get(elementId) ?? { element, attrs: [] };
    entry.attrs.push(attr);
    byOutletId.set(elementId, entry);
  }

  const result = new Map<string, ResolvedOutletTransition>();

  for (const [outletId, { element, attrs }] of byOutletId) {
    const resolvedByKey = new Map<string, ParsedAnimationConfig>();

    for (const navDirection of ['navigate', 'back'] as const) {
      for (const phase of ['in', 'out'] as const) {
        const matching = attrs.filter((a) => a.navDirection === navDirection && a.phase === phase);
        if (matching.length === 0) continue;
        if (matching.length > 1) {
          throw new CompileError({
            code: 'router/duplicate-transition-attribute',
            message: `<${ROUTER_OUTLET_TAG_NAME} id="${outletId}"> declares more than one "${attributeLabel(navDirection, phase)}" attribute.`,
          });
        }

        const attr = matching[0];
        const contextLabel = `${attributeLabel(navDirection, phase)}${attr.animationRef} on <${ROUTER_OUTLET_TAG_NAME} id="${outletId}">`;
        const syntheticName = routerOutletTransitionName(outletId, navDirection, phase);
        // `reverseDeclaredOnOut: false` — this feature's own four attributes are each an
        // independently authored, already-correctly-directed animation (never "the reverse of" its
        // in:/out: counterpart the way Layer 2's shared in:/out: animations are). See
        // `resolveTransitionAnimation`'s own doc comment for the full rationale and the live bug this
        // fixes. Presets (e.g. a bare `navigate-out:slide`) are unaffected — they still reverse on
        // "out", same as Layer 2.
        const config = resolveTransitionAnimation(attr.animationRef, attr.overrideConfigText, element, phase, syntheticName, animationConfigsByName, contextLabel, false);

        // Mirrors `transitions.ts`'s own `animation/repeat-not-supported-for-exit-animation` check —
        // `FlashTheaterRouterOutlet.brs`'s `_onOutAnimStopped` is the ONLY place that tears down the
        // outgoing screen and mounts the next route, gated entirely on this animation's own `state`
        // field reporting `"stopped"`, which a `repeat: true` animation never does on its own. Only
        // the "out" phase is checked: `_onInAnimStopped` does nothing but unobserve/clear bookkeeping
        // — it gates no teardown or mount — so `repeat: true` on `navigate-in:`/`back-in:` is harmless,
        // same reasoning Layer 2 uses to leave its own `in:` side unrestricted.
        if (phase === 'out' && stepHasRepeat(config.step)) {
          throw new CompileError({
            code: 'router/repeat-not-supported-for-exit-transition',
            message: `${contextLabel} declares "repeat: true" somewhere in its own step tree — an exit transition must actually finish (report state="stopped") for this outlet's own deferred unmount/next-route mount to ever run, and a repeating animation never does on its own. Remove "repeat: true" from the animation used as this outlet's "${attributeLabel(navDirection, phase)}".`,
          });
        }

        const effectiveTargetIds = collectEffectiveTargetIds(config.step, null);
        for (const targetId of effectiveTargetIds) {
          if (targetId !== outletId) {
            throw new CompileError({
              code: 'router/transition-target-must-be-outlet',
              message: `${contextLabel} resolves to an animation targeting "${targetId}" — a router-outlet transition must target the outlet itself ("${outletId}"), since the outlet's own runtime teleports/snaps its own translation between phases. Declare "${attr.animationRef}" with target: ${outletId}.`,
            });
          }
        }

        resolvedByKey.set(`${navDirection}_${phase}`, config);
      }
    }

    if (resolvedByKey.size === 0) continue;

    result.set(outletId, {
      navigateIn: resolvedByKey.get('navigate_in') ?? null,
      navigateOut: resolvedByKey.get('navigate_out') ?? null,
      backIn: resolvedByKey.get('back_in') ?? null,
      backOut: resolvedByKey.get('back_out') ?? null,
    });
  }

  return result;
}
