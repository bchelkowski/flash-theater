import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { parse, ThrFile } from 'flash-parser';
import { adaptScriptSection, adaptTemplateSection } from '../../src/dsl-parser/dsl-parser.js';
import { parseScriptFixture } from '../helpers/parseScriptFixture.js';
import { parseClassFixture } from '../helpers/parseClassFixture.js';

const SCHEDULE_DATE_MENU_ITEM_THR = fileURLToPath(
  new URL(
    '../../../../apps/sample-app/src/components/ScheduleDateMenuItem/ScheduleDateMenuItem.thr',
    import.meta.url,
  ),
);

/**
 * The DSL grammar itself (field/derived/function/if, and every error code)
 * is flash-parser's responsibility now — see
 * packages/flash-parser/test/parser/parser.test.ts for that exhaustive
 * coverage, including this exact real fixture parsed structurally. What's
 * left to test here is the adapter: does `adaptScriptSection` map
 * flash-parser's typed AST into the `ThrScriptAst` shape the rest of this
 * package's pipeline (dependency-graph.ts, xml-emitter.ts, brs-emitter.ts)
 * expects, byte-for-byte compatible with what a hand-rolled scanner used to
 * produce.
 */
describe('adaptScriptSection — ScheduleDateMenuItem.thr (real fixture)', () => {
  const source = readFileSync(SCHEDULE_DATE_MENU_ITEM_THR, 'utf8');
  const result = parse(source);
  const ast = adaptScriptSection(new ThrFile(result.root).script);

  it('parses all five field declarations, in order, with correct types and defaults', () => {
    expect(ast.fields.map((f) => [f.name, f.type, f.defaultLiteral])).to.deep.equal([
      ['width', 'integer', '0'],
      ['height', 'integer', '0'],
      ['focusPercent', 'float', '0.0'],
      ['gridHasFocus', 'boolean', 'false'],
      ['itemContent', 'node', 'invalid'],
    ]);
  });

  it('parses all seven derived declarations, in order, with their type and the raw expression text', () => {
    expect(ast.derived.map((d) => [d.name, d.type])).to.deep.equal([
      ['isGridFocused', 'boolean'],
      ['highlightColor', 'string'],
      ['highlightOpacity', 'float'],
      ['textColor', 'string'],
      ['contentOpacity', 'float'],
      ['titleText', 'string'],
      ['dayNameText', 'string'],
    ]);
    expect(ast.derived[0].expression).to.equal('focusPercent > 0.5');
    expect(ast.derived[1].expression).to.equal('pickColor(gridHasFocus, "0x0057FFFF", "0x3A3A3AFF")');
  });

  it('parses all five private functions with params, return type, body text, and a structured block', () => {
    expect(ast.functions.map((f) => f.name)).to.deep.equal([
      'pickColor',
      'pickOpacity',
      'pickContentOpacity',
      'itemContentTitle',
      'itemContentDayName',
    ]);
    expect(ast.functions.every((f) => f.visibility === 'private')).to.be.true;

    const pickColor = ast.functions[0];
    expect(pickColor.params).to.deep.equal([
      { name: 'condition', type: 'boolean' },
      { name: 'whenTrue', type: 'string' },
      { name: 'whenFalse', type: 'string' },
    ]);
    expect(pickColor.returnType).to.equal('string');
    expect(pickColor.body).to.include('if (condition) {');
    expect(pickColor.body).to.include('return whenTrue');
    expect(pickColor.block.statements).to.have.lengthOf(2);
  });
});

