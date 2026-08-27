import { expect } from 'chai';
import { parse } from 'kopytko-brightscript-parser';
import { emitConditionalBlockSubs, emitConditionalDestroySub, emitConditionalBlockCascadeCheck } from '../../src/codegen/conditional-block-emitter.js';
import { analyzeTemplateBlocks } from '../../src/analysis/conditional-blocks.js';
import { emitEachBlockSubs } from '../../src/codegen/each-block-emitter.js';
import { buildScriptBindings } from '../../src/analysis/scope-resolution.js';
import { TemplateAttribute, TemplateElement, TemplateNode } from '../../src/dsl-parser/dsl-ast.js';
import { ResolvedBlockTransition } from '../../src/analysis/transitions.js';
import { ParsedAnimationConfig } from '../../src/analysis/animation-config.js';
import { GlobalBindingsContext } from '../../src/analysis/global-bindings.js';
import { parseScriptFixture } from '../helpers/parseScriptFixture.js';

const NO_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };

function element(tagName: string, id: string | null, children: TemplateNode[] = [], attributes: TemplateAttribute[] = []): TemplateElement {
  return { kind: 'element', tagName, id, attributes, children };
}

function ifBlock(mode: 'toggle' | 'destroy', expression: string, children: TemplateNode[] = []): TemplateNode {
  return { kind: 'if', mode, expression, children };
}

function eachBlock(collectionExpression: string, itemAlias: string, keyExpression: string, children: TemplateNode[] = []): TemplateNode {
  return { kind: 'each', collectionExpression, itemAlias, keyExpression, children };
}

const COMPONENT_NAME = 'TestComponent';

describe('emitConditionalCreateSub / emitConditionalDestroySub — {#each} nested inside {#if:destroy}', () => {
  it('constructs the nested each\'s wrapper, initializes its keys/nodes state, and reconciles it once, inside the create sub', () => {
    const bindings = buildScriptBindings(parseScriptFixture('state schedule: object = invalid'));
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'hasLoaded', [eachBlock('schedule', 'day', 'day.id', [element('Label', 'row')])])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    const [sub] = emitConditionalBlockSubs(conditional, each, bindings, COMPONENT_NAME);

    expect(sub).to.include(`m["$$${each.blocks[0].id}"] = CreateObject("roSGNode", "Group")`);
    expect(sub).to.include(`m["$$${each.blocks[0].id}_keys"] = []`);
    expect(sub).to.include(`m["$$${each.blocks[0].id}_nodes"] = {}`);
    expect(sub).to.include(`TestComponent__reconcile_${each.blocks[0].id.replace('ft_', '')}()`);
  });

  it('nulls the nested each\'s wrapper AND its keys/nodes state (three slots) on teardown', () => {
    const bindings = buildScriptBindings(parseScriptFixture('state schedule: object = invalid'));
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'hasLoaded', [eachBlock('schedule', 'day', 'day.id')])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    const [, destroySub] = emitConditionalBlockSubs(conditional, each, bindings, COMPONENT_NAME);
    const eachId = each.blocks[0].id;

    expect(destroySub).to.include(`m["$$${eachId}"] = invalid`);
    expect(destroySub).to.include(`m["$$${eachId}_keys"] = invalid`);
    expect(destroySub).to.include(`m["$$${eachId}_nodes"] = invalid`);
  });

  it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
    const bindings = buildScriptBindings(parseScriptFixture('state schedule: object = invalid'));
    const row = element('Label', 'row', [], [{ kind: 'dynamic', name: 'text', expression: 'day.title' }]);
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'hasLoaded', [eachBlock('schedule', 'day', 'day.id', [row])])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    const subs = [...emitConditionalBlockSubs(conditional, each, bindings, COMPONENT_NAME), ...emitEachBlockSubs(each, conditional, bindings, COMPONENT_NAME)];
    const result = parse(subs.join('\n\n'));
    expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
  });
});

