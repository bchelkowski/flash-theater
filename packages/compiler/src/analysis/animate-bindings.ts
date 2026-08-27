/**
 * `animate:<field>="{{...}}"` — Layer 3: auto-animates the reactive cascade's write to a matching
 * DYNAMIC `<field>="{expr}"` attribute on the SAME element, instead of an instant snap. Unlike
 * every other piece of this feature (Layer 1's `animation {}` declarations, Layer 2's `transition:`/
 * `in:`/`out:`), the animated `keyValue` here is NOT knowable at compile time — it's `[<the live
 * current value>, <the new value the cascade just computed>]`, read fresh at every write. This
 * module only resolves the STATIC half (which field, which element, the timing config, the
 * synthesized `ParsedAnimationConfig`'s XML shape with a placeholder `keyValue`); the dynamic half
 * (reading the live value and overwriting the interpolator's `keyValue` at the write site) is
 * `codegen/brs-emitter.ts`'s job, in `emitBindingAssignment`.
 */
import { CompileError, TemplateElement } from '../dsl-parser/dsl-ast.js';
import { walkTemplate } from './template-walk.js';
import { LiteralValue, parseLiteralRoot, unquoteKey, walkLiteralValue } from './literal-value.js';
import { ANIMATION_FIELD_NAMES, AnimationFieldName, EASE_FUNCTIONS, FIELD_INTERPOLATOR_KIND, ParsedAnimationConfig } from './animation-config.js';
import { animateBindingAnimationName } from '../codegen/naming.js';
import { BsAALiteral } from 'flash-parser';

export interface ResolvedAnimateBinding {
  readonly elementId: string;
  readonly fieldName: AnimationFieldName;
  /** The synthesized animation's own config — a single interpolator with a placeholder `keyValue` (overwritten at runtime before every `.control = "start"`, see `codegen/brs-emitter.ts`). */
  readonly config: ParsedAnimationConfig;
}

interface AnimateOverrides {
  readonly duration: number | null;
  readonly easeFunction: string | null;
  readonly delay: number | null;
  readonly repeat: boolean | null;
}

const ANIMATE_OVERRIDE_KEYS = new Set(['duration', 'easeFunction', 'delay', 'repeat']);

function numberField(entries: Record<string, LiteralValue>, key: string, contextLabel: string): number | null {
  const value = entries[key];
  if (value === undefined) return null;
  if (value.kind !== 'number') throw new CompileError({ code: 'animation/invalid-config-value-type', message: `${contextLabel} "${key}" must be a number literal.` });
  return value.value;
}

function booleanField(entries: Record<string, LiteralValue>, key: string, contextLabel: string): boolean | null {
  const value = entries[key];
  if (value === undefined) return null;
  if (value.kind !== 'boolean') throw new CompileError({ code: 'animation/invalid-config-value-type', message: `${contextLabel} "${key}" must be a boolean literal.` });
  return value.value;
}

function parseAnimateOverrides(overrideConfigText: string | null, contextLabel: string): AnimateOverrides {
  if (overrideConfigText === null) return { duration: null, easeFunction: null, delay: null, repeat: null };

  const configNode = parseLiteralRoot(overrideConfigText, 'animation/config-parse-error', contextLabel);
  if (!(configNode instanceof BsAALiteral)) {
    throw new CompileError({ code: 'animation/config-must-be-literal', message: `${contextLabel} must be an object literal, e.g. {{duration: 250}}.` });
  }

  const entries: Record<string, LiteralValue> = {};
  for (const field of configNode.fields) {
    const key = unquoteKey(field.key);
    if (!ANIMATE_OVERRIDE_KEYS.has(key)) {
      throw new CompileError({ code: 'animation/unknown-config-key', message: `Unknown animate: override key "${key}" in ${contextLabel} — allowed: ${[...ANIMATE_OVERRIDE_KEYS].join(', ')}.` });
    }
    entries[key] = walkLiteralValue(field.value, 'animation/config-must-be-literal', contextLabel);
  }

  const easeFunctionValue = entries.easeFunction;
  if (easeFunctionValue !== undefined && (easeFunctionValue.kind !== 'string' || !EASE_FUNCTIONS.has(easeFunctionValue.value))) {
    throw new CompileError({ code: 'animation/invalid-ease-function', message: `${contextLabel} "easeFunction" must be one of ${[...EASE_FUNCTIONS].join(', ')}.` });
  }

  return {
    duration: numberField(entries, 'duration', contextLabel),
    easeFunction: easeFunctionValue?.kind === 'string' ? easeFunctionValue.value : null,
    delay: numberField(entries, 'delay', contextLabel),
    repeat: booleanField(entries, 'repeat', contextLabel),
  };
}

