/**
 * Resolves a `transition:`/`in:`/`out:` template attribute's `<name>` — either one of the four
 * built-in presets (`fade`/`fly`/`slide`/`scale`) or a script-declared `animation` name — into the
 * same `ParsedAnimationConfig` shape `analysis/animation-config.ts` produces, so
 * `codegen/animation-emitter.ts`/`conditional-block-emitter.ts` never need to know "preset vs.
 * custom": there is exactly one downstream shape.
 *
 * A preset is synthesized fresh, per USE SITE (a `fade` referenced on 3 different elements
 * produces 3 independent `ParsedAnimationConfig`s, one per element) — unlike a custom `animation`
 * declaration, which the author already scoped to one `target`. A custom animation reference is
 * looked up as-is; it does NOT support an inline override config (`transition:bounce={{duration:
 * 300}}` is rejected) — only presets do. Adjusting a custom animation's timing means editing its
 * own `animation {}` declaration, not overriding it per call site; supporting a per-site override
 * that has to merge onto an arbitrarily-nested composition tree is real added complexity with no
 * clear "right" merge semantics (does an override apply to every leaf step, just the outermost,
 * ...?) — deferred rather than guessed at.
 */
import { CompileError, TemplateElement } from '../dsl-parser/dsl-ast.js';
import { LiteralValue, parseLiteralRoot, unquoteKey, walkLiteralValue } from './literal-value.js';
import { ParsedAnimationConfig, ParsedAnimationStep, ParsedInterpolatorStep, EASE_FUNCTIONS, FIELD_INTERPOLATOR_KIND } from './animation-config.js';
import { BsAALiteral } from 'flash-parser';

export type AnimationPresetName = 'fade' | 'fly' | 'slide' | 'scale';
export const ANIMATION_PRESET_NAMES: ReadonlySet<AnimationPresetName> = new Set(['fade', 'fly', 'slide', 'scale']);

interface PresetOverrides {
  readonly duration: number | null;
  readonly easeFunction: string | null;
  readonly delay: number | null;
  readonly repeat: boolean | null;
  /** `fly`/`slide` only — the off-screen starting offset; ignored by `fade`/`scale`. */
  readonly x: number | null;
  readonly y: number | null;
}

const PRESET_OVERRIDE_KEYS = new Set(['duration', 'easeFunction', 'delay', 'repeat', 'x', 'y']);

function numberField(entries: Record<string, LiteralValue>, key: string, contextLabel: string): number | null {
  const value = entries[key];
  if (value === undefined) return null;
  if (value.kind !== 'number') {
    throw new CompileError({ code: 'animation/invalid-config-value-type', message: `${contextLabel} "${key}" must be a number literal.` });
  }
  return value.value;
}

function booleanField(entries: Record<string, LiteralValue>, key: string, contextLabel: string): boolean | null {
  const value = entries[key];
  if (value === undefined) return null;
  if (value.kind !== 'boolean') {
    throw new CompileError({ code: 'animation/invalid-config-value-type', message: `${contextLabel} "${key}" must be a boolean literal.` });
  }
  return value.value;
}

