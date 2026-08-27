import { expect } from 'chai';
import { parse as parseBrightScript } from 'kopytko-brightscript-parser';
import { compileThrSource } from '../../src/compile.js';
import { CompileError } from '../../src/dsl-parser/dsl-ast.js';

function component(scriptBody: string, template: string): string {
  return `<script>\n${scriptBody}\n</script>\n\n<component>\n${template}\n</component>`;
}

describe('isFocused / isInFocusChain — synthesized only when actually read', () => {
  it('emits nothing at all for a component that never mentions either name', () => {
    const result = compileThrSource(component('field label: string = ""', '<Label id="a" text="{label}" />'), 'Plain');

    expect(result.xml).to.not.include('isFocused');
    expect(result.xml).to.not.include('isInFocusChain');
    expect(result.brs).to.not.include('registerFocusState');
    expect(result.usesFocusSystem).to.equal(false);
  });

  it('synthesizes only the name that is actually read, not both', () => {
    const result = compileThrSource(component('derived label: string = describe(isFocused)\nprivate function describe(v: boolean): string {\n  return "x"\n}', '<Label id="a" text="{label}" />'), 'One');

    expect(result.xml).to.include('<field id="isFocused" type="boolean"');
    expect(result.xml).to.not.include('isInFocusChain');
  });

  it('synthesizes a read from a template binding, not just from script', () => {
    const result = compileThrSource(component('field unused: string = ""', '<Label id="a" visible="{isInFocusChain}" />'), 'FromTemplate');

    expect(result.xml).to.include('<field id="isInFocusChain" type="boolean"');
    expect(result.brs).to.include('registerFocusState');
  });

  it('synthesizes a read from an {#if} block condition', () => {
    const result = compileThrSource(component('field unused: string = ""', '<Rectangle id="root">\n{#if isFocused}\n<Label id="a" />\n{/if}\n</Rectangle>'), 'FromIf');

    expect(result.xml).to.include('<field id="isFocused" type="boolean"');
  });

  it('subscribes exactly once, in init(), and turns on the focus system for this component', () => {
    const result = compileThrSource(component('derived label: string = describe(isFocused)\nprivate function describe(v: boolean): string {\n  return "x"\n}', '<Label id="a" text="{label}" />'), 'Sub');

    expect(result.brs.match(/registerFocusState/g)).to.have.lengthOf(1);
    expect(result.brs).to.include('m.global.ft_focus.callFunc("registerFocusState", m.top)');
    // Reading focus state needs the manager wired into the app's globals, exactly like declaring a
    // focusable element does.
    expect(result.usesFocusSystem).to.equal(true);
  });

  it('behaves as an ordinary reactive field — a derived that reads it gets a change handler', () => {
    const result = compileThrSource(component('derived label: string = describe(isFocused)\nprivate function describe(v: boolean): string {\n  return "x"\n}', '<Label id="a" text="{label}" />'), 'Reactive');

    expect(result.xml).to.include('onChange="on_isFocusedChange"');
    expect(result.brs).to.include('sub on_isFocusedChange(');
    expect(result.brs).to.include('m?.top?.isFocused');
  });

  it('produces .brs that parses as valid BrightScript', () => {
    const result = compileThrSource(component('derived label: string = describe(isFocused, isInFocusChain)\nprivate function describe(a: boolean, b: boolean): string {\n  return "x"\n}', '<Label id="a" text="{label}" />'), 'Valid');

    const parsed = parseBrightScript(result.brs);
    expect(parsed.diagnostics, JSON.stringify(parsed.diagnostics)).to.have.lengthOf(0);
  });
});

describe('isFocused / isInFocusChain — reserved names', () => {
  const cases: { what: string; scriptBody: string }[] = [
    { what: 'field', scriptBody: 'field isFocused: boolean = false' },
    { what: 'derived', scriptBody: 'derived isFocused: boolean = true' },
    { what: 'state', scriptBody: 'state isInFocusChain: boolean = false' },
    { what: 'function', scriptBody: 'private function isFocused(): boolean {\n  return true\n}' },
  ];

  for (const { what, scriptBody } of cases) {
    it(`rejects declaring one as a ${what}`, () => {
      expect(() => compileThrSource(component(scriptBody, '<Label id="a" />'), 'Clash'))
        .to.throw(CompileError)
        .with.property('diagnostic')
        .that.deep.include({ code: 'dsl/reserved-focus-state-name' });
    });
  }

  it('leaves an unrelated name that merely resembles one alone', () => {
    const result = compileThrSource(component('field isFocusedByGrid: boolean = false', '<Label id="a" visible="{isFocusedByGrid}" />'), 'NearMiss');

    expect(result.xml).to.include('<field id="isFocusedByGrid"');
    expect(result.brs).to.not.include('registerFocusState');
  });
});
