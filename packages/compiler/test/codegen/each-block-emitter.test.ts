import { expect } from 'chai';
import { analyzeEachBlocks, buildItemEmitContext, emitCreateItemSub, emitEachBlockSubs, emitEachReconcileSub, emitUpdateItemSub } from '../../src/codegen/each-block-emitter.js';
import { analyzeTemplateBlocks } from '../../src/analysis/conditional-blocks.js';
import { buildScriptBindings } from '../../src/analysis/scope-resolution.js';
import { TemplateAttribute, TemplateEachBlock, TemplateElement, TemplateNode } from '../../src/dsl-parser/dsl-ast.js';
import { parseScriptFixture } from '../helpers/parseScriptFixture.js';

const COMPONENT_NAME = 'TestComponent';

function element(tagName: string, id: string | null, children: TemplateNode[] = [], attributes: TemplateAttribute[] = []): TemplateElement {
  return { kind: 'element', tagName, id, attributes, children };
}

function eachBlock(collectionExpression: string, itemAlias: string, keyExpression: string, children: TemplateNode[] = []): TemplateEachBlock {
  return { kind: 'each', collectionExpression, itemAlias, keyExpression, children };
}

function ifBlock(mode: 'toggle' | 'destroy', expression: string, children: TemplateNode[] = []): TemplateNode {
  return { kind: 'if', mode, expression, children };
}

/** Convenience: for a root with exactly one top-level {#each}, the `ItemEmitContext` its own item-body emitters need. */
function ctxFor(root: TemplateElement, bindings = buildScriptBindings(parseScriptFixture('state schedule: object = invalid'))) {
  const { conditional, each } = analyzeTemplateBlocks(root);
  return { each, ctx: buildItemEmitContext(conditional, each, bindings, COMPONENT_NAME) };
}

