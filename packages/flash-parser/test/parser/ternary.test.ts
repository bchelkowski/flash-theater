import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile, StateAssignment, StatementRegion, ExpressionRegion, TernaryExpression, TernaryOperand, TernaryAssignmentStatement } from '../../src/ast.js';
import { tokenize } from '../../src/lexer.js';
import { TokenKind } from '../../src/tokenKind.js';

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

/** Asserts `node` is a plain `ExpressionRegion` leaf and returns its text. */
function leaf(node: ExpressionRegion | TernaryExpression | TernaryOperand): string {
  expect(node).to.be.instanceOf(ExpressionRegion);
  return (node as ExpressionRegion).text;
}

describe('lexer — ? tokenizes as Question', () => {
  it('emits a Question token for a bare "?"', () => {
    const tokens = tokenize('cond ? a : b');
    expect(tokens.map((t) => t.kind)).to.deep.equal([
      TokenKind.Identifier,
      TokenKind.Question,
      TokenKind.Identifier,
      TokenKind.Colon,
      TokenKind.Identifier,
      TokenKind.EndOfFile,
    ]);
  });

  it('emits LBracket/RBracket for "[" / "]"', () => {
    const tokens = tokenize('[a]');
    expect(tokens.map((t) => t.kind)).to.deep.equal([TokenKind.LBracket, TokenKind.Identifier, TokenKind.RBracket, TokenKind.EndOfFile]);
  });
});

describe('parse — ternary in a plain assignment (isolated)', () => {
  it('parses bare identifiers on both sides as a TernaryAssignmentStatement', () => {
    const { file, diagnostics } = body('x = cond ? a : b');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(TernaryAssignmentStatement);
    const ternaryAssignment = statement as TernaryAssignmentStatement;
    expect(ternaryAssignment.target).to.equal('x');
    const rhs = ternaryAssignment.rhs as TernaryExpression;
    expect(rhs).to.be.instanceOf(TernaryExpression);
    expect(leaf(rhs.condition)).to.equal('cond');
    expect(leaf(rhs.whenTrue)).to.equal('a');
    expect(leaf(rhs.whenFalse)).to.equal('b');
  });

  it('parses literals on both sides', () => {
    const { file, diagnostics } = body('x = cond ? 1 : 2');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    expect(leaf(rhs.whenTrue)).to.equal('1');
    expect(leaf(rhs.whenFalse)).to.equal('2');
  });

  it('parses string literals on both sides', () => {
    const { file, diagnostics } = body('x = cond ? "yes" : "no"');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    expect(leaf(rhs.whenTrue)).to.equal('"yes"');
    expect(leaf(rhs.whenFalse)).to.equal('"no"');
  });

  it('parses a call expression as a branch', () => {
    const { file, diagnostics } = body('x = cond ? compute(a) : b');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    expect(leaf(rhs.whenTrue)).to.equal('compute(a)');
  });

  it('parses a parenthesized compound condition', () => {
    const { file, diagnostics } = body('x = (a > b) ? a : b');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    expect(leaf(rhs.condition)).to.equal('(a > b)');
  });

  it('parses a bare (unparenthesized) compound condition identically', () => {
    const { file, diagnostics } = body('x = a > b ? a : b');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    expect(leaf(rhs.condition)).to.equal('a > b');
  });
});

describe('parse — ternary in a state write (isolated)', () => {
  it('parses a StateAssignment whose .rhs is a TernaryExpression', () => {
    const { file, diagnostics } = body('state x = cond ? a : b');
    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(StateAssignment);
    const stateAssignment = statement as StateAssignment;
    expect(stateAssignment.name).to.equal('x');
    const rhs = stateAssignment.rhs as TernaryExpression;
    expect(rhs).to.be.instanceOf(TernaryExpression);
    expect(leaf(rhs.condition)).to.equal('cond');
  });

  it('throws when .expressionRegion is accessed on a ternary-bearing state write', () => {
    const { file } = body('state x = cond ? a : b');
    const stateAssignment = file.script.functions[0].block.statements[0] as StateAssignment;
    expect(() => stateAssignment.expressionRegion).to.throw();
  });

  it('a ternary-free state write keeps .rhs as a plain ExpressionRegion and .expression working', () => {
    const { file, diagnostics } = body('state x = a + b');
    expect(diagnostics).to.deep.equal([]);
    const stateAssignment = file.script.functions[0].block.statements[0] as StateAssignment;
    expect(stateAssignment.rhs).to.be.instanceOf(ExpressionRegion);
    expect(stateAssignment.expression).to.equal('a + b');
  });
});

