import { expect } from 'chai';
import { elideUnusedLocalAssignments } from '../../src/analysis/unused-locals.js';
import { FunctionScope, ScriptBindings } from '../../src/analysis/scope-resolution.js';

function scopeWhereUnused(...names: string[]): FunctionScope {
  const unused = new Set(names);
  return { hasLocal: (name) => unused.has(name), isUnused: (name) => unused.has(name) };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** No declared field/derived/state/etc. names — every target is treated as a genuine local. */
const NO_DSL_BINDINGS: ScriptBindings = {
  fieldNames: EMPTY_SET,
  derivedNames: EMPTY_SET,
  stateNames: EMPTY_SET,
  readNames: EMPTY_SET,
  watchNames: EMPTY_SET,
  streamNames: EMPTY_SET,
  animationNames: EMPTY_SET,
  privateFunctionNames: EMPTY_SET,
  publicFunctionNames: EMPTY_SET,
  importedClassNames: EMPTY_SET,
  reactiveSourceNames: EMPTY_SET,
  animationFieldRefreshByName: new Map(),
  resolveDsl: () => null,
};

function bindingsWithField(name: string): ScriptBindings {
  return { ...NO_DSL_BINDINGS, fieldNames: new Set([name]), resolveDsl: (n) => (n === name ? { kind: 'field', replacement: `m.top.${n}` } : null) };
}

describe('elideUnusedLocalAssignments', () => {
  it('elides a dead simple assignment to a never-read local', () => {
    const result = elideUnusedLocalAssignments('total = 0', scopeWhereUnused('total'), NO_DSL_BINDINGS);
    expect(result).to.equal('');
  });

  it('leaves an assignment to a local that IS read untouched', () => {
    const result = elideUnusedLocalAssignments('total = 0', { hasLocal: () => true, isUnused: () => false }, NO_DSL_BINDINGS);
    expect(result).to.equal('total = 0');
  });

  it('leaves a compound assignment untouched even when the target is unused — not exactly one plain "x = expr" shape', () => {
    const result = elideUnusedLocalAssignments('total += 1', scopeWhereUnused('total'), NO_DSL_BINDINGS);
    expect(result).to.equal('total += 1');
  });

  it('keeps a dead assignment whose RHS contains a call expression — the RHS might have a side effect', () => {
    const result = elideUnusedLocalAssignments('total = SomeFunc()', scopeWhereUnused('total'), NO_DSL_BINDINGS);
    expect(result).to.equal('total = SomeFunc()');
  });

  it('leaves a dotted/indexed assignment target untouched — not a bare identifier', () => {
    const result = elideUnusedLocalAssignments('m.total = 0', scopeWhereUnused('total'), NO_DSL_BINDINGS);
    expect(result).to.equal('m.total = 0');
  });

  it('elides multiple independent dead lines, each on its own — the elided lines are removed, not blanked', () => {
    const result = elideUnusedLocalAssignments(['total = 0', 'count = 1'].join('\n'), scopeWhereUnused('total', 'count'), NO_DSL_BINDINGS);
    expect(result).to.equal('');
  });

  it('elides only the dead line, leaving a live one in place, preserving relative order', () => {
    const result = elideUnusedLocalAssignments(['total = 0', 'print "hi"'].join('\n'), scopeWhereUnused('total'), NO_DSL_BINDINGS);
    expect(result).to.equal('print "hi"');
  });

  it('leaves a blank line untouched (not elidable, not an assignment at all)', () => {
    const result = elideUnusedLocalAssignments('', scopeWhereUnused('total'), NO_DSL_BINDINGS);
    expect(result).to.equal('');
  });

  it('never elides a bare assignment whose target resolves to a declared field, even when the scope reconstruction sees it as an unused local', () => {
    // A field write always has an externally-visible effect (a real SceneGraph field, observable by
    // any parent's ObserveFieldScoped/bind:) even when nothing in the SAME function reads it back —
    // scope analysis has no way to tell this apart from a genuine dead local, so resolveDsl must be
    // checked first. Confirmed live as a real bug: this exact shape silently vanished from generated
    // .brs before this check existed.
    const result = elideUnusedLocalAssignments('focusRequest = "x"', scopeWhereUnused('focusRequest'), bindingsWithField('focusRequest'));
    expect(result).to.equal('focusRequest = "x"');
  });
});