describe('analyzeEachBlocks', () => {
  it('assigns block ids in document order', () => {
    const root = element('Rectangle', 'root', [eachBlock('a', 'x', 'x.id'), eachBlock('b', 'y', 'y.id')]);
    const analysis = analyzeEachBlocks(root);
    expect(analysis.blocks.map((b) => b.id)).to.deep.equal(['ft_each_1', 'ft_each_2']);
  });

  it("captures the collection/alias/key split and builds a scope where the item alias resolves as a local", () => {
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id')]);
    const analysis = analyzeEachBlocks(root);
    const block = analysis.blocks[0];
    expect(block.collectionExpression).to.equal('schedule');
    expect(block.itemAlias).to.equal('day');
    expect(block.keyExpression).to.equal('day.id');
    expect(block.scope.hasLocal('day')).to.be.true;
    expect(block.scope.hasLocal('somethingElse')).to.be.false;
  });

  it('populates blockIdByNode with the same id as the corresponding blocks entry', () => {
    const node = eachBlock('a', 'x', 'x.id');
    const root = element('Rectangle', 'root', [node]);
    const analysis = analyzeEachBlocks(root);
    expect(analysis.blockIdByNode.get(node)).to.equal(analysis.blocks[0].id);
  });

  it('supports (does not throw for) an {#each} block nested inside another {#each} block — loop-in-loop', () => {
    const root = element('Rectangle', 'root', [eachBlock('outer', 'o', 'o.id', [eachBlock('o.items', 'inner', 'inner.id')])]);
    expect(() => analyzeEachBlocks(root)).to.not.throw();
  });

  it('assigns the nested each a globally-unique id, distinct from its enclosing each\'s own id', () => {
    const root = element('Rectangle', 'root', [eachBlock('outer', 'o', 'o.id', [eachBlock('o.items', 'inner', 'inner.id')])]);
    const analysis = analyzeEachBlocks(root);
    const ids = analysis.blocks.map((b) => b.id);
    expect(new Set(ids).size).to.equal(ids.length);
  });

  it('supports (does not throw for) an {#if}/{#if:destroy} block nested inside an {#each} block — the "forward" nesting direction', () => {
    const root = element('Rectangle', 'root', [eachBlock('items', 'item', 'item.id', [ifBlock('toggle', 'item.visible')])]);
    expect(() => analyzeEachBlocks(root)).to.not.throw();
  });

  it('records the nearest each ancestor for the nested each block itself', () => {
    const root = element('Rectangle', 'root', [eachBlock('outer', 'o', 'o.id', [eachBlock('o.items', 'inner', 'inner.id')])]);
    const analysis = analyzeEachBlocks(root);
    // A nested block's own entry is pushed before its enclosing block's (its nestedEachIds must be
    // known before the enclosing block can be pushed) — same post-order convention already used
    // for destroy-mode ConditionalBlocks, so lookup is always by a distinguishing field, never
    // positional destructuring.
    const outerBlock = analysis.blocks.find((b) => b.collectionExpression === 'outer')!;
    const innerBlock = analysis.blocks.find((b) => b.collectionExpression === 'o.items')!;
    expect(analysis.nearestEachAncestorById.get(innerBlock.id)).to.equal(outerBlock.id);
  });

  it('records every each id nested anywhere in the block\'s own body, including transitively — a further-nested each too', () => {
    const root = element('Rectangle', 'root', [eachBlock('outer', 'o', 'o.id', [eachBlock('o.mid', 'm', 'm.id', [eachBlock('m.inner', 'i', 'i.id')])])]);
    const analysis = analyzeEachBlocks(root);
    const outerBlock = analysis.blocks.find((b) => b.collectionExpression === 'outer')!;
    const midBlock = analysis.blocks.find((b) => b.collectionExpression === 'o.mid')!;
    const innerBlock = analysis.blocks.find((b) => b.collectionExpression === 'm.inner')!;
    expect(outerBlock.nestedEachIds).to.deep.equal([midBlock.id, innerBlock.id]);
    expect(midBlock.nestedEachIds).to.deep.equal([innerBlock.id]);
    expect(innerBlock.nestedEachIds).to.deep.equal([]);
  });

  it('does not throw for an ordinary {#if} sibling that does not nest against an {#each} at all', () => {
    const root = element('Rectangle', 'root', [ifBlock('toggle', 'visible', [element('Label', 'a')]), eachBlock('items', 'item', 'item.id')]);
    expect(() => analyzeEachBlocks(root)).to.not.throw();
  });

  it('supports (does not throw for) an {#each} block nested inside a {#if:destroy} block — the "reverse" nesting direction', () => {
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'hasLoaded', [eachBlock('items', 'item', 'item.id')])]);
    expect(() => analyzeEachBlocks(root)).to.not.throw();
  });

  it('records the nearest destroy ancestor for an {#each} block nested inside a {#if:destroy} block', () => {
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'hasLoaded', [eachBlock('items', 'item', 'item.id')])]);
    const analysis = analyzeEachBlocks(root);
    const [block] = analysis.blocks;
    // The {#if:destroy} block's own id is ft_if_1 (assigned by the same unified walk).
    expect(analysis.nearestDestroyAncestorById.get(block.id)).to.equal('ft_if_1');
  });

  it('does not record a nearest-destroy-ancestor entry for an {#each} nested only inside a toggle-mode {#if}', () => {
    const root = element('Rectangle', 'root', [ifBlock('toggle', 'visible', [eachBlock('items', 'item', 'item.id')])]);
    const analysis = analyzeEachBlocks(root);
    expect(analysis.nearestDestroyAncestorById.has(analysis.blocks[0].id)).to.be.false;
  });
});

