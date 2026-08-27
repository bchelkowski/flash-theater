/**
 * Emits one `animation <name> { ... }` declaration's whole XML subtree — a single `<Animation>`
 * when its step has no composition, `<SequentialAnimation>`/`<ParallelAnimation>` wrapping
 * recursively-emitted `<Animation>` leaves otherwise. Returned as pre-indented XML lines, spliced
 * into `xml-emitter.ts`'s `<children>` as a sibling of the template root via `EmitXmlOptions.
 * extraChildrenXml` — see that option's own doc comment for why an `Animation` node has to be a
 * real per-component child (Roku resolves `fieldToInterp="id.field"` via `findNode`, scoped to
 * this component), unlike `Store`/`Router`/etc.'s separate-copied-singleton shape.
 *
 * No `runtime-assets/` file backs this feature — unlike `Http`/`Scale`/`Stream`, nothing here needs
 * a shared imperative helper function: every piece of behavior is either static XML (Roku's own
 * built-in `Animation`/`Interpolator` node types do the real work) or a couple of inline
 * `.control =`/`ObserveFieldScoped` lines per call site (see `analysis/identifier-rewrite.ts`'s
 * `.start()`/`.stop()`/... trigger sugar).
 */
import { LiteralValue } from '../analysis/literal-value.js';
import { InterpolatorKind, ParsedAnimationConfig, ParsedAnimationStep, ParsedInterpolatorStep } from '../analysis/animation-config.js';
import { animationNodeId } from './naming.js';

const INTERPOLATOR_TAG: Record<InterpolatorKind, string> = {
  float: 'FloatFieldInterpolator',
  vector2d: 'Vector2DFieldInterpolator',
  color: 'ColorFieldInterpolator',
};

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One `scaled: true` interpolator's own generated `id`, plus everything `codegen/brs-emitter.ts`'s
 * `emitInitFunction` needs to override its `keyValue` at runtime with `ft_scale(...)`-wrapped
 * entries once `ft_scaleFactor` is known — see `analysis/animation-config.ts`'s `scaled` doc
 * comment. Collected as a side effect of `emitAnimationXml`/`emitAllAnimationsXml` (an optional,
 * mutated-in-place output array) rather than a second independent tree walk, so the assigned `id`
 * can never drift out of sync with what actually landed in the XML.
 */
export interface ScaledInterpolatorRef {
  readonly id: string;
  readonly keyValue: LiteralValue;
}

/**
 * One interpolator's own generated `id` plus its `fieldToInterp` string, for an interpolator whose
 * effective target lives inside a `{#if:destroy}` block — either a block's own Layer 2 `in:`/`out:`
 * transition (see `analysis/transitions.ts`'s `ResolvedBlockTransition.isDestroyMode` doc comment),
 * or a Layer 1 `animation {}` declaration whose `target:` (or a per-field override) resolves to an
 * id inside such a block (see `analysis/animation-config.ts`'s `collectEffectiveTargetIds` and
 * `identifier-rewrite.ts`'s `rewriteAnimationControlCalls`, the call site that emits the refresh
 * lines for a Layer 1 `.start()` trigger — unlike Layer 2's exactly-two call sites, a Layer 1
 * trigger can be called from anywhere, so the refresh is injected at EVERY `.start()` call site for
 * an animation that needs it, not just one create/hide sub). Both cases share the exact same
 * underlying bug: Roku's `Animation`/`*FieldInterpolator` `fieldToInterp="<id>.<field>"` attribute
 * resolves the target node BY ID once, the first time the interpolator's `.control` field is ever
 * set to `"start"`, and does NOT re-resolve on a later `.control = "start"` even if a NEW node with
 * the same id has since replaced the original — confirmed live on a real Roku Ultra: a destroy-mode
 * `in:popIn` animation played correctly the very first time a block was shown (fresh target,
 * fresh resolution), then silently did nothing on every subsequent show (the target node had been
 * destroyed and recreated via `{#if:destroy}`'s own teardown/rebuild in between, but the
 * interpolator stayed bound to the ORIGINAL, now-detached node). Re-assigning `fieldToInterp`
 * forces Roku to invalidate that cached binding and re-resolve fresh on the next
 * `.control = "start"` — but confirmed live that a SINGLE re-assignment to the exact same string
 * value is itself a silent no-op (`SetField` skips the field-change side effect entirely when the
 * new value equals the current one), so every call site emits TWO lines per ref — blank it to `""`,
 * then set it back to the real value — immediately before that animation's own
 * `.control = "start"` line, every single time (not just once, unlike a `scaled: true`
 * interpolator's one-time `init()` override). A toggle-mode block's target, or a Layer 1 animation
 * whose target is never inside a `{#if:destroy}` block, is never destroyed/recreated, so it needs
 * no such refresh.
 */
