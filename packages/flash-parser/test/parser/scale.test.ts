import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile, ScaleLocalAssignmentStatement, ScaleStateAssignmentStatement, ExpressionRegion } from '../../src/ast.js';

function wrap(source: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
  const result = parse(source);
  return { file: new ThrFile(result.root), diagnostics: result.diagnostics };
}

const TEMPLATE = '<Rectangle id="a" width="{width}" />';

function thr(scriptBody: string, templateMarkup: string = TEMPLATE): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${templateMarkup}\n</component>\n`;
}

describe('parse — scale field declaration (isolated)', () => {
  it('parses a scaled integer field', () => {
    const { file, diagnostics } = wrap(thr('scale field cardWidth: integer = 200'));

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.fields).to.have.lengthOf(0);
    expect(file.script.scaleFields).to.have.lengthOf(1);
    const field = file.script.scaleFields[0];
    expect(field.name).to.equal('cardWidth');
    expect(field.type).to.equal('integer');
    expect(field.defaultLiteral).to.equal('200');
  });

  it('parses a scaled float field', () => {
    const { file, diagnostics } = wrap(thr('scale field ratio: float = 1.5'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.scaleFields[0].type).to.equal('float');
  });

  it('throws dsl/scale-invalid-field-type for a scaled string field', () => {
    const { diagnostics } = wrap(thr('scale field label: string = "x"'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/scale-invalid-field-type']);
  });

  it('throws dsl/scale-invalid-field-type for a scaled boolean field', () => {
    const { diagnostics } = wrap(thr('scale field flag: boolean = true'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/scale-invalid-field-type']);
  });

  it('throws dsl/scale-invalid-field-type for a scaled node field', () => {
    const { diagnostics } = wrap(thr('scale field target: node = invalid'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/scale-invalid-field-type']);
  });

  it('parses a scaled array field', () => {
    const { file, diagnostics } = wrap(thr('scale field position: array = [100, 50]'));
    expect(diagnostics).to.deep.equal([]);
    const field = file.script.scaleFields[0];
    expect(field.name).to.equal('position');
    expect(field.type).to.equal('array');
    expect(field.defaultLiteral).to.equal('[100, 50]');
  });

  it('parses a scaled assocarray field', () => {
    const { file, diagnostics } = wrap(thr('scale field padding: assocarray = { top: 10, left: 5 }'));
    expect(diagnostics).to.deep.equal([]);
    const field = file.script.scaleFields[0];
    expect(field.type).to.equal('assocarray');
    expect(field.defaultLiteral).to.equal('{ top: 10, left: 5 }');
  });
});

describe('parse — scale state declaration (isolated)', () => {
  it('parses a scaled state', () => {
    const { file, diagnostics } = wrap(thr('scale state offset: integer = 10'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.state).to.have.lengthOf(0);
    expect(file.script.scaleState).to.have.lengthOf(1);
    const state = file.script.scaleState[0];
    expect(state.name).to.equal('offset');
    expect(state.type).to.equal('integer');
    expect(state.defaultLiteral).to.equal('10');
  });

  it('throws dsl/scale-non-numeric-literal for a scaled state with a non-numeric literal', () => {
    const { diagnostics } = wrap(thr('scale state label: string = "x"'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/scale-non-numeric-literal']);
  });

  it('throws dsl/scale-non-numeric-literal for a scaled state with an invalid (node) literal — node stays scale-excluded', () => {
    const { diagnostics } = wrap(thr('scale state target: object = invalid'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/scale-non-numeric-literal']);
  });

  it('parses a scaled state with an array literal', () => {
    const { file, diagnostics } = wrap(thr('scale state position: object = [100, 50]'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.scaleState[0].defaultLiteral).to.equal('[100, 50]');
  });

  it('parses a scaled state with an assocarray literal', () => {
    const { file, diagnostics } = wrap(thr('scale state padding: object = { top: 10, left: 5 }'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.scaleState[0].defaultLiteral).to.equal('{ top: 10, left: 5 }');
  });
});

describe('parse — scale derived declaration (isolated)', () => {
  it('parses a scaled derived', () => {
    const { file, diagnostics } = wrap(thr('field base: integer = 10\nscale derived doubled: integer = base * 2'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.derived).to.have.lengthOf(0);
    expect(file.script.scaleDerived).to.have.lengthOf(1);
    const derived = file.script.scaleDerived[0];
    expect(derived.name).to.equal('doubled');
    expect(derived.type).to.equal('integer');
    expect(derived.expression).to.equal('base * 2');
  });
});

describe('parse — scale watch / scale read declaration (isolated)', () => {
  it('parses a scaled watch', () => {
    const { file, diagnostics } = wrap(thr('scale watch cardWidth = store(cardWidth)'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.watches).to.have.lengthOf(0);
    expect(file.script.scaleWatches).to.have.lengthOf(1);
    const watch = file.script.scaleWatches[0];
    expect(watch.name).to.equal('cardWidth');
    expect(watch.path.topLevelKey).to.equal('cardWidth');
  });

  it('parses a scaled read', () => {
    const { file, diagnostics } = wrap(thr('scale read cardWidth = store(cardWidth)'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.reads).to.have.lengthOf(0);
    expect(file.script.scaleReads).to.have.lengthOf(1);
    const read = file.script.scaleReads[0];
    expect(read.name).to.equal('cardWidth');
    expect(read.path.topLevelKey).to.equal('cardWidth');
  });
});

describe('parse — invalid scale declaration (isolated)', () => {
  it('throws dsl/invalid-scale-declaration when scale is not followed by a known kind keyword', () => {
    const { diagnostics } = wrap(thr('scale foo: integer = 1'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-scale-declaration']);
  });

  it('throws dsl/invalid-scale-declaration for scale stream (unsupported kind)', () => {
    const { diagnostics } = wrap(thr('scale stream foo: integer'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-scale-declaration']);
  });
});

describe('parse — scale local assignment statement (isolated)', () => {
  function body(bodySource: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
    return wrap(thr(`private function f() {\n${bodySource}\n}`));
  }

  it('parses a scaled local-variable assignment', () => {
    const { file, diagnostics } = body('scale x = 10');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(ScaleLocalAssignmentStatement);
    const assignment = statement as ScaleLocalAssignmentStatement;
    expect(assignment.target).to.equal('x');
    expect(assignment.rhs).to.be.instanceOf(ExpressionRegion);
    expect((assignment.rhs as ExpressionRegion).text).to.equal('10');
  });

  it('parses a scaled local-variable assignment with an array literal', () => {
    const { file, diagnostics } = body('scale point = [10, 20]');
    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    const assignment = statement as ScaleLocalAssignmentStatement;
    expect(assignment.target).to.equal('point');
    expect((assignment.rhs as ExpressionRegion).text).to.equal('[10, 20]');
  });

  it('throws statement/invalid-scale-assignment for a malformed scale assignment', () => {
    const { diagnostics } = body('scale x 10');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/invalid-scale-assignment']);
  });
});

describe('parse — scale state assignment statement (isolated)', () => {
  function body(bodySource: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
    return wrap(thr(`scale state offset: integer = 0\nprivate function f() {\n${bodySource}\n}`));
  }

  it('parses a scaled state write', () => {
    const { file, diagnostics } = body('scale state offset = 20');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(ScaleStateAssignmentStatement);
    const assignment = statement as ScaleStateAssignmentStatement;
    expect(assignment.name).to.equal('offset');
    expect((assignment.rhs as ExpressionRegion).text).to.equal('20');
  });

  it('throws statement/invalid-scale-assignment for a malformed scale state write', () => {
    const { diagnostics } = body('scale state offset 20');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/invalid-scale-assignment']);
  });
});

describe('parse — scale round-trip fidelity', () => {
  it('reproduces a file mixing every scale form byte-for-byte', () => {
    const source = thr(
      [
        'scale field cardWidth: integer = 200',
        'scale state offset: integer = 0',
        'scale derived doubled: integer = cardWidth * 2',
        'scale watch remoteWidth = store(remoteWidth)',
        'scale read initialWidth = store(initialWidth)',
        'public function f() {',
        '  scale local = 10',
        '  scale state offset = 20',
        '}',
      ].join('\n'),
    );
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});
