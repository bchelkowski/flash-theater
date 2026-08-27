import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile } from '../../src/ast.js';
import { TemplateEachNode, TemplateElementNode, TemplateIfNode, TemplateNode } from '../../src/templateModel.js';

function wrap(source: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
  const result = parse(source);
  return { file: new ThrFile(result.root), diagnostics: result.diagnostics };
}

function thr(scriptBody: string, templateMarkup: string): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${templateMarkup}\n</component>\n`;
}

function asElement(node: TemplateNode): TemplateElementNode {
  if (node.kind !== 'element') throw new Error(`expected an element node, got kind "${node.kind}"`);
  return node;
}

function asIf(node: TemplateNode): TemplateIfNode {
  if (node.kind !== 'if') throw new Error(`expected an if node, got kind "${node.kind}"`);
  return node;
}

function asEach(node: TemplateNode): TemplateEachNode {
  if (node.kind !== 'each') throw new Error(`expected an each node, got kind "${node.kind}"`);
  return node;
}

describe('parse — {#each} keyed list rendering', () => {
  it('classifies a basic block, splitting the header into collection/alias/key', () => {
    const { file, diagnostics } = wrap(
      thr('field items: node = invalid', '<Rectangle id="a">{#each items as item (item.id)}<Label id="b" />{/each}</Rectangle>'),
    );
    expect(diagnostics).to.deep.equal([]);
    const root = file.template!.children[0];
    expect(root.children).to.have.lengthOf(1);
    const block = asEach(root.children[0]);
    expect(block.collectionExpression).to.equal('items');
    expect(block.itemAlias).to.equal('item');
    expect(block.keyExpression).to.equal('item.id');
    expect(block.children).to.have.lengthOf(1);
    expect(asElement(block.children[0]).tagName).to.equal('Label');
  });

  it('wraps multiple sibling elements in a single block with no container element required', () => {
    const { file, diagnostics } = wrap(
      thr('field items: node = invalid', '<Rectangle id="a">{#each items as item (item.id)}<Label id="b" /><Label id="c" />{/each}</Rectangle>'),
    );
    expect(diagnostics).to.deep.equal([]);
    const block = asEach(file.template!.children[0].children[0]);
    expect(block.children.map((c) => asElement(c).id)).to.deep.equal(['b', 'c']);
  });

  it('keeps ordinary sibling elements alongside a block, in document order', () => {
    const { file, diagnostics } = wrap(
      thr(
        'field items: node = invalid',
        '<Rectangle id="a"><Label id="x" />{#each items as item (item.id)}<Label id="b" />{/each}<Label id="y" /></Rectangle>',
      ),
    );
    expect(diagnostics).to.deep.equal([]);
    const [first, block, last] = file.template!.children[0].children;
    expect(asElement(first).id).to.equal('x');
    expect(asEach(block).itemAlias).to.equal('item');
    expect(asElement(last).id).to.equal('y');
  });

  it('nests an {#each} block inside another {#each} block', () => {
    const { file, diagnostics } = wrap(
      thr(
        'field days: node = invalid',
        '<Rectangle id="root">{#each days as day (day.id)}<Rectangle id="row">{#each day.events as event (event.id)}<Label id="inner" />{/each}</Rectangle>{/each}</Rectangle>',
      ),
    );
    expect(diagnostics).to.deep.equal([]);
    const outerBlock = asEach(file.template!.children[0].children[0]);
    expect(outerBlock.itemAlias).to.equal('day');
    const rowElement = asElement(outerBlock.children[0]);
    const innerBlock = asEach(rowElement.children[0]);
    expect(innerBlock.itemAlias).to.equal('event');
    expect(innerBlock.collectionExpression).to.equal('day.events');
    expect(asElement(innerBlock.children[0]).id).to.equal('inner');
  });

  it('nests an {#if}/{#if:destroy} block inside an {#each} block', () => {
    const { file, diagnostics } = wrap(
      thr(
        'field days: node = invalid',
        '<Rectangle id="root">{#each days as day (day.id)}{#if:destroy day.isToday}<Label id="badge" />{/if}{/each}</Rectangle>',
      ),
    );
    expect(diagnostics).to.deep.equal([]);
    const eachBlock = asEach(file.template!.children[0].children[0]);
    const ifBlock = asIf(eachBlock.children[0]);
    expect(ifBlock.mode).to.equal('destroy');
    expect(ifBlock.expression).to.equal('day.isToday');
    expect(asElement(ifBlock.children[0]).id).to.equal('badge');
  });

  it('nests an {#each} block inside an {#if:destroy} block', () => {
    const { file, diagnostics } = wrap(
      thr(
        'field hasLoaded: boolean = false\nfield schedule: node = invalid',
        '<Rectangle id="root">{#if:destroy hasLoaded}{#each schedule as day (day.id)}<Label id="row" />{/each}{/if}</Rectangle>',
      ),
    );
    expect(diagnostics).to.deep.equal([]);
    const ifBlock = asIf(file.template!.children[0].children[0]);
    expect(ifBlock.mode).to.equal('destroy');
    const eachBlock = asEach(ifBlock.children[0]);
    expect(eachBlock.itemAlias).to.equal('day');
    expect(asElement(eachBlock.children[0]).id).to.equal('row');
  });

  it('throws template/unterminated-each-block when {/each} is missing', () => {
    const { diagnostics } = wrap(thr('field items: node = invalid', '<Rectangle id="a">{#each items as item (item.id)}<Label id="b" /></Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/unterminated-each-block']);
  });

  it('throws template/unterminated-each-block for a stray {/each} with no opener', () => {
    const { diagnostics } = wrap(thr('field items: node = invalid', '<Rectangle id="a">{/each}<Label id="b" /></Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/unterminated-each-block']);
  });

  it('throws template/each-close-mismatch when {/each} closes an {#if} frame', () => {
    const { diagnostics } = wrap(thr('field visible: boolean = true', '<Rectangle id="a">{#if visible}<Label id="b" />{/each}</Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/each-close-mismatch']);
  });

  it('throws template/each-close-mismatch when {/if} closes an {#each} frame', () => {
    const { diagnostics } = wrap(thr('field items: node = invalid', '<Rectangle id="a">{#each items as item (item.id)}<Label id="b" />{/if}</Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/each-close-mismatch']);
  });

  it('throws template/each-cannot-be-root when the whole template is a single block', () => {
    const { diagnostics } = wrap(thr('field items: node = invalid', '{#each items as item (item.id)}<Rectangle id="a" />{/each}'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/each-cannot-be-root']);
  });

  it('throws template/each-missing-key when the (key) clause is absent entirely', () => {
    const { diagnostics } = wrap(thr('field items: node = invalid', '<Rectangle id="a">{#each items as item}<Label id="b" />{/each}</Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/each-missing-key']);
  });

  it('throws template/each-missing-key when the key clause paren never closes', () => {
    const { diagnostics } = wrap(thr('field items: node = invalid', '<Rectangle id="a">{#each items as item (item.id}<Label id="b" />{/each}</Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/each-missing-key']);
  });

  it('throws template/each-missing-key when the key clause is empty', () => {
    const { diagnostics } = wrap(thr('field items: node = invalid', '<Rectangle id="a">{#each items as item ()}<Label id="b" />{/each}</Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/each-missing-key']);
  });

  it('throws template/each-invalid-item-alias when the alias is not a valid identifier', () => {
    const { diagnostics } = wrap(thr('field items: node = invalid', '<Rectangle id="a">{#each items as 3x (key)}<Label id="b" />{/each}</Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/each-invalid-item-alias']);
  });

  it('throws template/each-invalid-header when there is no " as " separator at all', () => {
    const { diagnostics } = wrap(thr('field items: node = invalid', '<Rectangle id="a">{#each items (key)}<Label id="b" />{/each}</Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/each-invalid-header']);
  });

  it('throws template/each-invalid-header for trailing content after the key clause', () => {
    const { diagnostics } = wrap(
      thr('field items: node = invalid', '<Rectangle id="a">{#each items as item (item.id) extra}<Label id="b" />{/each}</Rectangle>'),
    );
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/each-invalid-header']);
  });

  it('throws expression/parse-error for a malformed collection expression, anchored at the real file position', () => {
    // "," alone is not a valid expression start — chosen (rather than an unmatched paren, like
    // {#if}'s own malformed-condition test uses) because an unmatched "(" here would itself throw
    // off this header's own paren-depth-aware " as "/key-clause scanning, producing a header-shape
    // diagnostic instead of reaching the embedded-expression parse this test targets.
    const source = thr('field items: node = invalid', '<Rectangle id="a">{#each , as item (item.id)}<Label id="b" />{/each}</Rectangle>');
    const { diagnostics } = wrap(source);
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'expression/parse-error')).to.be.true;
    const [d] = diagnostics as unknown as { pos: number; end: number }[];
    // pos lands exactly at the malformed token itself (the "," right after the "{#each " prefix).
    expect(d.pos).to.equal(source.indexOf(','));
  });

  it('throws expression/parse-error for a malformed key expression, anchored at the real file position', () => {
    // "item." (trailing dot, no member name) is syntactically incomplete but paren-balanced, so
    // the key clause's own "(...)" boundary is still found correctly and this reaches the
    // embedded-expression parse of the key text itself.
    const source = thr('field items: node = invalid', '<Rectangle id="a">{#each items as item (item.)}<Label id="b" />{/each}</Rectangle>');
    const { diagnostics } = wrap(source);
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'expression/parse-error')).to.be.true;
  });

  it('does not mis-scan a marker-shaped word appearing inside a static attribute value containing an apostrophe', () => {
    const { file, diagnostics } = wrap(
      thr(
        'field items: node = invalid',
        '<Rectangle id="a" caption="it\'s fine">{#each items as item (item.id)}<Label id="b" />{/each}</Rectangle>',
      ),
    );
    expect(diagnostics).to.deep.equal([]);
    const block = asEach(file.template!.children[0].children[0]);
    expect(block.itemAlias).to.equal('item');
    expect(asElement(block.children[0]).id).to.equal('b');
  });

  it('reproduces a template containing a block byte-for-byte', () => {
    const source = thr('field items: node = invalid', '<Rectangle id="a">{#each items as item (item.id)}<Label id="b" />{/each}</Rectangle>');
    const result = parse(source);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});