/** A zero-valued placeholder `keyValue`/`key`, type-shaped for `interpolatorKind` — overwritten at every write site before `.control = "start"` runs (see `codegen/brs-emitter.ts`); its only purpose is producing structurally valid static XML at compile time. */
function placeholderKeyValue(fieldName: AnimationFieldName): LiteralValue {
  const zero: LiteralValue = { kind: 'number', value: 0 };
  const kind = FIELD_INTERPOLATOR_KIND[fieldName];
  const point: LiteralValue = kind === 'vector2d' ? { kind: 'array', items: [zero, zero] } : zero;
  return { kind: 'array', items: [point, point] };
}

/**
 * Every `animate:<field>` attribute anywhere in the template, resolved and validated:
 * - `<field>` must be one of `ANIMATION_FIELD_NAMES` (the same closed set Layer 1's shorthand keys
 *   use — Roku's interpolator types cover exactly these, no arbitrary-field escape hatch here, un
 *   like Layer 1's `field`/`as` — an arbitrary field would need to know the *current* value's own
 *   BrightScript type to interpolate it correctly, which this compiler has no way to check).
 * - the same element must ALSO have a DYNAMIC `<field>="{expr}"` attribute — `animate:` modifies
 *   an existing reactive write, it doesn't create one.
 *
 * Returned as a map keyed by `"<elementId>.<fieldName>"`, looked up by `codegen/brs-emitter.ts`'s
 * cascade-line emission for that exact element+attribute pair.
 */
export function resolveAnimateBindings(root: TemplateElement): ReadonlyMap<string, ResolvedAnimateBinding> {
  const result = new Map<string, ResolvedAnimateBinding>();

  walkTemplate(root, {
    recurseIntoEach: true,
    onElement: (element) => {
      const animateAttrs = element.attributes.filter((a) => a.kind === 'animate');
      if (animateAttrs.length === 0) return;
      const elementId = element.id!;

      for (const attr of animateAttrs) {
        if (attr.kind !== 'animate') continue;
        const fieldName = attr.fieldName;
        if (!ANIMATION_FIELD_NAMES.has(fieldName as AnimationFieldName)) {
          throw new CompileError({
            code: 'animation/unknown-animate-field',
            message: `animate:${fieldName} on element "${elementId}" — "${fieldName}" is not an animatable field (allowed: ${[...ANIMATION_FIELD_NAMES].join(', ')}).`,
          });
        }
        const hasMatchingDynamicAttribute = element.attributes.some((a) => a.kind === 'dynamic' && a.name === fieldName);
        if (!hasMatchingDynamicAttribute) {
          throw new CompileError({
            code: 'template/animate-without-dynamic-attribute',
            message: `animate:${fieldName} on element "${elementId}" requires a matching dynamic ${fieldName}="{...}" attribute on the same element — animate: only auto-animates an existing reactive write, it doesn't create one.`,
          });
        }

        const key = `${elementId}.${fieldName}`;
        if (result.has(key)) {
          throw new CompileError({ code: 'animation/duplicate-animate-attribute', message: `Element "${elementId}" declares more than one animate:${fieldName} attribute.` });
        }

        const contextLabel = `animate:${fieldName} on element "${elementId}"`;
        const overrides = parseAnimateOverrides(attr.overrideConfigText, contextLabel);
        const typedFieldName = fieldName as AnimationFieldName;
        const config: ParsedAnimationConfig = {
          name: animateBindingAnimationName(elementId, fieldName),
          step: {
            duration: overrides.duration,
            easeFunction: overrides.easeFunction,
            delay: overrides.delay,
            repeat: overrides.repeat,
            targetId: elementId,
            interpolators: [
              {
                fieldName: typedFieldName,
                interpolatorKind: FIELD_INTERPOLATOR_KIND[typedFieldName],
                key: { kind: 'array', items: [{ kind: 'number', value: 0 }, { kind: 'number', value: 1 }] },
                keyValue: placeholderKeyValue(typedFieldName),
                targetId: null,
                reverse: false,
                // Layer 3 already computes its own keyValue at runtime (identifier-rewrite.ts's
                // animate: binding assignment, GetChild(0).keyValue = [current, new]) — a wholly
                // separate mechanism from `scaled: true`'s own ft_scale(...) override in init(), so
                // this is always false here regardless of the field's own scale-worthiness.
                scaled: false,
              },
            ],
            composition: null,
          },
        };
        result.set(key, { elementId, fieldName: typedFieldName, config });
      }
    },
  });

  return result;
}
