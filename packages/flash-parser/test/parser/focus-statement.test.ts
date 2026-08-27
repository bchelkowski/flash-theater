import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile, FocusStatement } from '../../src/ast.js';

function wrap(source: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
  const result = parse(source);
  return { file: new ThrFile(result.root), diagnostics: result.diagnostics };
}

const TEMPLATE = '<Rectangle id="a" width="{width}" />';

function thr(scriptBody: string, templateMarkup: string = TEMPLATE): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${templateMarkup}\n</component>\n`;
}

describe('parse — focus(...) statement (isolated)', () => {
  function body(bodySource: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
    return wrap(thr(`private function f() {\n${bodySource}\n}`));
  }

  it('parses a string-literal argument as a FocusStatement', () => {
    const { file, diagnostics } = body('focus("focusGroup")');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(FocusStatement);
    const focus = statement as FocusStatement;
    expect(focus.expression).to.equal('"focusGroup"');
  });

  it('parses an identifier (node-reference) argument as a FocusStatement', () => {
    const { file, diagnostics } = body('focus(targetGroup)');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    const focus = statement as FocusStatement;
    expect(focus.expression).to.equal('targetGroup');
  });

  it('captures a nested-call argument via balanced-paren matching, not a same-line scan', () => {
    const { file, diagnostics } = body('focus(m.top.findNode("x"))');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    const focus = statement as FocusStatement;
    expect(focus.expression).to.equal('m.top.findNode("x")');
  });

  it('throws statement/focus-requires-parens when not immediately followed by "("', () => {
    const { diagnostics } = body('focus targetGroup');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/focus-requires-parens']);
  });

  it('throws statement/focus-requires-argument for empty parens', () => {
    const { diagnostics } = body('focus()');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/focus-requires-argument']);
  });

  it('throws statement/unterminated-focus-call when the closing paren is missing', () => {
    const { diagnostics } = body('focus(targetGroup');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/unterminated-focus-call']);
  });
});

describe('parse — focus(...) round-trip fidelity', () => {
  it('reproduces a file containing a focus(...) call byte-for-byte', () => {
    const source = thr(['private function goToGroup(key: string, press: boolean) {', '  if (press) {', '    focus("focusGroup")', '  }', '}'].join('\n'));
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});

/**
 * `parseBlockContent`'s fallback statement-region scanner didn't stop at
 * `TokenKind.Focus`, so a `focus(...)` call following a plain statement in
 * the same block would have been silently swallowed into that PRECEDING
 * statement's own raw text instead of being recognized as its own
 * `FocusStatement` — untested until this was found while tracing `focus`'s
 * own parsing for an unrelated (router) feature, since every existing
 * example here has `focus(...)` as the sole/first statement in its block.
 * Fixed in `parseBlockContent`'s fallback-scan stop-list.
 */
describe('parse — a plain statement followed by focus(...) in the same block', () => {
  it('still recognizes focus(...) as its own statement after a preceding plain statement', () => {
    const { file, diagnostics } = wrap(thr('private function f() {\nx = 1\nfocus("row0")\n}'));

    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements).to.have.lengthOf(2);
    expect(statements[1]).to.be.instanceOf(FocusStatement);
    expect((statements[1] as FocusStatement).expression).to.equal('"row0"');
  });
});
