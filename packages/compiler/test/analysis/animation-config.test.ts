import { expect } from 'chai';
import { parseAnimationConfig } from '../../src/analysis/animation-config.js';
import { parseScriptFixture } from '../helpers/parseScriptFixture.js';

/** `parseScriptFixture`'s fixture always has a template with a single `<Label id="a" />` — every test below targets "a" unless it's specifically exercising the unknown-target error. */
const ELEMENT_IDS = new Set(['a']);

function config(scriptBody: string, elementIds: ReadonlySet<string> = ELEMENT_IDS) {
  const animation = parseScriptFixture(scriptBody).animations[0]!;
  return parseAnimationConfig(animation, elementIds, 'animation {} declaration');
}

function throwsCode(scriptBody: string, code: string, elementIds: ReadonlySet<string> = ELEMENT_IDS): void {
  expect(() => config(scriptBody, elementIds)).to.throw().with.property('diagnostic').that.deep.include({ code });
}

describe('parseAnimationConfig — simple (non-composed) form', () => {
  it('parses target + timing + a shorthand array field, auto-computing evenly-spaced key', () => {
    const parsed = config('animation bounce { target: a, duration: 400, easeFunction: "outCubic", scale: [1, 1.15, 1] }');
    expect(parsed.name).to.equal('bounce');
    expect(parsed.step.targetId).to.equal('a');
    expect(parsed.step.duration).to.equal(400);
    expect(parsed.step.easeFunction).to.equal('outCubic');
    expect(parsed.step.composition).to.equal(null);
    expect(parsed.step.interpolators).to.deep.equal([
      {
        fieldName: 'scale',
        interpolatorKind: 'vector2d',
        key: { kind: 'array', items: [{ kind: 'number', value: 0 }, { kind: 'number', value: 0.5 }, { kind: 'number', value: 1 }] },
        keyValue: {
          kind: 'array',
          items: [
            { kind: 'array', items: [{ kind: 'number', value: 1 }, { kind: 'number', value: 1 }] },
            { kind: 'array', items: [{ kind: 'number', value: 1.15 }, { kind: 'number', value: 1.15 }] },
            { kind: 'array', items: [{ kind: 'number', value: 1 }, { kind: 'number', value: 1 }] },
          ],
        },
        targetId: null,
        reverse: false,
        scaled: false,
      },
    ]);
  });

  it('auto-computes a single [0] key for a 1-value shorthand array, without dividing by zero', () => {
    const parsed = config('animation snap { target: a, opacity: [1] }');
    expect(parsed.step.interpolators[0].key).to.deep.equal({ kind: 'array', items: [{ kind: 'number', value: 0 }] });
  });

  it('parses multiple known-field shorthands sharing the same step', () => {
    const parsed = config('animation combo { target: a, opacity: [0, 1], rotation: [0, 360] }');
    expect(parsed.step.interpolators.map((i) => i.fieldName).sort()).to.deep.equal(['opacity', 'rotation']);
  });

  it('accepts a negative number in a translation keyValue, e.g. sliding in from off-screen', () => {
    const parsed = config('animation slideIn { target: a, translation: [[-300, 0], [0, 0]] }');
    expect(parsed.step.interpolators[0].keyValue).to.deep.equal({
      kind: 'array',
      items: [
        { kind: 'array', items: [{ kind: 'number', value: -300 }, { kind: 'number', value: 0 }] },
        { kind: 'array', items: [{ kind: 'number', value: 0 }, { kind: 'number', value: 0 }] },
      ],
    });
  });

  it('parses the object form with explicit key/keyValue and a per-field target override', () => {
    const parsed = config('animation move { target: a, translation: { key: [0, 0.3, 1], keyValue: [[0,0],[50,-20],[300,0]], target: a } }');
    const interp = parsed.step.interpolators[0];
    expect(interp.fieldName).to.equal('translation');
    expect(interp.targetId).to.equal('a');
    expect((interp.key as { items: unknown[] }).items).to.have.length(3);
  });

  it('defaults "scaled" to false when omitted from the object form', () => {
    const parsed = config('animation move { target: a, translation: { keyValue: [[0,0],[50,-20]] } }');
    expect(parsed.step.interpolators[0].scaled).to.equal(false);
  });

  it('parses "scaled: true" on a translation object-form field', () => {
    const parsed = config('animation move { target: a, translation: { keyValue: [[-300,0],[0,0]], scaled: true } }');
    expect(parsed.step.interpolators[0].scaled).to.equal(true);
  });

  it('parses "scaled: true" on the "field"/"as" escape hatch when "as" is "float" or "vector2d"', () => {
    const parsed = config('animation custom { target: a, field: { name: "customX", as: "float", keyValue: [0, 100], scaled: true } }');
    expect(parsed.step.interpolators[0].scaled).to.equal(true);
  });

  it('throws animation/scaled-not-supported-for-field for "scaled: true" on opacity/rotation/scale shorthands', () => {
    throwsCode('animation bad { target: a, opacity: { keyValue: [0, 1], scaled: true } }', 'animation/scaled-not-supported-for-field');
    throwsCode('animation bad { target: a, rotation: { keyValue: [0, 360], scaled: true } }', 'animation/scaled-not-supported-for-field');
    throwsCode('animation bad { target: a, scale: { keyValue: [1, 1.5], scaled: true } }', 'animation/scaled-not-supported-for-field');
  });

  it('throws animation/scaled-not-supported-for-color for "scaled: true" on the color shorthand or the escape hatch with as: "color"', () => {
    throwsCode('animation bad { target: a, color: { keyValue: [0, 4294967295], scaled: true } }', 'animation/scaled-not-supported-for-color');
    throwsCode('animation bad { target: a, field: { name: "tint", as: "color", keyValue: [0, 1], scaled: true } }', 'animation/scaled-not-supported-for-color');
  });

  it('color field accepts numeric keyValue entries (not 2-element arrays)', () => {
    const parsed = config('animation tint { target: a, color: [0, 4294967295] }');
    expect(parsed.step.interpolators[0].interpolatorKind).to.equal('color');
  });

  it('parses the "field" escape hatch for an arbitrary Roku field name', () => {
    const parsed = config('animation custom { target: a, field: { name: "customFloat", as: "float", keyValue: [0, 1] } }');
    const interp = parsed.step.interpolators[0];
    expect(interp.fieldName).to.equal('customFloat');
    expect(interp.interpolatorKind).to.equal('float');
  });

  it('throws animation/missing-target when neither the step nor every field declares a target', () => {
    throwsCode('animation noTarget { opacity: [0, 1] }', 'animation/missing-target');
  });

  it('does not throw when target is omitted at the step level but every field supplies its own', () => {
    expect(() => config('animation perField { opacity: { keyValue: [0, 1], target: a } }')).to.not.throw();
  });

  it('throws animation/unknown-target when target references a nonexistent element id', () => {
    throwsCode('animation bad { target: doesNotExist, opacity: [0, 1] }', 'animation/unknown-target');
  });

  it('throws animation/invalid-target when target is a string literal instead of a bare identifier', () => {
    throwsCode('animation bad { target: "a", opacity: [0, 1] }', 'animation/invalid-target');
  });

  it('throws animation/unknown-config-key for a key outside the closed set', () => {
    throwsCode('animation bad { target: a, bogus: [0, 1] }', 'animation/unknown-config-key');
  });

  it('throws animation/invalid-ease-function for an unrecognized easeFunction', () => {
    throwsCode('animation bad { target: a, easeFunction: "bogus", opacity: [0, 1] }', 'animation/invalid-ease-function');
  });

  it('accepts every documented easeFunction value', () => {
    expect(() => config('animation ok { target: a, easeFunction: "inOutCubic", opacity: [0, 1] }')).to.not.throw();
  });

  it('throws animation/key-length-mismatch when object-form key/keyValue lengths differ', () => {
    throwsCode('animation bad { target: a, opacity: { key: [0, 1], keyValue: [0, 0.5, 1] } }', 'animation/key-length-mismatch');
  });

  it('throws animation/invalid-key-value-shape when a vector2d field (other than scale, which broadcasts) gets scalar keyValue entries', () => {
    throwsCode('animation bad { target: a, translation: [1, 2] }', 'animation/invalid-key-value-shape');
  });

  it('broadcasts a scalar scale keyValue entry to uniform [v, v], mixed with explicit [x, y] entries', () => {
    const parsed = config('animation bad { target: a, scale: [1, [1.2, 0.8], 1] }');
    expect(parsed.step.interpolators[0].keyValue).to.deep.equal({
      kind: 'array',
      items: [
        { kind: 'array', items: [{ kind: 'number', value: 1 }, { kind: 'number', value: 1 }] },
        { kind: 'array', items: [{ kind: 'number', value: 1.2 }, { kind: 'number', value: 0.8 }] },
        { kind: 'array', items: [{ kind: 'number', value: 1 }, { kind: 'number', value: 1 }] },
      ],
    });
  });

  it('throws animation/invalid-key-value-shape when a float field gets array keyValue entries', () => {
    throwsCode('animation bad { target: a, opacity: [[0,0], [1,1]] }', 'animation/invalid-key-value-shape');
  });

  it('throws animation/step-declares-nothing when a step has no field and no composition', () => {
    throwsCode('animation bad { target: a }', 'animation/step-declares-nothing');
  });
});

