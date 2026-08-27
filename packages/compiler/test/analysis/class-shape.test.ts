import { expect } from 'chai';
import { parseClassFixture } from '../helpers/parseClassFixture.js';
import { buildClassShape } from '../../src/analysis/class-shape.js';

describe('buildClassShape', () => {
  it('collects top-level fields and methods as own members', () => {
    const classAst = parseClassFixture(['class C {', '  private x: integer = 0', '  public function get(): integer {', '    return m.x', '  }', '}'].join('\n'));
    const shape = buildClassShape(classAst, null);

    expect(shape.className).to.equal('C');
    expect(shape.baseName).to.equal(null);
    expect([...shape.ownMembers.keys()].sort()).to.deep.equal(['get', 'x']);
    expect(shape.ownMembers.get('x')).to.deep.equal({ name: 'x', kind: 'field', visibility: 'private', returnType: null });
    expect(shape.ownMembers.get('get')).to.deep.equal({ name: 'get', kind: 'method', visibility: 'public', returnType: 'integer' });
  });

  it('collects a stream field as an own member with kind "field", same as an ordinary field', () => {
    const classAst = parseClassFixture(['class C {', '  public stream onChanged: string', '}'].join('\n'));
    const shape = buildClassShape(classAst, null);

    expect(shape.ownMembers.get('onChanged')).to.deep.equal({ name: 'onChanged', kind: 'field', visibility: 'public', returnType: null });
  });

  it('also collects a field declared entirely inside the constructor (no top-level ClassFieldDeclaration)', () => {
    const classAst = parseClassFixture(['class C {', '  constructor(a: string) {', '    private a: string = a', '  }', '}'].join('\n'));
    const shape = buildClassShape(classAst, null);

    expect(shape.ownMembers.get('a')).to.deep.equal({ name: 'a', kind: 'field', visibility: 'private', returnType: null });
  });

  it('a method with no return-type clause (compiles to a sub) has returnType: null', () => {
    const classAst = parseClassFixture(['class C {', '  public function log() {', '    print "hi"', '  }', '}'].join('\n'));
    const shape = buildClassShape(classAst, null);

    expect(shape.ownMembers.get('log')).to.deep.equal({ name: 'log', kind: 'method', visibility: 'public', returnType: null });
  });

  it('allMembers layers own members on top of the base shape, own winning on a name clash (override)', () => {
    const baseAst = parseClassFixture(['class Base {', '  public function f(): integer {', '    return 1', '  }', '}'].join('\n'));
    const baseShape = buildClassShape(baseAst, null);

    const childAst = parseClassFixture(
      [
        'import Base from "./Base.flsh"',
        '',
        'class Child extends Base {',
        '  override constructor() {',
        '    super()',
        '  }',
        '  override public function f(): integer {',
        '    return 2',
        '  }',
        '}',
      ].join('\n'),
    );
    const childShape = buildClassShape(childAst, baseShape);

    expect(childShape.ownMembers.get('f')).to.deep.equal({ name: 'f', kind: 'method', visibility: 'public', returnType: 'integer' });
    expect(childShape.allMembers.get('f')).to.deep.equal({ name: 'f', kind: 'method', visibility: 'public', returnType: 'integer' });
  });

  it('an override changing the return type is reflected in allMembers (own always wins)', () => {
    const baseAst = parseClassFixture(['class Base {', '  public function f(): integer {', '    return 1', '  }', '}'].join('\n'));
    const baseShape = buildClassShape(baseAst, null);

    const childAst = parseClassFixture(
      [
        'import Base from "./Base.flsh"',
        '',
        'class Child extends Base {',
        '  override constructor() {',
        '    super()',
        '  }',
        '  override public function f(): string {',
        '    return "2"',
        '  }',
        '}',
      ].join('\n'),
    );
    const childShape = buildClassShape(childAst, baseShape);

    expect(baseShape.allMembers.get('f')?.returnType).to.equal('integer');
    expect(childShape.allMembers.get('f')?.returnType).to.equal('string');
  });

  it('allMembers includes an inherited member the child does not redeclare', () => {
    const baseAst = parseClassFixture(['class Base {', '  private x: integer = 0', '}'].join('\n'));
    const baseShape = buildClassShape(baseAst, null);

    const childAst = parseClassFixture(
      ['import Base from "./Base.flsh"', '', 'class Child extends Base {', '  override constructor() {', '    super()', '  }', '}'].join('\n'),
    );
    const childShape = buildClassShape(childAst, baseShape);

    expect(childShape.allMembers.get('x')).to.deep.equal({ name: 'x', kind: 'field', visibility: 'private', returnType: null });
    expect(childShape.ownMembers.has('x')).to.equal(false);
  });

  it('allMembers includes an inherited method return type the child does not redeclare', () => {
    const baseAst = parseClassFixture(['class Base {', '  public function describe(): string {', '    return "base"', '  }', '}'].join('\n'));
    const baseShape = buildClassShape(baseAst, null);

    const childAst = parseClassFixture(
      ['import Base from "./Base.flsh"', '', 'class Child extends Base {', '  override constructor() {', '    super()', '  }', '}'].join('\n'),
    );
    const childShape = buildClassShape(childAst, baseShape);

    expect(childShape.allMembers.get('describe')?.returnType).to.equal('string');
  });
});