describe('parse — a ternary-free assignment/state-write is unaffected', () => {
  it('a plain assignment with no "?" stays an ordinary StatementRegion', () => {
    const { file, diagnostics } = body('x = a + b');
    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(StatementRegion);
    expect((statement as StatementRegion).text).to.equal('x = a + b');
  });

  it('reproduces a file with only ternary-free assignments byte-for-byte', () => {
    const source = thr('private function f() {\n  x = a + b\n  state y = c\n}', '<Rectangle id="a" width="{width}" />');
    const result = parse(source);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});

describe('parse — ternary nesting', () => {
  it('chains unparenthesized in the false branch: c1 ? a : c2 ? b : c', () => {
    const { file, diagnostics } = body('x = c1 ? a : c2 ? b : c');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    expect(leaf(rhs.condition)).to.equal('c1');
    expect(leaf(rhs.whenTrue)).to.equal('a');
    const nested = rhs.whenFalse as TernaryExpression;
    expect(nested).to.be.instanceOf(TernaryExpression);
    expect(leaf(nested.condition)).to.equal('c2');
    expect(leaf(nested.whenTrue)).to.equal('b');
    expect(leaf(nested.whenFalse)).to.equal('c');
  });

  it('chains explicitly parenthesized in the false branch, same tree shape: c1 ? a : (c2 ? b : c)', () => {
    const { file, diagnostics } = body('x = c1 ? a : (c2 ? b : c)');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    // Parenthesized -> the false branch is a TernaryOperand wrapping one nested TernaryExpression.
    const operand = rhs.whenFalse as TernaryOperand;
    expect(operand).to.be.instanceOf(TernaryOperand);
    const nested = operand.segments.find((s) => typeof s !== 'string') as TernaryExpression;
    expect(nested).to.be.instanceOf(TernaryExpression);
    expect(leaf(nested.condition)).to.equal('c2');
  });

  it('nests unparenthesized in the true branch: c1 ? c2 ? a : b : c', () => {
    const { file, diagnostics } = body('x = c1 ? c2 ? a : b : c');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    expect(leaf(rhs.condition)).to.equal('c1');
    const nested = rhs.whenTrue as TernaryExpression;
    expect(nested).to.be.instanceOf(TernaryExpression);
    expect(leaf(nested.condition)).to.equal('c2');
    expect(leaf(nested.whenTrue)).to.equal('a');
    expect(leaf(nested.whenFalse)).to.equal('b');
    expect(leaf(rhs.whenFalse)).to.equal('c');
  });

  it('nests parenthesized in the true branch: c1 ? (c2 ? a : b) : c', () => {
    const { file, diagnostics } = body('x = c1 ? (c2 ? a : b) : c');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    const operand = rhs.whenTrue as TernaryOperand;
    expect(operand).to.be.instanceOf(TernaryOperand);
    const nested = operand.segments.find((s) => typeof s !== 'string') as TernaryExpression;
    expect(leaf(nested.condition)).to.equal('c2');
  });

  it('resolves a three-deep chain: c1 ? a : c2 ? b : c3 ? d : e', () => {
    const { file, diagnostics } = body('x = c1 ? a : c2 ? b : c3 ? d : e');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    expect(leaf(rhs.condition)).to.equal('c1');
    const second = rhs.whenFalse as TernaryExpression;
    expect(leaf(second.condition)).to.equal('c2');
    const third = second.whenFalse as TernaryExpression;
    expect(leaf(third.condition)).to.equal('c3');
    expect(leaf(third.whenTrue)).to.equal('d');
    expect(leaf(third.whenFalse)).to.equal('e');
  });

  it('nests independently in both branches: c1 ? (c2 ? a : b) : (c3 ? d : e)', () => {
    const { file, diagnostics } = body('x = c1 ? (c2 ? a : b) : (c3 ? d : e)');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryExpression;
    const trueOperand = rhs.whenTrue as TernaryOperand;
    const falseOperand = rhs.whenFalse as TernaryOperand;
    const nestedTrue = trueOperand.segments.find((s) => typeof s !== 'string') as TernaryExpression;
    const nestedFalse = falseOperand.segments.find((s) => typeof s !== 'string') as TernaryExpression;
    expect(leaf(nestedTrue.condition)).to.equal('c2');
    expect(leaf(nestedFalse.condition)).to.equal('c3');
  });

  it('chains in a ternary-bearing state write too', () => {
    const { file, diagnostics } = body('state x = c1 ? a : c2 ? b : c');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as StateAssignment).rhs as TernaryExpression;
    expect((rhs.whenFalse as TernaryExpression)).to.be.instanceOf(TernaryExpression);
  });
});

describe('parse — ternary nested inside a bracketed sub-expression', () => {
  it('as an operand of a binary expression: x = 1 + (cond ? a : b)', () => {
    const { file, diagnostics } = body('x = 1 + (cond ? a : b)');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryOperand;
    expect(rhs).to.be.instanceOf(TernaryOperand);
    const nested = rhs.segments.find((s) => typeof s !== 'string') as TernaryExpression;
    expect(nested).to.be.instanceOf(TernaryExpression);
    expect(leaf(nested.condition)).to.equal('cond');
  });

  it('two independent ternaries in one binary expression: x = (cond ? a : b) + (cond2 ? c : d)', () => {
    const { file, diagnostics } = body('x = (cond ? a : b) + (cond2 ? c : d)');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryOperand;
    const nestedTernaries = rhs.segments.filter((s) => typeof s !== 'string') as TernaryExpression[];
    expect(nestedTernaries).to.have.lengthOf(2);
    expect(leaf(nestedTernaries[0].condition)).to.equal('cond');
    expect(leaf(nestedTernaries[1].condition)).to.equal('cond2');
  });

  it('as a call argument: x = foo(cond ? a : b)', () => {
    const { file, diagnostics } = body('x = foo(cond ? a : b)');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryOperand;
    expect(rhs).to.be.instanceOf(TernaryOperand);
  });

  it('as one of several call arguments: x = foo(a, cond ? b : c, d)', () => {
    const { file, diagnostics } = body('x = foo(a, cond ? b : c, d)');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryOperand;
    const nested = rhs.segments.find((s) => typeof s !== 'string') as TernaryExpression;
    expect(leaf(nested.whenTrue)).to.equal('b');
  });

  it('as an array literal element: x = [cond ? a : b, c]', () => {
    const { file, diagnostics } = body('x = [cond ? a : b, c]');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryOperand;
    expect(rhs).to.be.instanceOf(TernaryOperand);
    const nested = rhs.segments.find((s) => typeof s !== 'string') as TernaryExpression;
    expect(leaf(nested.condition)).to.equal('cond');
  });

  it('as an index expression: x = arr[cond ? 0 : 1]', () => {
    const { file, diagnostics } = body('x = arr[cond ? 0 : 1]');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryOperand;
    expect(rhs).to.be.instanceOf(TernaryOperand);
  });

  it('a plain (ternary-free) index expression is unaffected: x = arr[i]', () => {
    const { file, diagnostics } = body('x = arr[i]');
    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(StatementRegion);
  });

  it('nested two levels inside brackets: x = foo(1 + (cond ? a : b))', () => {
    const { file, diagnostics } = body('x = foo(1 + (cond ? a : b))');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryOperand;
    expect(rhs).to.be.instanceOf(TernaryOperand);
  });

  it('a ternary-free bracketed group beside one that has a ternary is left untouched: x = (a + b) + (cond ? c : d)', () => {
    const { file, diagnostics } = body('x = (a + b) + (cond ? c : d)');
    expect(diagnostics).to.deep.equal([]);
    const rhs = (file.script.functions[0].block.statements[0] as TernaryAssignmentStatement).rhs as TernaryOperand;
    const rawSegments = rhs.segments.filter((s) => typeof s === 'string') as string[];
    expect(rawSegments.join('')).to.contain('(a + b)');
  });

  it('the worked example from the plan: value = cond1 ? (cond2 ? a : b) : c', () => {
    const { file, diagnostics } = body('value = cond1 ? (cond2 ? a : b) : c');
    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(TernaryAssignmentStatement);
    const ternaryAssignment = statement as TernaryAssignmentStatement;
    expect(ternaryAssignment.target).to.equal('value');
    const rhs = ternaryAssignment.rhs as TernaryExpression;
    expect(leaf(rhs.condition)).to.equal('cond1');
    const operand = rhs.whenTrue as TernaryOperand;
    expect(operand).to.be.instanceOf(TernaryOperand);
    const nested = operand.segments.find((s) => typeof s !== 'string') as TernaryExpression;
    expect(leaf(nested.condition)).to.equal('cond2');
    expect(leaf(nested.whenTrue)).to.equal('a');
    expect(leaf(nested.whenFalse)).to.equal('b');
    expect(leaf(rhs.whenFalse)).to.equal('c');
  });
});

describe('parse — malformed ternary', () => {
  it('throws expression/unterminated-ternary when "?" has no matching ":"', () => {
    const { diagnostics } = body('x = cond ? a');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['expression/unterminated-ternary']);
  });

  it('throws expression/unterminated-ternary for an empty condition', () => {
    const { diagnostics } = body('x = ? a : b');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['expression/unterminated-ternary']);
  });

  it('throws expression/unterminated-ternary for an empty whenFalse branch', () => {
    const { diagnostics } = body('x = cond ? a :');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['expression/unterminated-ternary']);
  });
});

