import { expect } from 'chai';
import { checkAndGroupKeyBindings, collectKeyBindingAttributes, rewriteKeyHandlerCall } from '../../src/analysis/key-bindings.js';
import { analyzeTemplateBlocks } from '../../src/analysis/conditional-blocks.js';
import { buildScriptBindings, extendTemplateScope, NO_FUNCTION_SCOPE } from '../../src/analysis/scope-resolution.js';
import { GlobalBindingsContext } from '../../src/analysis/global-bindings.js';
import { CompileError, TemplateAttribute, TemplateEachBlock, TemplateElement, TemplateNode } from '../../src/dsl-parser/dsl-ast.js';
import { parseScriptFixture } from '../helpers/parseScriptFixture.js';

const NO_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };

function element(tagName: string, id: string | null, children: TemplateNode[] = [], attributes: TemplateAttribute[] = []): TemplateElement {
  return { kind: 'element', tagName, id, attributes, children };
}

function onKey(keys: string[], expression: string): TemplateAttribute {
  return { kind: 'onKey', keys, expression };
}

function eachBlock(collectionExpression: string, itemAlias: string, keyExpression: string, children: TemplateNode[] = []): TemplateEachBlock {
  return { kind: 'each', collectionExpression, itemAlias, keyExpression, children };
}

describe('collectKeyBindingAttributes', () => {
  it('collects a single onKey attribute on the root element', () => {
    const root = element('Rectangle', 'card', [], [onKey(['OK'], 'selectItem()')]);
    const raw = collectKeyBindingAttributes(root);
    expect(raw).to.deep.equal([{ elementId: 'card', keys: ['OK'], expression: 'selectItem()' }]);
  });

  it('recurses into an {#each} block body, unlike bind-targets', () => {
    const root = element('Rectangle', 'root', [eachBlock('items', 'item', 'item.id', [element('Rectangle', 'row', [], [onKey(['OK'], 'selectItem(item)')])])]);
    const raw = collectKeyBindingAttributes(root);
    expect(raw).to.deep.equal([{ elementId: 'row', keys: ['OK'], expression: 'selectItem(item)' }]);
  });

  it('collects multiple onKey attributes on the same element, in document order', () => {
    const root = element('Rectangle', 'card', [], [onKey(['OK'], 'selectItem()'), onKey(['*'], 'fallback()')]);
    const raw = collectKeyBindingAttributes(root);
    expect(raw).to.deep.equal([
      { elementId: 'card', keys: ['OK'], expression: 'selectItem()' },
      { elementId: 'card', keys: ['*'], expression: 'fallback()' },
    ]);
  });
});

describe('checkAndGroupKeyBindings — valid usage', () => {
  it('groups specific keys and a wildcard onto one element', () => {
    const root = element('Rectangle', 'card', [], [onKey(['OK', 'play'], 'selectItem()'), onKey(['*'], 'fallback()')]);
    const { each } = analyzeTemplateBlocks(root);
    const [grouped] = checkAndGroupKeyBindings(collectKeyBindingAttributes(root), each);
    expect(grouped.elementId).to.equal('card');
    expect([...grouped.specific.entries()]).to.deep.equal([
      ['OK', 'selectItem()'],
      ['play', 'selectItem()'],
    ]);
    expect(grouped.wildcard).to.equal('fallback()');
    expect(grouped.insideEach).to.be.false;
    expect(grouped.nearestEachAncestorId).to.be.null;
  });

  it('marks an element inside an {#each} body with insideEach and its nearest each-block id', () => {
    const root = element('Rectangle', 'root', [eachBlock('items', 'item', 'item.id', [element('Rectangle', 'row', [], [onKey(['OK'], 'selectItem(item)')])])]);
    const { each } = analyzeTemplateBlocks(root);
    const [grouped] = checkAndGroupKeyBindings(collectKeyBindingAttributes(root), each);
    expect(grouped.insideEach).to.be.true;
    expect(grouped.nearestEachAncestorId).to.equal('ft_each_1');
  });
});

describe('checkAndGroupKeyBindings — template/on-key-duplicate-key', () => {
  it('throws when two onKey attributes on the same element claim the same literal key', () => {
    const root = element('Rectangle', 'card', [], [onKey(['OK'], 'a()'), onKey(['OK', 'up'], 'b()')]);
    const { each } = analyzeTemplateBlocks(root);
    expect(() => checkAndGroupKeyBindings(collectKeyBindingAttributes(root), each))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/on-key-duplicate-key' });
  });
});

