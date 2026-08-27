/**
 * Interprets an `animation <name> { ... }` declaration's config-literal text into a structured
 * `ParsedAnimationConfig` — see `dsl-parser/dsl-ast.ts`'s `AnimationDecl` and GRAMMAR.md's
 * "animation" section.
 *
 * Modeled directly on `request-config.ts`, but with one structural deviation: `target` (top-level
 * and per-field-object-form) is a BARE IDENTIFIER reference to a template element id, not a
 * literal — `literal-value.ts`'s `walkLiteralValue` rejects non-literals, so this module cannot
 * blindly reuse it over the whole config AA the way `request-config.ts` does. It walks the
 * `BsAALiteral`'s fields itself, dispatching `target` (and each field-step's own nested `target`
 * override) to a small dedicated identifier extractor, and only literal-shaped values (`duration`,
 * `easeFunction`, `delay`, `repeat`, `key`/`keyValue` arrays, `sequential`/`parallel`, the `field`/
 * `as` escape hatch) through `walkLiteralValue`/`parseLiteralRoot` as usual.
 */
import { CompileError, AnimationDecl } from '../dsl-parser/dsl-ast.js';
import { LiteralValue, parseLiteralRoot, unquoteKey, walkLiteralValue } from './literal-value.js';
import { BsAALiteral, BsArrayLiteral, BsAAField, BsAstNode, BsIdentifierExpression } from 'flash-parser';

const CODE = 'animation/config-must-be-literal';

export type AnimationFieldName = 'opacity' | 'rotation' | 'translation' | 'scale' | 'color';
export const ANIMATION_FIELD_NAMES: ReadonlySet<AnimationFieldName> = new Set(['opacity', 'rotation', 'translation', 'scale', 'color']);

/** Roku's own FloatFieldInterpolator vs Vector2DFieldInterpolator vs ColorFieldInterpolator split. */
export type InterpolatorKind = 'float' | 'vector2d' | 'color';
export const FIELD_INTERPOLATOR_KIND: Record<AnimationFieldName, InterpolatorKind> = {
  opacity: 'float',
  rotation: 'float',
  translation: 'vector2d',
  scale: 'vector2d',
  color: 'color',
};

/** Roku's closed `Animation.easeFunction` value set — see GRAMMAR.md's "animation" section. */
export const EASE_FUNCTIONS = new Set([
  'linear',
  'inQuad', 'inCubic', 'inQuartic', 'inQuintic', 'inExpo',
  'outQuad', 'outCubic', 'outQuartic', 'outQuintic', 'outExpo',
  'inOutQuad', 'inOutCubic', 'inOutQuartic', 'inOutQuintic', 'inOutExpo',
  'piecewise',
]);

const TOP_LEVEL_KEYS = new Set(['target', 'duration', 'easeFunction', 'delay', 'repeat', 'sequential', 'parallel', 'steps', 'field']);

export interface ParsedInterpolatorStep {
  /** One of `ANIMATION_FIELD_NAMES`, or the escape hatch's own `name` value — the real Roku field this interpolator targets. */
  readonly fieldName: string;
  readonly interpolatorKind: InterpolatorKind;
  /** Always an already-validated `{kind:'array', items:[...]}` literal — key percentages, 0–1, same length as `keyValue`. */
  readonly key: LiteralValue;
  /** Always an already-validated `{kind:'array', items:[...]}` literal. */
  readonly keyValue: LiteralValue;
  /** Bare identifier text, or `null` to inherit the step's own `targetId`. */
  readonly targetId: string | null;
  /**
   * Roku's own `FieldInterpolator.reverse` field — plays this same keyframe set backwards. Never
   * author-settable inside an `animation {}` config literal; always `false` from
   * `parseAnimationConfig`. Set to `true` only by `analysis/animation-presets.ts`'s
   * `resolveTransitionAnimation`, for the exit side of a `transition:`/`out:` template attribute —
   * see that module's own doc comment for why reusing this native field (instead of a second,
   * independently-authored config) keeps enter/exit symmetric by construction.
   */
  readonly reverse: boolean;
  /**
   * `true` when this interpolator's `keyValue` entries must be run through the app's `scale`
   * factor at runtime (`ft_scale(...)`, computed once at boot) rather than baked as static XML
   * literals — see GRAMMAR.md's "animation" section and `findings/animation.md`. Only settable via
   * the object form's `scaled: true` key (no shorthand-array support), and only on `translation` or
   * the `field`/`as` escape hatch (`animation/scaled-not-supported-for-field`/`-color` otherwise) —
   * every other known shorthand (`opacity`/`rotation`/`scale`/`color`) is a relative or unitless
   * quantity `ft_scale` would silently corrupt, not a design-resolution pixel value. Always `false`
   * from `parseAnimationConfig` for the array-shorthand form; `animation-presets.ts`'s
   * `buildPresetStep` sets it `true` unconditionally for `fly`/`slide`'s own absolute pixel offset.
   */
  readonly scaled: boolean;
}