/** Parses a `transition:`/`in:`/`out:` attribute's inner `{...}` override text — `null` (no attribute value at all) short-circuits to every-field-null (use the preset's own defaults). */
function parsePresetOverrides(overrideConfigText: string | null, contextLabel: string): PresetOverrides {
  if (overrideConfigText === null) {
    return { duration: null, easeFunction: null, delay: null, repeat: null, x: null, y: null };
  }

  const configNode = parseLiteralRoot(overrideConfigText, 'animation/config-parse-error', contextLabel);
  if (!(configNode instanceof BsAALiteral)) {
    throw new CompileError({ code: 'animation/config-must-be-literal', message: `${contextLabel} must be an object literal, e.g. {{duration: 250}}.` });
  }

  const entries: Record<string, LiteralValue> = {};
  for (const field of configNode.fields) {
    const key = unquoteKey(field.key);
    if (!PRESET_OVERRIDE_KEYS.has(key)) {
      throw new CompileError({
        code: 'animation/unknown-config-key',
        message: `Unknown preset override key "${key}" in ${contextLabel} — allowed: ${[...PRESET_OVERRIDE_KEYS].join(', ')}.`,
      });
    }
    entries[key] = walkLiteralValue(field.value, 'animation/config-must-be-literal', contextLabel);
  }

  const easeFunctionValue = entries.easeFunction;
  if (easeFunctionValue !== undefined && (easeFunctionValue.kind !== 'string' || !EASE_FUNCTIONS.has(easeFunctionValue.value))) {
    throw new CompileError({
      code: 'animation/invalid-ease-function',
      message: `${contextLabel} "easeFunction" must be one of ${[...EASE_FUNCTIONS].join(', ')}.`,
    });
  }

  return {
    duration: numberField(entries, 'duration', contextLabel),
    easeFunction: easeFunctionValue?.kind === 'string' ? easeFunctionValue.value : null,
    delay: numberField(entries, 'delay', contextLabel),
    repeat: booleanField(entries, 'repeat', contextLabel),
    x: numberField(entries, 'x', contextLabel),
    y: numberField(entries, 'y', contextLabel),
  };
}

function numberLiteral(value: number): LiteralValue {
  return { kind: 'number', value };
}

function pairLiteral(x: number, y: number): LiteralValue {
  return { kind: 'array', items: [numberLiteral(x), numberLiteral(y)] };
}

/** One interpolator, `key: [0, 1]` (a plain two-point animation — every preset is a straight A→B tween, no multi-keyframe presets in this catalog). */
function presetInterpolator(fieldName: 'opacity' | 'translation' | 'scale', from: LiteralValue, to: LiteralValue, targetId: string, reverse: boolean, scaled: boolean): ParsedInterpolatorStep {
  return {
    fieldName,
    interpolatorKind: FIELD_INTERPOLATOR_KIND[fieldName],
    key: { kind: 'array', items: [numberLiteral(0), numberLiteral(1)] },
    keyValue: { kind: 'array', items: [from, to] },
    targetId,
    reverse,
    scaled,
  };
}

/**
 * Reads `target`'s own static `translation="[x, y]"` attribute, if it declares one — used so
 * `fly`/`slide` can compute their absolute keyframes relative to the target's ACTUAL resting
 * position instead of unconditionally assuming Roku's own bare default `[0, 0]`. `null` when the
 * target has no `translation` attribute at all — the ordinary, overwhelmingly common case, falling
 * back to the original `[0, 0]` assumption exactly as before this existed.
 *
 * Only a STATIC `translation` is usable here: `translation="{expr}"`/`bind:translation` is a
 * runtime fact this compile-time preset construction can't safely read, so it's rejected instead of
 * silently guessed at — see `animation/preset-target-has-dynamic-translation` below. An author with
 * a dynamically-computed resting translation should reach for a custom `animation {}` declaration
 * instead, where every absolute keyframe is already under their own direct control (and, per
 * findings/animation.md's own `SequentialDemo.thr` example, can reuse the exact same `ft_scale(...)`
 * call a `scale derived` resting-position declaration already makes, keeping the two in sync by
 * construction).
 */
function restingTranslationOf(target: TemplateElement, contextLabel: string): { readonly x: number; readonly y: number } | null {
  const attr = target.attributes.find((a) => (a.kind === 'static' || a.kind === 'dynamic' || a.kind === 'bind') && a.name === 'translation');
  if (attr === undefined) return null;
  if (attr.kind !== 'static') {
    throw new CompileError({
      code: 'animation/preset-target-has-dynamic-translation',
      message: `${contextLabel}'s target element "${target.id}" has a dynamic "translation" attribute — the fly/slide presets can only account for a STATIC resting translation. Use a custom animation {} declaration instead, where you control every absolute keyframe directly.`,
    });
  }
  const node = parseLiteralRoot(attr.value, 'animation/preset-target-translation-not-a-pair', contextLabel);
  const value = walkLiteralValue(node, 'animation/preset-target-translation-not-a-pair', contextLabel);
  if (value.kind !== 'array' || value.items.length !== 2 || value.items[0].kind !== 'number' || value.items[1].kind !== 'number') {
    throw new CompileError({
      code: 'animation/preset-target-translation-not-a-pair',
      message: `${contextLabel}'s target element "${target.id}" has a "translation" attribute that isn't a [x, y] number pair — can't compute the fly/slide preset's absolute keyframes from it.`,
    });
  }
  return { x: value.items[0].value, y: value.items[1].value };
}

