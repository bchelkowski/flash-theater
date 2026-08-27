import { expect } from 'chai';
import { analyzeTemplateBindings, collectElementIds } from '../../src/codegen/template-bindings.js';
import { buildDependencyGraph } from '../../src/analysis/dependency-graph.js';
import { buildScriptBindings } from '../../src/analysis/scope-resolution.js';
import { analyzeTemplateBlocks } from '../../src/analysis/conditional-blocks.js';
import { TemplateAttribute, TemplateElement, TemplateNode, CompileError } from '../../src/dsl-parser/dsl-ast.js';
import { parseScriptFixture } from '../helpers/parseScriptFixture.js';

function element(tagName: string, id: string | null, children: TemplateNode[] = [], attributes: TemplateAttribute[] = []): TemplateElement {
  return { kind: 'element', tagName, id, attributes, children };
}

function dynAttr(name: string, expression: string): TemplateAttribute {
  return { kind: 'dynamic', name, expression };
}

function ifBlock(mode: 'toggle' | 'destroy', expression: string, children: TemplateNode[] = []): TemplateNode {
  return { kind: 'if', mode, expression, children };
}

function eachBlock(collectionExpression: string, itemAlias: string, keyExpression: string, children: TemplateNode[] = []): TemplateNode {
  return { kind: 'each', collectionExpression, itemAlias, keyExpression, children };
}

describe('collectElementIds', () => {
  it('collects every element id in document order', () => {
    const root = element('Rectangle', 'root', [element('Label', 'a'), element('Label', 'b')]);
    expect(collectElementIds(root)).to.deep.equal(['root', 'a', 'b']);
  });

  it('skips an element with no id (and no synthetic parent id given for it)', () => {
    const root = element('Rectangle', 'root', [element('Label', null)]);
    expect(collectElementIds(root)).to.deep.equal(['root']);
  });

  it('recurses into a {#if}/{#if:destroy} block\'s own children — a destroy-mode subtree still needs id collision validation', () => {
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'cond', [element('Label', 'hidden')])]);
    expect(collectElementIds(root)).to.deep.equal(['root', 'hidden']);
  });

  it('does NOT recurse into an {#each} block\'s own item body — an item id is never a flat m.<id> slot', () => {
    const root = element('Rectangle', 'root', [eachBlock('items', 'item', 'item.id', [element('Label', 'row')])]);
    expect(collectElementIds(root)).to.deep.equal(['root']);
  });

  it('folds in a synthesized parent id via syntheticParentIds, as if it were author-given', () => {
    const inner = element('Rectangle', null);
    const root = element('Group', 'root', [inner]);
    const synthetic = new Map([[inner, 'ft_parent_1']]);
    expect(collectElementIds(root, synthetic)).to.deep.equal(['root', 'ft_parent_1']);
  });

  it('includes duplicate ids verbatim — callers that care about uniqueness check separately', () => {
    const root = element('Rectangle', 'root', [element('Label', 'dup'), element('Label', 'dup')]);
    expect(collectElementIds(root)).to.deep.equal(['root', 'dup', 'dup']);
  });
});