describe('emitEachReconcileSub', () => {
  it('computes the new key list, removes stale keys before the position pass, then creates/updates and positions every surviving/new item', () => {
    const bindings = buildScriptBindings(parseScriptFixture('state schedule: object = invalid'));
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [element('Label', 'row', [], [{ kind: 'dynamic', name: 'text', expression: 'day.title' }])])]);
    const analysis = analyzeEachBlocks(root);
    const sub = emitEachReconcileSub(analysis.blocks[0], bindings, COMPONENT_NAME);

    expect(sub).to.include('sub TestComponent__reconcile_each_1()');
    expect(sub).to.include('ft_collection = m?.schedule');
    // node-typed collections (e.g. a bare SceneGraph node) iterate their children instead of
    // indexing directly — see the "iterates a node's children" test below for the full assertion.
    expect(sub).to.include('if type(ft_collection) = "roSGNode" then');
    expect(sub).to.include('day = ft_collection[ft_i]');
    expect(sub).to.include('ft_key = TestComponent__each_key_to_string(day?.id)');
    // remove-stale pass reads the _keys dict, before the position pass ever runs
    const removeStaleIndex = sub.indexOf('m["$$ft_each_1"].removeChild(');
    const positionPassIndex = sub.indexOf('m["$$ft_each_1"].insertChild(');
    expect(removeStaleIndex).to.be.greaterThan(-1);
    expect(positionPassIndex).to.be.greaterThan(removeStaleIndex);
    expect(sub).to.include('TestComponent__update_item_each_1(ft_key, day, ft_node)');
    expect(sub).to.include('ft_node = TestComponent__create_item_each_1(ft_key, day)');
    expect(sub).to.include('m["$$ft_each_1_keys"] = ft_newKeys');
    expect(sub).to.include('m["$$ft_each_1_nodes"] = ft_newNodes');
  });

  it('converts a node-typed collection to its children array before the diff runs, without touching an already-array collection', () => {
    const bindings = buildScriptBindings(parseScriptFixture('state schedule: object = invalid'));
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id')]);
    const analysis = analyzeEachBlocks(root);
    const sub = emitEachReconcileSub(analysis.blocks[0], bindings, COMPONENT_NAME);

    const collectIndex = sub.indexOf('ft_collection = m?.schedule');
    const typeCheckIndex = sub.indexOf('if type(ft_collection) = "roSGNode" then');
    const getChildrenIndex = sub.indexOf('ft_collection = ft_collection.getChildren(-1, 0)');
    expect(collectIndex).to.be.greaterThan(-1);
    expect(typeCheckIndex).to.be.greaterThan(collectIndex);
    expect(getChildrenIndex).to.be.greaterThan(typeCheckIndex);
  });

  it('deletes a removed key\'s entry from every transitively-nested each\'s own m-scope dict, not just this block\'s own _nodes', () => {
    const bindings = buildScriptBindings(parseScriptFixture('state schedule: object = invalid'));
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [eachBlock('day.events', 'event', 'event.id')])]);
    const { each } = analyzeTemplateBlocks(root);
    const outerBlock = each.blocks.find((b) => b.collectionExpression === 'schedule')!;
    const innerBlock = each.blocks.find((b) => b.collectionExpression === 'day.events')!;
    const sub = emitEachReconcileSub(outerBlock, bindings, COMPONENT_NAME);

    expect(sub).to.include(`m["$$${innerBlock.id}_keys"].Delete(ft_oldKey)`);
    expect(sub).to.include(`m["$$${innerBlock.id}_nodes"].Delete(ft_oldKey)`);
  });
});

