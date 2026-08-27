import { expect } from 'chai';
import { parseFlshFile } from '../../src/parser.js';
import { FlshFile } from '../../src/ast.js';

function wrap(source: string): { file: FlshFile; diagnostics: readonly { code: string }[] } {
  const result = parseFlshFile(source);
  return { file: new FlshFile(result.root), diagnostics: result.diagnostics };
}

describe('parseFlshFile — top-level .flsh shape', () => {
  it('parses a bare class with no imports, no <script> wrapper', () => {
    const source = ['class Counter {', '  private count: integer = 0', '}'].join('\n');
    const { file, diagnostics } = wrap(source);
    expect(diagnostics).to.deep.equal([]);
    expect(file.imports).to.deep.equal([]);
    expect(file.classDecl.name).to.equal('Counter');
  });

  it('parses one or more imports before the class', () => {
    const source = ['import Base from "./Base.flsh"', '', 'class Counter extends Base {', '  override constructor() {', '    super()', '  }', '}'].join('\n');
    const { file, diagnostics } = wrap(source);
    expect(diagnostics).to.deep.equal([]);
    expect(file.imports.map((i) => i.className)).to.deep.equal(['Base']);
    expect(file.imports[0].path).to.equal('./Base.flsh');
    expect(file.classDecl.baseName).to.equal('Base');
  });

  it('reproduces a .flsh file byte-for-byte, with zero diagnostics', () => {
    const source = ['import Base from "./Base.flsh"', 'class Counter extends Base {', '  override constructor() {', '    super()', '  }', '}'].join('\n');
    const result = parseFlshFile(source);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });

  it('throws flsh/missing-class for a file with only imports', () => {
    const { diagnostics } = wrap('import Base from "./Base.flsh"\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['flsh/missing-class']);
  });

  it('throws flsh/missing-class for an empty file', () => {
    const { diagnostics } = wrap('');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['flsh/missing-class']);
  });

  it('throws flsh/trailing-content when a second class follows the first', () => {
    const source = ['class A {', '  private x: integer = 0', '}', 'class B {', '  private y: integer = 0', '}'].join('\n');
    const { diagnostics } = wrap(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['flsh/trailing-content']);
  });

  it('throws flsh/trailing-content when an import follows the class', () => {
    const source = ['class A {', '  private x: integer = 0', '}', 'import Base from "./Base.flsh"'].join('\n');
    const { diagnostics } = wrap(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['flsh/trailing-content']);
  });

  it('throws flsh/expected-import-or-class for unrecognized leading content', () => {
    const { diagnostics } = wrap('field x: integer = 0\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['flsh/expected-import-or-class']);
  });
});
