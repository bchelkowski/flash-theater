import { expect } from 'chai';
import {
  parseEmbeddedExpression,
  parseEmbeddedStatements,
  parseEmbeddedCallArgs,
  splitEmbeddedCallArgs,
  findTopLevelIdentifiers,
  findGlobalPathAccesses,
  findMemberAccesses,
  findGlobalFunctionCalls,
  findChainAccesses,
  translateBrightScriptDiagnostics,
} from '../../src/embedded.js';

/** Applies `?` insertions from `findChainAccesses` to `text`, for readable assertions against the resulting optional-chained string. */
function withOptionalChains(text: string, accesses: { operatorStart: number }[]): string {
  let out = text;
  for (const a of [...accesses].sort((x, y) => y.operatorStart - x.operatorStart)) {
    out = out.slice(0, a.operatorStart) + '?' + out.slice(a.operatorStart);
  }
  return out;
}

describe('parseEmbeddedExpression', () => {
  it('produces zero diagnostics for a valid expression', () => {
    const parsed = parseEmbeddedExpression('focusPercent > 0.5');
    expect(parsed.result.diagnostics).to.have.lengthOf(0);
  });

  it('memoizes by exact text — repeat calls return the same parse result', () => {
    const first = parseEmbeddedExpression('pickColor(a, b)');
    const second = parseEmbeddedExpression('pickColor(a, b)');
    expect(second.result).to.equal(first.result);
  });

  it('produces a diagnostic for malformed input, translated to outer-source coordinates', () => {
    const parsed = parseEmbeddedExpression('focusPercent >');
    expect(parsed.result.diagnostics.length).to.be.greaterThan(0);

    const outerOffset = 100;
    const translated = translateBrightScriptDiagnostics(parsed, outerOffset);
    expect(translated.length).to.be.greaterThan(0);
    expect(translated[0].pos).to.be.at.least(outerOffset);
  });
});

describe('findTopLevelIdentifiers', () => {
  it('finds a single top-level identifier with the exact offsets in the original text', () => {
    const text = 'focusPercent > 0.5';
    const parsed = parseEmbeddedExpression(text);
    expect(findTopLevelIdentifiers(parsed, text)).to.deep.equal([{ name: 'focusPercent', start: 0, end: 12 }]);
  });

  it('finds the callee identifier of a call expression plus its identifier arguments', () => {
    const text = 'pickColor(gridHasFocus, "0x0057FFFF", "0x3A3A3AFF")';
    const parsed = parseEmbeddedExpression(text);
    expect(findTopLevelIdentifiers(parsed, text).map((i) => i.name)).to.deep.equal(['pickColor', 'gridHasFocus']);
  });

  it('only extracts the object side of a dot expression, not the member name', () => {
    const text = 'content.title';
    const parsed = parseEmbeddedExpression(text);
    expect(findTopLevelIdentifiers(parsed, text).map((i) => i.name)).to.deep.equal(['content']);
  });

  it('reports the exact identifier text via the returned offsets', () => {
    const text = 'itemContentAvailable(itemContent)';
    const parsed = parseEmbeddedExpression(text);
    for (const id of findTopLevelIdentifiers(parsed, text)) {
      expect(text.slice(id.start, id.end)).to.equal(id.name);
    }
  });
});