describe('emitCreateItemSub', () => {
  it('builds a new item subtree and returns its root node, using the real item alias as the BrightScript local name', () => {
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [element('Label', 'row', [], [{ kind: 'dynamic', name: 'text', expression: 'day.title' }])])]);
    const { each, ctx } = ctxFor(root);
    const sub = emitCreateItemSub(each.blocks[0], ctx);

    expect(sub).to.include('function TestComponent__create_item_each_1(ft_key as string, day as object) as object');
    expect(sub).to.include('ft_n1.text = day?.title');
    expect(sub).to.include('return ft_item');
  });

  it('never caches an item-body element at a fixed m.<id> slot, even when it has an author-given id — its .id is the literal suffixed with the item key instead', () => {
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [element('Label', 'row')])]);
    const { each, ctx } = ctxFor(root);
    const sub = emitCreateItemSub(each.blocks[0], ctx);

    expect(sub).to.not.include('m.row');
    expect(sub).to.include('ft_n1.id = "row_" + ft_key');
  });

  it('never caches a per-item node reference in any field — every dynamically-created node gets a unique, key-suffixed id instead of a stored AddFields ref', () => {
    // Two earlier designs (a compound value nested inside a node field, then a flat per-node
    // AddFields ref field) were both tried and rejected — see the class doc comment. Neither
    // AddFields nor a nested "state" field appears anywhere in generated construction code now.
    const plainRoot = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [element('Label', 'row')])]);
    const { each: plainEach, ctx: plainCtx } = ctxFor(plainRoot);
    const plainSub = emitCreateItemSub(plainEach.blocks[0], plainCtx);
    expect(plainSub).to.not.include('ft_state');
    expect(plainSub).to.not.include('AddFields');
    expect(plainSub).to.include('ft_n1.id = "row_" + ft_key');

    const nestedRoot = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [ifBlock('destroy', 'day.isToday', [element('Label', 'badge')])])]);
    const { each: nestedEach, ctx: nestedCtx } = ctxFor(nestedRoot);
    const sub = emitCreateItemSub(nestedEach.blocks[0], nestedCtx);
    expect(sub).to.not.include('ft_state');
    expect(sub).to.not.include('AddFields');
    expect(sub).to.include('if day?.isToday then');
    expect(sub).to.include('.id = "ft_if_1_" + ft_key');
  });

  it('always threads a leading ft_key parameter, whether or not the item body itself needs one — unique ids need it unconditionally', () => {
    const plainRoot = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [ifBlock('destroy', 'day.isToday', [element('Label', 'badge')])])]);
    const { each: plainEach, ctx: plainCtx } = ctxFor(plainRoot);
    expect(emitCreateItemSub(plainEach.blocks[0], plainCtx)).to.include('function TestComponent__create_item_each_1(ft_key as string, day as object) as object');

    const nestedEachRoot = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [eachBlock('day.events', 'event', 'event.id')])]);
    const { each: nestedEachEach, ctx: nestedEachCtx } = ctxFor(nestedEachRoot);
    const outerBlock = nestedEachEach.blocks.find((b) => b.collectionExpression === 'schedule')!;
    expect(emitCreateItemSub(outerBlock, nestedEachCtx)).to.include('function TestComponent__create_item_each_1(ft_key as string, day as object) as object');
  });

  it('batches 2+ plain attribute assignments on a freshly-created node into a single setFields() call', () => {
    const root = element('Rectangle', 'root', [
      eachBlock('schedule', 'day', 'day.id', [
        element(
          'Label',
          'row',
          [],
          [
            { kind: 'static', name: 'font', value: 'bold' },
            { kind: 'dynamic', name: 'text', expression: 'day.title' },
            { kind: 'dynamic', name: 'color', expression: 'day.color' },
          ],
        ),
      ]),
    ]);
    const { each, ctx } = ctxFor(root);
    const sub = emitCreateItemSub(each.blocks[0], ctx);

    expect(sub).to.include('ft_n1.setFields({font: "bold", text: day?.title, color: day?.color})');
    expect(sub).to.not.match(/ft_n1\.text = /);
  });

  it('keeps a dynamic focusable attribute out of the batched setFields() call', () => {
    const root = element('Rectangle', 'root', [
      eachBlock('schedule', 'day', 'day.id', [
        element(
          'Label',
          'row',
          [],
          [
            { kind: 'dynamic', name: 'text', expression: 'day.title' },
            { kind: 'dynamic', name: 'color', expression: 'day.color' },
            { kind: 'dynamic', name: 'focusable', expression: 'day.canFocus' },
          ],
        ),
      ]),
    ]);
    const { each, ctx } = ctxFor(root);
    const sub = emitCreateItemSub(each.blocks[0], ctx);

    expect(sub).to.include('ft_n1.setFields({text: day?.title, color: day?.color})');
    expect(sub).to.include('ft_focusable_ft_n1 = day?.canFocus');
    expect(sub).to.include('ft_n1.focusable = ft_focusable_ft_n1');
    expect(sub).to.not.include('focusable: day.canFocus');
  });
});

