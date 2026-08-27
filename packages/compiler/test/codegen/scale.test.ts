import { expect } from 'chai';
import { compileThrSource } from '../../src/compile.js';
import { CompileError } from '../../src/dsl-parser/dsl-ast.js';
import { GlobalBindingsContext } from '../../src/analysis/global-bindings.js';

const TEMPLATE = '<Label id="out" text="{a}" />';

function thr(scriptBody: string): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${TEMPLATE}\n</component>\n`;
}

const CONFIGURED: GlobalBindingsContext = { theme: null, designResolutionConfigured: true };

describe('emitBrs — scale', () => {
  it('throws dsl/scale-requires-config when scale is used but no design resolution was configured', () => {
    const source = thr(['derived a: integer = 1', 'scale field width: integer = 100'].join('\n'));

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/scale-requires-config' });
  });

  it('does not require config when scale is never used', () => {
    const source = thr('derived a: integer = 1');
    expect(() => compileThrSource(source, 'X')).to.not.throw();
  });

  it('overrides a scaled field default in init() with ft_scale(...), leaving the XML default raw', () => {
    const source = thr(['scale field width: integer = 200', 'derived a: integer = 1'].join('\n'));
    const { brs, xml } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

    expect(brs).to.include('m.top.width = ft_scale(200, m.global.ft_scaleFactor)');
    expect(xml).to.include('value="200"');
  });

  it('wraps a scaled state default with ft_scale(...)', () => {
    const source = thr(['scale state offset: integer = 10', 'derived a: integer = 1'].join('\n'));
    const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

    expect(brs).to.include('m.offset = ft_scale(10, m.global.ft_scaleFactor)');
  });

  it('wraps a scaled derived recompute with ft_scale(...)', () => {
    const source = thr(['derived a: integer = 1', 'field base: integer = 10', 'scale derived doubled: integer = base * 2'].join('\n'));
    const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

    expect(brs).to.include('m.doubled = ft_scale(m?.top?.base * 2, m.global.ft_scaleFactor)');
  });

  it('wraps a scaled watch recompute with ft_scale(...)', () => {
    const source = thr(['scale watch remoteWidth = store(remoteWidth)', 'derived a: integer = 1'].join('\n'));
    const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

    expect(brs).to.include('m.remoteWidth = ft_scale(m.global.ft_store.remoteWidth, m.global.ft_scaleFactor)');
  });

  it('wraps a scaled read snapshot with ft_scale(...), assigned once in init()', () => {
    const source = thr(['scale read initialWidth = store(initialWidth)', 'derived a: integer = 1'].join('\n'));
    const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

    expect(brs).to.include('m.initialWidth = ft_scale(m.global.ft_store.initialWidth, m.global.ft_scaleFactor)');
  });

  it('wraps a scaled local-variable assignment inside a function body with ft_scale(...)', () => {
    const source = thr(['derived a: integer = 1', 'public function f() {', '  scale x = 10', '}'].join('\n'));
    const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

    expect(brs).to.include('x = ft_scale(10, m.global.ft_scaleFactor)');
  });

  it('wraps a scaled state write inside a function body with ft_scale(...), still running the reactive cascade', () => {
    const source = thr(
      ['scale state offset: integer = 0', 'derived a: integer = offset * 2', 'public function f() {', '  scale state offset = 20', '}'].join('\n'),
    );
    const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

    expect(brs).to.include('m.offset = ft_scale(20, m.global.ft_scaleFactor)');
    // the reactive cascade still recomputes the dependent (unscaled) `derived` right after the
    // scaled write — it reads the already-scaled `m.offset` value, itself unwrapped.
    expect(brs).to.include('m.a = m?.offset * 2');
  });

  it('splices a <script uri> pointing at the Scale runtime helper only when ft_scale( is actually emitted', () => {
    const unscaled = thr('derived a: integer = 1');
    const { brs: unscaledBrs, xml: unscaledXml } = compileThrSource(unscaled, 'X', {
      globalBindings: CONFIGURED,
      scaleHelperScriptUri: 'pkg:/components/FlashTheater/Scale/FlashTheaterScale.brs',
    });
    expect(unscaledBrs).to.not.include('ft_scale(');
    expect(unscaledXml).to.not.include('FlashTheaterScale.brs');

    const scaled = thr(['scale field width: integer = 100', 'derived a: integer = 1'].join('\n'));
    const { xml: scaledXml } = compileThrSource(scaled, 'X', {
      globalBindings: CONFIGURED,
      scaleHelperScriptUri: 'pkg:/components/FlashTheater/Scale/FlashTheaterScale.brs',
    });
    expect(scaledXml).to.include('pkg:/components/FlashTheater/Scale/FlashTheaterScale.brs');
  });

  it('rejects a scale field with a non-integer/float type at parse time', () => {
    const source = thr('scale field label: string = "x"');
    expect(() => compileThrSource(source, 'X', { globalBindings: CONFIGURED }))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/scale-invalid-field-type' });
  });

  it('an UNSCALED array field still gets an unconditional (unwrapped) init() override, since XML has no representable default for it', () => {
    const source = thr(['field items: array = [1, 2, 3]', 'derived a: integer = 1'].join('\n'));
    const { brs, xml } = compileThrSource(source, 'X');

    expect(brs).to.include('m.top.items = [1, 2, 3]');
    expect(brs).to.not.include('ft_scale(');
    expect(xml).to.include('<field id="items" type="array" />');
  });

  it('an UNSCALED assocarray field also gets an unconditional init() override', () => {
    const source = thr(['field config: assocarray = { a: 1 }', 'derived a: integer = 1'].join('\n'));
    const { brs, xml } = compileThrSource(source, 'X');

    expect(brs).to.include('m.top.config = { a: 1 }');
    expect(xml).to.include('<field id="config" type="assocarray" />');
  });

  it('a SCALED array field wraps its init() override with ft_scale(...)', () => {
    const source = thr(['scale field position: array = [100, 50]', 'derived a: integer = 1'].join('\n'));
    const { brs, xml } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

    expect(brs).to.include('m.top.position = ft_scale([100, 50], m.global.ft_scaleFactor)');
    expect(xml).to.include('<field id="position" type="array" />');
  });

  it('a SCALED assocarray field wraps its init() override with ft_scale(...)', () => {
    const source = thr(['scale field padding: assocarray = { top: 10, left: 5 }', 'derived a: integer = 1'].join('\n'));
    const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

    expect(brs).to.include('m.top.padding = ft_scale({ top: 10, left: 5 }, m.global.ft_scaleFactor)');
  });

  it('a SCALED state with an array literal wraps m.<name> with ft_scale(...)', () => {
    const source = thr(['scale state position: object = [100, 50]', 'derived a: integer = 1'].join('\n'));
    const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

    expect(brs).to.include('m.position = ft_scale([100, 50], m.global.ft_scaleFactor)');
  });

  describe('scale meets animation — "scaled: true" on an interpolator, and fly/slide presets', () => {
    function withAnimation(scriptBody: string): string {
      return ['<script>', scriptBody, '</script>', '<component>', '<Rectangle id="card" />', '</component>'].join('\n');
    }

    it('gives a "scaled: true" interpolator its own id, distinct from the outer animation id', () => {
      const source = withAnimation('animation slideIn {\n  target: card\n  translation: { keyValue: [[-300, 0], [0, 0]], scaled: true }\n}');
      const { xml } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

      expect(xml).to.include('id="ft_anim_slideIn_ref_0"');
    });

    it('overrides the scaled interpolator\'s keyValue in init() with one ft_scale(...) call per keyframe, leaving the XML default raw', () => {
      const source = withAnimation('animation slideIn {\n  target: card\n  translation: { keyValue: [[-300, 0], [0, 0]], scaled: true }\n}');
      const { brs, xml } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

      expect(brs).to.include(
        'm.top.findNode("ft_anim_slideIn_ref_0").keyValue = [ft_scale([-300, 0], m.global.ft_scaleFactor), ft_scale([0, 0], m.global.ft_scaleFactor)]',
      );
      expect(xml).to.include('keyValue="[[-300, 0], [0, 0]]"');
    });

    it('does not emit any scaled-interpolator override line when no interpolator sets "scaled: true"', () => {
      const source = withAnimation('animation bounce {\n  target: card\n  scale: [1, 1.15, 1]\n}');
      const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

      expect(brs).to.not.include('_ref_');
    });

    it('a Float-kind "scaled: true" field (the "field"/"as" escape hatch) wraps each plain-number keyframe individually', () => {
      const source = withAnimation('animation grow {\n  target: card\n  field: { name: "customWidth", as: "float", keyValue: [100, 300], scaled: true }\n}');
      const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

      expect(brs).to.include('.keyValue = [ft_scale(100, m.global.ft_scaleFactor), ft_scale(300, m.global.ft_scaleFactor)]');
    });

    it('fly/slide transition presets scale their own x/y offset by default, without the author writing "scaled: true"', () => {
      const source = [
        '<script>',
        'state show: boolean = true',
        '</script>',
        '<component>',
        '<Rectangle id="root">',
        '{#if show}',
        '<Rectangle id="panel" transition:fly="" />',
        '{/if}',
        '</Rectangle>',
        '</component>',
      ].join('\n');
      const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

      expect(brs).to.match(/m\.top\.findNode\("ft_anim_if_1_(in|out)_ref_0"\)\.keyValue = \[ft_scale\(\[0, 40\], m\.global\.ft_scaleFactor\), ft_scale\(\[0, 0\], m\.global\.ft_scaleFactor\)\]/);
    });

    it('fade/scale transition presets are never scaled (opacity/relative-multiplier values are unitless)', () => {
      const source = [
        '<script>',
        'state show: boolean = true',
        '</script>',
        '<component>',
        '<Rectangle id="root">',
        '{#if show}',
        '<Rectangle id="panel" transition:fade="" />',
        '{/if}',
        '</Rectangle>',
        '</component>',
      ].join('\n');
      const { brs } = compileThrSource(source, 'X', { globalBindings: CONFIGURED });

      expect(brs).to.not.include('_ref_');
    });
  });
});
