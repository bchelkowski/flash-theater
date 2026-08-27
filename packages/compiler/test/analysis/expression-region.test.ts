import { expect } from 'chai';
import { checkNoStreamCallsInReactiveExpression, parseExpression, parseStatements } from '../../src/analysis/expression-region.js';
import { CompileError } from '../../src/dsl-parser/dsl-ast.js';

describe('parseExpression', () => {
  it('finds a single top-level identifier with the exact offsets in the original text', () => {
    const { identifiers } = parseExpression('focusPercent > 0.5', 'derived isGridFocused');

    expect(identifiers).to.deep.equal([{ name: 'focusPercent', start: 0, end: 12 }]);
  });

  it('finds the callee identifier of a call expression plus its identifier arguments', () => {
    const { identifiers } = parseExpression('pickColor(gridHasFocus, "0x0057FFFF", "0x3A3A3AFF")', 'derived highlightColor');

    expect(identifiers.map((i) => i.name)).to.deep.equal(['pickColor', 'gridHasFocus']);
  });

  it('finds each identifier inside an array literal', () => {
    const { identifiers } = parseExpression('[width / 2, height / 2]', 'translation binding');

    expect(identifiers.map((i) => i.name)).to.deep.equal(['width', 'height']);
  });

  it('only extracts the object side of a dot expression, not the member name', () => {
    const { identifiers } = parseExpression('content.title', 'itemContentTitle body');

    expect(identifiers.map((i) => i.name)).to.deep.equal(['content']);
  });

  it('reports the exact identifier text via the returned offsets', () => {
    const text = 'itemContentAvailable(itemContent)';
    const { identifiers } = parseExpression(text, 'derived contentOpacity');

    for (const id of identifiers) {
      expect(text.slice(id.start, id.end)).to.equal(id.name);
    }
  });

  it('throws expression/parse-error on malformed input', () => {
    expect(() => parseExpression('focusPercent >', 'derived isGridFocused'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/parse-error' });
  });
});

describe('checkNoStreamCallsInReactiveExpression', () => {
  it('does not throw for a plain reference to a stream name', () => {
    expect(() => checkNoStreamCallsInReactiveExpression('dataLoaded.value', new Set(['dataLoaded']), 'derived label')).to.not.throw();
  });

  it('does not throw when no known stream name appears in the text at all', () => {
    expect(() => checkNoStreamCallsInReactiveExpression('width + height', new Set(['dataLoaded']), 'derived label')).to.not.throw();
  });

  it('throws expression/stream-call-in-reactive-expression for .emit(...) on a known stream name', () => {
    expect(() => checkNoStreamCallsInReactiveExpression('dataLoaded.emit("x")', new Set(['dataLoaded']), 'derived label'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/stream-call-in-reactive-expression' });
  });

  it('throws expression/stream-call-in-reactive-expression for .subscribe(...) on a known stream name', () => {
    expect(() => checkNoStreamCallsInReactiveExpression('dataLoaded.subscribe(cb)', new Set(['dataLoaded']), 'derived label'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/stream-call-in-reactive-expression' });
  });

  it('does not match a same-named method on an unrelated object — only the known stream name itself', () => {
    expect(() => checkNoStreamCallsInReactiveExpression('otherObject.emit("x")', new Set(['dataLoaded']), 'derived label')).to.not.throw();
  });
});

describe('parseStatements', () => {
  it('finds a single identifier in a return statement', () => {
    const { identifiers } = parseStatements('return enabled', 'function describe');

    expect(identifiers.map((i) => i.name)).to.deep.equal(['enabled']);
  });

  it('finds an identifier nested inside a call argument, same as an expression', () => {
    const { identifiers } = parseStatements('return "on: " + str(doubled)', 'function describe');

    expect(identifiers.map((i) => i.name)).to.deep.equal(['str', 'doubled']);
  });

  it('finds every identifier across multiple statements, including a repeated assignment target', () => {
    const { identifiers } = parseStatements('total = score\nreturn total + 1', 'function tally');

    expect(identifiers.map((i) => i.name)).to.deep.equal(['total', 'score', 'total']);
  });

  it('throws expression/parse-error on malformed input', () => {
    expect(() => parseStatements('return (', 'function describe'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/parse-error' });
  });
});
