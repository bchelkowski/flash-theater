import { expect } from 'chai';
import { parseClassFixture } from '../helpers/parseClassFixture.js';
import { buildClassShape } from '../../src/analysis/class-shape.js';
import { checkDuplicateClassMemberNames, checkOverrideCoherence } from '../../src/analysis/class-analysis.js';
import { CompileError } from '../../src/dsl-parser/dsl-ast.js';

function expectThrows(fn: () => void, code: string): void {
  try {
    fn();
    expect.fail(`expected CompileError ${code}, but nothing was thrown`);
  } catch (e) {
    expect(e).to.be.instanceOf(CompileError);
    expect((e as CompileError).diagnostic.code).to.equal(code);
  }
}

describe('checkDuplicateClassMemberNames', () => {
  it('does not throw for a class with no name collisions', () => {
    const classAst = parseClassFixture(['class C {', '  private x: integer = 0', '  public function get(): integer {', '    return m.x', '  }', '}'].join('\n'));
    expect(() => checkDuplicateClassMemberNames(classAst, null)).to.not.throw();
  });

  it('throws class/duplicate-member-name when a field and a method share a name', () => {
    const classAst = parseClassFixture(['class C {', '  private x: integer = 0', '  public function x(): integer {', '    return 1', '  }', '}'].join('\n'));
    expectThrows(() => checkDuplicateClassMemberNames(classAst, null), 'class/duplicate-member-name');
  });

  it('throws class/duplicate-member-name when a stream field and an ordinary field share a name', () => {
    const classAst = parseClassFixture(['class C {', '  private x: integer = 0', '  public stream x: string', '}'].join('\n'));
    expectThrows(() => checkDuplicateClassMemberNames(classAst, null), 'class/duplicate-member-name');
  });

  it('throws class/duplicate-member-name when a stream field collides with an inherited member', () => {
    const baseAst = parseClassFixture(['class Base {', '  private x: integer = 0', '}'].join('\n'));
    const baseShape = buildClassShape(baseAst, null);
    const childAst = parseClassFixture(
      ['import Base from "./Base.flsh"', '', 'class Child extends Base {', '  public stream x: string', '  override constructor() {', '    super()', '  }', '}'].join('\n'),
    );
    expectThrows(() => checkDuplicateClassMemberNames(childAst, baseShape), 'class/duplicate-member-name');
  });

  it('throws class/duplicate-member-name when a constructor field-init collides with a top-level field', () => {
    const classAst = parseClassFixture(['class C {', '  private x: integer = 0', '  constructor(x: integer) {', '    private x: integer = x', '  }', '}'].join('\n'));
    expectThrows(() => checkDuplicateClassMemberNames(classAst, null), 'class/duplicate-member-name');
  });

  it('throws class/duplicate-member-name when a new field collides with an inherited member', () => {
    const baseAst = parseClassFixture(['class Base {', '  private x: integer = 0', '}'].join('\n'));
    const baseShape = buildClassShape(baseAst, null);
    const childAst = parseClassFixture(
      ['import Base from "./Base.flsh"', '', 'class Child extends Base {', '  private x: integer = 1', '  override constructor() {', '    super()', '  }', '}'].join('\n'),
    );
    expectThrows(() => checkDuplicateClassMemberNames(childAst, baseShape), 'class/duplicate-member-name');
  });

  it('does not throw when a method legitimately overrides a base member of the same name', () => {
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
    expect(() => checkDuplicateClassMemberNames(childAst, baseShape)).to.not.throw();
  });
});

describe('checkOverrideCoherence', () => {
  it('does not throw when override matches a real base member', () => {
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
    expect(() => checkOverrideCoherence(childAst, baseShape)).to.not.throw();
  });

  it('throws class/override-no-matching-member when override has no base member of that name', () => {
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
        '  override public function g(): integer {',
        '    return 2',
        '  }',
        '}',
      ].join('\n'),
    );
    expectThrows(() => checkOverrideCoherence(childAst, baseShape), 'class/override-no-matching-member');
  });

  it('throws class/missing-override when a method redeclares a base member name without override', () => {
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
        '  public function f(): integer {',
        '    return 2',
        '  }',
        '}',
      ].join('\n'),
    );
    expectThrows(() => checkOverrideCoherence(childAst, baseShape), 'class/missing-override');
  });
});
