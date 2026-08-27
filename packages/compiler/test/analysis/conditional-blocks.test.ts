import { expect } from 'chai';
import { analyzeConditionalBlocks, analyzeTemplateBlocks, collectStaticallyPresentIds } from '../../src/analysis/conditional-blocks.js';
import { EMPTY_EACH_BLOCKS } from '../../src/codegen/each-block-emitter.js';
import { TemplateAttribute, TemplateElement, TemplateNode } from '../../src/dsl-parser/dsl-ast.js';

function element(tagName: string, id: string | null, children: TemplateNode[] = [], attributes: TemplateAttribute[] = []): TemplateElement {
  return { kind: 'element', tagName, id, attributes, children };
}

function ifBlock(mode: 'toggle' | 'destroy', expression: string, children: TemplateNode[] = []): TemplateNode {
  return { kind: 'if', mode, expression, children };
}

function eachBlock(collectionExpression: string, itemAlias: string, keyExpression: string, children: TemplateNode[] = []): TemplateNode {
  return { kind: 'each', collectionExpression, itemAlias, keyExpression, children };
}

describe('analyzeConditionalBlocks', () => {
  it('assigns block ids in document order, shared across toggle and destroy modes', () => {
    const root = element('Rectangle', 'root', [ifBlock('toggle', 'a'), ifBlock('destroy', 'b'), ifBlock('toggle', 'c')]);
    const analysis = analyzeConditionalBlocks(root);
    expect(analysis.blocks.map((b) => b.id)).to.deep.equal(['ft_if_1', 'ft_if_2', 'ft_if_3']);
    expect(analysis.blocks.map((b) => b.mode)).to.deep.equal(['toggle', 'destroy', 'toggle']);
  });

  it('a top-level destroy-mode block\'s container is the template\'s own root element, not m.top — root is a real container like any other', () => {
    // Confirmed on a real device: treating root as containerId=null (m.top) undercounts the
    // sibling-insertion-index (root itself, already m.top's sole static child, was never counted
    // as a preceding sibling), landing the block BEFORE root in paint order — root's own
    // background then covers it entirely. See findings/template-conditional-blocks.md.
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'cond')]);
    const analysis = analyzeConditionalBlocks(root);
    expect(analysis.blocks[0].containerId).to.equal('root');
    expect(analysis.syntheticParentIds.size).to.equal(0);
  });

  it('synthesizes a parent id for the root element itself when it has a direct destroy-mode child and no author-given id', () => {
    const root = element('Rectangle', null, [ifBlock('destroy', 'cond')]);
    const analysis = analyzeConditionalBlocks(root);
    expect(analysis.syntheticParentIds.get(root)).to.equal('ft_parent_1');
    expect(analysis.blocks[0].containerId).to.equal('ft_parent_1');
  });

  it('synthesizes a parent id for a real element with no author-given id that is a destroy block\'s direct parent', () => {
    const inner = element('Rectangle', null, [ifBlock('destroy', 'cond')]);
    const root = element('Group', 'root', [inner]);
    const analysis = analyzeConditionalBlocks(root);
    expect(analysis.syntheticParentIds.get(inner)).to.equal('ft_parent_1');
    expect(analysis.blocks[0].containerId).to.equal('ft_parent_1');
  });

  it('reuses an element\'s own author-given id as the container, without synthesizing one', () => {
    const inner = element('Rectangle', 'myBox', [ifBlock('destroy', 'cond')]);
    const root = element('Group', 'root', [inner]);
    const analysis = analyzeConditionalBlocks(root);
    expect(analysis.syntheticParentIds.size).to.equal(0);
    expect(analysis.blocks[0].containerId).to.equal('myBox');
  });

  it('computes preceding siblings: always-present elements count unconditionally, destroy-mode siblings need a runtime guard', () => {
    const root = element('Rectangle', 'root', [
      element('Label', 'a'),
      ifBlock('destroy', 'condX'),
      element('Label', 'b'),
      ifBlock('destroy', 'condY'),
    ]);
    const analysis = analyzeConditionalBlocks(root);
    const [blockX, blockY] = analysis.blocks;
    expect(blockX.precedingSiblings).to.deep.equal([{ kind: 'always-present' }]);
    expect(blockY.precedingSiblings).to.deep.equal([{ kind: 'always-present' }, { kind: 'destroy', id: blockX.id }, { kind: 'always-present' }]);
  });

  it('collects every id in a destroy-mode block\'s subtree, including a nested block\'s own id, for teardown', () => {
    const root = element('Rectangle', 'root', [
      ifBlock('destroy', 'outer', [element('Label', 'x'), ifBlock('toggle', 'inner', [element('Label', 'y')])]),
    ]);
    const analysis = analyzeConditionalBlocks(root);
    const outerBlock = analysis.blocks.find((b) => b.expression === 'outer')!;
    const innerBlock = analysis.blocks.find((b) => b.expression === 'inner')!;
    expect(outerBlock.nestedIds).to.deep.equal(['x', innerBlock.id, 'y']);
  });

  it('records the nearest enclosing destroy ancestor for an ordinary element nested inside a destroy-mode block', () => {
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'outer', [element('Label', 'inner')])]);
    const analysis = analyzeConditionalBlocks(root);
    const outerId = analysis.blocks[0].id;
    expect(analysis.nearestDestroyAncestorById.get('inner')).to.equal(outerId);
  });

  it('records the nearest (innermost), not outermost, destroy ancestor for a doubly-nested destroy block', () => {
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'outer', [ifBlock('destroy', 'inner', [element('Label', 'deep')])])]);
    const analysis = analyzeConditionalBlocks(root);
    const outerBlock = analysis.blocks.find((b) => b.expression === 'outer')!;
    const innerBlock = analysis.blocks.find((b) => b.expression === 'inner')!;
    expect(analysis.nearestDestroyAncestorById.get(innerBlock.id)).to.equal(outerBlock.id);
    expect(analysis.nearestDestroyAncestorById.get('deep')).to.equal(innerBlock.id);
  });

  it('does not record a nearest-destroy-ancestor entry for anything nested only inside toggle-mode blocks', () => {
    const root = element('Rectangle', 'root', [ifBlock('toggle', 'cond', [element('Label', 'inner')])]);
    const analysis = analyzeConditionalBlocks(root);
    expect(analysis.nearestDestroyAncestorById.has('inner')).to.equal(false);
  });

  it('leaves a toggle-mode block\'s own id and preceding-sibling/nestedIds data unused (destroy-mode-only concepts)', () => {
    const root = element('Rectangle', 'root', [ifBlock('toggle', 'cond', [element('Label', 'inner')])]);
    const analysis = analyzeConditionalBlocks(root);
    expect(analysis.blocks[0].precedingSiblings).to.deep.equal([]);
    expect(analysis.blocks[0].nestedIds).to.deep.equal([]);
  });
});

