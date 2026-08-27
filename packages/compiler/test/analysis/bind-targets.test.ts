import { expect } from 'chai';
import { compileThrSource } from '../../src/compile.js';
import { CompileError } from '../../src/dsl-parser/dsl-ast.js';

function thr(scriptBody: string, template: string): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${template}\n</component>\n`;
}

describe('bind-targets — valid usage', () => {
  it('compiles successfully for a statically-present bind: attribute targeting a declared state', () => {
    const source = thr('state inputValue: string = ""', '<TextEditBox id="input" bind:text="{inputValue}" />');
    expect(() => compileThrSource(source, 'X')).to.not.throw();
  });

  it('compiles successfully for a bind: attribute nested inside a {#if:destroy} block', () => {
    const source = thr(
      ['state hasLoaded: boolean = false', 'state inputValue: string = ""'].join('\n'),
      '<Rectangle id="root">{#if:destroy hasLoaded}<TextEditBox id="input" bind:text="{inputValue}" />{/if}</Rectangle>',
    );
    expect(() => compileThrSource(source, 'X')).to.not.throw();
  });
});

describe('bind-targets — template/invalid-bind-target', () => {
  it('throws when the bind: expression is not a single bare identifier', () => {
    const source = thr('state inputValue: string = ""', '<TextEditBox id="input" bind:text="{inputValue.length}" />');
    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/invalid-bind-target' });
  });
});

describe('bind-targets — template/bind-target-not-state', () => {
  it('throws when the bind: target names a declared field', () => {
    const source = thr('field inputValue: string = ""', '<TextEditBox id="input" bind:text="{inputValue}" />');
    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/bind-target-not-state' });
  });

  it('throws when the bind: target names a declared derived', () => {
    const source = thr('derived inputValue: string = "hi"', '<TextEditBox id="input" bind:text="{inputValue}" />');
    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/bind-target-not-state' });
  });

  it('throws when the bind: target names nothing declared at all', () => {
    const source = thr('field unrelated: integer = 0', '<TextEditBox id="input" bind:text="{inputValue}" />');
    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/bind-target-not-state' });
  });
});

describe('bind-targets — template/bind-inside-each', () => {
  it('throws when a bind: attribute lives inside an {#each} block body', () => {
    const source = thr(
      ['field schedule: node = invalid', 'state inputValue: string = ""'].join('\n'),
      '<Rectangle id="root">{#each schedule as item (item.id)}<TextEditBox id="row" bind:text="{inputValue}" />{/each}</Rectangle>',
    );
    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/bind-inside-each' });
  });
});