describe('parseAnimationConfig — composition (sequential/parallel + steps)', () => {
  it('parses a sequential composition with two field-only steps', () => {
    const parsed = config(
      [
        'animation intro {',
        '  target: a,',
        '  sequential: true,',
        '  steps: [',
        '    { opacity: [0, 1], duration: 300 },',
        '    { translation: [[0,40],[0,0]], duration: 300 }',
        '  ]',
        '}',
      ].join('\n'),
    );
    expect(parsed.step.composition).to.not.equal(null);
    expect(parsed.step.composition!.mode).to.equal('sequential');
    expect(parsed.step.composition!.steps).to.have.length(2);
    expect(parsed.step.composition!.steps[0].interpolators[0].fieldName).to.equal('opacity');
    expect(parsed.step.composition!.steps[0].targetId).to.equal(null); // inherits the outer declaration's target
  });

  it('parses a parallel composition', () => {
    const parsed = config('animation both { target: a, parallel: true, steps: [ { opacity: [0, 1] }, { rotation: [0, 90] } ] }');
    expect(parsed.step.composition!.mode).to.equal('parallel');
  });

  it('supports nested composition (a step that is itself composed)', () => {
    const parsed = config(
      [
        'animation nested {',
        '  target: a,',
        '  sequential: true,',
        '  steps: [',
        '    { opacity: [0, 1] },',
        '    { parallel: true, steps: [ { rotation: [0, 90] }, { scale: [1, 1.2] } ] }',
        '  ]',
        '}',
      ].join('\n'),
    );
    const nestedStep = parsed.step.composition!.steps[1];
    expect(nestedStep.composition!.mode).to.equal('parallel');
    expect(nestedStep.composition!.steps).to.have.length(2);
  });

  it('throws animation/sequential-and-parallel-both-set when both are true', () => {
    throwsCode('animation bad { target: a, sequential: true, parallel: true, steps: [ { opacity: [0,1] } ] }', 'animation/sequential-and-parallel-both-set');
  });

  it('throws animation/steps-requires-composition-mode when steps is given without sequential/parallel', () => {
    throwsCode('animation bad { target: a, steps: [ { opacity: [0,1] } ] }', 'animation/steps-requires-composition-mode');
  });

  it('throws animation/composition-mode-requires-steps when sequential is set but steps is missing', () => {
    throwsCode('animation bad { target: a, sequential: true, opacity: [0, 1] }', 'animation/composition-mode-requires-steps');
  });

  it('throws animation/mixed-composition-and-fields when top-level fields are combined with composition', () => {
    throwsCode('animation bad { target: a, sequential: true, opacity: [0, 1], steps: [ { rotation: [0, 90] } ] }', 'animation/mixed-composition-and-fields');
  });

  it('throws animation/empty-steps when steps is an empty array', () => {
    throwsCode('animation bad { target: a, sequential: true, steps: [] }', 'animation/empty-steps');
  });

  it('throws animation/composition-does-not-support-duration-or-ease-function when the composed step itself sets duration', () => {
    throwsCode('animation bad { target: a, sequential: true, duration: 300, steps: [ { opacity: [0,1] } ] }', 'animation/composition-does-not-support-duration-or-ease-function');
  });

  it('inherits "target" from the top-level declaration through nested composition, with no per-step target needed', () => {
    expect(() =>
      config('animation nested { target: a, sequential: true, steps: [ { opacity: [0,1] }, { parallel: true, steps: [ { rotation: [0,90] } ] } ] }'),
    ).to.not.throw();
  });

  it('throws animation/missing-target when a deeply-nested step has no resolvable target anywhere in its ancestor chain', () => {
    throwsCode('animation bad { sequential: true, steps: [ { parallel: true, steps: [ { rotation: [0,90] } ] } ] }', 'animation/missing-target');
  });
});