/**
 * Builds `fly`/`slide`'s own translation interpolator. The off-screen `from` keyframe is always
 * `restingTranslation + offset`; the `to` (resting) keyframe is `restingTranslation` itself when the
 * target declared one, else Roku's bare default `[0, 0]` — exactly the pre-existing behavior for
 * every target that has no static `translation` attribute of its own.
 *
 * `scaled: true` (the offset is a design-resolution pixel quantity, resolution-independent by
 * construction) only when `restingTranslation` is `null`. Once a REAL resting position is known,
 * BOTH keyframes are built from that same raw literal and deliberately left UNscaled — the target's
 * own static `translation` attribute is a fixed value, baked into the compiled XML exactly as
 * written, never touched by `ft_scaleFactor` at any resolution; wrapping the "resting" keyframe in
 * `ft_scale(...)` would land it somewhere OTHER than the target's own actual value at any factor
 * besides `1.0`, a real (if easy to miss) regression this fix must not introduce. Keeping the offset
 * in the SAME unscaled coordinate space as the resting literal it's added to is what keeps `from`
 * and `to` consistent with each other, even though it means the offset amount itself no longer
 * scales with resolution in this specific combination — see GRAMMAR.md's own "Known limitations".
 */
function flyOrSlideInterpolator(
  offsetX: number,
  offsetY: number,
  targetId: string,
  reverse: boolean,
  restingTranslation: { readonly x: number; readonly y: number } | null,
): ParsedInterpolatorStep {
  if (restingTranslation === null) {
    return presetInterpolator('translation', pairLiteral(offsetX, offsetY), pairLiteral(0, 0), targetId, reverse, true);
  }
  const from = pairLiteral(restingTranslation.x + offsetX, restingTranslation.y + offsetY);
  const to = pairLiteral(restingTranslation.x, restingTranslation.y);
  return presetInterpolator('translation', from, to, targetId, reverse, false);
}

/**
 * Builds one preset's `ParsedAnimationStep`. `fly`/`slide`'s own `x`/`y` offset (default or
 * overridden) — see `flyOrSlideInterpolator` for how `restingTranslation` changes both the absolute
 * keyframes AND the `scaled` flag. `fade`/`scale` never take a resting translation at all (their own
 * 0/1 endpoints are always unitless by construction, never `scaled`) — see GRAMMAR.md/
 * findings/animation.md.
 */
function buildPresetStep(
  name: AnimationPresetName,
  targetId: string,
  overrides: PresetOverrides,
  reverse: boolean,
  restingTranslation: { readonly x: number; readonly y: number } | null,
): ParsedAnimationStep {
  const interpolator = ((): ParsedInterpolatorStep => {
    switch (name) {
      case 'fade':
        return presetInterpolator('opacity', numberLiteral(0), numberLiteral(1), targetId, reverse, false);
      case 'scale':
        return presetInterpolator('scale', pairLiteral(0, 0), pairLiteral(1, 1), targetId, reverse, false);
      case 'fly':
        return flyOrSlideInterpolator(overrides.x ?? 0, overrides.y ?? 40, targetId, reverse, restingTranslation);
      case 'slide':
        return flyOrSlideInterpolator(overrides.x ?? -100, overrides.y ?? 0, targetId, reverse, restingTranslation);
    }
  })();

  return {
    duration: overrides.duration,
    easeFunction: overrides.easeFunction,
    delay: overrides.delay,
    repeat: overrides.repeat,
    targetId,
    interpolators: [interpolator],
    composition: null,
  };
}

