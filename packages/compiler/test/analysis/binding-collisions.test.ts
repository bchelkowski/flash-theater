import { expect } from 'chai';
import { compileThrSource } from '../../src/compile.js';
import { CompileError } from '../../src/dsl-parser/dsl-ast.js';

function thr(scriptBody: string, template: string): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${template}\n</component>\n`;
}

describe('binding-collisions — template id vs derived/state', () => {
  it('throws template/id-collides-with-binding when an element id matches a derived name', () => {
    const source = thr('derived label: string = "hi"', '<Label id="label" text="{label}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/id-collides-with-binding' });
  });

  it('throws template/id-collides-with-binding when an element id matches a state name', () => {
    const source = thr('state label: string = "hi"', '<Label id="label" text="{label}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/id-collides-with-binding' });
  });

  it('compiles successfully when an element id matches a field name (different m. slot, no clobber)', () => {
    const source = thr('field label: string = "hi"', '<Label id="label" text="{label}" />');

    expect(() => compileThrSource(source, 'X')).to.not.throw();
  });

  it('throws template/id-collides-with-binding when an element id matches a read name', () => {
    const source = thr('read label = store(label)', '<Label id="label" text="{label}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/id-collides-with-binding' });
  });

  it('throws template/id-collides-with-binding when an element id matches a watch name', () => {
    const source = thr('watch label = store(label)', '<Label id="label" text="{label}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/id-collides-with-binding' });
  });

  it('throws template/id-collides-with-binding when an element id matches a stream name', () => {
    const source = thr('stream label: string', '<Label id="label" text="{label}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/id-collides-with-binding' });
  });
});

describe('binding-collisions — field/derived/state name collisions with each other', () => {
  it('throws dsl/duplicate-binding-name when a field and a derived share a name', () => {
    const source = thr(
      ['field foo: integer = 0', 'derived foo: integer = 1'].join('\n'),
      '<Label id="out" text="{foo}" />',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/duplicate-binding-name' });
  });

  it('throws dsl/duplicate-binding-name when a field and a state share a name', () => {
    const source = thr(
      ['field foo: integer = 0', 'state foo: integer = 1'].join('\n'),
      '<Label id="out" text="{foo}" />',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/duplicate-binding-name' });
  });

  it('throws dsl/duplicate-binding-name when a derived and a state share a name', () => {
    const source = thr(
      ['state foo: integer = 0', 'derived foo: integer = 1'].join('\n'),
      '<Label id="out" text="{foo}" />',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/duplicate-binding-name' });
  });

  it('throws dsl/duplicate-binding-name when a field and a read share a name', () => {
    const source = thr(
      ['field foo: integer = 0', 'read foo = store(foo)'].join('\n'),
      '<Label id="out" text="{foo}" />',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/duplicate-binding-name' });
  });

  it('throws dsl/duplicate-binding-name when a read and a watch share a name', () => {
    const source = thr(
      ['read foo = store(foo)', 'watch foo = store(foo)'].join('\n'),
      '<Label id="out" text="{foo}" />',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/duplicate-binding-name' });
  });

  it('throws dsl/duplicate-binding-name when a field and a stream share a name', () => {
    const source = thr(
      ['field foo: integer = 0', 'stream foo: string'].join('\n'),
      '<Label id="out" text="{foo}" />',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/duplicate-binding-name' });
  });
});

describe('binding-collisions — duplicate element ids', () => {
  it('throws template/duplicate-id when two elements share an id', () => {
    const source = thr(
      'field a: integer = 0',
      ['<Rectangle id="root">', '  <Label id="dup" text="{a}" />', '  <Label id="dup" text="{a}" />', '</Rectangle>'].join('\n'),
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/duplicate-id' });
  });
});

describe('binding-collisions — reserved "ft_" identifier prefix', () => {
  it('throws dsl/reserved-identifier-prefix for a field named with the reserved prefix', () => {
    const source = thr('field ft_x: integer = 0', '<Label id="out" text="{ft_x}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-identifier-prefix' });
  });

  it('throws dsl/reserved-identifier-prefix for a derived named with the reserved prefix', () => {
    const source = thr('derived ft_x: integer = 1', '<Label id="out" text="{ft_x}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-identifier-prefix' });
  });

  it('throws dsl/reserved-identifier-prefix for a public function named with the reserved prefix', () => {
    const source = thr('public function ft_bump() {\n  print "hi"\n}', '<Label id="out" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-identifier-prefix' });
  });

  it('throws dsl/reserved-identifier-prefix for an element id starting with the reserved prefix', () => {
    const source = thr('field a: integer = 0', '<Label id="ft_bogus" text="{a}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-identifier-prefix' });
  });

  it('throws dsl/reserved-identifier-prefix for a stream named with the reserved prefix', () => {
    const source = thr('stream ft_x: string', '<Label id="out" text="{ft_x}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-identifier-prefix' });
  });

  it('compiles successfully when no name uses the reserved prefix', () => {
    const source = thr('field a: integer = 0', '<Label id="out" text="{a}" />');
    expect(() => compileThrSource(source, 'X')).to.not.throw();
  });

  it('throws dsl/reserved-identifier-prefix for an {#each} item alias starting with the reserved prefix', () => {
    const source = thr(
      'field schedule: node = invalid',
      '<Rectangle id="root">{#each schedule as ft_bad (ft_bad.id)}<Label id="row" text="{ft_bad.id}" />{/each}</Rectangle>',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-identifier-prefix' });
  });
});

describe('binding-collisions — {#each} item alias collisions', () => {
  it('throws template/each-alias-collision when the item alias matches a field name', () => {
    const source = thr(
      ['field label: string = "hi"', 'field schedule: node = invalid'].join('\n'),
      '<Rectangle id="root">{#each schedule as label (label)}<Label id="row" text="{label}" />{/each}</Rectangle>',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/each-alias-collision' });
  });

  it('throws template/each-alias-collision when the item alias matches a derived name', () => {
    const source = thr(
      ['derived label: string = "hi"', 'field schedule: node = invalid'].join('\n'),
      '<Rectangle id="root">{#each schedule as label (label)}<Label id="row" text="{label}" />{/each}</Rectangle>',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/each-alias-collision' });
  });

  it('throws template/each-alias-collision when the item alias matches a state name', () => {
    const source = thr(
      ['state label: string = "hi"', 'field schedule: node = invalid'].join('\n'),
      '<Rectangle id="root">{#each schedule as label (label)}<Label id="row" text="{label}" />{/each}</Rectangle>',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/each-alias-collision' });
  });

  it('throws template/each-alias-collision when the item alias matches a read name', () => {
    const source = thr(
      ['read label = store(label)', 'field schedule: node = invalid'].join('\n'),
      '<Rectangle id="root">{#each schedule as label (label)}<Label id="row" text="{label}" />{/each}</Rectangle>',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/each-alias-collision' });
  });

  it('throws template/each-alias-collision when the item alias matches a watch name', () => {
    const source = thr(
      ['watch label = store(label)', 'field schedule: node = invalid'].join('\n'),
      '<Rectangle id="root">{#each schedule as label (label)}<Label id="row" text="{label}" />{/each}</Rectangle>',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/each-alias-collision' });
  });

  it('throws template/each-alias-collision when the item alias matches a stream name', () => {
    const source = thr(
      ['stream label: string', 'field schedule: node = invalid'].join('\n'),
      '<Rectangle id="root">{#each schedule as label (label)}<Label id="row" text="{label}" />{/each}</Rectangle>',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/each-alias-collision' });
  });

  it('throws template/each-alias-collision when the item alias matches a function name', () => {
    const source = thr(
      ['field schedule: node = invalid', 'private function label() {\n  print "hi"\n}'].join('\n'),
      '<Rectangle id="root">{#each schedule as label (label)}<Label id="row" text="{label}" />{/each}</Rectangle>',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/each-alias-collision' });
  });

  it('throws template/each-alias-collision when the item alias matches an element id declared elsewhere in the template', () => {
    const source = thr(
      'field schedule: node = invalid',
      '<Rectangle id="root"><Label id="badge" text="hi" />{#each schedule as badge (badge.id)}<Label id="row" text="{badge.title}" />{/each}</Rectangle>',
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/each-alias-collision' });
  });

  it('compiles successfully when the item alias does not collide with anything', () => {
    const source = thr(
      'field schedule: node = invalid',
      '<Rectangle id="root">{#each schedule as item (item.id)}<Label id="row" text="{item.title}" />{/each}</Rectangle>',
    );

    expect(() => compileThrSource(source, 'X')).to.not.throw();
  });
});

describe('binding-collisions — reserved global function names (setTimeout/setInterval/clearTimeout/clearInterval)', () => {
  it('throws dsl/reserved-global-function-name for a field named setTimeout', () => {
    const source = thr('field setTimeout: integer = 0', '<Label id="out" text="{setTimeout}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-global-function-name' });
  });

  it('throws dsl/reserved-global-function-name for a derived named setInterval', () => {
    const source = thr('derived setInterval: integer = 1', '<Label id="out" text="{setInterval}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-global-function-name' });
  });

  it('throws dsl/reserved-global-function-name for a state named clearTimeout', () => {
    const source = thr('state clearTimeout: integer = 0', '<Label id="out" text="{clearTimeout}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-global-function-name' });
  });

  it('throws dsl/reserved-global-function-name for a read named clearInterval', () => {
    const source = thr('read clearInterval = store(clearInterval)', '<Label id="out" text="{clearInterval}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-global-function-name' });
  });

  it('throws dsl/reserved-global-function-name for a watch named setTimeout', () => {
    const source = thr('watch setTimeout = store(setTimeout)', '<Label id="out" text="{setTimeout}" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-global-function-name' });
  });

  it('throws dsl/reserved-global-function-name for a stream named setInterval', () => {
    const source = thr('stream setInterval: string', '<Label id="out" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-global-function-name' });
  });

  it('throws dsl/reserved-global-function-name for an animation named clearTimeout', () => {
    const source = thr('animation clearTimeout {\n  target: out\n  duration: 1\n  key: [0, 1]\n  keyValue: [0, 1]\n}', '<Label id="out" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-global-function-name' });
  });

  it('throws dsl/reserved-global-function-name for a function named clearInterval', () => {
    const source = thr('public function clearInterval() {\n  print "hi"\n}', '<Label id="out" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-global-function-name' });
  });

  it('throws dsl/reserved-global-function-name for a function parameter named setTimeout', () => {
    const source = thr('public function invokeIt(setTimeout: integer) {\n  print setTimeout\n}', '<Label id="out" />');

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/reserved-global-function-name' });
  });

  it('compiles successfully when no name collides with a reserved global function', () => {
    const source = thr('field a: integer = 0', '<Label id="out" text="{a}" />');
    expect(() => compileThrSource(source, 'X')).to.not.throw();
  });
});