describe('emitConditionalCreateSub — attribute batching on a freshly-constructed subtree', () => {
  it('batches 2+ plain attribute assignments on one constructed element into a single setFields() call', () => {
    const bindings = buildScriptBindings(parseScriptFixture('state titleText: string = ""\nstate titleColor: string = "0xFFFFFFFF"'));
    const label = element(
      'Label',
      'titleLabel',
      [],
      [
        { kind: 'static', name: 'font', value: 'bold' },
        { kind: 'dynamic', name: 'text', expression: 'titleText' },
        { kind: 'dynamic', name: 'color', expression: 'titleColor' },
      ],
    );
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'hasLoaded', [label])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    const [createSub] = emitConditionalBlockSubs(conditional, each, bindings, COMPONENT_NAME);

    expect(createSub).to.include('m.titleLabel.setFields({font: "bold", text: m?.titleText, color: m?.titleColor})');
  });

  it('keeps a single plain attribute assignment as plain dot-notation, not setFields()', () => {
    const bindings = buildScriptBindings(parseScriptFixture('state titleText: string = ""'));
    const label = element('Label', 'titleLabel', [], [{ kind: 'dynamic', name: 'text', expression: 'titleText' }]);
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'hasLoaded', [label])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    const [createSub] = emitConditionalBlockSubs(conditional, each, bindings, COMPONENT_NAME);

    expect(createSub).to.include('m.titleLabel.text = m?.titleText');
    expect(createSub).to.not.include('setFields');
  });
});

/** Minimal `ParsedAnimationConfig` fixture — only `name` (used by `animationNodeId`) matters for these tests, `step` is never read on this path. */
function fakeOutConfig(name: string): ParsedAnimationConfig {
  return { name, step: { duration: 0.2, easeFunction: null, delay: null, repeat: false, targetId: null, interpolators: [], composition: null } };
}

function fakeTransition(outConfig: ParsedAnimationConfig): ResolvedBlockTransition {
  return { targetElementId: 'card', inConfig: null, outConfig, isDestroyMode: true, inRefreshRefs: [], outRefreshRefs: [] };
}

// component-unmount-hook.md gap 1: the destroy sub's own ordering between focus-recovery
// (unregister/recoverFocusFor) and the ft_unmount cascade was never asserted directly — only
// observed live as "navigation kept working," never pinned down as a contract.
describe('emitConditionalDestroySub — focus-recovery vs. ft_unmount-cascade ordering (component-unmount-hook.md gap 1)', () => {
  function buildBlock() {
    const card = element('Rectangle', 'card', [], [{ kind: 'static', name: 'focusable', value: 'true' }]);
    const widget = element('TimerWidget', 'widget');
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'hasLoaded', [card, widget])]);
    const { conditional } = analyzeTemplateBlocks(root);
    return conditional.blocks[0];
  }

  it('non-transitioning: unregisters focusable content, then cascades ft_unmount, then removeChild, then recoverFocusFor once at the end', () => {
    const block = buildBlock();
    const destroySub = emitConditionalDestroySub(block, COMPONENT_NAME);

    const unregisterIdx = destroySub.indexOf('callFunc("unregister"');
    const unmountCardIdx = destroySub.indexOf('m.card.callFunc("ft_unmount")');
    const unmountWidgetIdx = destroySub.indexOf('m.widget.callFunc("ft_unmount")');
    const removeChildIdx = destroySub.indexOf('.removeChild(');
    const recoverIdx = destroySub.indexOf('callFunc("recoverFocusFor"');

    expect(unregisterIdx, destroySub).to.be.greaterThan(-1);
    expect(unmountCardIdx, destroySub).to.be.greaterThan(-1);
    expect(unmountWidgetIdx, destroySub).to.be.greaterThan(-1);
    expect(removeChildIdx, destroySub).to.be.greaterThan(-1);
    expect(recoverIdx, destroySub).to.be.greaterThan(-1);

    // unregister (focus) happens before the unmount cascade, both happen before removeChild, and
    // recoverFocusFor is called exactly once, after removeChild/id-nulling — the ordering
    // `emitConditionalDestroySub` documents in its own comments, now pinned down as a contract.
    expect(unregisterIdx).to.be.lessThan(unmountCardIdx);
    expect(unregisterIdx).to.be.lessThan(unmountWidgetIdx);
    expect(unmountCardIdx).to.be.lessThan(removeChildIdx);
    expect(unmountWidgetIdx).to.be.lessThan(removeChildIdx);
    expect(removeChildIdx).to.be.lessThan(recoverIdx);
    expect(destroySub.indexOf('callFunc("recoverFocusFor"', recoverIdx + 1)).to.equal(-1);
  });

  it('transitioning (out:): focus unregister + recoverFocusFor run at cascade-check time (animation start), not deferred to the destroy sub', () => {
    const block = buildBlock();
    const transition = fakeTransition(fakeOutConfig('cardOut'));
    const cascadeCheck = emitConditionalBlockCascadeCheck(block, buildScriptBindings(parseScriptFixture('state hasLoaded: boolean = false')), NO_GLOBAL_BINDINGS, new Map(), 1, COMPONENT_NAME, transition).join('\n');

    expect(cascadeCheck).to.include('callFunc("unregister"');
    expect(cascadeCheck).to.include('callFunc("recoverFocusFor"');
    // Starts the exit animation instead of calling the destroy sub directly.
    expect(cascadeCheck).to.include('.control = "start"');
    expect(cascadeCheck).to.not.include(`${COMPONENT_NAME}__destroy_if`);
  });

  it('transitioning (out:): the destroy sub itself (animation-stop time) still cascades ft_unmount, but emits no unregister/recoverFocusFor lines — those already ran at animation-start', () => {
    const block = buildBlock();
    // Mirrors emitConditionalBlockSubs's own call: skipFocusHandling = (transition?.outConfig != null).
    const destroySub = emitConditionalDestroySub(block, COMPONENT_NAME, true);

    expect(destroySub).to.not.include('callFunc("unregister"');
    expect(destroySub).to.not.include('callFunc("recoverFocusFor"');
    expect(destroySub).to.include('m.card.callFunc("ft_unmount")');
    expect(destroySub).to.include('m.widget.callFunc("ft_unmount")');
    expect(destroySub).to.include('.removeChild(');
  });
});

