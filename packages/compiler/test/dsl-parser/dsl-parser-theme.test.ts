import { expect } from 'chai';
import { parse, ThrFile } from 'flash-parser';
import { adaptThemeTemplateSection, adaptThemeVariantSection } from '../../src/dsl-parser/dsl-parser.js';

describe('adaptThemeTemplateSection', () => {
  it('adapts nested groups and leaves into the ThemeMemberDecl tree', () => {
    const source = ['<theme-template default="dark">', 'colors: {', '  primary: string = "#FFFFFF"', '  surface: {', '    card: string = "#EEEEEE"', '  }', '}', 'fontSizeLarge: integer = 32', '</theme-template>'].join('\n');
    const result = parse(source);
    expect(result.diagnostics).to.deep.equal([]);

    const ast = adaptThemeTemplateSection(new ThrFile(result.root).themeTemplate);
    expect(ast.defaultVariantName).to.equal('dark');
    expect(ast.members.map((m) => [m.kind, m.name])).to.deep.equal([
      ['theme-group', 'colors'],
      ['theme-leaf', 'fontSizeLarge'],
    ]);

    const colors = ast.members[0];
    if (colors.kind !== 'theme-group') throw new Error('expected a theme-group');
    expect(colors.members.map((m) => [m.kind, m.name])).to.deep.equal([
      ['theme-leaf', 'primary'],
      ['theme-group', 'surface'],
    ]);

    const primary = colors.members[0];
    if (primary.kind !== 'theme-leaf') throw new Error('expected a theme-leaf');
    expect(primary.type).to.equal('string');
    expect(primary.defaultLiteral).to.equal('"#FFFFFF"');
  });
});

describe('adaptThemeVariantSection', () => {
  it('adapts a variant\'s name and partial member overrides', () => {
    const source = ['<theme name="dark">', 'colors: {', '  primary: string = "#000000"', '}', '</theme>'].join('\n');
    const result = parse(source);
    expect(result.diagnostics).to.deep.equal([]);

    const ast = adaptThemeVariantSection(new ThrFile(result.root).themeVariant);
    expect(ast.variantName).to.equal('dark');
    expect(ast.members.map((m) => [m.kind, m.name])).to.deep.equal([['theme-group', 'colors']]);
  });
});