export interface ParsedAnimationComposition {
  readonly mode: 'sequential' | 'parallel';
  readonly steps: readonly ParsedAnimationStep[];
}

export interface ParsedAnimationStep {
  readonly duration: number | null;
  readonly easeFunction: string | null;
  readonly delay: number | null;
  readonly repeat: boolean | null;
  /** Bare identifier text, or `null` when every interpolator supplies its own `target` (composed steps may omit it and inherit the outer declaration's). */
  readonly targetId: string | null;
  readonly interpolators: readonly ParsedInterpolatorStep[];
  /** Non-null only for a composed step (`sequential: true`/`parallel: true` + `steps: [...]`) — mutually exclusive with a non-empty `interpolators`. */
  readonly composition: ParsedAnimationComposition | null;
}

export interface ParsedAnimationConfig {
  readonly name: string;
  readonly step: ParsedAnimationStep;
}

function requireField(fields: Map<string, BsAAField>, key: string): BsAAField | undefined {
  return fields.get(key);
}

function fieldsByKey(aa: BsAALiteral): Map<string, BsAAField> {
  const map = new Map<string, BsAAField>();
  for (const field of aa.fields) map.set(unquoteKey(field.key), field);
  return map;
}

/** Extracts a `target: <id>` value as a bare identifier's text — NOT a literal, so it deliberately bypasses `walkLiteralValue`. */
function extractIdentifierValue(field: BsAAField, keyLabel: string, contextLabel: string): string {
  const value = field.value;
  if (!(value instanceof BsIdentifierExpression) || value.name.length === 0) {
    throw new CompileError({
      code: 'animation/invalid-target',
      message: `animation "${keyLabel}" in ${contextLabel} must be a bare identifier referencing a template element id (e.g. ${keyLabel}: card), not a literal or expression — found "${value?.getText().trim() ?? ''}".`,
    });
  }
  return value.name;
}

function extractOptionalTargetId(fields: Map<string, BsAAField>, elementIds: ReadonlySet<string>, contextLabel: string): string | null {
  const field = requireField(fields, 'target');
  if (!field) return null;
  const id = extractIdentifierValue(field, 'target', contextLabel);
  if (!elementIds.has(id)) {
    throw new CompileError({
      code: 'animation/unknown-target',
      message: `animation "target" in ${contextLabel} references unknown element id "${id}" — no template element with that id exists.`,
    });
  }
  return id;
}

function extractOptionalNumber(fields: Map<string, BsAAField>, key: string, contextLabel: string): number | null {
  const field = requireField(fields, key);
  if (!field) return null;
  const value = walkLiteralValue(field.value, CODE, contextLabel);
  if (value.kind !== 'number') {
    throw new CompileError({ code: 'animation/invalid-config-value-type', message: `animation "${key}" in ${contextLabel} must be a number literal.` });
  }
  return value.value;
}

function extractOptionalBoolean(fields: Map<string, BsAAField>, key: string, contextLabel: string): boolean | null {
  const field = requireField(fields, key);
  if (!field) return null;
  const value = walkLiteralValue(field.value, CODE, contextLabel);
  if (value.kind !== 'boolean') {
    throw new CompileError({ code: 'animation/invalid-config-value-type', message: `animation "${key}" in ${contextLabel} must be a boolean literal.` });
  }
  return value.value;
}

function extractOptionalEaseFunction(fields: Map<string, BsAAField>, contextLabel: string): string | null {
  const field = requireField(fields, 'easeFunction');
  if (!field) return null;
  const value = walkLiteralValue(field.value, CODE, contextLabel);
  if (value.kind !== 'string' || !EASE_FUNCTIONS.has(value.value)) {
    throw new CompileError({
      code: 'animation/invalid-ease-function',
      message: `animation "easeFunction" in ${contextLabel} must be one of ${[...EASE_FUNCTIONS].join(', ')} — found "${value.kind === 'string' ? value.value : '<non-string>'}".`,
    });
  }
  return value.value;
}

