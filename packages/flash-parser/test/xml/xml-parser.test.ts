import { expect } from 'chai';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseXml } from '../../src/xml/xml-parser.js';
import { XmlSyntaxKind } from '../../src/xml/xml-syntax.js';
import { XmlDocument, parseSceneGraphXml } from '../../src/xml/xml-ast.js';
import { xmlTokensToText } from '../../src/xml/xml-syntax.js';

describe('parseXml — lossless round-trip on synthetic samples', () => {
  const samples = [
    '<component name="Foo" extends="Group"><children><Label id="a" text="hi" /></children></component>',
    '<component>\n  <children>\n    <!-- a comment -->\n    <Rectangle id="r" width="100" height="50" color="0xFF0000" />\n  </children>\n</component>',
    "<component><interface><field id=\"x\" type='integer' value=\"1\" /></interface></component>",
    '<a><b><c/></b><d>text content</d></a>',
  ];

  for (const source of samples) {
    it(`reproduces ${JSON.stringify(source.slice(0, 50))} byte-for-byte`, () => {
      const { root, tokens } = parseXml(source);
      expect(root.getText()).to.equal(source);
      expect(xmlTokensToText(tokens)).to.equal(source);
    });
  }
});

describe('parseXml — element/attribute structure', () => {
  it('parses tag name, attributes, and nested children', () => {
    const { root, diagnostics } = parseXml('<component name="Foo" extends="Group"><children><Label id="a" text="hi"/></children></component>');
    expect(diagnostics).to.deep.equal([]);
    const doc = new XmlDocument(root);
    const component = doc.root!;
    expect(component.tagName).to.equal('component');
    expect(component.getAttribute('name')?.value).to.equal('Foo');
    expect(component.getAttribute('extends')?.value).to.equal('Group');
    const children = component.findChildByTagName('children')!;
    const label = children.findChildByTagName('Label')!;
    expect(label.selfClosing).to.equal(true);
    expect(label.getAttribute('id')?.value).to.equal('a');
    expect(label.getAttribute('text')?.value).to.equal('hi');
  });

  it('findAllDescendants walks the whole subtree, self-inclusive', () => {
    const el = parseSceneGraphXml('<a><b><c/></b><d><e/></d></a>')!;
    const names = el.findAllDescendants().map((e) => e.tagName);
    expect(names).to.deep.equal(['a', 'b', 'c', 'd', 'e']);
  });

  it('attribute value strips quotes and does not decode entities', () => {
    const el = parseSceneGraphXml('<a x="1 &amp; 2"/>')!;
    expect(el.getAttribute('x')?.value).to.equal('1 &amp; 2');
  });
});

describe('parseXml — bare attribute (no "=value" at all) is legal, meaning the same as ""', () => {
  it('parses a bare attribute with zero diagnostics, value equal to an empty string', () => {
    const { root, diagnostics } = parseXml('<a x/>');
    expect(diagnostics).to.deep.equal([]);
    const el = new XmlDocument(root).root!;
    expect(el.getAttribute('x')?.value).to.equal('');
  });

  it('a bare attribute and an explicit `=""` produce identical attribute values', () => {
    const bare = new XmlDocument(parseXml('<a x/>').root).root!;
    const explicit = new XmlDocument(parseXml('<a x=""/>').root).root!;
    expect(bare.getAttribute('x')?.value).to.equal(explicit.getAttribute('x')?.value);
  });

  it('mixes bare and valued attributes freely, in either order', () => {
    const { root, diagnostics } = parseXml('<a bare1 id="real" bare2 width="10"/>');
    expect(diagnostics).to.deep.equal([]);
    const el = new XmlDocument(root).root!;
    expect(el.getAttribute('bare1')?.value).to.equal('');
    expect(el.getAttribute('id')?.value).to.equal('real');
    expect(el.getAttribute('bare2')?.value).to.equal('');
    expect(el.getAttribute('width')?.value).to.equal('10');
  });

  it('round-trips a bare attribute byte-for-byte', () => {
    const source = '<FlashTheaterRouterOutlet id="outlet" navigate-out:slideOutLeft navigate-in:slideInFromRight />';
    const { root } = parseXml(source);
    expect(root.getText()).to.equal(source);
  });

  it('still reports a diagnostic for a dangling "=" with no value at all (not treated as bare)', () => {
    const { diagnostics } = parseXml('<a x= />');
    expect(diagnostics.length).to.be.greaterThan(0);
  });
});

describe('parseXml — error tolerance', () => {
  it('never throws, and reports a mismatched closing tag', () => {
    expect(() => parseXml('<a><b></c></a>')).to.not.throw();
    const { diagnostics } = parseXml('<a><b></c></a>');
    expect(diagnostics.length).to.be.greaterThan(0);
  });

  it('reports a diagnostic for a missing closing tag but still returns a tree', () => {
    const { root, diagnostics } = parseXml('<a><b>');
    expect(root.kind).to.equal(XmlSyntaxKind.Document);
    expect(diagnostics.length).to.be.greaterThan(0);
  });
});

describe('parseXml — round-trips real generated SceneGraph XML from apps/sample-app', () => {
  // A committed snapshot of apps/sample-app's own compiled output (packages/flash-parser/test/fixtures/generated-xml/,
  // mirroring its out/components/ tree), not a live read of apps/sample-app itself — that directory
  // now holds only .thr source under src/, and out/ is gitignored/build-generated (see
  // findings/build-layout.md), so this suite can no longer assume compiled .xml exists on disk
  // without requiring a full app build to run first. Refresh this snapshot after a deliberate
  // codegen change: `npm run build:roku --workspace apps/sample-app` then re-copy `out/components/**/*.xml`.
  const componentsDir = join(__dirname, '../fixtures/generated-xml');
  const xmlFiles: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.xml')) xmlFiles.push(full);
    }
  }
  walk(componentsDir);

  it('found at least one real .xml fixture to test against', () => {
    expect(xmlFiles.length).to.be.greaterThan(0);
  });

  for (const file of xmlFiles) {
    it(`round-trips ${file.slice(componentsDir.length)} byte-for-byte with zero diagnostics`, () => {
      const source = readFileSync(file, 'utf8');
      const { root, diagnostics } = parseXml(source);
      expect(diagnostics, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`).to.deep.equal([]);
      expect(root.getText()).to.equal(source);
    });
  }
});
