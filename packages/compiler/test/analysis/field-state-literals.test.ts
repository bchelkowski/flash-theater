import { expect } from 'chai';
import { checkFieldStateDefaultLiterals } from '../../src/analysis/field-state-literals.js';
import { parseScriptFixture } from '../helpers/parseScriptFixture.js';

function check(scriptBody: string): void {
  checkFieldStateDefaultLiterals(parseScriptFixture(scriptBody));
}

function throwsCode(scriptBody: string, code: string): void {
  expect(() => check(scriptBody)).to.throw().with.property('diagnostic').that.deep.include({ code });
}

describe('checkFieldStateDefaultLiterals — field', () => {
  it('accepts a matching literal for every closed field type', () => {
    expect(() =>
      check(
        [
          'field a: string = "x"',
          'field b: integer = 5',
          'field c: float = 1.5',
          'field d: boolean = true',
          'field e: node = invalid',
          'field f: array = [1, 2, 3]',
          'field g: assocarray = { a: 1, b: "two" }',
        ].join('\n'),
      ),
    ).to.not.throw();
  });

  it('accepts a nested array/assocarray literal', () => {
    expect(() => check('field a: assocarray = { nested: [1, 2], flag: true, inner: { x: 1 } }')).to.not.throw();
  });

  it('throws dsl/field-default-type-mismatch when a string field gets a numeric literal', () => {
    throwsCode('field x: string = 5', 'dsl/field-default-type-mismatch');
  });

  it('throws dsl/field-default-type-mismatch when a node field default is not exactly invalid', () => {
    throwsCode('field x: node = "bogus"', 'dsl/field-default-type-mismatch');
  });

  it('throws dsl/field-default-type-mismatch when an array field gets an assocarray literal', () => {
    throwsCode('field x: array = { a: 1 }', 'dsl/field-default-type-mismatch');
  });

  it('throws dsl/field-default-type-mismatch when an assocarray field gets an array literal', () => {
    throwsCode('field x: assocarray = [1, 2]', 'dsl/field-default-type-mismatch');
  });

  it('throws dsl/field-default-type-mismatch when an array field gets a scalar literal', () => {
    throwsCode('field x: array = 5', 'dsl/field-default-type-mismatch');
  });

  it('throws dsl/field-default-not-literal for a non-literal expression inside an array default', () => {
    throwsCode('field x: array = [SomeFunc()]', 'dsl/field-default-not-literal');
  });

  it('throws dsl/field-default-not-literal for a non-literal expression inside an assocarray default', () => {
    throwsCode('field x: assocarray = { a: someVar }', 'dsl/field-default-not-literal');
  });
});

describe('checkFieldStateDefaultLiterals — state', () => {
  it('does not validate state\'s declared type against its literal — state stays unrestricted', () => {
    expect(() => check('state x: node = 5')).to.not.throw();
    expect(() => check('state x: banana = "whatever"')).to.not.throw();
  });

  it('accepts an array/assocarray literal default regardless of the (decorative) declared type', () => {
    expect(() => check('state x: object = [1, 2, 3]')).to.not.throw();
    expect(() => check('state x: object = { a: 1, b: [1, 2] }')).to.not.throw();
  });

  it('throws dsl/state-default-not-literal for a non-literal expression inside an array default', () => {
    throwsCode('state x: object = [SomeFunc()]', 'dsl/state-default-not-literal');
  });

  it('throws dsl/state-default-not-literal for a non-literal expression inside an assocarray default', () => {
    throwsCode('state x: object = { a: someVar }', 'dsl/state-default-not-literal');
  });
});