/**
 * Resolves one `transition:`/`in:`/`out:` attribute into a `ParsedAnimationConfig`, `reverse`
 * applied to every interpolator when `direction === 'out'` (see `ParsedInterpolatorStep.reverse`'s
 * own doc comment for why reusing Roku's native field keeps enter/exit symmetric). `syntheticName`
 * becomes the generated `<Animation>`'s own `id="ft_anim_<syntheticName>"` — callers pass a name
 * unique to this attribute's use site (see `codegen/naming.ts`'s `transitionAnimationName`),
 * never reused across two different elements even for the same preset/animation name.
 *
 * Takes the whole `target` element (not just its id) so a `fly`/`slide` preset can read its own
 * static `translation` attribute, if any — see `restingTranslationOf`'s own doc comment. Unused by
 * the DECLARED-custom-animation branch below (that branch's own targets come entirely from the
 * declaration's own `target:`/per-field overrides, never from `target` here).
 *
 * `reverseDeclaredOnOut` (default `true`, Layer 2's own `transitions.ts` callers rely on the
 * default) controls ONLY the declared-custom-animation branch below — a PRESET is always still
 * reversed on `out:` regardless of this flag, since a preset step is always authored generically as
 * an "arrive at rest" shape and genuinely needs `reverse` to become an exit. Layer 2's `in:`/`out:`
 * on `{#if}`/`{#if:destroy}` blocks deliberately lets ONE declared animation serve both directions
 * this way (author writes one "popIn", `out:popIn` plays it backwards for free). Router-outlet
 * transitions (`router-transitions.ts`) pass `false` here: that feature's whole design is FOUR
 * independently authored, already-correctly-directed animations (`navigate-out:slideOutLeft` is
 * already a complete rest→off-screen animation in its own right, never meant to be "the reverse of"
 * `navigate-in:slideInFromRight`) — applying this same auto-reverse there double-flips an
 * already-out-shaped animation into an in-shaped one, which manifests as an instant snap to the off-
 * screen keyframe followed by a visible slide BACK to rest, exactly backwards from the intended
 * "slide out, then swap, then slide in" sequence. Confirmed live and documented in
 * findings/router-transitions.md.
 */
export function resolveTransitionAnimation(
  animationRef: string,
  overrideConfigText: string | null,
  target: TemplateElement,
  direction: 'both' | 'in' | 'out',
  syntheticName: string,
  animationConfigsByName: ReadonlyMap<string, ParsedAnimationConfig>,
  contextLabel: string,
  reverseDeclaredOnOut = true,
): ParsedAnimationConfig {
  const reverse = direction === 'out';
  const targetId = target.id!;

  const declared = animationConfigsByName.get(animationRef);
  if (declared) {
    if (overrideConfigText !== null) {
      throw new CompileError({
        code: 'animation/transition-override-not-supported-for-custom-animation',
        message: `${contextLabel} references the custom animation "${animationRef}" with an override config — overrides are only supported for built-in presets (fade/fly/slide/scale). Adjust "${animationRef}"'s own animation {} declaration instead.`,
      });
    }
    const reverseDeclared = reverse && reverseDeclaredOnOut;
    return reverseDeclared ? { name: syntheticName, step: applyReverse(declared.step) } : { name: syntheticName, step: declared.step };
  }

  if (ANIMATION_PRESET_NAMES.has(animationRef as AnimationPresetName)) {
    const overrides = parsePresetOverrides(overrideConfigText, contextLabel);
    const restingTranslation = animationRef === 'fly' || animationRef === 'slide' ? restingTranslationOf(target, contextLabel) : null;
    return { name: syntheticName, step: buildPresetStep(animationRef as AnimationPresetName, targetId, overrides, reverse, restingTranslation) };
  }

  throw new CompileError({
    code: 'animation/unknown-transition-reference',
    message: `${contextLabel} references "${animationRef}" — not a built-in preset (fade/fly/slide/scale) or a declared animation.`,
  });
}

/** Recursively sets `reverse: true` on every interpolator in `step`'s own tree — used for a custom (non-preset) animation referenced as the "out:" side of a transition. */
function applyReverse(step: ParsedAnimationStep): ParsedAnimationStep {
  if (step.composition !== null) {
    return { ...step, composition: { ...step.composition, steps: step.composition.steps.map(applyReverse) } };
  }
  return { ...step, interpolators: step.interpolators.map((i) => ({ ...i, reverse: true })) };
}
