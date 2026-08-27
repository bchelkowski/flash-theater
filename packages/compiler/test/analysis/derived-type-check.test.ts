import { expect } from 'chai';
import { checkDerivedTypes } from '../../src/analysis/derived-type-check.js';
import { CompileError, FieldDecl, FunctionDecl, DerivedDecl, StateDecl, ThrScriptAst } from '../../src/dsl-parser/dsl-ast.js';
import { ClassShape } from '../../src/analysis/class-shape.js';

const SPAN = { line: 0 };

function field(name: string, type: string): FieldDecl {
  return { kind: 'field', name, type: type as FieldDecl['type'], defaultLiteral: '0', span: SPAN };
}

function state(name: string, type: string): StateDecl {
  return { kind: 'state', name, type, defaultLiteral: '0', span: SPAN };
}

function derivedDecl(name: string, type: string, expression: string): DerivedDecl {
  return { kind: 'derived', name, type, expression, scale: false, span: SPAN };
}

function fn(name: string, returnType: string | null): FunctionDecl {
  return { kind: 'function', visibility: 'private', name, params: [], returnType, body: '', span: SPAN } as FunctionDecl;
}

function script(overrides: Partial<ThrScriptAst>): ThrScriptAst {
  return { imports: [], fields: [], derived: [], state: [], reads: [], watches: [], streams: [], request: null, animations: [], functions: [], ...overrides };
}

function classShape(className: string, members: Record<string, { kind: 'method'; returnType: string | null }>): ClassShape {
  const map = new Map(Object.entries(members).map(([name, m]) => [name, { name, kind: m.kind, visibility: 'public' as const, returnType: m.returnType }]));
  return { className, baseName: null, ownMembers: map, allMembers: map };
}

function checkOne(d: DerivedDecl, overrides: Partial<ThrScriptAst> = {}, classShapes?: ReadonlyMap<string, ClassShape>) {
  checkDerivedTypes(script({ derived: [d], ...overrides }), classShapes);
}

describe('checkDerivedTypes — happy path (no error)', () => {
  it('a literal matching the declared type', () => {
    expect(() => checkOne(derivedDecl('x', 'string', '"a"'))).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'boolean', 'true'))).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'integer', '5'))).to.not.throw();
  });

  it('a field/state/derived reference matching its own declared type', () => {
    expect(() => checkOne(derivedDecl('x', 'string', 'name'), { fields: [field('name', 'string')] })).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'integer', 'count'), { state: [state('count', 'integer')] })).to.not.throw();
    expect(() =>
      checkDerivedTypes(script({ derived: [derivedDecl('other', 'string', '"a"'), derivedDecl('x', 'string', 'other')] })),
    ).to.not.throw();
  });

  it('numeric-subtype arithmetic — declared float accepts an integer-literal-arithmetic result', () => {
    expect(() => checkOne(derivedDecl('x', 'float', '1 + 2'))).to.not.throw();
  });

  it('string concatenation via +', () => {
    expect(() => checkOne(derivedDecl('x', 'string', '"Hello " + name'), { fields: [field('name', 'string')] })).to.not.throw();
  });

  it('comparison and relational operators always infer boolean', () => {
    expect(() => checkOne(derivedDecl('x', 'boolean', 'a == b'), { fields: [field('a', 'integer'), field('b', 'integer')] })).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'boolean', 'a < b'), { fields: [field('a', 'integer'), field('b', 'integer')] })).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'boolean', 'a >= b'), { fields: [field('a', 'integer'), field('b', 'integer')] })).to.not.throw();
  });

  it('Not on a confirmed-boolean operand infers boolean; safe-NOT (!) always infers boolean', () => {
    expect(() => checkOne(derivedDecl('x', 'boolean', 'Not a'), { fields: [field('a', 'boolean')] })).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'boolean', '!a'), { fields: [field('a', 'boolean')] })).to.not.throw();
  });

  it('AND/OR/Not on integer operands are real BrightScript bitwise ops, not forced to boolean (regression: false positive on flagsA AND flagsB)', () => {
    expect(() => checkOne(derivedDecl('x', 'integer', 'flagsA AND flagsB'), { fields: [field('flagsA', 'integer'), field('flagsB', 'integer')] })).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'integer', 'flagsA OR flagsB'), { fields: [field('flagsA', 'integer'), field('flagsB', 'integer')] })).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'integer', 'Not mask'), { fields: [field('mask', 'integer')] })).to.not.throw();
  });

  it('AND/OR/Not on confirmed-boolean operands still infer boolean (and are still checked)', () => {
    expect(() => checkOne(derivedDecl('x', 'boolean', 'a AND b'), { fields: [field('a', 'boolean'), field('b', 'boolean')] })).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'integer', 'a AND b'), { fields: [field('a', 'boolean'), field('b', 'boolean')] }))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'derived/type-mismatch' });
  });

  it('a matching user-function call', () => {
    expect(() => checkOne(derivedDecl('x', 'string', 'greet()'), { functions: [fn('greet', 'string')] })).to.not.throw();
  });

  it('a matching class-method call — ClassName(...).method()', () => {
    const shapes = new Map([['LabeledCounter', classShape('LabeledCounter', { describe: { kind: 'method', returnType: 'string' } })]]);
    expect(() => checkOne(derivedDecl('x', 'string', 'LabeledCounter(1, "a").describe()'), {}, shapes)).to.not.throw();
  });

  it('a call to an unresolvable name (a BrightScript builtin, or anything else this compiler does not model) is never flagged', () => {
    expect(() => checkOne(derivedDecl('x', 'integer', 'Len(a)'), { fields: [field('a', 'string')] })).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'boolean', 'Len(a)'), { fields: [field('a', 'string')] })).to.not.throw();
  });

  it('a dot-chain / member access is never flagged, regardless of declared type', () => {
    expect(() => checkOne(derivedDecl('x', 'string', 'theme.colors.background'))).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'boolean', 'theme.colors.background'))).to.not.throw();
  });

  it('object/dynamic accepts an array literal', () => {
    expect(() => checkOne(derivedDecl('x', 'object', '[1, 2, 3]'))).to.not.throw();
    expect(() => checkOne(derivedDecl('x', 'dynamic', '[1, 2, 3]'))).to.not.throw();
  });

  it('object/dynamic accepts an opaque (unresolvable) call', () => {
    expect(() => checkOne(derivedDecl('x', 'object', 'someUnknownThing()'))).to.not.throw();
  });
});

