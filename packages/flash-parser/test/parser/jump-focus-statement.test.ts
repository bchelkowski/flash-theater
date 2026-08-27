import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile, JumpFocusStatement } from '../../src/ast.js';

function wrap(source: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
  const result = parse(source);
  return { file: new ThrFile(result.root), diagnostics: result.diagnostics };
}

const TEMPLATE = '<Rectangle id="a" width="{width}" />';

function thr(scriptBody: string, templateMarkup: string = TEMPLATE): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${templateMarkup}\n</component>\n`;
}

describe('parse — jumpFocus(...) statement (isolated)', () => {
  function body(bodySource: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
    return wrap(thr(`private function f(key: string, press: boolean) {\n${bodySource}\n}`));
  }

  it('parses three literal arguments as a JumpFocusStatement', () => {
    const { file, diagnostics } = body('jumpFocus("down", 5, press)');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(JumpFocusStatement);
    const jumpFocus = statement as JumpFocusStatement;
    expect(jumpFocus.directionExpression).to.equal('"down"');
    expect(jumpFocus.countExpression).to.equal('5');
    expect(jumpFocus.pressExpression).to.equal('press');
  });

  it('captures a nested-call argument in any position via top-level-comma splitting, not a naive comma scan', () => {
    const { file, diagnostics } = body('jumpFocus("down", listPageSize(a, b), press)');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    const jumpFocus = statement as JumpFocusStatement;
    expect(jumpFocus.directionExpression).to.equal('"down"');
    expect(jumpFocus.countExpression).to.equal('listPageSize(a, b)');
    expect(jumpFocus.pressExpression).to.equal('press');
  });

  it('throws statement/jump-focus-requires-parens when not immediately followed by "("', () => {
    const { diagnostics } = body('jumpFocus "down", 5, press');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/jump-focus-requires-parens']);
  });

  it('throws statement/jump-focus-requires-three-arguments for empty parens', () => {
    const { diagnostics } = body('jumpFocus()');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/jump-focus-requires-three-arguments']);
  });

  it('throws statement/jump-focus-requires-three-arguments for a single argument', () => {
    const { diagnostics } = body('jumpFocus("down")');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/jump-focus-requires-three-arguments']);
  });

  it('throws statement/jump-focus-requires-three-arguments for two arguments', () => {
    const { diagnostics } = body('jumpFocus("down", 5)');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/jump-focus-requires-three-arguments']);
  });

  it('throws statement/jump-focus-requires-three-arguments for a trailing comma with nothing after it', () => {
    const { diagnostics } = body('jumpFocus("down", 5, )');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/jump-focus-requires-three-arguments']);
  });

  it('throws statement/unterminated-jump-focus-call when the closing paren is missing', () => {
    const { diagnostics } = body('jumpFocus("down", 5, press');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/unterminated-jump-focus-call']);
  });
});

describe('parse — jumpFocus(...) round-trip fidelity', () => {
  it('reproduces a file containing a jumpFocus(...) call byte-for-byte', () => {
    const source = thr(['private function jumpDown(key: string, press: boolean) {', '  jumpFocus("down", 5, press)', '}'].join('\n'));
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});

/**
 * Mirrors focus-statement.test.ts's own regression case: `parseBlockContent`'s fallback
 * statement-region scanner needs `TokenKind.JumpFocus` in its own stop-list (alongside
 * `TokenKind.Focus`), or a `jumpFocus(...)` call following a plain statement in the same block
 * would be silently swallowed into that PRECEDING statement's own raw text instead of being
 * recognized as its own `JumpFocusStatement`.
 */
describe('parse — a plain statement followed by jumpFocus(...) in the same block', () => {
  it('still recognizes jumpFocus(...) as its own statement after a preceding plain statement', () => {
    const { file, diagnostics } = wrap(thr('private function f(key: string, press: boolean) {\nx = 1\njumpFocus("down", 5, press)\n}'));

    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements).to.have.lengthOf(2);
    expect(statements[1]).to.be.instanceOf(JumpFocusStatement);
    expect((statements[1] as JumpFocusStatement).directionExpression).to.equal('"down"');
  });
});

describe('parse — jumpFocus is a reserved keyword', () => {
  it('rejects a field literally named jumpFocus', () => {
    const source = thr('field jumpFocus: string = "x"');
    const result = parse(source);
    expect(result.diagnostics.length).to.be.greaterThan(0);
  });
});