describe('parse — ternary round-trip fidelity', () => {
  it('reproduces a file with a nested, bracket-embedded ternary byte-for-byte', () => {
    const source = thr('private function f() {\n  value = cond1 ? (cond2 ? a : b) : c\n  state y = 1 + (cond ? a : b)\n}');
    const result = parse(source);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});

describe('parse — ternary is rejected outside assignment/state-write (falls through to the existing diagnostics)', () => {
  it('a "?" in a derived expression still fails as expression/parse-error', () => {
    const { diagnostics } = wrap(thr('field a: boolean = true\nfield b: integer = 1\nfield c: integer = 2\nderived x: integer = a ? b : c'));
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'expression/parse-error')).to.be.true;
  });

  it('a "?" in an if condition still fails as expression/parse-error', () => {
    const { diagnostics } = body('if (cond ? a : b) {\n  x = 1\n}');
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'expression/parse-error')).to.be.true;
  });

  it('a "?" in a store(...) write still fails as expression/parse-error', () => {
    const { diagnostics } = body('store(key) = cond ? a : b');
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'expression/parse-error')).to.be.true;
  });

  it('a "?" in a focus(...) argument still fails as expression/parse-error', () => {
    const { diagnostics } = body('focus(cond ? "a" : "b")');
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'expression/parse-error')).to.be.true;
  });

  it('a "?" in a template dynamic attribute still fails as expression/parse-error', () => {
    const { diagnostics } = wrap(thr('field width: integer = 0\nfield cond: boolean = true', '<Rectangle id="a" width="{cond ? width : 0}" />'));
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'expression/parse-error')).to.be.true;
  });

  it('a "?" in a {#each} key expression still fails as expression/parse-error', () => {
    const { diagnostics } = wrap(
      thr('field items: node = invalid\nfield cond: boolean = true', '{#each items as item (cond ? item : item)}\n<Rectangle id="a" />\n{/each}'),
    );
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'expression/parse-error')).to.be.true;
  });
});
