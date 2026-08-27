import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile, ThemeGroupDeclaration, ThemeLeafDeclaration } from '../../src/ast.js';

function wrap(source: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
  const result = parse(source);
  return { file: new ThrFile(result.root), diagnostics: result.diagnostics };
}

describe('parse — <theme-template>', () => {
  it('parses nested groups and leaves, 2+ levels deep', () => {
    const source = [
      '<theme-template>',
      'colors: {',
      '  primary: string = "#FFFFFF"',
      '  surface: {',
      '    card: string = "#EEEEEE"',
      '  }',
      '}',
      'fontSizeLarge: integer = 32',
      '</theme-template>',
    ].join('\n');

    const { file, diagnostics } = wrap(source);
    expect(diagnostics).to.deep.equal([]);
    expect(file.kind).to.equal('theme-template');

    const members = file.themeTemplate.members;
    expect(members.map((m) => m.name)).to.deep.equal(['colors', 'fontSizeLarge']);

    const colors = members[0] as ThemeGroupDeclaration;
    expect(colors).to.be.instanceOf(ThemeGroupDeclaration);
    const colorsMembers = colors.members;
    expect(colorsMembers.map((m) => m.name)).to.deep.equal(['primary', 'surface']);
    expect((colorsMembers[0] as ThemeLeafDeclaration).type).to.equal('string');
    expect((colorsMembers[0] as ThemeLeafDeclaration).defaultLiteral).to.equal('"#FFFFFF"');

    const surface = colorsMembers[1] as ThemeGroupDeclaration;
    expect(surface).to.be.instanceOf(ThemeGroupDeclaration);
    expect(surface.members.map((m) => m.name)).to.deep.equal(['card']);

    const fontSizeLarge = members[1] as ThemeLeafDeclaration;
    expect(fontSizeLarge.type).to.equal('integer');
    expect(fontSizeLarge.defaultLiteral).to.equal('32');
  });

  it('extracts the optional default="name" attribute', () => {
    const source = ['<theme-template default="dark">', 'fontSize: integer = 16', '</theme-template>'].join('\n');
    const { file } = wrap(source);
    expect(file.themeTemplate.defaultVariantName).to.equal('dark');
  });

  it('has a null defaultVariantName when the attribute is absent', () => {
    const source = ['<theme-template>', 'fontSize: integer = 16', '</theme-template>'].join('\n');
    const { file } = wrap(source);
    expect(file.themeTemplate.defaultVariantName).to.equal(null);
  });

  it('reproduces a <theme-template> file byte-for-byte, with zero diagnostics', () => {
    const source = ['<theme-template default="dark">', 'colors: {', '  primary: string = "#FFFFFF"', '}', '</theme-template>'].join('\n');
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });

  it('throws thr/theme-must-be-headless when content follows </theme-template>', () => {
    const source = ['<theme-template>', 'fontSize: integer = 16', '</theme-template>', '<Rectangle id="a" />'].join('\n');
    const { diagnostics } = wrap(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['thr/theme-must-be-headless']);
  });

  it('throws dsl/invalid-theme-leaf for an unknown leaf type', () => {
    const { diagnostics } = wrap('<theme-template>\nfontSize: notAType = 16\n</theme-template>');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-theme-leaf']);
  });

  it('throws dsl/invalid-theme-leaf for "array" — array/assocarray support is scoped to field/state only, not theme leaves', () => {
    const { diagnostics } = wrap('<theme-template>\nitems: array = [1, 2, 3]\n</theme-template>');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-theme-leaf']);
  });

  it('throws dsl/invalid-theme-group when a group\'s closing brace is missing', () => {
    const { diagnostics } = wrap('<theme-template>\ncolors: {\n  primary: string = "#fff"\n</theme-template>');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-theme-group']);
  });
});

describe('parse — <theme name="...">', () => {
  it('extracts the required name="..." attribute', () => {
    const source = ['<theme name="dark">', 'fontSize: integer = 20', '</theme>'].join('\n');
    const { file, diagnostics } = wrap(source);

    expect(diagnostics).to.deep.equal([]);
    expect(file.kind).to.equal('theme-variant');
    expect(file.themeVariant.variantName).to.equal('dark');
    expect(file.themeVariant.members.map((m) => m.name)).to.deep.equal(['fontSize']);
  });

  it('reproduces a <theme> file byte-for-byte, with zero diagnostics', () => {
    const source = ['<theme name="dark">', 'colors: {', '  primary: string = "#000000"', '}', '</theme>'].join('\n');
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });

  it('throws thr/theme-must-be-headless when content follows </theme>', () => {
    const source = ['<theme name="dark">', 'fontSize: integer = 20', '</theme>', '<Rectangle id="a" />'].join('\n');
    const { diagnostics } = wrap(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['thr/theme-must-be-headless']);
  });

  it('throws thr/unterminated-theme-variant when </theme> is never found', () => {
    const { diagnostics } = wrap('<theme name="dark">\nfontSize: integer = 20\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['thr/unterminated-theme-variant']);
  });
});
