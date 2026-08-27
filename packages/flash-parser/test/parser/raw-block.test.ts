import { expect } from 'chai';
import { parse, parseFlshFile } from '../../src/parser.js';
import { ThrFile, FlshFile, RawBrightScriptStatement, IfStatement } from '../../src/ast.js';

function wrap(source: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
  const result = parse(source);
  return { file: new ThrFile(result.root), diagnostics: result.diagnostics };
}

const TEMPLATE = '<Rectangle id="a" width="{width}" />';

function thr(scriptBody: string, templateMarkup: string = TEMPLATE): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${templateMarkup}\n</component>\n`;
}

function body(bodySource: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
  return wrap(thr(`private function f() {\n${bodySource}\n}`));
}

describe('parse — raw BrightScript passthrough', () => {
  it('parses a single raw block as one statement', () => {
    const { file, diagnostics } = body(["' flash-theater:raw", 'print "hello"', "' flash-theater:end-raw"].join('\n'));

    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements).to.have.lengthOf(1);
    expect(statements[0]).to.be.instanceOf(RawBrightScriptStatement);
    expect((statements[0] as RawBrightScriptStatement).text).to.equal('print "hello"');
  });

  it('preserves the raw block content byte-for-byte, including internal blank lines and indentation', () => {
    const { file, diagnostics } = body(["' flash-theater:raw", 'x = 1', '', '    y = 2', "' flash-theater:end-raw"].join('\n'));

    expect(diagnostics).to.deep.equal([]);
    const raw = file.script.functions[0].block.statements[0] as RawBrightScriptStatement;
    expect(raw.text).to.equal(['x = 1', '', '    y = 2'].join('\n'));
  });

  it('parses multiple raw blocks in one function body, interleaved with ordinary statements', () => {
    const source = [
      "' flash-theater:raw",
      'x = 1',
      "' flash-theater:end-raw",
      'y = 2',
      "' flash-theater:raw",
      'z = 3',
      "' flash-theater:end-raw",
    ].join('\n');
    const { file, diagnostics } = body(source);

    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements).to.have.lengthOf(3);
    expect(statements[0]).to.be.instanceOf(RawBrightScriptStatement);
    expect((statements[0] as RawBrightScriptStatement).text).to.equal('x = 1');
    expect(statements[1]).to.not.be.instanceOf(RawBrightScriptStatement);
    expect(statements[2]).to.be.instanceOf(RawBrightScriptStatement);
    expect((statements[2] as RawBrightScriptStatement).text).to.equal('z = 3');
  });

  it('does not misdispatch real BrightScript control flow (if/then/end if) inside a raw block as DSL if-syntax', () => {
    const source = [
      "' flash-theater:raw",
      'if x = 1 then',
      '  print "one"',
      'end if',
      "' flash-theater:end-raw",
    ].join('\n');
    const { file, diagnostics } = body(source);

    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements).to.have.lengthOf(1);
    expect(statements[0]).to.be.instanceOf(RawBrightScriptStatement);
    expect(statements[0]).to.not.be.instanceOf(IfStatement);
  });

  it('handles a raw block containing balanced-but-real braces (an AA literal) without corrupting the enclosing function boundary', () => {
    const source = ["' flash-theater:raw", 'aa = {a: 1, b: {c: 2}}', "' flash-theater:end-raw"].join('\n');
    const { file, diagnostics } = body(source);

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions[0].block.statements).to.have.lengthOf(1);
  });

  it('parses a raw block that runs to the very end of the enclosing function body (last statement before "}")', () => {
    const { file, diagnostics } = body(["x = 1", "' flash-theater:raw", 'print x', "' flash-theater:end-raw"].join('\n'));

    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements).to.have.lengthOf(2);
    expect(statements[1]).to.be.instanceOf(RawBrightScriptStatement);
    expect((statements[1] as RawBrightScriptStatement).text).to.equal('print x');
  });

  it('throws statement/unterminated-raw-block when the end marker is missing', () => {
    const { diagnostics } = body(["' flash-theater:raw", 'print "hello"'].join('\n'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/unterminated-raw-block']);
  });

  it('throws statement/invalid-raw-brightscript for genuinely invalid BrightScript inside a raw block', () => {
    const source = ["' flash-theater:raw", 'end if', "' flash-theater:end-raw"].join('\n');
    const { diagnostics } = body(source);
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'statement/invalid-raw-brightscript')).to.equal(true);
  });

  it('treats a stray end marker with no preceding start marker as an ordinary comment', () => {
    const { file, diagnostics } = body(["' flash-theater:end-raw", 'x = 1'].join('\n'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions[0].block.statements).to.have.lengthOf(1);
    expect(file.script.functions[0].block.statements[0]).to.not.be.instanceOf(RawBrightScriptStatement);
  });

  it('parses a declaration-level raw block in <script>, collected on ScriptSection.rawBlocks', () => {
    const source = thr('field count: integer = 0\n\n\' flash-theater:raw\nm.top.count = 1\n\' flash-theater:end-raw\n\nprivate function noop() {\n}');
    const { file, diagnostics } = wrap(source);

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.rawBlocks).to.have.lengthOf(1);
    expect(file.script.rawBlocks[0].text).to.equal('m.top.count = 1');
    expect(file.script.functions).to.have.lengthOf(1);
  });

  it('parses a raw block inside a .flsh method body and inside a constructor body', () => {
    const source = [
      'class C {',
      '  constructor() {',
      "    ' flash-theater:raw",
      '    x = 1',
      "    ' flash-theater:end-raw",
      '  }',
      '',
      '  public function doThing() {',
      "    ' flash-theater:raw",
      '    y = 2',
      "    ' flash-theater:end-raw",
      '  }',
      '}',
    ].join('\n');
    const result = parseFlshFile(source);
    expect(result.diagnostics).to.deep.equal([]);

    const classDecl = new FlshFile(result.root).classDecl!;
    const ctorStatements = classDecl.constructorDecl!.body.statements;
    expect(ctorStatements).to.have.lengthOf(1);
    expect(ctorStatements[0]).to.be.instanceOf(RawBrightScriptStatement);
    expect((ctorStatements[0] as RawBrightScriptStatement).text).to.equal('    x = 1');

    const methodStatements = classDecl.methods[0].block.statements;
    expect(methodStatements).to.have.lengthOf(1);
    expect(methodStatements[0]).to.be.instanceOf(RawBrightScriptStatement);
    expect((methodStatements[0] as RawBrightScriptStatement).text).to.equal('    y = 2');
  });
});