describe('emitUpdateItemSub', () => {
  it('re-locates a bound element via findNode against its own unique, key-suffixed id', () => {
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [element('Label', 'row', [], [{ kind: 'dynamic', name: 'text', expression: 'day.title' }])])]);
    const { each, ctx } = ctxFor(root);
    const sub = emitUpdateItemSub(each.blocks[0], ctx);

    expect(sub).to.include('sub TestComponent__update_item_each_1(ft_key as string, day as object, ft_item as object)');
    expect(sub).to.match(/ft_u\d+ = ft_item\.findNode\("row_" \+ ft_key\)/);
    expect(sub).to.match(/ft_u\d+\.text = day\?\.title/);
  });

  it('groups multiple dynamic attributes on the same element under a single findNode read', () => {
    const root = element('Rectangle', 'root', [
      eachBlock('schedule', 'day', 'day.id', [
        element(
          'Label',
          'row',
          [],
          [
            { kind: 'dynamic', name: 'text', expression: 'day.title' },
            { kind: 'dynamic', name: 'color', expression: 'day.color' },
          ],
        ),
      ]),
    ]);
    const { each, ctx } = ctxFor(root);
    const sub = emitUpdateItemSub(each.blocks[0], ctx);

    expect(sub.match(/findNode\("row_" \+ ft_key\)/g)).to.have.lengthOf(1);
    expect(sub).to.match(/ft_u\d+\.setFields\(\{text: day\?\.title, color: day\?\.color\}\)/);
  });

  it('emits an empty body (just sub/end sub) when the item body has no dynamic attributes at all', () => {
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [element('Label', 'row', [], [{ kind: 'static', name: 'text', value: 'fixed' }])])]);
    const { each, ctx } = ctxFor(root);
    const sub = emitUpdateItemSub(each.blocks[0], ctx);

    expect(sub).to.equal('sub TestComponent__update_item_each_1(ft_key as string, day as object, ft_item as object)\nend sub');
  });

  it('re-runs a nested toggle-mode {#if}\'s visible binding on every update', () => {
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [ifBlock('toggle', 'day.flag')])]);
    const { each, ctx } = ctxFor(root);
    const sub = emitUpdateItemSub(each.blocks[0], ctx);

    expect(sub).to.include('.visible = day?.flag');
  });

  it('re-runs a nested destroy-mode {#if:destroy} idempotently — findNode-based mount check (no field ever cached), create only false→true, destroy only true→false', () => {
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [ifBlock('destroy', 'day.isToday', [element('Label', 'badge')])])]);
    const { each, ctx } = ctxFor(root);
    const sub = emitUpdateItemSub(each.blocks[0], ctx);

    expect(sub).to.match(/ft_u\d+ = ft_item\.findNode\("ft_if_1_" \+ ft_key\)/);
    expect(sub).to.include('if day?.isToday and ft_u1 = invalid then');
    expect(sub).to.include('else if not (day?.isToday) and ft_u1 <> invalid then');
    expect(sub).to.include('else if day?.isToday then');
    // Nothing is ever cached — no compound nested-field state, no per-node AddFields ref field, no
    // hasField guard. The mount check re-resolves via findNode every update pass instead, so there
    // is no stale-reference class of bug to worry about here (see the class doc comment).
    expect(sub).to.not.include('ft_state');
    expect(sub).to.not.include('AddFields');
    expect(sub).to.not.include('hasField');
    expect(sub).to.include('ft_item.removeChild(ft_u1)');
  });
});

describe('emitEachBlockSubs', () => {
  it('emits the shared key normalizer exactly once, before every top-level block\'s own subs', () => {
    const bindings = buildScriptBindings(parseScriptFixture('state schedule: object = invalid'));
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'day', 'day.id', [element('Label', 'row', [], [{ kind: 'dynamic', name: 'text', expression: 'day.title' }])])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    const sections = emitEachBlockSubs(each, conditional, bindings, COMPONENT_NAME);

    const normalizerCount = sections.filter((s) => s.includes('function TestComponent__each_key_to_string(key as dynamic) as string')).length;
    expect(normalizerCount).to.equal(1);
    expect(sections[0]).to.include('TestComponent__each_key_to_string');
    expect(sections.some((s) => s.includes('sub TestComponent__reconcile_each_1()'))).to.be.true;
    expect(sections.some((s) => s.includes('function TestComponent__create_item_each_1('))).to.be.true;
    expect(sections.some((s) => s.includes('sub TestComponent__update_item_each_1('))).to.be.true;
  });

  it('excludes a nested each block from getting its own subs — its logic is inlined into its enclosing each\'s own create/update instead', () => {
    const bindings = buildScriptBindings(parseScriptFixture('state schedule: object = invalid'));
    const root = element('Rectangle', 'root', [eachBlock('schedule', 'o', 'o.id', [eachBlock('o.items', 'inner', 'inner.id')])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    const sections = emitEachBlockSubs(each, conditional, bindings, COMPONENT_NAME);
    const innerId = each.blocks.find((b) => b.collectionExpression === 'o.items')!.id;

    expect(sections.some((s) => s.includes(`sub TestComponent__reconcile_${innerId.replace('ft_', '')}()`))).to.be.false;
    expect(sections.some((s) => s.includes(`function TestComponent__create_item_${innerId.replace('ft_', '')}(`))).to.be.false;
  });

  it('emits nothing at all when there are no {#each} blocks', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field a: integer = 0'));
    const emptyEach = { blocks: [], blockIdByNode: new Map(), nearestDestroyAncestorById: new Map(), nearestEachAncestorById: new Map() };
    const emptyConditional = { blocks: [], blockIdByNode: new Map(), syntheticParentIds: new Map(), nearestDestroyAncestorById: new Map(), nearestEachAncestorById: new Map() };
    expect(emitEachBlockSubs(emptyEach, emptyConditional, bindings, COMPONENT_NAME)).to.deep.equal([]);
  });
});
