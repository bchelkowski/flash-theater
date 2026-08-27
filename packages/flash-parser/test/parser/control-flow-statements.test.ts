import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile, ForStatement, ForEachStatement, WhileStatement, TryStatement, IfStatement } from '../../src/ast.js';

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

describe('parse — for (...) { } statement (isolated)', () => {
  it('parses a numeric for with no step', () => {
    const { file, diagnostics } = body('for (i = 0 to 10) {\n  print i\n}');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(ForStatement);
    const forStmt = statement as ForStatement;
    expect(forStmt.loopVariable).to.equal('i');
    expect(forStmt.startExpr.text).to.equal('0');
    expect(forStmt.endExpr.text).to.equal('10');
    expect(forStmt.stepExpr).to.equal(null);
    expect(forStmt.body.statements).to.have.lengthOf(1);
  });

  it('parses a numeric for with a step', () => {
    const { file, diagnostics } = body('for (i = 0 to 10 step 2) {\n  print i\n}');

    expect(diagnostics).to.deep.equal([]);
    const forStmt = file.script.functions[0].block.statements[0] as ForStatement;
    expect(forStmt.stepExpr?.text).to.equal('2');
  });

  it('captures a call expression with its own nested parens in the start/end/step expressions, not mistaking their tokens for the header\'s own to/step', () => {
    const { file, diagnostics } = body('for (i = min(0, 1) to max(9, 10) step Abs(-2)) {\n  print i\n}');

    expect(diagnostics).to.deep.equal([]);
    const forStmt = file.script.functions[0].block.statements[0] as ForStatement;
    expect(forStmt.startExpr.text).to.equal('min(0, 1)');
    expect(forStmt.endExpr.text).to.equal('max(9, 10)');
    expect(forStmt.stepExpr?.text).to.equal('Abs(-2)');
  });

  it('allows a nested DSL if inside a for body', () => {
    const { file, diagnostics } = body('for (i = 0 to 10) {\n  if (i == 5) {\n    print i\n  }\n}');

    expect(diagnostics).to.deep.equal([]);
    const forStmt = file.script.functions[0].block.statements[0] as ForStatement;
    expect(forStmt.body.statements[0]).to.be.instanceOf(IfStatement);
  });

  it('throws statement/for-requires-parens when not immediately followed by "("', () => {
    const { diagnostics } = body('for i = 0 to 10\nend for');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/for-requires-parens']);
  });

  it('throws statement/invalid-for-header when the header has no "to"', () => {
    const { diagnostics } = body('for (i = 0) {\n  print i\n}');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/invalid-for-header']);
  });

  it('throws statement/for-requires-block when there is no "{" after the header', () => {
    const { diagnostics } = body('for (i = 0 to 10)\n  print i');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/for-requires-block']);
  });

  it('throws statement/unterminated-for-header when the closing paren is missing', () => {
    const { diagnostics } = body('for (i = 0 to 10 {\n  print i\n}');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/unterminated-for-header']);
  });
});

describe('parse — for each (...) { } statement (isolated)', () => {
  it('parses a for each over an array literal', () => {
    const { file, diagnostics } = body('for each (item in [1, 2, 3]) {\n  print item\n}');

    expect(diagnostics).to.deep.equal([]);
    const forEach = file.script.functions[0].block.statements[0] as ForEachStatement;
    expect(forEach).to.be.instanceOf(ForEachStatement);
    expect(forEach.itemVariable).to.equal('item');
    expect(forEach.collectionExpr.text).to.equal('[1, 2, 3]');
  });

  it('throws statement/foreach-requires-parens when not immediately followed by "("', () => {
    const { diagnostics } = body('for each item in [1, 2, 3]\nend for');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/foreach-requires-parens']);
  });

  it('throws statement/foreach-requires-in when the header has no "in"', () => {
    const { diagnostics } = body('for each (item) {\n  print item\n}');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/foreach-requires-in']);
  });

  it('throws statement/foreach-requires-block when there is no "{" after the header', () => {
    const { diagnostics } = body('for each (item in [1, 2, 3])\n  print item');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/foreach-requires-block']);
  });
});