describe('findGlobalPathAccesses', () => {
  const ROOTS = ['store', 'theme'];

  it('finds a single-segment plain read', () => {
    const text = 'store.count';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findGlobalPathAccesses(parsed, ROOTS, text);
    expect(accesses).to.deep.equal([
      { root: 'store', segments: ['count'], rootStart: 0, rootEnd: 5, chainEnd: 11, isCallTarget: false, callArgsText: null, callArgSpans: [] },
    ]);
    expect(text.slice(accesses[0].rootStart, accesses[0].chainEnd)).to.equal('store.count');
  });

  it('finds a multi-segment nested read', () => {
    const text = 'theme.colors.primary';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findGlobalPathAccesses(parsed, ROOTS, text);
    expect(accesses).to.have.lengthOf(1);
    expect(accesses[0].root).to.equal('theme');
    expect(accesses[0].segments).to.deep.equal(['colors', 'primary']);
    expect(text.slice(accesses[0].rootStart, accesses[0].chainEnd)).to.equal('theme.colors.primary');
  });

  it('finds a call target with unrestricted argument count, capturing the args text verbatim', () => {
    const text = 'store.setRange(min, max)';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findGlobalPathAccesses(parsed, ROOTS, text);
    expect(accesses).to.have.lengthOf(1);
    expect(accesses[0]).to.include({ root: 'store', isCallTarget: true, callArgsText: 'min, max' });
    expect(accesses[0].segments).to.deep.equal(['setRange']);
    expect(text.slice(accesses[0].rootStart, accesses[0].chainEnd)).to.equal('store.setRange(min, max)');
  });

  it('reports one callArgSpans entry per argument, each spanning exactly that argument\'s own text', () => {
    const text = 'store.setRange(store.count, 10)';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findGlobalPathAccesses(parsed, ROOTS, text);
    const outer = accesses.find((a) => a.segments.join('.') === 'setRange')!;
    expect(outer.callArgSpans).to.have.lengthOf(2);
    expect(text.slice(outer.callArgSpans[0].start, outer.callArgSpans[0].end)).to.equal('store.count');
    expect(text.slice(outer.callArgSpans[1].start, outer.callArgSpans[1].end)).to.equal('10');
  });

  it('a call with zero arguments reports an empty callArgSpans and a null callArgsText', () => {
    const text = 'store.reset()';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findGlobalPathAccesses(parsed, ROOTS, text);
    expect(accesses).to.have.lengthOf(1);
    expect(accesses[0].callArgsText).to.equal(null);
    expect(accesses[0].callArgSpans).to.deep.equal([]);
  });

  it('finds both the outer call and a nested global access in its own argument', () => {
    const text = 'store.describeFavorites(store.favoriteCount)';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findGlobalPathAccesses(parsed, ROOTS, text);
    expect(accesses.map((a) => [a.root, ...a.segments].join('.')).sort()).to.deep.equal(['store.describeFavorites', 'store.favoriteCount']);
  });

  it('ignores a chain not rooted in one of rootNames', () => {
    const text = 'content.title';
    const parsed = parseEmbeddedExpression(text);
    expect(findGlobalPathAccesses(parsed, ROOTS, text)).to.deep.equal([]);
  });

  it('finds a global access nested inside an unrelated call\'s arguments', () => {
    const text = 'pickColor(store.isDark, theme.colors.primary)';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findGlobalPathAccesses(parsed, ROOTS, text);
    expect(accesses.map((a) => [a.root, ...a.segments].join('.'))).to.deep.equal(['store.isDark', 'theme.colors.primary']);
  });

  it('bails on a chain broken by an index — does not surface a truncated prefix', () => {
    const text = 'store.list[0].x';
    const parsed = parseEmbeddedExpression(text);
    expect(findGlobalPathAccesses(parsed, ROOTS, text)).to.deep.equal([]);
  });

  it('bails on a chain broken by a nested call — does not surface a truncated prefix', () => {
    const text = 'store.get().x';
    const parsed = parseEmbeddedExpression(text);
    expect(findGlobalPathAccesses(parsed, ROOTS, text)).to.deep.equal([]);
  });

  it('still finds an independent access inside an index subscript, even when the base chain bails', () => {
    const text = 'store.list[theme.startIndex]';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findGlobalPathAccesses(parsed, ROOTS, text);
    expect(accesses.map((a) => [a.root, ...a.segments].join('.'))).to.deep.equal(['theme.startIndex']);
  });
});