function evenlySpacedKey(length: number): LiteralValue {
  if (length <= 1) return { kind: 'array', items: [{ kind: 'number', value: 0 }] };
  return { kind: 'array', items: Array.from({ length }, (_, i) => ({ kind: 'number' as const, value: i / (length - 1) })) };
}

function requireArrayLiteral(node: BsAstNode | null, keyLabel: string, contextLabel: string): LiteralValue {
  const value = walkLiteralValue(node, CODE, contextLabel);
  if (value.kind !== 'array') {
    throw new CompileError({ code: 'animation/invalid-config-value-type', message: `animation "${keyLabel}" in ${contextLabel} must be an array literal.` });
  }
  return value;
}

/**
 * `scale` is the one Vector2D field where a bare number is unambiguous — "uniform scale," the
 * overwhelmingly common case — so a scalar `keyValue` entry broadcasts to `[v, v]` here, before
 * shape validation. `translation` gets no such broadcast: `x`/`y` almost always differ, so a bare
 * number there would silently guess a meaning the author probably didn't intend. Non-scalar entries
 * (already `[x, y]`) pass through untouched, so a mix of uniform and non-uniform scale keyframes —
 * `[1, [1.2, 0.8], 1]` — is allowed too.
 */
function broadcastUniformScale(fieldName: string, keyValue: LiteralValue): LiteralValue {
  if (fieldName !== 'scale' || keyValue.kind !== 'array') return keyValue;
  return { kind: 'array', items: keyValue.items.map((item) => (item.kind === 'number' ? { kind: 'array', items: [item, item] } : item)) };
}

function validateKeyValueShape(fieldName: string, interpolatorKind: InterpolatorKind, keyValue: LiteralValue, contextLabel: string): void {
  if (keyValue.kind !== 'array') return; // already reported by requireArrayLiteral's caller
  for (const item of keyValue.items) {
    if (interpolatorKind === 'vector2d') {
      if (item.kind !== 'array' || item.items.length !== 2 || item.items.some((n) => n.kind !== 'number')) {
        throw new CompileError({
          code: 'animation/invalid-key-value-shape',
          message: `animation "${fieldName}" keyValue entries in ${contextLabel} must each be a 2-element [x, y] array, since "${fieldName}" is a Vector2D field.`,
        });
      }
    } else if (item.kind !== 'number') {
      throw new CompileError({
        code: 'animation/invalid-key-value-shape',
        message: `animation "${fieldName}" keyValue entries in ${contextLabel} must each be a number, since "${fieldName}" is a ${interpolatorKind === 'color' ? 'Color' : 'Float'} field.`,
      });
    }
  }
}

/** Shorthand array form (`scale: [1, 1.15, 1]`) — key auto-computed as evenly-spaced percentages. */
function parseShorthandInterpolator(fieldName: AnimationFieldName, valueNode: BsAstNode, contextLabel: string): ParsedInterpolatorStep {
  const interpolatorKind = FIELD_INTERPOLATOR_KIND[fieldName];
  const keyValue = broadcastUniformScale(fieldName, requireArrayLiteral(valueNode, fieldName, contextLabel));
  validateKeyValueShape(fieldName, interpolatorKind, keyValue, contextLabel);
  return { fieldName, interpolatorKind, key: evenlySpacedKey((keyValue as { items: unknown[] }).items.length), keyValue, targetId: null, reverse: false, scaled: false };
}

