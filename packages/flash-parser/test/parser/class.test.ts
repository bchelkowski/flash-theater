import { expect } from 'chai';
import { parseFlshFile } from '../../src/parser.js';
import { ClassDeclaration, ConstructorFieldInit, FlshFile } from '../../src/ast.js';

function parseClass(source: string): { classDecl: ClassDeclaration | null; diagnostics: readonly { code: string }[] } {
  const result = parseFlshFile(source);
  if (result.diagnostics.length > 0) return { classDecl: null, diagnostics: result.diagnostics };
  return { classDecl: new FlshFile(result.root).classDecl, diagnostics: result.diagnostics };
}

describe('parse — class declarations', () => {
  it('parses a class with no extends, fields, a constructor, and methods', () => {
    const source = [
      'class MyClass {',
      '  private myPrivateValue: string = "ad"',
      '  public myPublicValue: integer = 123',
      '',
      '  constructor(a: string, b: integer) {',
      '    private a: string = a',
      '    private b: integer = b',
      '  }',
      '',
      '  public function myPublicMethod(count: integer): string {',
      '    return m.private_myPrivateMethod(count)',
      '  }',
      '',
      '  private function myPrivateMethod(count: integer): string {',
      '    return str(count + m.b) + " " + m.a',
      '  }',
      '}',
    ].join('\n');

    const { classDecl, diagnostics } = parseClass(source);
    expect(diagnostics).to.deep.equal([]);
    expect(classDecl!.name).to.equal('MyClass');
    expect(classDecl!.baseName).to.equal(null);

    const fields = classDecl!.fields;
    expect(fields.map((f) => f.name)).to.deep.equal(['myPrivateValue', 'myPublicValue']);
    expect(fields[0].visibility).to.equal('private');
    expect(fields[0].type).to.equal('string');
    expect(fields[0].defaultLiteral).to.equal('"ad"');
    expect(fields[1].visibility).to.equal('public');
    expect(fields[1].defaultLiteral).to.equal('123');

    const ctor = classDecl!.constructorDecl!;
    expect(ctor.isOverride).to.equal(false);
    expect(ctor.parameters).to.deep.equal([
      { name: 'a', type: 'string' },
      { name: 'b', type: 'integer' },
    ]);
    expect(ctor.superCall).to.equal(null);
    const ctorFieldInits = ctor.body.statements as ConstructorFieldInit[];
    expect(ctorFieldInits).to.have.lengthOf(2);
    expect(ctorFieldInits.map((s) => s.name)).to.deep.equal(['a', 'b']);
    expect(ctorFieldInits.map((s) => s.visibility)).to.deep.equal(['private', 'private']);
    expect(ctorFieldInits[0].expression).to.equal('a');

    const methods = classDecl!.methods;
    expect(methods.map((m) => m.name)).to.deep.equal(['myPublicMethod', 'myPrivateMethod']);
    expect(methods[0].visibility).to.equal('public');
    expect(methods[0].returnType).to.equal('string');
    expect(methods[0].isOverride).to.equal(false);
    expect(methods[1].visibility).to.equal('private');
  });

  it('parses a method with no return type', () => {
    const { classDecl, diagnostics } = parseClass(['class C {', '  public function doThing(x: integer) {', '    m.a = x', '  }', '}'].join('\n'));
    expect(diagnostics).to.deep.equal([]);
    expect(classDecl!.methods[0].returnType).to.equal(null);
  });

  it('parses protected as a third field/method visibility', () => {
    const source = ['class C {', '  protected count: integer = 0', '  protected function get(): integer {', '    return m.count', '  }', '}'].join('\n');
    const { classDecl, diagnostics } = parseClass(source);
    expect(diagnostics).to.deep.equal([]);
    expect(classDecl!.fields[0].visibility).to.equal('protected');
    expect(classDecl!.methods[0].visibility).to.equal('protected');
  });

  it('parses extends + override constructor + super(...) + override method', () => {
    const source = [
      'class MyExtendedClass extends MyClass {',
      '  override constructor(a: string, b: integer, c: integer) {',
      '    super(a, b)',
      '    private c: integer = c',
      '  }',
      '  override public function myPublicMethod(count: integer): string {',
      '    return m.private_myPrivateMethod2(count)',
      '  }',
      '}',
    ].join('\n');

    const { classDecl, diagnostics } = parseClass(source);
    expect(diagnostics).to.deep.equal([]);
    expect(classDecl!.baseName).to.equal('MyClass');

    const ctor = classDecl!.constructorDecl!;
    expect(ctor.isOverride).to.equal(true);
    expect(ctor.superCall).to.not.equal(null);
    expect(ctor.superCall!.args).to.deep.equal(['a', 'b']);

    const method = classDecl!.methods[0];
    expect(method.isOverride).to.equal(true);
    expect(method.name).to.equal('myPublicMethod');
  });

  it('reproduces a class file byte-for-byte, with zero diagnostics', () => {
    const source = ['class Counter {', '  private count: integer = 0', '', '  public function get(): integer {', '    return m.count', '  }', '}'].join('\n');
    const result = parseFlshFile(source);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });

  // ---- diagnostics ------------------------------------------------------

  it('throws dsl/invalid-class-header for a malformed header', () => {
    const { diagnostics } = parseClass('class {\n}\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-class-header']);
  });

  it('throws dsl/unterminated-class when the closing brace is missing', () => {
    const { diagnostics } = parseClass('class C {\n  private x: integer = 0\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/unterminated-class']);
  });

  it('throws dsl/invalid-class-field for a malformed field', () => {
    const { diagnostics } = parseClass('class C {\n  private x integer = 0\n}\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-class-field']);
  });

  it('throws dsl/invalid-class-field for an array literal default — array/assocarray support is scoped to field/state only, not class fields', () => {
    const { diagnostics } = parseClass('class C {\n  private x: array = [1, 2, 3]\n}\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-class-field']);
  });

  it('parses a stream field per visibility, separately from .fields', () => {
    const source = ['class C {', '  public stream onChanged: string', '  private stream onInternal: integer', '}'].join('\n');
    const { classDecl, diagnostics } = parseClass(source);
    expect(diagnostics).to.deep.equal([]);
    expect(classDecl!.fields).to.have.lengthOf(0);
    const streamFields = classDecl!.streamFields;
    expect(streamFields.map((s) => [s.visibility, s.name, s.type])).to.deep.equal([
      ['public', 'onChanged', 'string'],
      ['private', 'onInternal', 'integer'],
    ]);
  });

  it('distinguishes a stream field from a method and a plain field via lookahead', () => {
    const source = [
      'class C {',
      '  public stream onChanged: string',
      '  private count: integer = 0',
      '  public function get(): integer {',
      '    return m.count',
      '  }',
      '}',
    ].join('\n');
    const { classDecl, diagnostics } = parseClass(source);
    expect(diagnostics).to.deep.equal([]);
    expect(classDecl!.streamFields.map((s) => s.name)).to.deep.equal(['onChanged']);
    expect(classDecl!.fields.map((f) => f.name)).to.deep.equal(['count']);
    expect(classDecl!.methods.map((m) => m.name)).to.deep.equal(['get']);
  });

  it('throws dsl/invalid-class-stream-field for a malformed stream field (missing colon/type)', () => {
    const { diagnostics } = parseClass('class C {\n  public stream onChanged\n}\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-class-stream-field']);
  });

  it('throws dsl/invalid-class-stream-field when trailing content follows the type', () => {
    const { diagnostics } = parseClass('class C {\n  public stream onChanged: string = "nope"\n}\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-class-stream-field']);
  });

  it('throws dsl/void-not-a-type for a stream field typed void', () => {
    const { diagnostics } = parseClass('class C {\n  public stream onChanged: void\n}\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/void-not-a-type']);
  });

  it('throws dsl/invalid-class-member for unrecognized content in a class body', () => {
    const { diagnostics } = parseClass('class C {\n  derived x: integer = 1\n}\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-class-member']);
  });

  it('throws dsl/multiple-constructors when a class declares two constructors', () => {
    const source = ['class C {', '  constructor() {', '  }', '  constructor(x: integer) {', '  }', '}'].join('\n');
    const { diagnostics } = parseClass(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/multiple-constructors']);
  });

  it('throws dsl/invalid-constructor-field-init for a malformed constructor field init', () => {
    const source = ['class C {', '  constructor(a: string) {', '    private a string = a', '  }', '}'].join('\n');
    const { diagnostics } = parseClass(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-constructor-field-init']);
  });

  it('throws dsl/invalid-class-method-header for a malformed method header', () => {
    const { diagnostics } = parseClass('class C {\n  public function () {\n  }\n}\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-class-method-header']);
  });

  it('throws dsl/invalid-super-call for a malformed super(...) call', () => {
    const source = ['class C extends Base {', '  override constructor() {', '    super(a, )', '  }', '}'].join('\n');
    const { diagnostics } = parseClass(source);
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'dsl/invalid-super-call')).to.equal(true);
  });

  it('throws dsl/override-without-extends when override is used on a method with no extends', () => {
    const source = ['class C {', '  override public function f(): integer {', '    return 1', '  }', '}'].join('\n');
    const { diagnostics } = parseClass(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/override-without-extends']);
  });

  it('throws dsl/override-without-extends when override is used on a constructor with no extends', () => {
    const source = ['class C {', '  override constructor() {', '  }', '}'].join('\n');
    const { diagnostics } = parseClass(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/override-without-extends']);
  });

  it('throws dsl/unexpected-super-call when super(...) is used with no extends', () => {
    const source = ['class C {', '  constructor() {', '    super()', '  }', '}'].join('\n');
    const { diagnostics } = parseClass(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/unexpected-super-call']);
  });

  it('throws dsl/missing-override-constructor when an extending class has no constructor at all', () => {
    const { diagnostics } = parseClass('class C extends Base {\n  private x: integer = 0\n}\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/missing-override-constructor']);
  });

  it('throws dsl/missing-override-constructor when the constructor is not marked override', () => {
    const source = ['class C extends Base {', '  constructor() {', '    super()', '  }', '}'].join('\n');
    const { diagnostics } = parseClass(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/missing-override-constructor']);
  });

  it('throws dsl/missing-super-call when the override constructor never calls super(...)', () => {
    const source = ['class C extends Base {', '  override constructor() {', '  }', '}'].join('\n');
    const { diagnostics } = parseClass(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/missing-super-call']);
  });

  it('throws dsl/super-call-not-first when super(...) is not the first statement', () => {
    const source = ['class C extends Base {', '  override constructor(a: integer) {', '    private a: integer = a', '    super(a)', '  }', '}'].join('\n');
    const { diagnostics } = parseClass(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/super-call-not-first']);
  });

  it('throws dsl/super-call-not-first when super(...) is called twice', () => {
    const source = ['class C extends Base {', '  override constructor() {', '    super()', '    super()', '  }', '}'].join('\n');
    const { diagnostics } = parseClass(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/super-call-not-first']);
  });

  it('an override constructor with no arguments and super() is valid (zero-arg base)', () => {
    const source = ['class C extends Base {', '  override constructor() {', '    super()', '  }', '}'].join('\n');
    const { classDecl, diagnostics } = parseClass(source);
    expect(diagnostics).to.deep.equal([]);
    expect(classDecl!.constructorDecl!.superCall!.args).to.deep.equal([]);
  });
});
