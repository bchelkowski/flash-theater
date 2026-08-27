import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile } from '../../src/ast.js';
import { TemplateElementNode, TemplateIfNode, TemplateNode } from '../../src/templateModel.js';

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

describe('parse — {#if} conditional blocks', () => {
  it('classifies a toggle-mode block wrapping a single element', () => {
    const { file, diagnostics } = wrap(thr('field visible: boolean = true', '<Rectangle id="a">{#if visible}<Label id="b" />{/if}</Rectangle>'));
    expect(diagnostics).to.deep.equal([]);
    const root = file.template!.children[0];
    expect(root.children).to.have.lengthOf(1);
    const block = asIf(root.children[0]);
    expect(block.mode).to.equal('toggle');
    expect(block.expression).to.equal('visible');
    expect(block.children).to.have.lengthOf(1);
    expect(asElement(block.children[0]).tagName).to.equal('Label');
  });

  it('classifies a destroy-mode block via the {#if:destroy} prefix', () => {
    const { file, diagnostics } = wrap(thr('field showDetails: boolean = true', '<Rectangle id="a">{#if:destroy showDetails}<Label id="b" />{/if}</Rectangle>'));
    expect(diagnostics).to.deep.equal([]);
    const block = asIf(file.template!.children[0].children[0]);
    expect(block.mode).to.equal('destroy');
    expect(block.expression).to.equal('showDetails');
  });

  it('wraps multiple sibling elements in a single block with no container element required', () => {
    const { file, diagnostics } = wrap(thr('field visible: boolean = true', '<Rectangle id="a">{#if visible}<Label id="b" /><Label id="c" />{/if}</Rectangle>'));
    expect(diagnostics).to.deep.equal([]);
    const block = asIf(file.template!.children[0].children[0]);
    expect(block.children.map((c) => asElement(c).id)).to.deep.equal(['b', 'c']);
  });

  it('keeps ordinary sibling elements alongside a block, in document order', () => {
    const { file, diagnostics } = wrap(
      thr('field visible: boolean = true', '<Rectangle id="a"><Label id="x" />{#if visible}<Label id="b" />{/if}<Label id="y" /></Rectangle>'),
    );
    expect(diagnostics).to.deep.equal([]);
    const [first, block, last] = file.template!.children[0].children;
    expect(asElement(first).id).to.equal('x');
    expect(asIf(block).mode).to.equal('toggle');
    expect(asElement(last).id).to.equal('y');
  });

  it('nests an {#if:destroy} block inside an {#if} block', () => {
    const { file, diagnostics } = wrap(
      thr(
        'field a: boolean = true\nfield b: boolean = true',
        '<Rectangle id="root">{#if a}<Rectangle id="outer">{#if:destroy b}<Label id="inner" />{/if}</Rectangle>{/if}</Rectangle>',
      ),
    );
    expect(diagnostics).to.deep.equal([]);
    const outerBlock = asIf(file.template!.children[0].children[0]);
    expect(outerBlock.mode).to.equal('toggle');
    const outerRect = asElement(outerBlock.children[0]);
    const innerBlock = asIf(outerRect.children[0]);
    expect(innerBlock.mode).to.equal('destroy');
    expect(asElement(innerBlock.children[0]).id).to.equal('inner');
  });

  it('throws template/unterminated-if-block when {/if} is missing', () => {
    const { diagnostics } = wrap(thr('field visible: boolean = true', '<Rectangle id="a">{#if visible}<Label id="b" /></Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/unterminated-if-block']);
  });

  it('throws template/unterminated-if-block for a stray {/if} with no opener', () => {
    const { diagnostics } = wrap(thr('field visible: boolean = true', '<Rectangle id="a">{/if}<Label id="b" /></Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/unterminated-if-block']);
  });

  it('throws template/if-cannot-be-root when the whole template is a single block', () => {
    const { diagnostics } = wrap(thr('field visible: boolean = true', '{#if visible}<Rectangle id="a" />{/if}'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/if-cannot-be-root']);
  });

  it('throws expression/parse-error for a malformed condition expression, anchored at the real file position', () => {
    const source = thr('field visible: boolean = true', '<Rectangle id="a">{#if (}<Label id="b" />{/if}</Rectangle>');
    const { diagnostics } = wrap(source);
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'expression/parse-error')).to.be.true;
    const [d] = diagnostics as unknown as { pos: number; end: number }[];
    // The condition text "(" starts right after "{#if " within the real source — confirm the
    // reported position lands inside the real file, not at a wrapper-relative offset (the
    // latent bug this feature's parsing work also fixed for ordinary dynamic attributes).
    expect(d.pos).to.be.greaterThan(0);
    expect(source.slice(0, d.pos)).to.include('{#if (');
  });

  it('does not mis-scan a marker-shaped word appearing inside a static attribute value containing an apostrophe', () => {
    // Regression case for the rejected text-splice parsing design: a BrightScript-flavored
    // comment/quote scanner would treat everything after the apostrophe below as "inside a
    // comment" and silently corrupt marker recognition. The real-parse-first design never scans
    // raw text outside of already-positioned XML Text tokens, so this must parse cleanly.
    const { file, diagnostics } = wrap(
      thr('field visible: boolean = true', '<Rectangle id="a" caption="it\'s fine">{#if visible}<Label id="b" />{/if}</Rectangle>'),
    );
    expect(diagnostics).to.deep.equal([]);
    const block = asIf(file.template!.children[0].children[0]);
    expect(block.mode).to.equal('toggle');
    expect(asElement(block.children[0]).id).to.equal('b');
  });

  it('reproduces a template containing a block byte-for-byte', () => {
    const source = thr('field visible: boolean = true', '<Rectangle id="a">{#if visible}<Label id="b" />{/if}</Rectangle>');
    const result = parse(source);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});
