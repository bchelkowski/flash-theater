import { expect } from 'chai';
import { parseBrightScript } from '../src/brightscript-parser.js';
import {
  wrapBrightScriptNode,
  BsSourceFile,
  BsFunctionDeclaration,
  BsIfStatement,
  BsAssignmentStatement,
  BsBinaryExpression,
  BsComparisonExpression,
  BsSafeNotExpression,
  BsUnaryExpression,
  BsCallExpression,
  BsIdentifierExpression,
  BsLiteralExpression,
  BsForEachStatement,
} from '../src/brightscript-ast.js';

function file(source: string): BsSourceFile {
  const { root, diagnostics } = parseBrightScript(source);
  expect(diagnostics, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`).to.deep.equal([]);
  return wrapBrightScriptNode(root) as BsSourceFile;
}

describe('brightscript-ast — wrapBrightScriptNode returns the same instance for the same node', () => {
  it('memoizes via the WeakMap cache', () => {
    const { root } = parseBrightScript('x = 1');
    const a = wrapBrightScriptNode(root);
    const b = wrapBrightScriptNode(root);
    expect(a).to.equal(b);
  });
});

describe('brightscript-ast — BsFunctionDeclaration', () => {
  it('exposes name, isFunction/isSub, params, returnType, and body', () => {
    const f = file('function add(a as integer, b as integer) as integer\n  return a + b\nend function');
    const fn = f.statements[0] as BsFunctionDeclaration;
    expect(fn).to.be.instanceOf(BsFunctionDeclaration);
    expect(fn.name).to.equal('add');
    expect(fn.isFunction).to.equal(true);
    expect(fn.isSub).to.equal(false);
    expect(fn.params.map((p) => p.name)).to.deep.equal(['a', 'b']);
    expect(fn.params.map((p) => p.typeName)).to.deep.equal(['integer', 'integer']);
    expect(fn.returnType).to.equal('integer');
    expect(fn.body).to.have.length(1);
  });
});

describe('brightscript-ast — BsIfStatement / else-if / else', () => {
  it('exposes condition, body, elseIfClauses, and elseClause', () => {
    const f = file('sub s()\n  if a then\n    x = 1\n  else if b then\n    x = 2\n  else\n    x = 3\n  end if\nend sub');
    const fn = f.statements[0] as BsFunctionDeclaration;
    const ifStmt = fn.body[0] as BsIfStatement;
    expect(ifStmt).to.be.instanceOf(BsIfStatement);
    expect(ifStmt.condition).to.be.instanceOf(BsIdentifierExpression);
    expect((ifStmt.condition as BsIdentifierExpression).name).to.equal('a');
    expect(ifStmt.body).to.have.length(1);
    expect(ifStmt.elseIfClauses).to.have.length(1);
    expect((ifStmt.elseIfClauses[0].condition as BsIdentifierExpression).name).to.equal('b');
    expect(ifStmt.elseClause).to.exist;
    expect(ifStmt.elseClause!.body).to.have.length(1);
  });
});

describe('brightscript-ast — BsAssignmentStatement / BsBinaryExpression', () => {
  it('exposes target, operatorToken, isCompound, and value', () => {
    const f = file('x = 1 + 2');
    const assign = f.statements[0] as BsAssignmentStatement;
    expect(assign).to.be.instanceOf(BsAssignmentStatement);
    expect(assign.target).to.be.instanceOf(BsIdentifierExpression);
    expect(assign.isCompound).to.equal(false);
    const bin = assign.value as BsBinaryExpression;
    expect(bin).to.be.instanceOf(BsBinaryExpression);
    expect(bin.operator).to.equal('+');
    expect((bin.left as BsLiteralExpression).value).to.equal('1');
    expect((bin.right as BsLiteralExpression).value).to.equal('2');
  });

  it('recognizes a compound assignment operator', () => {
    const f = file('x += 1');
    const assign = f.statements[0] as BsAssignmentStatement;
    expect(assign.isCompound).to.equal(true);
    expect(assign.operatorToken!.text).to.equal('+=');
  });
});

describe('brightscript-ast — BsComparisonExpression (DSL-only ==/!=/</>/<=/>=)', () => {
  it('exposes left/operator/right/isNegated for ==', () => {
    const f = file('x = a == b');
    const assign = f.statements[0] as BsAssignmentStatement;
    const cmp = assign.value as BsComparisonExpression;
    expect(cmp).to.be.instanceOf(BsComparisonExpression);
    expect(cmp.operator).to.equal('==');
    expect(cmp.isNegated).to.equal(false);
    expect((cmp.left as BsIdentifierExpression).name).to.equal('a');
    expect((cmp.right as BsIdentifierExpression).name).to.equal('b');
  });

  it('isNegated is true for !=', () => {
    const f = file('x = a != b');
    const assign = f.statements[0] as BsAssignmentStatement;
    const cmp = assign.value as BsComparisonExpression;
    expect(cmp.operator).to.equal('!=');
    expect(cmp.isNegated).to.equal(true);
  });

  for (const op of ['<', '>', '<=', '>=']) {
    it(`exposes left/operator/right for ${op}, isNegated always false`, () => {
      const f = file(`x = a ${op} b`);
      const assign = f.statements[0] as BsAssignmentStatement;
      const cmp = assign.value as BsComparisonExpression;
      expect(cmp).to.be.instanceOf(BsComparisonExpression);
      expect(cmp.operator).to.equal(op);
      expect(cmp.isNegated).to.equal(false);
      expect((cmp.left as BsIdentifierExpression).name).to.equal('a');
      expect((cmp.right as BsIdentifierExpression).name).to.equal('b');
    });
  }

  it('a real BrightScript = never wraps as BsComparisonExpression', () => {
    const f = file('if a = b then\nend if');
    const ifStmt = f.statements[0] as BsIfStatement;
    expect(ifStmt.condition).to.be.instanceOf(BsBinaryExpression);
    expect(ifStmt.condition).to.not.be.instanceOf(BsComparisonExpression);
  });

  it('a real BrightScript <> never wraps as BsComparisonExpression', () => {
    const f = file('if a <> b then\nend if');
    const ifStmt = f.statements[0] as BsIfStatement;
    expect(ifStmt.condition).to.be.instanceOf(BsBinaryExpression);
    expect(ifStmt.condition).to.not.be.instanceOf(BsComparisonExpression);
  });
});

describe('brightscript-ast — BsSafeNotExpression (DSL-only !)', () => {
  it('exposes operator/operand for !', () => {
    const f = file('x = !a');
    const assign = f.statements[0] as BsAssignmentStatement;
    const not = assign.value as BsSafeNotExpression;
    expect(not).to.be.instanceOf(BsSafeNotExpression);
    expect(not.operator).to.equal('!');
    expect((not.operand as BsIdentifierExpression).name).to.equal('a');
  });

  it('a real BrightScript Not never wraps as BsSafeNotExpression', () => {
    const f = file('x = not a');
    const assign = f.statements[0] as BsAssignmentStatement;
    expect(assign.value).to.be.instanceOf(BsUnaryExpression);
    expect(assign.value).to.not.be.instanceOf(BsSafeNotExpression);
  });
});

describe('brightscript-ast — BsCallExpression', () => {
  it('exposes callee and args', () => {
    const f = file('x = foo(1, "two", bar)');
    const assign = f.statements[0] as BsAssignmentStatement;
    const call = assign.value as BsCallExpression;
    expect(call).to.be.instanceOf(BsCallExpression);
    expect((call.callee as BsIdentifierExpression).name).to.equal('foo');
    expect(call.args).to.have.length(3);
  });
});

describe('brightscript-ast — BsForEachStatement', () => {
  it('exposes the iterator variable and body', () => {
    const f = file('for each item in items\n  print item\nend for');
    const forEach = f.statements[0] as BsForEachStatement;
    expect(forEach).to.be.instanceOf(BsForEachStatement);
    expect(forEach.variable).to.equal('item');
    expect(forEach.body).to.have.length(1);
  });
});