describe('collectStaticallyPresentIds', () => {
  it('includes ordinary ids and toggle-mode block ids, in document order', () => {
    const root = element('Rectangle', 'root', [element('Label', 'a'), ifBlock('toggle', 'cond', [element('Label', 'b')]), element('Label', 'c')]);
    const analysis = analyzeConditionalBlocks(root);
    expect(collectStaticallyPresentIds(root, analysis, EMPTY_EACH_BLOCKS)).to.deep.equal(['root', 'a', 'ft_if_1', 'b', 'c']);
  });

  it('excludes a destroy-mode block\'s own id and everything in its subtree', () => {
    const root = element('Rectangle', 'root', [element('Label', 'a'), ifBlock('destroy', 'cond', [element('Label', 'hidden')]), element('Label', 'c')]);
    const analysis = analyzeConditionalBlocks(root);
    expect(collectStaticallyPresentIds(root, analysis, EMPTY_EACH_BLOCKS)).to.deep.equal(['root', 'a', 'c']);
  });

  it('includes a synthesized parent id for a real element with no author-given id', () => {
    const inner = element('Rectangle', null, [ifBlock('destroy', 'cond')]);
    const root = element('Group', 'root', [inner]);
    const analysis = analyzeConditionalBlocks(root);
    expect(collectStaticallyPresentIds(root, analysis, EMPTY_EACH_BLOCKS)).to.deep.equal(['root', 'ft_parent_1']);
  });

  it('includes a top-level {#each} block\'s own wrapper id, never recursing into its body', () => {
    const root = element('Rectangle', 'root', [element('Label', 'a'), eachBlock('items', 'item', 'item.id', [element('Label', 'row')])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    expect(collectStaticallyPresentIds(root, conditional, each)).to.deep.equal(['root', 'a', 'ft_each_1']);
  });

  it('excludes an {#each} block nested inside a {#if:destroy} block — its wrapper does not exist statically', () => {
    const root = element('Rectangle', 'root', [element('Label', 'a'), ifBlock('destroy', 'cond', [eachBlock('items', 'item', 'item.id')])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    expect(collectStaticallyPresentIds(root, conditional, each)).to.deep.equal(['root', 'a']);
  });
});

describe('analyzeTemplateBlocks — {#each} nested inside {#if}/{#if:destroy} ("reverse" nesting)', () => {
  it('assigns the each block an id from its own independent counter, sharing document-order traversal with if-block ids', () => {
    const root = element('Rectangle', 'root', [ifBlock('toggle', 'a'), eachBlock('items', 'item', 'item.id'), ifBlock('destroy', 'b')]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    expect(conditional.blocks.map((b) => b.id)).to.deep.equal(['ft_if_1', 'ft_if_2']);
    expect(each.blocks.map((b) => b.id)).to.deep.equal(['ft_each_1']);
  });

  it('records the nearest destroy ancestor for an each block nested inside a {#if:destroy} block, and propagates through unchanged for a doubly-nested destroy block', () => {
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'outer', [ifBlock('destroy', 'inner', [eachBlock('items', 'item', 'item.id')])])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    const innerBlock = conditional.blocks.find((b) => b.expression === 'inner')!;
    expect(each.nearestDestroyAncestorById.get(each.blocks[0].id)).to.equal(innerBlock.id);
  });

  it('an each nested only inside a toggle-mode {#if} has no nearest-destroy-ancestor entry — it is statically present', () => {
    const root = element('Rectangle', 'root', [ifBlock('toggle', 'cond', [eachBlock('items', 'item', 'item.id')])]);
    const { each } = analyzeTemplateBlocks(root);
    expect(each.nearestDestroyAncestorById.has(each.blocks[0].id)).to.be.false;
  });

  it('adds a destroy-mode block\'s nested each id to nestedEachIds, not nestedIds', () => {
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'cond', [element('Label', 'a'), eachBlock('items', 'item', 'item.id')])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    expect(conditional.blocks[0].nestedIds).to.deep.equal(['a']);
    expect(conditional.blocks[0].nestedEachIds).to.deep.equal([each.blocks[0].id]);
  });

  it('does not recurse into a nested each\'s own body when collecting a destroy-mode block\'s nestedIds', () => {
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'cond', [eachBlock('items', 'item', 'item.id', [element('Label', 'row')])])]);
    const { conditional } = analyzeTemplateBlocks(root);
    // "row" lives inside the each's own per-item body — never a flat m.<id> slot, so it must
    // never appear in the destroy-mode block's own nestedIds teardown list.
    expect(conditional.blocks[0].nestedIds).to.deep.equal([]);
  });

  it('supports (does not throw for) an {#each} nested inside a toggle-mode {#if} nested inside a {#if:destroy} block', () => {
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'outer', [ifBlock('toggle', 'inner', [eachBlock('items', 'item', 'item.id')])])]);
    expect(() => analyzeTemplateBlocks(root)).to.not.throw();
  });

  it('supports (does not throw for) the forward direction too — {#if} nested inside {#each} nested inside a {#if:destroy} block', () => {
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'outer', [eachBlock('items', 'item', 'item.id', [ifBlock('toggle', 'item.flag')])])]);
    expect(() => analyzeTemplateBlocks(root)).to.not.throw();
  });

  it('records the nearest each ancestor for a block nested inside an {#each}\'s own body', () => {
    const root = element('Rectangle', 'root', [eachBlock('items', 'item', 'item.id', [ifBlock('toggle', 'item.flag')])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    expect(conditional.nearestEachAncestorById.get(conditional.blocks[0].id)).to.equal(each.blocks[0].id);
  });
});