/** Object form (`translation: { key: [...], keyValue: [...], target: overlay }`) — full per-field control, or the `field`/`as` escape hatch for an arbitrary Roku field name. */
function parseObjectFormInterpolator(fieldName: AnimationFieldName | null, aa: BsAALiteral, elementIds: ReadonlySet<string>, contextLabel: string): ParsedInterpolatorStep {
  const fields = fieldsByKey(aa);

  let resolvedFieldName: string;
  let interpolatorKind: InterpolatorKind;
  if (fieldName !== null) {
    resolvedFieldName = fieldName;
    interpolatorKind = FIELD_INTERPOLATOR_KIND[fieldName];
  } else {
    const nameField = requireField(fields, 'name');
    const nameValue = nameField ? walkLiteralValue(nameField.value, CODE, contextLabel) : null;
    if (!nameValue || nameValue.kind !== 'string') {
      throw new CompileError({ code: 'animation/invalid-config-value-type', message: `animation "field" escape hatch in ${contextLabel} requires a string "name" (the real Roku field to animate).` });
    }
    resolvedFieldName = nameValue.value;

    const asField = requireField(fields, 'as');
    const asValue = asField ? walkLiteralValue(asField.value, CODE, contextLabel) : null;
    if (!asValue || asValue.kind !== 'string' || !['float', 'vector2d', 'color'].includes(asValue.value)) {
      throw new CompileError({ code: 'animation/invalid-config-value-type', message: `animation "field" escape hatch in ${contextLabel} requires "as": "float" | "vector2d" | "color".` });
    }
    interpolatorKind = asValue.value as InterpolatorKind;
  }

  const keyField = requireField(fields, 'key');
  const keyValueField = requireField(fields, 'keyValue');
  if (!keyValueField) {
    throw new CompileError({ code: 'animation/invalid-config-value-type', message: `animation "${resolvedFieldName}" in ${contextLabel} must declare "keyValue".` });
  }
  const keyValue = broadcastUniformScale(resolvedFieldName, requireArrayLiteral(keyValueField.value, `${resolvedFieldName}.keyValue`, contextLabel));
  validateKeyValueShape(resolvedFieldName, interpolatorKind, keyValue, contextLabel);
  const key = keyField ? requireArrayLiteral(keyField.value, `${resolvedFieldName}.key`, contextLabel) : evenlySpacedKey((keyValue as { items: unknown[] }).items.length);
  if (key.kind === 'array' && keyValue.kind === 'array' && key.items.length !== keyValue.items.length) {
    throw new CompileError({
      code: 'animation/key-length-mismatch',
      message: `animation "${resolvedFieldName}" in ${contextLabel}: "key" and "keyValue" must be the same length (${key.items.length} vs ${keyValue.items.length}).`,
    });
  }

  const targetField = requireField(fields, 'target');
  const targetId = targetField ? extractIdentifierValue(targetField, `${resolvedFieldName}.target`, contextLabel) : null;
  if (targetId !== null && !elementIds.has(targetId)) {
    throw new CompileError({ code: 'animation/unknown-target', message: `animation "${resolvedFieldName}.target" in ${contextLabel} references unknown element id "${targetId}".` });
  }

  const scaled = extractOptionalBoolean(fields, 'scaled', contextLabel) ?? false;
  if (scaled) {
    if (interpolatorKind === 'color') {
      throw new CompileError({
        code: 'animation/scaled-not-supported-for-color',
        message: `animation "${resolvedFieldName}" in ${contextLabel} cannot set "scaled: true" on a Color field — scaling would multiply the packed color value, not a position/size, and silently corrupt it.`,
      });
    }
    if (fieldName !== null && fieldName !== 'translation') {
      throw new CompileError({
        code: 'animation/scaled-not-supported-for-field',
        message: `animation "${resolvedFieldName}" in ${contextLabel} cannot set "scaled: true" — only "translation" (a design-resolution pixel quantity) or the "field"/"as" escape hatch support it. opacity/rotation/scale values are relative or unitless and would be corrupted by scaling.`,
      });
    }
  }

  return { fieldName: resolvedFieldName, interpolatorKind, key, keyValue, targetId, reverse: false, scaled };
}

function parseInterpolatorField(key: string, field: BsAAField, elementIds: ReadonlySet<string>, contextLabel: string): ParsedInterpolatorStep {
  if (key === 'field') {
    const value = field.value;
    if (!(value instanceof BsAALiteral)) {
      throw new CompileError({ code: CODE, message: `animation "field" escape hatch in ${contextLabel} must be an object literal — { name, as, key?, keyValue, target? }.` });
    }
    return parseObjectFormInterpolator(null, value, elementIds, contextLabel);
  }

  if (!ANIMATION_FIELD_NAMES.has(key as AnimationFieldName)) {
    throw new CompileError({
      code: 'animation/unknown-config-key',
      message: `Unknown animation config key "${key}" in ${contextLabel} — allowed: target, duration, easeFunction, delay, repeat, sequential, parallel, steps, field, or one of ${[...ANIMATION_FIELD_NAMES].join(', ')}.`,
    });
  }
  const fieldName = key as AnimationFieldName;
  const value = field.value;
  if (value instanceof BsArrayLiteral) return parseShorthandInterpolator(fieldName, value, contextLabel);
  if (value instanceof BsAALiteral) return parseObjectFormInterpolator(fieldName, value, elementIds, contextLabel);
  throw new CompileError({
    code: CODE,
    message: `animation "${fieldName}" in ${contextLabel} must be an array literal (shorthand) or an object literal ({ key?, keyValue, target? }).`,
  });
}