describe('findGlobalFunctionCalls', () => {
  const NAMES = ['setTimeout', 'setInterval'];

  it('finds a single bare call matching one of the given names, with exact offsets', () => {
    const text = 'setTimeout(onFire, 1000)';
    const parsed = parseEmbeddedExpression(text);
    const matches = findGlobalFunctionCalls(parsed, NAMES, text);
    expect(matches).to.have.lengthOf(1);
    expect(matches[0].name).to.equal('setTimeout');
    expect(text.slice(matches[0].start, matches[0].end)).to.equal(text);
  });

  it('reports each argument span so the raw argument text round-trips', () => {
    const text = 'setInterval(onPoll, baseDelayMs + 250)';
    const parsed = parseEmbeddedExpression(text);
    const matches = findGlobalFunctionCalls(parsed, NAMES, text);
    expect(matches[0].argSpans.map((s) => text.slice(s.start, s.end))).to.deep.equal(['onPoll', 'baseDelayMs + 250']);
  });

  it('ignores a dot-qualified call of the same name — obj.setTimeout() is a different shape entirely', () => {
    const text = 'obj.setTimeout(onFire, 1000)';
    const parsed = parseEmbeddedExpression(text);
    expect(findGlobalFunctionCalls(parsed, NAMES, text)).to.deep.equal([]);
  });

  it('ignores an unrelated bare call not in the given name list', () => {
    const text = 'doSomething(1, 2)';
    const parsed = parseEmbeddedExpression(text);
    expect(findGlobalFunctionCalls(parsed, NAMES, text)).to.deep.equal([]);
  });

  it('finds a zero-argument call with an empty argSpans list', () => {
    const text = 'clearTimeout()';
    const parsed = parseEmbeddedExpression(text);
    const matches = findGlobalFunctionCalls(parsed, ['clearTimeout'], text);
    expect(matches).to.have.lengthOf(1);
    expect(matches[0].argSpans).to.deep.equal([]);
  });

  it('finds more than one matching call in the same text', () => {
    const text = 'setTimeout(a, 1) : setTimeout(b, 2)';
    const parsed = parseEmbeddedStatements(text);
    const matches = findGlobalFunctionCalls(parsed, NAMES, text);
    expect(matches.map((m) => text.slice(m.start, m.end))).to.deep.equal(['setTimeout(a, 1)', 'setTimeout(b, 2)']);
  });
});

describe('findMemberAccesses', () => {
  it('finds a plain m.<name> read', () => {
    const text = 'm.a';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findMemberAccesses(parsed, 'm', text);
    expect(accesses).to.deep.equal([{ name: 'a', nameStart: 2, nameEnd: 3, rootStart: 0, rootEnd: 1 }]);
    expect(text.slice(accesses[0].nameStart, accesses[0].nameEnd)).to.equal('a');
    expect(text.slice(accesses[0].rootStart, accesses[0].rootEnd)).to.equal('m');
  });

  it('matches only the first hop of a nested chain — m.a.b finds "a", not "b"', () => {
    const text = 'm.a.b';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findMemberAccesses(parsed, 'm', text);
    expect(accesses.map((a) => a.name)).to.deep.equal(['a']);
  });

  it('finds a call target — m.foo(x)', () => {
    const text = 'm.foo(x)';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findMemberAccesses(parsed, 'm', text);
    expect(accesses.map((a) => a.name)).to.deep.equal(['foo']);
  });

  it('finds an assignment target — m.a = x', () => {
    const text = 'm.a = x';
    const parsed = parseEmbeddedStatements(text);
    const accesses = findMemberAccesses(parsed, 'm', text);
    expect(accesses.map((a) => a.name)).to.deep.equal(['a']);
  });

  it('finds a member access nested inside a call argument — foo(m.a)', () => {
    const text = 'foo(m.a)';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findMemberAccesses(parsed, 'm', text);
    expect(accesses.map((a) => a.name)).to.deep.equal(['a']);
  });

  it('ignores a chain not rooted in rootName', () => {
    const text = 'self.a';
    const parsed = parseEmbeddedExpression(text);
    expect(findMemberAccesses(parsed, 'm', text)).to.deep.equal([]);
  });

  it('finds every independent m.<name> access when there is more than one', () => {
    const text = 'm.a + m.b';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findMemberAccesses(parsed, 'm', text);
    expect(accesses.map((a) => a.name)).to.deep.equal(['a', 'b']);
  });

  it('rootName is configurable — finds self.<name> when asked for "self"', () => {
    const text = 'self.a';
    const parsed = parseEmbeddedExpression(text);
    const accesses = findMemberAccesses(parsed, 'self', text);
    expect(accesses.map((a) => a.name)).to.deep.equal(['a']);
  });
});