describe('adaptScriptSection — isolated cases', () => {
  it('parses back-to-back field, derived, and function declarations in one pass', () => {
    const ast = parseScriptFixture(
      ['field width: integer = 0', 'derived isWide: boolean = width > 100', 'public function label(): string {', '  return "wide"', '}'].join('\n'),
    );

    expect(ast.fields).to.have.lengthOf(1);
    expect(ast.derived).to.have.lengthOf(1);
    expect(ast.functions).to.have.lengthOf(1);
    expect(ast.functions[0].visibility).to.equal('public');
  });

  it('adapts read/watch declarations, mapping their store(<path>) into a segment array', () => {
    const ast = parseScriptFixture(['read snapshot = store(favoriteCount)', 'watch live = store(some.nested.value)'].join('\n'));

    expect(ast.reads).to.deep.equal([{ kind: 'read', name: 'snapshot', path: ['favoriteCount'], scale: false, span: { line: 0 } }]);
    expect(ast.watches).to.deep.equal([{ kind: 'watch', name: 'live', path: ['some', 'nested', 'value'], scale: false, span: { line: 1 } }]);
  });

  it('adapts a stream declaration, with no expression/defaultLiteral', () => {
    const ast = parseScriptFixture('stream dataLoaded: string');
    expect(ast.streams).to.deep.equal([{ kind: 'stream', name: 'dataLoaded', type: 'string', span: { line: 0 } }]);
  });

  it('adapts a request declaration, keeping the config literal\'s own braces', () => {
    const ast = parseScriptFixture('request Http { method: "GET", url: "https://example.com" }');
    expect(ast.request).to.deep.equal({
      kind: 'request',
      requestKind: 'Http',
      configText: '{ method: "GET", url: "https://example.com" }',
      span: { line: 0 },
    });
  });

  it('adapts a component with no request declaration as null', () => {
    const ast = parseScriptFixture('field width: integer = 0');
    expect(ast.request).to.equal(null);
  });

  it("adapts an animation declaration, keeping the config literal's own braces", () => {
    const ast = parseScriptFixture('animation bounce { target: card, duration: 400 }');
    expect(ast.animations).to.deep.equal([
      { kind: 'animation', name: 'bounce', configText: '{ target: card, duration: 400 }', span: { line: 0 } },
    ]);
  });

  it('adapts a component with no animation declarations as an empty array', () => {
    const ast = parseScriptFixture('field width: integer = 0');
    expect(ast.animations).to.deep.equal([]);
  });

  it('adapts a class stream field, kept separate from .fields', () => {
    const classAst = parseClassFixture(['class C {', '  public stream onChanged: string', '  private count: integer = 0', '}'].join('\n'));
    expect(classAst.streamFields.map((s) => [s.kind, s.visibility, s.name, s.type])).to.deep.equal([['class-stream-field', 'public', 'onChanged', 'string']]);
    expect(classAst.fields.map((f) => [f.kind, f.visibility, f.name, f.type, f.defaultLiteral])).to.deep.equal([['class-field', 'private', 'count', 'integer', '0']]);
  });

  it('adapts <component extends="..."> into ThrTemplateAst.extends, defaulting to null when absent', () => {
    const withExtends = parse('<script>\nfield width: integer = 0\n</script>\n<component extends="Scene">\n<Label id="a" />\n</component>\n');
    const template = adaptTemplateSection(new ThrFile(withExtends.root).template!);
    expect(template.extends).to.equal('Scene');

    const plain = parse('<script>\nfield width: integer = 0\n</script>\n<component>\n<Label id="a" />\n</component>\n');
    const plainTemplate = adaptTemplateSection(new ThrFile(plain.root).template!);
    expect(plainTemplate.extends).to.equal(null);
  });

  it('adapts 2+ top-level <component> children into a synthetic multi-child root, transparent to the real ids underneath', () => {
    const source = parse('<script>\nfield width: integer = 0\n</script>\n<component>\n<Rectangle id="a" />\n<Rectangle id="b" />\n</component>\n');
    const template = adaptTemplateSection(new ThrFile(source.root).template!);
    expect(template.root.id).to.equal(null);
    expect(template.root.children.map((c) => (c.kind === 'element' ? c.id : c.kind))).to.deep.equal(['a', 'b']);
  });
});