describe('checkAndGroupKeyBindings — template/on-key-multiple-wildcards', () => {
  it('throws when two onKey attributes on the same element are both wildcards', () => {
    const root = element('Rectangle', 'card', [], [onKey(['*'], 'a()'), onKey(['*'], 'b()')]);
    const { each } = analyzeTemplateBlocks(root);
    expect(() => checkAndGroupKeyBindings(collectKeyBindingAttributes(root), each))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/on-key-multiple-wildcards' });
  });
});

describe('checkAndGroupKeyBindings — template/on-key-inside-nested-each', () => {
  it('throws when an on:key element lives inside an {#each} that is itself nested inside another {#each}', () => {
    const root = element('Rectangle', 'root', [
      eachBlock('outer', 'group', 'group.id', [eachBlock('group.items', 'item', 'item.id', [element('Rectangle', 'row', [], [onKey(['OK'], 'selectItem()')])])]),
    ]);
    const { each } = analyzeTemplateBlocks(root);
    expect(() => checkAndGroupKeyBindings(collectKeyBindingAttributes(root), each))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/on-key-inside-nested-each' });
  });

  it('does not throw for on:key inside a single, top-level {#each}', () => {
    const root = element('Rectangle', 'root', [eachBlock('items', 'item', 'item.id', [element('Rectangle', 'row', [], [onKey(['OK'], 'selectItem()')])])]);
    const { each } = analyzeTemplateBlocks(root);
    expect(() => checkAndGroupKeyBindings(collectKeyBindingAttributes(root), each)).to.not.throw();
  });
});

describe('checkAndGroupKeyBindings — template/on-key-expression-not-call', () => {
  it('throws when the expression is a bare identifier, not a call', () => {
    const root = element('Rectangle', 'card', [], [onKey(['OK'], 'selectItem')]);
    const { each } = analyzeTemplateBlocks(root);
    expect(() => checkAndGroupKeyBindings(collectKeyBindingAttributes(root), each))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/on-key-expression-not-call' });
  });

  it('throws when the expression is a call plus more, e.g. a() + 1', () => {
    const root = element('Rectangle', 'card', [], [onKey(['OK'], 'selectItem() + 1')]);
    const { each } = analyzeTemplateBlocks(root);
    expect(() => checkAndGroupKeyBindings(collectKeyBindingAttributes(root), each))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/on-key-expression-not-call' });
  });
});

describe('rewriteKeyHandlerCall', () => {
  it('prepends key, press before the author-written args and renames a private callee', () => {
    const bindings = buildScriptBindings(parseScriptFixture('private function selectItem(key: string, press: boolean, item: object) {}'));
    const result = rewriteKeyHandlerCall('selectItem(item)', bindings, 'test', extendTemplateScope('item', NO_FUNCTION_SCOPE), NO_GLOBAL_BINDINGS);
    expect(result).to.equal('private_selectItem(key, press, item)');
  });

  it('leaves a public callee name unchanged', () => {
    const bindings = buildScriptBindings(parseScriptFixture('public function selectItem(key: string, press: boolean, item: object) {}'));
    const result = rewriteKeyHandlerCall('selectItem(item)', bindings, 'test', extendTemplateScope('item', NO_FUNCTION_SCOPE), NO_GLOBAL_BINDINGS);
    expect(result).to.equal('selectItem(key, press, item)');
  });

  it('handles a zero-argument call, still prepending key, press', () => {
    const bindings = buildScriptBindings(parseScriptFixture('private function closeModal(key: string, press: boolean) {}'));
    const result = rewriteKeyHandlerCall('closeModal()', bindings, 'test', NO_FUNCTION_SCOPE, NO_GLOBAL_BINDINGS);
    expect(result).to.equal('private_closeModal(key, press)');
  });

  it('throws template/on-key-expression-not-call when the expression is not a call', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field selectItem: string = ""'));
    expect(() => rewriteKeyHandlerCall('selectItem', bindings, 'test', NO_FUNCTION_SCOPE, NO_GLOBAL_BINDINGS))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/on-key-expression-not-call' });
  });
});