function parseStepFromAALiteral(aa: BsAALiteral, elementIds: ReadonlySet<string>, contextLabel: string): ParsedAnimationStep {
  const fields = fieldsByKey(aa);

  const targetId = extractOptionalTargetId(fields, elementIds, contextLabel);
  const duration = extractOptionalNumber(fields, 'duration', contextLabel);
  const easeFunction = extractOptionalEaseFunction(fields, contextLabel);
  const delay = extractOptionalNumber(fields, 'delay', contextLabel);
  const repeat = extractOptionalBoolean(fields, 'repeat', contextLabel);
  const sequential = extractOptionalBoolean(fields, 'sequential', contextLabel) ?? false;
  const parallel = extractOptionalBoolean(fields, 'parallel', contextLabel) ?? false;

  if (sequential && parallel) {
    throw new CompileError({ code: 'animation/sequential-and-parallel-both-set', message: `animation in ${contextLabel} cannot set both "sequential" and "parallel" — choose one.` });
  }

  const stepsField = requireField(fields, 'steps');
  let composition: ParsedAnimationComposition | null = null;
  if (stepsField) {
    if (!sequential && !parallel) {
      throw new CompileError({ code: 'animation/steps-requires-composition-mode', message: `animation "steps" in ${contextLabel} requires "sequential: true" or "parallel: true".` });
    }
    const stepsValue = stepsField.value;
    if (!(stepsValue instanceof BsArrayLiteral)) {
      throw new CompileError({ code: CODE, message: `animation "steps" in ${contextLabel} must be an array literal of step objects.` });
    }
    const steps = stepsValue.elements.map((el) => {
      if (!(el instanceof BsAALiteral)) {
        throw new CompileError({ code: CODE, message: `Each animation step in ${contextLabel} must be an object literal.` });
      }
      return parseStepFromAALiteral(el, elementIds, contextLabel);
    });
    if (steps.length === 0) {
      throw new CompileError({ code: 'animation/empty-steps', message: `animation "steps" in ${contextLabel} must declare at least one step.` });
    }
    composition = { mode: sequential ? 'sequential' : 'parallel', steps };
  } else if (sequential || parallel) {
    throw new CompileError({ code: 'animation/composition-mode-requires-steps', message: `animation "${sequential ? 'sequential' : 'parallel'}: true" in ${contextLabel} requires a "steps" array.` });
  }

  const interpolators: ParsedInterpolatorStep[] = [];
  for (const [key, field] of fields) {
    if (TOP_LEVEL_KEYS.has(key)) continue;
    interpolators.push(parseInterpolatorField(key, field, elementIds, contextLabel));
  }
  // The `field` escape-hatch key is itself one of TOP_LEVEL_KEYS (skipped above) but still needs parsing as an interpolator.
  const fieldEscapeHatch = requireField(fields, 'field');
  if (fieldEscapeHatch) interpolators.push(parseInterpolatorField('field', fieldEscapeHatch, elementIds, contextLabel));

  if (composition !== null && interpolators.length > 0) {
    throw new CompileError({
      code: 'animation/mixed-composition-and-fields',
      message: `animation in ${contextLabel} cannot combine top-level field shorthands with "sequential"/"parallel" composition — move the fields into their own step.`,
    });
  }
  if (composition === null && interpolators.length === 0) {
    throw new CompileError({
      code: 'animation/step-declares-nothing',
      message: `animation step in ${contextLabel} declares no field to animate and no "sequential"/"parallel" composition.`,
    });
  }
  // `duration`/`easeFunction` are real Roku `Animation` fields, but `SequentialAnimation`/
  // `ParallelAnimation` (a composed step's own emitted node — see codegen/animation-emitter.ts)
  // have no such fields at all — silently dropping an author-declared value would be a real bug,
  // not a convenience, so this is rejected up front instead. Put them on the individual `steps:`
  // entries, which each become their own real `<Animation>` leaf.
  if (composition !== null && (duration !== null || easeFunction !== null)) {
    throw new CompileError({
      code: 'animation/composition-does-not-support-duration-or-ease-function',
      message: `animation in ${contextLabel}: "duration"/"easeFunction" have no effect on a "sequential"/"parallel" composition itself (Roku's SequentialAnimation/ParallelAnimation nodes have no such fields) — set them on each entry inside "steps" instead.`,
    });
  }

  return { duration, easeFunction, delay, repeat, targetId, interpolators, composition };
}