describe('parseEmbeddedCallArgs / splitEmbeddedCallArgs', () => {
  it('splits a two-argument call into its individual argument texts', () => {
    const text = 'a, b';
    const parsed = parseEmbeddedCallArgs(text);
    expect(parsed.result.diagnostics).to.deep.equal([]);
    expect(splitEmbeddedCallArgs(parsed, text)).to.deep.equal(['a', 'b']);
  });

  it('handles a single argument with no comma', () => {
    const text = 'm.count';
    const parsed = parseEmbeddedCallArgs(text);
    expect(splitEmbeddedCallArgs(parsed, text)).to.deep.equal(['m.count']);
  });

  it('handles zero arguments', () => {
    const text = '';
    const parsed = parseEmbeddedCallArgs(text);
    expect(splitEmbeddedCallArgs(parsed, text)).to.deep.equal([]);
  });

  it('handles an argument that is itself a call, without splitting on its internal comma', () => {
    const text = 'foo(1, 2), b';
    const parsed = parseEmbeddedCallArgs(text);
    expect(splitEmbeddedCallArgs(parsed, text)).to.deep.equal(['foo(1, 2)', 'b']);
  });

  it('is memoized by exact text', () => {
    expect(parseEmbeddedCallArgs('a, b')).to.equal(parseEmbeddedCallArgs('a, b'));
  });
});

describe('findChainAccesses', () => {
  it('marks a lone, non-chained member access', () => {
    const text = 'x.foo';
    const parsed = parseEmbeddedExpression(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('x?.foo');
  });

  it('marks every hop of a multi-hop chain, including the first', () => {
    const text = 'array[3].foo.bar("my argument")';
    const parsed = parseEmbeddedExpression(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('array?[3]?.foo?.bar?("my argument")');
  });

  it('marks a `[a,b]` multi-index access once, not once per index', () => {
    const text = 'a[1,2].b';
    const parsed = parseEmbeddedExpression(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('a?[1,2]?.b');
  });

  it('recurses into a call argument that is itself a chain', () => {
    const text = 'array[3].foo.bar(my.nested[2].method())';
    const parsed = parseEmbeddedExpression(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('array?[3]?.foo?.bar?(my?.nested?[2]?.method?())');
  });

  it('marks `@attr` access with `?@` semantics (found alongside `.` on BsDotExpression)', () => {
    const text = 'node@attr.foo';
    const parsed = parseEmbeddedExpression(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('node?@attr?.foo');
  });

  it('leaves an assignment target chain fully untouched, but chains its RHS', () => {
    const text = 'obj.a.b = c.d.e';
    const parsed = parseEmbeddedStatements(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('obj.a.b = c?.d?.e');
  });

  it('leaves a compound-assignment target untouched', () => {
    const text = 'x.a += 1';
    const parsed = parseEmbeddedStatements(text);
    expect(findChainAccesses(parsed, text)).to.deep.equal([]);
  });

  it('leaves an increment/decrement statement\'s operand untouched', () => {
    const text = 'obj.count++';
    const parsed = parseEmbeddedStatements(text);
    expect(findChainAccesses(parsed, text)).to.deep.equal([]);
  });

  it('leaves a bare void-context call statement fully untouched', () => {
    const text = 'obj.foo.bar()';
    const parsed = parseEmbeddedStatements(text);
    expect(findChainAccesses(parsed, text)).to.deep.equal([]);
  });

  it('still chains a void-context call statement\'s own arguments', () => {
    const text = 'obj.foo.bar(x.y.z())';
    const parsed = parseEmbeddedStatements(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('obj.foo.bar(x?.y?.z?())');
  });

  it('fully chains the identical call shape when used as an assignment RHS (a read context)', () => {
    const text = 'x = obj.foo.bar()';
    const parsed = parseEmbeddedStatements(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('x = obj?.foo?.bar?()');
  });

  it('leaves an index-assignment target\'s own `[` untouched, but still chains a read sub-expression inside it', () => {
    const text = 'arr[getIndex().value] = x';
    const parsed = parseEmbeddedStatements(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('arr[getIndex()?.value] = x');
  });

  it('leaves a call whose callee is a bare identifier untouched — Roku rejects `?(` on a global/built-in function name', () => {
    const text = 'someFunction(a, b)';
    const parsed = parseEmbeddedExpression(text);
    expect(findChainAccesses(parsed, text)).to.deep.equal([]);
  });

  it('still chains a bare call\'s own arguments, and still chains a later hop off its result', () => {
    const text = 'someFunction(obj.value).result';
    const parsed = parseEmbeddedExpression(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('someFunction(obj?.value)?.result');
  });

  it('chains a call once its callee is itself a chain (not a bare identifier)', () => {
    const text = 'obj.method()';
    const parsed = parseEmbeddedExpression(text);
    expect(withOptionalChains(text, findChainAccesses(parsed, text))).to.equal('obj?.method?()');
  });
});