export interface RefreshableInterpolatorRef {
  readonly id: string;
  readonly fieldToInterp: string;
}

/**
 * Prints an already-validated array-shaped `LiteralValue` (numbers, or nested 2-element arrays for
 * a Vector2D field) as the bracket-syntax literal text Roku's `key`/`keyValue` XML attributes
 * expect — e.g. `[0, 0.5, 1]` or `[[0,0], [50,-20], [300,0]]`. Exported (not just used for XML
 * attribute text) because the exact same bracket syntax is also valid BrightScript array-literal
 * source text — `brs-emitter.ts`'s `emitInitFunction` reuses it verbatim, unescaped, to print each
 * `scaled: true` interpolator's own `ft_scale(...)`-wrapped runtime override.
 */
export function printArrayAttr(value: LiteralValue): string {
  if (value.kind === 'number') return String(value.value);
  if (value.kind !== 'array') {
    // Unreachable given animation-config.ts's own upstream validation (every key/keyValue entry is
    // a number or a nested array by the time it reaches here) — a defensive fallback, not a real path.
    throw new Error(`printArrayAttr: expected a number or array LiteralValue, got "${value.kind}".`);
  }
  return `[${value.items.map(printArrayAttr).join(', ')}]`;
}

function emitInterpolatorXml(
  interp: ParsedInterpolatorStep,
  inheritedTargetId: string | null,
  depth: number,
  idPrefix: string,
  counter: { n: number },
  scaledRefs: ScaledInterpolatorRef[],
  destroyModeTargetIds: ReadonlySet<string>,
  refreshRefs: RefreshableInterpolatorRef[],
): string[] {
  const indent = '  '.repeat(depth);
  const targetId = interp.targetId ?? inheritedTargetId;
  // Non-null by construction — analysis/animation-config.ts's parseAnimationConfig runs
  // validateEffectiveTargets over the whole step tree before this module ever sees it.
  const tag = INTERPOLATOR_TAG[interp.interpolatorKind];
  const fieldToInterp = `${targetId}.${interp.fieldName}`;
  // THIS interpolator's own effective target, checked individually (not a single flag for the
  // whole declaration) — a composed Layer 1 animation can mix per-field `target:` overrides, so one
  // interpolator's target can be inside a `{#if:destroy}` block while a sibling's isn't. See
  // `analysis/animation-config.ts`'s `collectEffectiveTargetIds` (the function that builds this set)
  // and `RefreshableInterpolatorRef`'s own doc comment.
  const needsFieldRefresh = targetId !== null && destroyModeTargetIds.has(targetId);
  // An interpolator gets its own `id` (siblings otherwise have none — addressed only positionally
  // as an Animation node's children) whenever EITHER a `scaled: true` runtime keyValue override or
  // a destroy-mode `fieldToInterp` refresh (see `RefreshableInterpolatorRef`'s own doc comment)
  // needs to reach it directly via `findNode()` — sharing ONE id/counter between both purposes
  // (rather than two independent ids) since a SceneGraph node has exactly one `id` field; an
  // interpolator needing both (e.g. a `scaled: true` `fly`/`slide` preset used as `in:`/`out:` on a
  // `{#if:destroy}` block) gets the one id pushed into both ref lists.
  const needsId = interp.scaled || needsFieldRefresh;
  const id = needsId ? `${idPrefix}_ref_${counter.n++}` : null;
  if (id !== null && interp.scaled) scaledRefs.push({ id, keyValue: interp.keyValue });
  if (id !== null && needsFieldRefresh) refreshRefs.push({ id, fieldToInterp });
  const attrs = [
    ...(id !== null ? [`id="${escapeXmlAttr(id)}"`] : []),
    `key="${escapeXmlAttr(printArrayAttr(interp.key))}"`,
    `keyValue="${escapeXmlAttr(printArrayAttr(interp.keyValue))}"`,
    `fieldToInterp="${escapeXmlAttr(fieldToInterp)}"`,
    ...(interp.reverse ? ['reverse="true"'] : []),
  ];
  return [`${indent}<${tag} ${attrs.join(' ')} />`];
}

