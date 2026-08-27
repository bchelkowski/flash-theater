import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { parse, ThrFile } from 'flash-parser';
import { buildDependencyGraph } from '../../src/analysis/dependency-graph.js';
import { buildScriptBindings } from '../../src/analysis/scope-resolution.js';
import { buildThemeShape, GlobalBindingsContext } from '../../src/analysis/global-bindings.js';
import { adaptScriptSection, adaptThemeTemplateSection } from '../../src/dsl-parser/dsl-parser.js';
import { CompileError } from '../../src/dsl-parser/dsl-ast.js';
import { parseScriptFixture } from '../helpers/parseScriptFixture.js';

const SCHEDULE_DATE_MENU_ITEM_THR = fileURLToPath(
  new URL(
    '../../../../apps/sample-app/src/components/ScheduleDateMenuItem/ScheduleDateMenuItem.thr',
    import.meta.url,
  ),
);

describe('buildDependencyGraph — ScheduleDateMenuItem.thr (real fixture)', () => {
  const source = readFileSync(SCHEDULE_DATE_MENU_ITEM_THR, 'utf8');
  const result = parse(source);
  const script = adaptScriptSection(new ThrFile(result.root).script);
  const graph = buildDependencyGraph(script, buildScriptBindings(script));

  it('places isGridFocused before the derived that depend on it in the topological order', () => {
    const index = (name: string) => graph.order.indexOf(name);

    expect(index('isGridFocused')).to.be.lessThan(index('highlightOpacity'));
    expect(index('isGridFocused')).to.be.lessThan(index('textColor'));
  });

  it('resolves the transitive chain focusPercent -> isGridFocused -> highlightOpacity/textColor', () => {
    expect(graph.dependentsOfSource.get('focusPercent')).to.deep.equal(['isGridFocused', 'highlightOpacity', 'textColor']);
  });

  it('resolves direct-only dependents for gridHasFocus (highlightColor only)', () => {
    expect(graph.dependentsOfSource.get('gridHasFocus')).to.deep.equal(['highlightColor']);
  });

  it('resolves all three itemContent-derived values, none of which depend on each other', () => {
    expect(graph.dependentsOfSource.get('itemContent')).to.deep.equal(['contentOpacity', 'titleText', 'dayNameText']);
  });

  it('reports no dependents for fields never referenced by a derived expression', () => {
    expect(graph.dependentsOfSource.get('width')).to.deep.equal([]);
    expect(graph.dependentsOfSource.get('height')).to.deep.equal([]);
  });

  it('does not include function names (e.g. pickColor) as graph nodes', () => {
    expect(graph.directDependencies.get('highlightColor')).to.deep.equal(['gridHasFocus']);
  });
});

describe('buildDependencyGraph — cycle detection', () => {
  it('throws dependency/cycle with the offending chain for a direct two-node cycle', () => {
    const script = parseScriptFixture(['derived a: integer = b', 'derived b: integer = a'].join('\n'));

    expect(() => buildDependencyGraph(script, buildScriptBindings(script)))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dependency/cycle' });
  });

  it('throws dependency/cycle for a self-referencing derived', () => {
    const script = parseScriptFixture('derived a: integer = a');

    expect(() => buildDependencyGraph(script, buildScriptBindings(script)))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dependency/cycle' });
  });

  it('does not throw for an acyclic diamond dependency', () => {
    const script = parseScriptFixture(
      ['field base: integer = 0', 'derived a: integer = base', 'derived b: integer = base', 'derived c: integer = a + b'].join('\n'),
    );

    const graph = buildDependencyGraph(script, buildScriptBindings(script));

    expect(graph.order.indexOf('a')).to.be.lessThan(graph.order.indexOf('c'));
    expect(graph.order.indexOf('b')).to.be.lessThan(graph.order.indexOf('c'));
    expect(graph.dependentsOfSource.get('base')).to.deep.equal(['a', 'b', 'c']);
  });
});

describe('buildDependencyGraph — global store/theme composite sources', () => {
  function themeCtx(): GlobalBindingsContext {
    const result = parse('<theme-template>\ncolors: {\n  primary: string = "#fff"\n}\n</theme-template>');
    return { theme: buildThemeShape(adaptThemeTemplateSection(new ThrFile(result.root).themeTemplate), []) };
  }

  it('a watch registers "store.<topLevelKey>" as its one direct dependency, known structurally (not scanned from expression text)', () => {
    const script = parseScriptFixture('watch count = store(count)');
    const graph = buildDependencyGraph(script, buildScriptBindings(script));

    expect(graph.directDependencies.get('count')).to.deep.equal(['store.count']);
    expect(graph.dependentsOfSource.get('store.count')).to.deep.equal(['count']);
  });

  it('a derived can depend on a watch name, exactly like it can on another derived', () => {
    const script = parseScriptFixture(['watch count = store(count)', 'derived doubled: integer = count * 2'].join('\n'));
    const graph = buildDependencyGraph(script, buildScriptBindings(script));

    expect(graph.order.indexOf('count')).to.be.lessThan(graph.order.indexOf('doubled'));
    expect(graph.directDependencies.get('doubled')).to.deep.equal(['count']);
    expect(graph.dependentsOfSource.get('store.count')).to.deep.equal(['count', 'doubled']);
  });

  it('a derived depending on a nested theme leaf registers the TOP-LEVEL GROUP as the composite source, not the leaf path', () => {
    const script = parseScriptFixture('derived primaryColor: string = theme.colors.primary');
    const graph = buildDependencyGraph(script, buildScriptBindings(script), themeCtx());

    expect(graph.directDependencies.get('primaryColor')).to.deep.equal(['theme.colors']);
    expect(graph.dependentsOfSource.get('theme.colors')).to.deep.equal(['primaryColor']);
  });

  it('does not register any theme composite source when globalBindings is omitted (defaults to backward-compatible behavior)', () => {
    const script = parseScriptFixture('field width: integer = 0\nderived doubled: integer = width * 2');
    const graph = buildDependencyGraph(script, buildScriptBindings(script));

    expect(graph.dependentsOfSource.has('theme.colors')).to.be.false;
    expect(graph.dependentsOfSource.get('width')).to.deep.equal(['doubled']);
  });
});

describe('buildDependencyGraph — stream non-participation (deliberate scope boundary)', () => {
  it('a derived reading a stream\'s .value produces no dependency edge for that stream', () => {
    const script = parseScriptFixture(['stream dataLoaded: string', 'derived label: string = dataLoaded.value'].join('\n'));
    const graph = buildDependencyGraph(script, buildScriptBindings(script));

    expect(graph.directDependencies.get('label')).to.deep.equal([]);
    expect(graph.dependentsOfSource.has('dataLoaded')).to.be.false;
  });

  it('throws expression/stream-call-in-reactive-expression for .emit(...) inside a derived expression', () => {
    const script = parseScriptFixture(['stream dataLoaded: string', 'derived label: string = dataLoaded.emit("x")'].join('\n'));

    expect(() => buildDependencyGraph(script, buildScriptBindings(script)))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.has.property('code', 'expression/stream-call-in-reactive-expression');
  });

  it('throws expression/stream-call-in-reactive-expression for .subscribe(...) inside a derived expression', () => {
    const script = parseScriptFixture(['stream dataLoaded: string', 'derived label: string = dataLoaded.subscribe(cb)'].join('\n'));

    expect(() => buildDependencyGraph(script, buildScriptBindings(script)))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.has.property('code', 'expression/stream-call-in-reactive-expression');
  });
});
