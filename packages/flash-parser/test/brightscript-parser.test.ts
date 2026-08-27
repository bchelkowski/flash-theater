import { expect } from 'chai';
import { parseBrightScript } from '../src/brightscript-parser.js';
import { SyntaxKind } from '../src/syntaxKind.js';
import { SyntaxNode, isNode } from '../src/syntaxNode.js';
import { tokensToText } from '../src/token.js';

function root(source: string): SyntaxNode {
  const { root, diagnostics } = parseBrightScript(source);
  expect(diagnostics, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`).to.deep.equal([]);
  return root;
}

/** First descendant (including `node` itself) with the given kind, depth-first. */
function findFirst(node: SyntaxNode, kind: SyntaxKind): SyntaxNode | undefined {
  if (node.kind === kind) return node;
  for (const child of node.children) {
    if (isNode(child)) {
      const found = findFirst(child, kind);
      if (found) return found;
    }
  }
  return undefined;
}

describe('parseBrightScript — lossless round-trip', () => {
  const samples = [
    'x = 1 + 2 * 3',
    'function add(a as integer, b as integer) as integer\n  return a + b\nend function',
    'sub doStuff()\n  x = 1\n  if x > 0 then\n    print "positive"\n  else if x < 0 then\n    print "negative"\n  else\n    print "zero"\n  end if\nend sub',
    'for i = 0 to 10 step 2\n  print i\nend for',
    'for each item in items\n  print item\nend for',
    'while x < 10\n  x = x + 1\nend while',
    'try\n  x = risky()\ncatch e\n  print e\nend try',
    'x = a and b or not c',
    'x = a?.b?["c"]?(d, e)?@f',
    'x = a == b and c != d',
    'x = !a and not b',
    'x = [1, 2, {a: 1, b: [2, 3]}]',
    'x = (1 + 2) * (3 - 4)',
    'x = -y ^ 2',
    'dim arr[3, 4]',
    'if a then print "x" else print "y"',
    '#if debug\nprint "d"\n#end if',
  ];

  for (const source of samples) {
    it(`reproduces ${JSON.stringify(source.slice(0, 50))} byte-for-byte`, () => {
      const { root, tokens } = parseBrightScript(source);
      expect(root.getText()).to.equal(source);
      expect(tokensToText(tokens)).to.equal(source);
    });
  }
});

describe('parseBrightScript — operator precedence', () => {
  it('multiplication binds tighter than addition: 1 + 2 * 3 parses as 1 + (2 * 3)', () => {
    const r = root('x = 1 + 2 * 3');
    const assign = findFirst(r, SyntaxKind.BsAssignmentStatement)!;
    const outer = assign.childNodes.find((n) => n.kind === SyntaxKind.BsBinaryExpression)!;
    const [left, right] = outer.childNodes;
    expect(left.kind).to.equal(SyntaxKind.BsLiteralExpression);
    expect(right.kind).to.equal(SyntaxKind.BsBinaryExpression);
    // getText() includes leading trivia (the space after "+"), correctly —
    // a lossless CST attaches trivia to the node it precedes.
    expect(right.getText().trim()).to.equal('2 * 3');
  });

  it('^ is right-associative: 2 ^ 3 ^ 2 parses as 2 ^ (3 ^ 2)', () => {
    const r = root('x = 2 ^ 3 ^ 2');
    const outer = findFirst(r, SyntaxKind.BsBinaryExpression)!;
    const [left, right] = outer.childNodes;
    expect(left.kind).to.equal(SyntaxKind.BsLiteralExpression);
    expect(right.kind).to.equal(SyntaxKind.BsBinaryExpression);
  });

  it('and binds tighter than or: a or b and c parses as a or (b and c)', () => {
    const r = root('x = a or b and c');
    const outer = findFirst(r, SyntaxKind.BsBinaryExpression)!;
    const [left, right] = outer.childNodes;
    expect(left.kind).to.equal(SyntaxKind.BsIdentifierExpression);
    expect(right.kind).to.equal(SyntaxKind.BsBinaryExpression);
    expect(right.getText().trim()).to.equal('b and c');
  });
});

describe('parseBrightScript — DSL-only ==/!=/</>/<=/>= produce BsComparisonExpression, not BsBinaryExpression', () => {
  it('== lowers to a distinct BsComparisonExpression node', () => {
    const r = root('x = a == b');
    const cmp = findFirst(r, SyntaxKind.BsComparisonExpression);
    expect(cmp, 'expected a BsComparisonExpression').to.exist;
    expect(cmp!.getText().trim()).to.equal('a == b');
  });

  it('!= lowers to a distinct BsComparisonExpression node', () => {
    const r = root('x = a != b');
    const cmp = findFirst(r, SyntaxKind.BsComparisonExpression);
    expect(cmp, 'expected a BsComparisonExpression').to.exist;
    expect(cmp!.getText().trim()).to.equal('a != b');
  });

  for (const op of ['<', '>', '<=', '>=']) {
    it(`${op} lowers to a distinct BsComparisonExpression node`, () => {
      const r = root(`x = a ${op} b`);
      const cmp = findFirst(r, SyntaxKind.BsComparisonExpression);
      expect(cmp, 'expected a BsComparisonExpression').to.exist;
      expect(cmp!.getText().trim()).to.equal(`a ${op} b`);
    });
  }

  it('real BrightScript = and <> still produce plain BsBinaryExpression, never BsComparisonExpression', () => {
    const r1 = root('if a = b then\nend if');
    expect(findFirst(r1, SyntaxKind.BsComparisonExpression)).to.be.undefined;
    expect(findFirst(r1, SyntaxKind.BsBinaryExpression)).to.exist;

    const r2 = root('if a <> b then\nend if');
    expect(findFirst(r2, SyntaxKind.BsComparisonExpression)).to.be.undefined;
    expect(findFirst(r2, SyntaxKind.BsBinaryExpression)).to.exist;
  });

  it('== and != share the same precedence tier as real (still-unguarded) comparisons: a == b and c <> d', () => {
    const r = root('x = a == b and c <> d');
    const outer = findFirst(r, SyntaxKind.BsBinaryExpression)!; // the "and"
    expect(outer.getText().trim()).to.equal('a == b and c <> d');
    const left = outer.childNodes[0];
    const right = outer.childNodes[1];
    expect(left.kind).to.equal(SyntaxKind.BsComparisonExpression);
    expect(right.kind).to.equal(SyntaxKind.BsBinaryExpression);
  });

  it('== and < share the same precedence tier — both now guarded sugar: a == b and c < d', () => {
    const r = root('x = a == b and c < d');
    const outer = findFirst(r, SyntaxKind.BsBinaryExpression)!; // the "and"
    const left = outer.childNodes[0];
    const right = outer.childNodes[1];
    expect(left.kind).to.equal(SyntaxKind.BsComparisonExpression);
    expect(right.kind).to.equal(SyntaxKind.BsComparisonExpression);
  });
});

describe('parseBrightScript — DSL-only ! produces BsSafeNotExpression, not BsUnaryExpression', () => {
  it('! lowers to a distinct BsSafeNotExpression node', () => {
    const r = root('x = !a');
    const not = findFirst(r, SyntaxKind.BsSafeNotExpression);
    expect(not, 'expected a BsSafeNotExpression').to.exist;
    expect(not!.getText().trim()).to.equal('!a');
  });

  it('real BrightScript Not still produces plain BsUnaryExpression, never BsSafeNotExpression', () => {
    const r = root('x = not a');
    expect(findFirst(r, SyntaxKind.BsSafeNotExpression)).to.be.undefined;
    expect(findFirst(r, SyntaxKind.BsUnaryExpression)).to.exist;
  });

  it('! and Not share the same precedence tier: !a and b parses the same shape as Not a and b', () => {
    const rBang = root('x = !a and b');
    const rNot = root('x = not a and b');
    const outerBang = findFirst(rBang, SyntaxKind.BsBinaryExpression)!; // the "and"
    const outerNot = findFirst(rNot, SyntaxKind.BsBinaryExpression)!;
    expect(outerBang.childNodes[0].kind).to.equal(SyntaxKind.BsSafeNotExpression);
    expect(outerNot.childNodes[0].kind).to.equal(SyntaxKind.BsUnaryExpression);
    expect(outerBang.childNodes[1].kind).to.equal(SyntaxKind.BsIdentifierExpression);
  });

  it('!! nests correctly: outer and inner are both BsSafeNotExpression', () => {
    const r = root('x = !!a');
    const outer = findFirst(r, SyntaxKind.BsSafeNotExpression)!;
    expect(outer.getText().trim()).to.equal('!!a');
    expect(outer.childNodes[0]?.kind).to.equal(SyntaxKind.BsSafeNotExpression);
    expect(outer.childNodes[0]?.getText().trim()).to.equal('!a');
  });
});

describe('parseBrightScript — Tier-2 anonymous function expressions (nested in an arbitrary expression position)', () => {
  it('parses a DSL anonymous function as a call argument', () => {
    const r = root('x = list.Map(function (item: object) {\n  return item.name\n})');
    const anon = findFirst(r, SyntaxKind.AnonymousFunctionExpression);
    expect(anon, 'expected a nested AnonymousFunctionExpression').to.exist;
    const call = findFirst(r, SyntaxKind.BsCallExpression);
    expect(call, 'expected the surrounding call to still parse as BsCallExpression').to.exist;
  });

  it('parses a DSL anonymous function as one argument among several', () => {
    const r = root('x = obj.doThing(1, function (a: integer) {\n  return a\n}, 2)');
    const anon = findFirst(r, SyntaxKind.AnonymousFunctionExpression);
    expect(anon, 'expected a nested AnonymousFunctionExpression').to.exist;
  });

  it('parses a return-typed DSL anonymous function nested in a condition expression', () => {
    const r = root('if isValid(function (x: integer): boolean {\n  return x > 0\n}) then\n  print "ok"\nend if');
    const anon = findFirst(r, SyntaxKind.AnonymousFunctionExpression);
    expect(anon, 'expected a nested AnonymousFunctionExpression').to.exist;
    expect(findFirst(r, SyntaxKind.BsIfStatement), 'expected the surrounding if to still parse').to.exist;
  });

  it('DSL sugar inside a Tier-2 body: state/store/nested if all parse as their real DSL node kinds, not opaque text', () => {
    const r = root(['x = list.Map(function (item: object) {', '  state y = item', '  store(count) = 1', '  if (y) {', '    print y', '  }', '  return y', '})'].join('\n'));

    expect(findFirst(r, SyntaxKind.StateAssignment), 'expected a real StateAssignment node inside the Tier-2 body').to.exist;
    expect(findFirst(r, SyntaxKind.StoreWriteStatement), 'expected a real StoreWriteStatement node inside the Tier-2 body').to.exist;
    expect(findFirst(r, SyntaxKind.IfStatement), 'expected a real (DSL) IfStatement node inside the Tier-2 body').to.exist;
  });

  it('a second, nested anonymous function (Tier 1, assignment-RHS-shaped) works inside a Tier-2 body', () => {
    const r = root(['x = list.Map(function (item: object) {', '  transform = function (v: object) {', '    return v.name', '  }', '  return transform(item)', '})'].join('\n'));

    expect(findFirst(r, SyntaxKind.AnonymousFunctionAssignmentStatement), 'expected the inner Tier-1 anonymous-function assignment').to.exist;
    const outer = findFirst(r, SyntaxKind.AnonymousFunctionExpression)!;
    expect(findFirst(outer, SyntaxKind.AnonymousFunctionAssignmentStatement), 'expected it nested inside the outer anon function specifically').to.exist;
  });

  it('a real BrightScript anonymous function (as/end function) with a default-parameter AA literal is unaffected — no misfire on the header brace', () => {
    const r = root('x = list.Map(function (y = {a: 1}) as integer\n  return y.a\nend function)');
    expect(findFirst(r, SyntaxKind.AnonymousFunctionExpression), 'must not be treated as a DSL anonymous function').to.be.undefined;
    expect(findFirst(r, SyntaxKind.BsFunctionExpression), 'must still parse as a real BrightScript function expression').to.exist;
  });

  it('a real BrightScript anonymous function with no return type is still unaffected', () => {
    const r = root('x = list.Map(function (y)\n  print y\nend function)');
    expect(findFirst(r, SyntaxKind.AnonymousFunctionExpression)).to.be.undefined;
    expect(findFirst(r, SyntaxKind.BsFunctionExpression), 'expected a real BrightScript function expression').to.exist;
  });

  it('a diagnostic inside a Tier-2 body still reports the correct position in the outer source', () => {
    const source = 'x = list.Map(function (a integer) {\n  return a\n})';
    const { diagnostics } = parseBrightScript(source);

    expect(diagnostics).to.have.lengthOf.at.least(1);
    const paramTokenPos = source.indexOf('a integer') + 2; // "integer" starts right after "a "
    expect(diagnostics[0].pos).to.equal(paramTokenPos);
  });
});

describe('parseBrightScript — statement shapes', () => {
  it('parses an if/else if/else chain into nested ElseIf/Else clauses', () => {
    const r = root('if a then\n  print "a"\nelse if b then\n  print "b"\nelse\n  print "c"\nend if');
    const ifStmt = findFirst(r, SyntaxKind.BsIfStatement)!;
    expect(findFirst(ifStmt, SyntaxKind.BsElseIfClause)).to.exist;
    expect(findFirst(ifStmt, SyntaxKind.BsElseClause)).to.exist;
  });

  it('parses a for-each loop with the iterator/collection in the right slots', () => {
    const r = root('for each x in items\n  print x\nend for');
    const forEach = findFirst(r, SyntaxKind.BsForEachStatement)!;
    expect(forEach.getText().trim()).to.equal('for each x in items\n  print x\nend for');
  });

  it('reports zero diagnostics for a real function with mixed control flow', () => {
    const { diagnostics } = parseBrightScript('function classify(x as integer) as string\n  if x > 0 then\n    return "pos"\n  end if\n  return "non-pos"\nend function');
    expect(diagnostics).to.deep.equal([]);
  });
});

describe('parseBrightScript — error tolerance', () => {
  it('never throws on malformed input, and always returns a tree', () => {
    expect(() => parseBrightScript('if a then')).to.not.throw();
    const { root: r, diagnostics } = parseBrightScript('if a then');
    expect(r).to.exist;
    expect(diagnostics.length).to.be.greaterThan(0);
  });

  it('reports a diagnostic for an unterminated if', () => {
    const { diagnostics } = parseBrightScript('if a then\n  print "x"');
    expect(diagnostics.length).to.be.greaterThan(0);
  });
});