describe('analyzeTemplateBindings', () => {
  it('maps a dynamic attribute expression to the field it reads', () => {
    const script = parseScriptFixture('field count: integer = 0');
    const bindings = buildScriptBindings(script);
    const graph = buildDependencyGraph(script, bindings);
    const root = element('Label', 'label', [], [dynAttr('text', 'count')]);

    const result = analyzeTemplateBindings({ root }, bindings, graph);

    expect(result.all).to.deep.equal([{ elementId: 'label', attributeName: 'text', expression: 'count' }]);
    expect(result.affectedBySource.get('count')).to.deep.equal([{ elementId: 'label', attributeName: 'text', expression: 'count' }]);
    expect(result.sourcesNeedingCascade.has('count')).to.be.true;
  });

  it('does not create a cascade dependency for a plain (non-call) reference to a stream in a template binding', () => {
    const script = parseScriptFixture('stream dataLoaded: string');
    const bindings = buildScriptBindings(script);
    const graph = buildDependencyGraph(script, bindings);
    const root = element('Label', 'label', [], [dynAttr('text', 'dataLoaded.value')]);

    const result = analyzeTemplateBindings({ root }, bindings, graph);

    expect(result.sourcesNeedingCascade.has('dataLoaded')).to.be.false;
  });

  it('throws expression/stream-call-in-reactive-expression for .subscribe(...) inside a template binding', () => {
    const script = parseScriptFixture('stream dataLoaded: string');
    const bindings = buildScriptBindings(script);
    const graph = buildDependencyGraph(script, bindings);
    const root = element('Label', 'label', [], [dynAttr('text', 'dataLoaded.subscribe(cb)')]);

    expect(() => analyzeTemplateBindings({ root }, bindings, graph))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/stream-call-in-reactive-expression' });
  });

  it('resolves a binding that reads a derived through the dependency graph back to its underlying field', () => {
    const script = parseScriptFixture(['field count: integer = 0', 'derived doubled: integer = count * 2'].join('\n'));
    const bindings = buildScriptBindings(script);
    const graph = buildDependencyGraph(script, bindings);
    const root = element('Label', 'label', [], [dynAttr('text', 'doubled')]);

    const result = analyzeTemplateBindings({ root }, bindings, graph);

    expect(result.affectedBySource.get('count')).to.deep.equal([{ elementId: 'label', attributeName: 'text', expression: 'doubled' }]);
  });

  it('never collects a binding living inside an {#each} body into the whole-component bindings.all — each-block-emitter.ts owns per-item bindings entirely', () => {
    const script = parseScriptFixture('state items: object = invalid');
    const bindings = buildScriptBindings(script);
    const graph = buildDependencyGraph(script, bindings);
    const row = element('Label', 'row', [], [dynAttr('text', 'item.title')]);
    const root = element('Rectangle', 'root', [eachBlock('items', 'item', 'item.id', [row])]);

    const result = analyzeTemplateBindings({ root }, bindings, graph);

    expect(result.all).to.deep.equal([]);
  });

  it('folds a component-wide source referenced inside an {#each} item body into affectedByEachSourceBlocks, triggering the whole block\'s reconcile', () => {
    const script = parseScriptFixture(['state items: object = invalid', 'field prefix: string = ""'].join('\n'));
    const bindings = buildScriptBindings(script);
    const graph = buildDependencyGraph(script, bindings);
    const row = element('Label', 'row', [], [dynAttr('text', 'prefix + item.title')]);
    const root = element('Rectangle', 'root', [eachBlock('items', 'item', 'item.id', [row])]);
    const { conditional, each } = analyzeTemplateBlocks(root);

    const result = analyzeTemplateBindings({ root }, bindings, graph, undefined, conditional, each);

    expect(result.affectedByEachSourceBlocks.get('prefix')?.map((b) => b.id)).to.deep.equal([each.blocks[0].id]);
    expect(result.affectedByEachSourceBlocks.get('items')?.map((b) => b.id)).to.deep.equal([each.blocks[0].id]);
  });

  it('adds a synthetic visible binding for every toggle-mode {#if} block, but not a destroy-mode one', () => {
    const script = parseScriptFixture('field flag: boolean = true');
    const bindings = buildScriptBindings(script);
    const graph = buildDependencyGraph(script, bindings);
    const root = element('Rectangle', 'root', [ifBlock('toggle', 'flag')]);
    const { conditional, each } = analyzeTemplateBlocks(root);

    const result = analyzeTemplateBindings({ root }, bindings, graph, undefined, conditional, each);

    expect(result.all).to.deep.equal([{ elementId: conditional.blocks[0].id, attributeName: 'visible', expression: 'flag' }]);
  });
});