// component-unmount-hook.md gap 2: ft_unmount's cascade loop guards every hop with
// `if <ref> <> invalid then`, but that guard was only ever exercised against an already-nulled
// ref (ordinary sequential teardown) — never against a nested destroy-mode block's own id while
// that block is still validly attached (e.g. mid exit-animation, its own destroy sub not yet run).
describe('emitConditionalDestroySub — nested destroy-mode block reachable via the ft_unmount cascade while still independently mid-teardown (component-unmount-hook.md gap 2)', () => {
  it('an outer destroy-mode block\'s nestedIds includes an inner destroy-mode block\'s own synthetic id', () => {
    const innerCard = element('Rectangle', 'badge', [], [{ kind: 'static', name: 'focusable', value: 'true' }]);
    const inner = ifBlock('destroy', 'showBadge', [innerCard]);
    const outerCard = element('Rectangle', 'card', [inner]);
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'showCard', [outerCard])]);
    const { conditional } = analyzeTemplateBlocks(root);

    // conditional.blocks is post-order (inner pushed before outer) — find by shape, not position,
    // per template-conditional-blocks.md's own documented ordering caveat.
    const outerBlock = conditional.blocks.find((b) => b.expression === 'showCard')!;
    const innerBlock = conditional.blocks.find((b) => b.expression === 'showBadge')!;

    expect(outerBlock.nestedIds).to.include(innerBlock.id);
  });

  it('the outer destroy sub\'s cascade line for the inner block\'s id is individually guarded, not an unconditional callFunc', () => {
    const innerCard = element('Rectangle', 'badge', [], [{ kind: 'static', name: 'focusable', value: 'true' }]);
    const inner = ifBlock('destroy', 'showBadge', [innerCard]);
    const outerCard = element('Rectangle', 'card', [inner]);
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'showCard', [outerCard])]);
    const { conditional } = analyzeTemplateBlocks(root);
    const outerBlock = conditional.blocks.find((b) => b.expression === 'showCard')!;
    const innerBlock = conditional.blocks.find((b) => b.expression === 'showBadge')!;

    const destroySub = emitConditionalDestroySub(outerBlock, COMPONENT_NAME);
    const innerRef = `m["$$${innerBlock.id}"]`;

    // Same "guard individually — a nested block may have already torn itself down independently,
    // calling a method on invalid crashes" shape emitConditionalDestroySub's own comment documents
    // for unobserveLines/unregisterLines — asserted here for the unmount cascade specifically.
    expect(destroySub).to.include(`if ${innerRef} <> invalid then`);
    expect(destroySub).to.include(`${innerRef}.callFunc("ft_unmount")`);
    expect(destroySub).to.not.include(`\n${innerRef}.callFunc("ft_unmount")`);
  });

  it('produces .brs that parses as valid BrightScript with zero diagnostics for a nested destroy-in-destroy shape', () => {
    const innerCard = element('Rectangle', 'badge', [], [{ kind: 'static', name: 'focusable', value: 'true' }]);
    const inner = ifBlock('destroy', 'showBadge', [innerCard]);
    const outerCard = element('Rectangle', 'card', [inner]);
    const root = element('Rectangle', 'root', [ifBlock('destroy', 'showCard', [outerCard])]);
    const { conditional, each } = analyzeTemplateBlocks(root);
    const bindings = buildScriptBindings(parseScriptFixture('state showCard: boolean = false\nstate showBadge: boolean = false'));
    const subs = emitConditionalBlockSubs(conditional, each, bindings, COMPONENT_NAME);
    const result = parse(subs.join('\n\n'));

    expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
  });
});