describe('parse — while (...) { } statement (isolated)', () => {
  it('parses a while loop', () => {
    const { file, diagnostics } = body('while (i < 10) {\n  i = i + 1\n}');

    expect(diagnostics).to.deep.equal([]);
    const whileStmt = file.script.functions[0].block.statements[0] as WhileStatement;
    expect(whileStmt).to.be.instanceOf(WhileStatement);
    expect(whileStmt.condition.text).to.equal('i < 10');
    expect(whileStmt.body.statements).to.have.lengthOf(1);
  });

  it('throws statement/while-requires-parens when not immediately followed by "("', () => {
    const { diagnostics } = body('while i < 10\nend while');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/while-requires-parens']);
  });

  it('throws statement/while-requires-block when there is no "{" after the condition', () => {
    const { diagnostics } = body('while (i < 10)\n  i = i + 1');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/while-requires-block']);
  });

  it('throws statement/unterminated-while-condition when the closing paren is missing', () => {
    const { diagnostics } = body('while (i < 10 {\n  i = i + 1\n}');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/unterminated-while-condition']);
  });
});

describe('parse — try { } catch (...) { } statement (isolated)', () => {
  it('parses a try/catch', () => {
    const { file, diagnostics } = body('try {\n  risky()\n} catch (e) {\n  print e\n}');

    expect(diagnostics).to.deep.equal([]);
    const tryStmt = file.script.functions[0].block.statements[0] as TryStatement;
    expect(tryStmt).to.be.instanceOf(TryStatement);
    expect(tryStmt.tryBlock.statements).to.have.lengthOf(1);
    expect(tryStmt.catchClause.variableName).to.equal('e');
    expect(tryStmt.catchClause.body.statements).to.have.lengthOf(1);
  });

  it('throws statement/try-requires-block when "try" is not immediately followed by "{"', () => {
    const { diagnostics } = body('try (x)\n  risky()');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/try-requires-block']);
  });

  it('throws statement/try-requires-catch when the try block has no catch clause', () => {
    const { diagnostics } = body('try {\n  risky()\n}');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/try-requires-catch']);
  });

  it('throws statement/catch-requires-parens when the caught variable is not parenthesized', () => {
    const { diagnostics } = body('try {\n  risky()\n} catch e {\n  print e\n}');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/catch-requires-parens']);
  });

  it('throws statement/dangling-catch for a catch with no matching try', () => {
    const { diagnostics } = body('catch (e) {\n  print e\n}');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/dangling-catch']);
  });
});

describe('parse — for/for each/while/try round-trip fidelity', () => {
  it('reproduces a file containing every new statement kind byte-for-byte', () => {
    const source = thr(
      [
        'private function f() {',
        '  for (i = 0 to 10 step 2) {',
        '    print i',
        '  }',
        '  for each (item in [1, 2, 3]) {',
        '    print item',
        '  }',
        '  while (i < 10) {',
        '    i = i + 1',
        '  }',
        '  try {',
        '    risky()',
        '  } catch (e) {',
        '    print e',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});

/**
 * Mirrors `focus-statement.test.ts`'s own regression case: `parseBlockContent`'s fallback
 * statement-region scanner must stop at `for`/`while`/`try`/`catch` even when one of these follows a
 * plain statement in the same block, not just when it's the sole/first statement.
 */
describe('parse — a plain statement followed by for/while/try in the same block', () => {
  it('still recognizes for(...) {} as its own statement after a preceding plain statement', () => {
    const { file, diagnostics } = body('x = 1\nfor (i = 0 to 10) {\n  print i\n}');

    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements).to.have.lengthOf(2);
    expect(statements[1]).to.be.instanceOf(ForStatement);
  });

  it('still recognizes while(...) {} as its own statement after a preceding plain statement', () => {
    const { file, diagnostics } = body('x = 1\nwhile (x < 10) {\n  x = x + 1\n}');

    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements).to.have.lengthOf(2);
    expect(statements[1]).to.be.instanceOf(WhileStatement);
  });

  it('still recognizes try {} catch (...) {} as its own statement after a preceding plain statement', () => {
    const { file, diagnostics } = body('x = 1\ntry {\n  risky()\n} catch (e) {\n  print e\n}');

    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements).to.have.lengthOf(2);
    expect(statements[1]).to.be.instanceOf(TryStatement);
  });
});

/**
 * The documented bug this feature fixes as a side effect: a raw (unbracketed) `for`/`while`/`try`
 * is no longer parseable at all once these become DSL stop-tokens with mandatory bracket syntax
 * (mirrors `if`, which already made raw `then`/`end if` unusable in `.thr` source) — confirming the
 * deliberate breaking change is exactly what happens, not a silent misparse.
 */
describe('parse — raw (unbracketed) for/while/try is no longer usable in .thr source', () => {
  it('rejects a raw numeric for with statement/for-requires-parens, rather than silently swallowing it as passthrough text', () => {
    const { diagnostics } = body('for i = 0 to 10\n  print i\nend for');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/for-requires-parens']);
  });
});