/**
 * Recursively verifies every interpolator (at any nesting depth) resolves to a non-null target,
 * once inheritance from an ancestor step's own `target`/top-level `target` is taken into account —
 * a plain shallow check on the top-level step alone isn't enough, since a composed animation may
 * set `target` once at the very top and let every nested step/interpolator inherit it.
 */
function validateEffectiveTargets(step: ParsedAnimationStep, inheritedTargetId: string | null, contextLabel: string): void {
  const effectiveTargetId = step.targetId ?? inheritedTargetId;
  if (step.composition !== null) {
    for (const child of step.composition.steps) validateEffectiveTargets(child, effectiveTargetId, contextLabel);
    return;
  }
  for (const interpolator of step.interpolators) {
    if (interpolator.targetId === null && effectiveTargetId === null) {
      throw new CompileError({
        code: 'animation/missing-target',
        message: `animation "${interpolator.fieldName}" in ${contextLabel} has no resolvable target — declare "target" on the animation, the containing step, or the field itself.`,
      });
    }
  }
}

/**
 * Every effective target id referenced anywhere in `step`'s own tree (recursing through
 * `sequential`/`parallel` composition, same shape `validateEffectiveTargets` already walks) — one
 * entry per DISTINCT target, since a composed animation may mix a top-level `target:` with one or
 * more per-field overrides. Used by `compile.ts` to decide which of a Layer 1 `animation {}`
 * declaration's own interpolators need the same `{#if:destroy}` `fieldToInterp` refresh treatment
 * Layer 2 transitions already get — see `analysis/transitions.ts`'s
 * `ResolvedBlockTransition.isDestroyMode` doc comment for the underlying Roku staleness bug, and
 * `identifier-rewrite.ts`'s `rewriteAnimationControlCalls` for the call site that actually emits
 * the refresh lines for a Layer 1 `.start()` trigger. Every id returned is non-null by construction
 * — `validateEffectiveTargets` has already run over this exact tree by the time any caller reaches
 * this function (both `parseAnimationConfig` below and `analysis/transitions.ts`'s custom-animation
 * reuse path go through it first), so a `null` effective target here would already have thrown.
 */
export function collectEffectiveTargetIds(step: ParsedAnimationStep, inheritedTargetId: string | null): ReadonlySet<string> {
  const effectiveTargetId = step.targetId ?? inheritedTargetId;
  const ids = new Set<string>();
  if (step.composition !== null) {
    for (const child of step.composition.steps) {
      for (const id of collectEffectiveTargetIds(child, effectiveTargetId)) ids.add(id);
    }
    return ids;
  }
  for (const interpolator of step.interpolators) {
    const id = interpolator.targetId ?? effectiveTargetId;
    if (id !== null) ids.add(id);
  }
  return ids;
}

/**
 * Parses and validates one `animation {}` declaration's `configText` into a `ParsedAnimationConfig`.
 * `elementIds` is the template's own real element ids (from `compile.ts`'s `collectElementIds`) —
 * every `target`/per-field `target` override is validated against it. Throws `CompileError` on the
 * first problem.
 */
export function parseAnimationConfig(decl: AnimationDecl, elementIds: ReadonlySet<string>, contextLabel: string): ParsedAnimationConfig {
  const configNode = parseLiteralRoot(decl.configText, 'animation/config-parse-error', `animation ${decl.name} {} config in ${contextLabel}`);
  if (!(configNode instanceof BsAALiteral)) {
    throw new CompileError({
      code: CODE,
      message: `animation ${decl.name} {} in ${contextLabel} must be an object literal, e.g. animation ${decl.name} { target: ..., duration: ... }.`,
    });
  }

  const step = parseStepFromAALiteral(configNode, elementIds, contextLabel);
  validateEffectiveTargets(step, null, `animation ${decl.name} {} in ${contextLabel}`);

  return { name: decl.name, step };
}
