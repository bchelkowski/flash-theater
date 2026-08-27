import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile, StateAssignment, AnonymousFunctionExpression, AnonymousFunctionAssignmentStatement } from '../../src/ast.js';

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

describe('parse — anonymous function expressions (isolated, Tier 1: whole assignment RHS)', () => {
  it('parses a plain assignment whose RHS is a return-typed anonymous function', () => {
    const { file, diagnostics } = body('add = function (a: integer, b: integer): integer {\n  return a + b\n}');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(AnonymousFunctionAssignmentStatement);
    const assignment = statement as AnonymousFunctionAssignmentStatement;
    expect(assignment.target).to.equal('add');
    expect(assignment.value).to.be.instanceOf(AnonymousFunctionExpression);
    expect(assignment.value.parameters).to.deep.equal([
      { name: 'a', type: 'integer' },
      { name: 'b', type: 'integer' },
    ]);
    expect(assignment.value.returnType).to.equal('integer');
    expect(assignment.value.block.statements).to.have.lengthOf(1);
  });

  it('parses a plain assignment whose RHS is a return-less anonymous function (compiles to a sub)', () => {
    const { file, diagnostics } = body('onFire = function () {\n  print "fired"\n}');

    expect(diagnostics).to.deep.equal([]);
    const assignment = file.script.functions[0].block.statements[0] as AnonymousFunctionAssignmentStatement;
    expect(assignment.value.returnType).to.equal(null);
    expect(assignment.value.parameters).to.deep.equal([]);
  });

  it('parses a state write whose RHS is an anonymous function', () => {
    const { file, diagnostics } = wrap(
      thr(['state handler: object = invalid', 'public function setup() {', '  state handler = function (key: string) {', '    print key', '  }', '}'].join('\n')),
    );

    expect(diagnostics).to.deep.equal([]);
    const setupFn = file.script.functions.find((f) => f.name === 'setup')!;
    const [statement] = setupFn.block.statements;
    expect(statement).to.be.instanceOf(StateAssignment);
    const stateAssignment = statement as StateAssignment;
    expect(stateAssignment.rhs).to.be.instanceOf(AnonymousFunctionExpression);
  });

  it('allows a nested DSL if inside the anonymous function body', () => {
    const { file, diagnostics } = body('cb = function (press: boolean) {\n  if (press) {\n    print "pressed"\n  }\n}');

    expect(diagnostics).to.deep.equal([]);
    const assignment = file.script.functions[0].block.statements[0] as AnonymousFunctionAssignmentStatement;
    expect(assignment.value.block.statements).to.have.lengthOf(1);
  });

  it('spans multiple lines correctly via brace-matching, not a same-line scan', () => {
    const { file, diagnostics } = body(['cb = function (x: integer): integer {', '  y = x * 2', '  return y', '}'].join('\n'));

    expect(diagnostics).to.deep.equal([]);
    const assignment = file.script.functions[0].block.statements[0] as AnonymousFunctionAssignmentStatement;
    // `y = x * 2` and `return y` neither start a DSL keyword, so — same as any other pair of
    // consecutive plain statements — they arrive as one merged opaque `StatementRegion`, not two;
    // what this asserts is that the anonymous function's own body was captured at all (spanning
    // both physical lines), not that each line becomes its own statement node.
    expect(assignment.value.block.statements).to.have.lengthOf(1);
    expect(assignment.value.block.getText().trim()).to.include('y = x * 2').and.to.include('return y');
  });

  it('throws dsl/invalid-param when the parameter list is malformed', () => {
    const { diagnostics } = body('cb = function (x integer) {\n  print x\n}');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-param']);
  });
});

describe('parse — anonymous function expressions (Tier 2: nested inside an arbitrary expression) — full .thr pipeline', () => {
  it('parses a call-argument-nested anonymous function inside a real .thr function body, byte-for-byte round-trip', () => {
    const source = thr(['private function f() {', '  results = list.Map(function (item: object) {', '    return item.name', '  })', '  print results', '}'].join('\n'));
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });

  it('reports a diagnostic when a call-argument-nested anonymous function is malformed, without corrupting the surrounding statement', () => {
    const { diagnostics } = body('results = list.Map(function (item object) {\n  return item.name\n})');
    expect(diagnostics.length).to.be.greaterThan(0);
  });

  /**
   * Regression: the outer DSL block-content scanner (`parseBlockContent`'s opaque-region
   * accumulation loop) has no dedicated Tier-1-style lookahead for this shape (the assignment's
   * RHS isn't `Identifier = function (`, it's `Identifier = list.Map(function (...) {...})`), so
   * it falls into the generic bracket-depth-tracked scan. Before that scan tracked bracket depth,
   * it treated a DSL keyword like `if`/`state` inside the anon function's own body as if it were
   * a fresh TOP-LEVEL statement the moment it saw the keyword — splitting the region right before
   * it, leaving the anonymous function's own header with no matching closing brace at all
   * (surfaced as `dsl/unterminated-anonymous-function-block`/`statement/parse-error`, confirmed
   * live via a failed Tier-2 compile before the depth-tracking fix in `parseBlockContent`).
   */
  it('a nested DSL if/state inside a Tier-2 body does not fool the outer block scanner into ending the region early', () => {
    const source = thr(
      [
        'state total: integer = 0',
        'private function f() {',
        '  results = list.Map(function (item: object) {',
        '    if (item.value > 0) {',
        '      state total = total + item.value',
        '    }',
        '    return item.value',
        '  })',
        '  print results',
        '}',
      ].join('\n'),
    );
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});

describe('parse — anonymous function expression round-trip fidelity', () => {
  it('reproduces a file containing an anonymous function assignment byte-for-byte', () => {
    const source = thr(
      ['private function f() {', '  add = function (a: integer, b: integer): integer {', '    return a + b', '  }', '  print add(1, 2)', '}'].join('\n'),
    );
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});

/**
 * Mirrors `focus-statement.test.ts`'s/`control-flow-statements.test.ts`'s own regression case: the
 * opaque-scan fallback loop must stop accumulating a `StatementRegion` the moment a later physical
 * line within it turns out to be an anonymous-function assignment.
 */
describe('parse — a plain statement followed by an anonymous function assignment in the same block', () => {
  it('still recognizes the anonymous function assignment as its own statement after a preceding plain statement', () => {
    const { file, diagnostics } = body('x = 1\ncb = function () {\n  print "hi"\n}');

    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements).to.have.lengthOf(2);
    expect(statements[1]).to.be.instanceOf(AnonymousFunctionAssignmentStatement);
  });
});