/**
 * Emits one step's own node — a leaf `<Animation>` (carrying `duration`/`easeFunction`, which
 * `SequentialAnimation`/`ParallelAnimation` have no such fields for at all, see
 * `analysis/animation-config.ts`'s own `animation/composition-does-not-support-duration-or-ease-
 * function` check) or a composed `<SequentialAnimation>`/`<ParallelAnimation>` wrapping each of
 * `step.composition.steps` recursively. `id` is non-null only for the outermost node of the whole
 * declaration — a nested step needs no id of its own in this feature's current scope (no per-step
 * `.start()`/... targeting yet).
 */
function emitStepXml(
  step: ParsedAnimationStep,
  inheritedTargetId: string | null,
  id: string | null,
  depth: number,
  idPrefix: string,
  counter: { n: number },
  scaledRefs: ScaledInterpolatorRef[],
  destroyModeTargetIds: ReadonlySet<string>,
  refreshRefs: RefreshableInterpolatorRef[],
): string[] {
  const indent = '  '.repeat(depth);
  const effectiveTargetId = step.targetId ?? inheritedTargetId;

  const sharedAttrs = [
    id !== null ? `id="${escapeXmlAttr(id)}"` : null,
    step.repeat !== null ? `repeat="${String(step.repeat)}"` : null,
    step.delay !== null ? `delay="${step.delay}"` : null,
  ].filter((a): a is string => a !== null);

  if (step.composition !== null) {
    const tag = step.composition.mode === 'sequential' ? 'SequentialAnimation' : 'ParallelAnimation';
    const openTag = `<${tag}${sharedAttrs.length > 0 ? ' ' + sharedAttrs.join(' ') : ''}>`;
    const lines = [`${indent}${openTag}`];
    for (const child of step.composition.steps) {
      lines.push(...emitStepXml(child, effectiveTargetId, null, depth + 1, idPrefix, counter, scaledRefs, destroyModeTargetIds, refreshRefs));
    }
    lines.push(`${indent}</${tag}>`);
    return lines;
  }

  const animationAttrs = [
    ...sharedAttrs,
    step.duration !== null ? `duration="${step.duration}"` : null,
    step.easeFunction !== null ? `easeFunction="${escapeXmlAttr(step.easeFunction)}"` : null,
  ].filter((a): a is string => a !== null);
  const openTag = `<Animation${animationAttrs.length > 0 ? ' ' + animationAttrs.join(' ') : ''}>`;
  const lines = [`${indent}${openTag}`];
  for (const interp of step.interpolators) {
    lines.push(...emitInterpolatorXml(interp, effectiveTargetId, depth + 1, idPrefix, counter, scaledRefs, destroyModeTargetIds, refreshRefs));
  }
  lines.push(`${indent}</Animation>`);
  return lines;
}

/**
 * Emits one `animation {}` declaration's whole XML subtree, with `id="ft_anim_<name>"` on its
 * outermost node. `scaledRefs`, when passed, is mutated in place with one entry per `scaled: true`
 * interpolator found anywhere in this declaration's tree — `compile.ts` collects these across every
 * `animation`/transition/`animate:` binding in the component and threads the combined list into
 * `emitBrs` so `emitInitFunction` can emit their runtime `ft_scale(...)` overrides. `refreshRefs`,
 * similarly, is mutated in place with one entry per interpolator whose own effective target id is a
 * member of `destroyModeTargetIds` — see `RefreshableInterpolatorRef`'s own doc comment; `compile.ts`
 * passes a non-empty set for a destroy-mode block's own Layer 2 `in:`/`out:` transition, or for a
 * Layer 1 declaration whose own `collectEffectiveTargetIds` overlaps a `{#if:destroy}` block. Fully
 * deterministic in `config`/`destroyModeTargetIds` alone (the `{n: 0}` counter is always fresh per
 * call), so calling this twice with the same arguments always assigns the same ids — safe to call
 * once to collect `scaledRefs`/`refreshRefs` and again later to produce the actual XML text, as
 * `compile.ts` does for every destroy-mode-relevant config.
 */
export function emitAnimationXml(
  config: ParsedAnimationConfig,
  depth: number,
  scaledRefs: ScaledInterpolatorRef[] = [],
  destroyModeTargetIds: ReadonlySet<string> = new Set(),
  refreshRefs: RefreshableInterpolatorRef[] = [],
): string[] {
  const idPrefix = animationNodeId(config.name);
  return emitStepXml(config.step, null, idPrefix, depth, idPrefix, { n: 0 }, scaledRefs, destroyModeTargetIds, refreshRefs);
}