describe('checkDerivedTypes — derived/type-mismatch', () => {
  it('a literal of the wrong type', () => {
    expect(() => checkOne(derivedDecl('x', 'string', '5')))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'derived/type-mismatch' });
    expect(() => checkOne(derivedDecl('x', 'integer', '"hi"'))).to.throw(CompileError).with.property('diagnostic').that.deep.include({ code: 'derived/type-mismatch' });
  });

  it('an arithmetic result declared as the wrong type', () => {
    expect(() => checkOne(derivedDecl('x', 'boolean', '1 + 2')))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'derived/type-mismatch' });
  });

  it('a user function whose declared return type disagrees', () => {
    expect(() => checkOne(derivedDecl('x', 'string', 'numericFn()'), { functions: [fn('numericFn', 'integer')] }))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'derived/type-mismatch' });
  });

  it('a class method whose declared return type disagrees', () => {
    const shapes = new Map([['LabeledCounter', classShape('LabeledCounter', { count: { kind: 'method', returnType: 'integer' } })]]);
    expect(() => checkOne(derivedDecl('x', 'string', 'LabeledCounter(1, "a").count()'), {}, shapes))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'derived/type-mismatch' });
  });

  it('the error message names both the declared and inferred type', () => {
    try {
      checkOne(derivedDecl('isReady', 'string', '5'));
      expect.fail('expected a throw');
    } catch (e) {
      expect(e).to.be.instanceOf(CompileError);
      const message = (e as CompileError).diagnostic.message;
      expect(message).to.include('isReady');
      expect(message).to.include('"string"');
      expect(message).to.include('"integer"');
    }
  });
});

describe('checkDerivedTypes — derived/no-value-call', () => {
  it('calling a function with no declared return type (compiles to a sub)', () => {
    expect(() => checkOne(derivedDecl('x', 'string', 'logIt()'), { functions: [fn('logIt', null)] }))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'derived/no-value-call' });
  });

  it('calling a class method with no declared return type', () => {
    const shapes = new Map([['LabeledCounter', classShape('LabeledCounter', { log: { kind: 'method', returnType: null } })]]);
    expect(() => checkOne(derivedDecl('x', 'string', 'LabeledCounter(1, "a").log()'), {}, shapes))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'derived/no-value-call' });
  });
});

describe('checkDerivedTypes — no classShapes given (standalone compile, no app-wide class context)', () => {
  it('a ClassName(...).method() call infers unknown, never flagged, when classShapes is omitted', () => {
    expect(() => checkOne(derivedDecl('x', 'string', 'LabeledCounter(1, "a").describe()'))).to.not.throw();
  });
});

describe('checkDerivedTypes — no false positives against real derived shapes', () => {
  it('a real ScheduleDateMenuItem-shaped comparison derived', () => {
    expect(() => checkOne(derivedDecl('isGridFocused', 'boolean', 'focusPercent > 0.5'), { fields: [field('focusPercent', 'float')] })).to.not.throw();
  });

  it('a string-concat derived calling .ToStr() on a numeric field', () => {
    expect(() => checkOne(derivedDecl('label', 'string', '"Running: " + runningCount.ToStr()'), { fields: [field('runningCount', 'integer')] })).to.not.throw();
  });

  it('a derived calling a user function with a matching declared return type, inside a larger expression', () => {
    expect(() =>
      checkOne(derivedDecl('statusText', 'string', 'pickLabel(enabled, label)'), {
        fields: [field('enabled', 'boolean'), field('label', 'string')],
        functions: [fn('pickLabel', 'string')],
      }),
    ).to.not.throw();
  });
});
