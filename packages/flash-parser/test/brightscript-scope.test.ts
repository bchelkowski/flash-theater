import { expect } from 'chai';
import { parseBrightScript } from '../src/brightscript-parser.js';
import { buildScopes, resolve, Scope } from '../src/brightscript-scope.js';

function scopeFor(source: string): Scope {
  const { root, diagnostics } = parseBrightScript(source);
  expect(diagnostics, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`).to.deep.equal([]);
  return buildScopes(root);
}

describe('brightscript-scope — function scopes and parameters', () => {
  it('creates a child scope per function/sub, with parameters declared in it', () => {
    const file = scopeFor('function add(a as integer, b as integer) as integer\n  return a + b\nend function');
    expect(file.children).to.have.length(1);
    const fnScope = file.children[0];
    expect(fnScope.ownerName).to.equal('add');
    expect(resolve('a', fnScope)?.kind).to.equal('parameter');
    expect(resolve('b', fnScope)?.kind).to.equal('parameter');
  });

  it('registers the function itself as a declaration in the parent (file) scope', () => {
    const file = scopeFor('function add(a as integer) as integer\n  return a\nend function');
    expect(resolve('add', file)?.kind).to.equal('function');
  });
});

describe('brightscript-scope — variable declarations', () => {
  it('a plain assignment declares a local variable in the enclosing scope', () => {
    const file = scopeFor('sub s()\n  total = 0\n  print total\nend sub');
    const fnScope = file.children[0];
    expect(resolve('total', fnScope)?.kind).to.equal('variable');
  });

  it('for/for-each/catch/dim all declare locals of their own distinct kind', () => {
    const file = scopeFor(
      'sub s()\n  for i = 0 to 10\n  end for\n  for each x in y\n  end for\n  try\n  catch e\n  end try\n  dim arr[3]\nend sub',
    );
    const fnScope = file.children[0];
    expect(resolve('i', fnScope)?.kind).to.equal('for-variable');
    expect(resolve('x', fnScope)?.kind).to.equal('for-variable');
    expect(resolve('e', fnScope)?.kind).to.equal('catch-variable');
    expect(resolve('arr', fnScope)?.kind).to.equal('dim-variable');
  });
});

describe('brightscript-scope — resolution is case-insensitive and shadows up the chain', () => {
  it('resolves a differently-cased reference to the same declaration', () => {
    const file = scopeFor('sub s()\n  total = 0\n  print TOTAL\nend sub');
    const fnScope = file.children[0];
    expect(resolve('Total', fnScope)?.name).to.equal('total');
  });

  it('a nested function-expression parameter shadows an outer variable of the same name', () => {
    const file = scopeFor('sub s()\n  x = 1\n  cb = function(x as integer) as integer\n    return x\n  end function\nend sub');
    const fnScope = file.children[0];
    const nestedFnExprScope = fnScope.children[0];
    expect(resolve('x', fnScope)?.kind).to.equal('variable');
    expect(resolve('x', nestedFnExprScope)?.kind).to.equal('parameter');
  });

  it('resolve() walks up to the file scope when not found locally', () => {
    const file = scopeFor('function outer() as integer\n  return 1\nend function\nsub s()\n  x = outer()\nend sub');
    const sScope = file.children.find((c) => c.ownerName === 's')!;
    expect(resolve('outer', sScope)?.kind).to.equal('function');
  });

  it('"m" is always valid and never a real declaration', () => {
    const file = scopeFor('sub s()\n  m.x = 1\nend sub');
    const fnScope = file.children[0];
    expect(resolve('m', fnScope)).to.be.undefined;
  });
});

describe('brightscript-scope — reference tracking (isWrite)', () => {
  it('a plain "=" assignment target is recorded as a pure write, not a read', () => {
    const file = scopeFor('sub s()\n  x = 1\nend sub');
    const fnScope = file.children[0];
    const xRefs = fnScope.references.filter((r) => r.nameLower === 'x');
    expect(xRefs).to.have.length(1);
    expect(xRefs[0].isWrite).to.equal(true);
  });

  it('a compound assignment target is recorded as NOT a pure write (it also reads)', () => {
    const file = scopeFor('sub s()\n  x = 1\n  x += 1\nend sub');
    const fnScope = file.children[0];
    const xRefs = fnScope.references.filter((r) => r.nameLower === 'x');
    // First "x = 1" is a pure write; "x += 1"'s target reference is not.
    expect(xRefs.some((r) => r.isWrite)).to.equal(true);
    expect(xRefs.some((r) => !r.isWrite)).to.equal(true);
  });

  it('an ordinary read (not an assignment target) is recorded as isWrite: false', () => {
    const file = scopeFor('sub s()\n  x = 1\n  print x\nend sub');
    const fnScope = file.children[0];
    const reads = fnScope.references.filter((r) => r.nameLower === 'x' && !r.isWrite);
    expect(reads).to.have.length(1);
  });

  it('a name read only inside a nested function expression is recorded in the CHILD scope, not the parent', () => {
    const file = scopeFor('sub s()\n  x = 1\n  cb = function() as integer\n    return x\n  end function\nend sub');
    const fnScope = file.children[0];
    const nestedScope = fnScope.children[0];
    expect(fnScope.references.some((r) => r.nameLower === 'x' && !r.isWrite)).to.equal(false);
    expect(nestedScope.references.some((r) => r.nameLower === 'x' && !r.isWrite)).to.equal(true);
  });
});

describe('brightscript-scope — #if/#elseif conditions are skipped, bodies are analyzed', () => {
  it('does not register the manifest-constant condition name as a reference', () => {
    const file = scopeFor('sub s()\n#if DEBUG\n  x = 1\n#end if\nend sub');
    const fnScope = file.children[0];
    expect(fnScope.references.some((r) => r.nameLower === 'debug')).to.equal(false);
    expect(resolve('x', fnScope)?.kind).to.equal('variable');
  });
});
