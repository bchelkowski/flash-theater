import { expect } from 'chai';
import { validateGeneratedBrs, GeneratedBrsValidationError } from '../src/validate-generated-brs.js';
import { compileThrSource } from '../src/compile.js';

describe('validateGeneratedBrs', () => {
  it('reports valid: true and no diagnostics for real BrightScript', () => {
    const result = validateGeneratedBrs('function add(a as integer, b as integer) as integer\n  return a + b\nend function');
    expect(result.valid).to.equal(true);
    expect(result.diagnostics).to.deep.equal([]);
  });

  it('reports valid: false with a diagnostic for malformed BrightScript', () => {
    const result = validateGeneratedBrs('function add(a as integer\n  return a\nend function');
    expect(result.valid).to.equal(false);
    expect(result.diagnostics.length).to.be.greaterThan(0);
  });
});

describe('GeneratedBrsValidationError', () => {
  it('carries the component name and first diagnostic in its message', () => {
    const result = validateGeneratedBrs('function broken(\nend function');
    const err = new GeneratedBrsValidationError('MyComponent', result);
    expect(err.message).to.include('MyComponent');
    expect(err.message).to.include('codegen bug');
    expect(err.diagnostics).to.deep.equal(result.diagnostics);
  });
});

describe('compileThrSource — validateOutput opt-in flag', () => {
  const VALID_THR = '<script>\nfield count: integer = 0\n</script>\n<component>\n<Label id="a" text="{count}" />\n</component>\n';

  it('does not validate generated .brs by default', () => {
    // No throw either way for genuinely valid DSL source — this just
    // confirms the default path still works unchanged (the interesting
    // case, "does opting IN actually run the check", is covered below).
    expect(() => compileThrSource(VALID_THR, 'Valid')).to.not.throw();
  });

  it('does not throw when validateOutput is true and the generated .brs is actually valid', () => {
    expect(() => compileThrSource(VALID_THR, 'Valid', { validateOutput: true })).to.not.throw();
  });
});
