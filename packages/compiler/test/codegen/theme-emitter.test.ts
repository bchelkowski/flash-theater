import { expect } from 'chai';
import { parse as parseBrightScript, parseSceneGraphXml } from 'kopytko-brightscript-parser';
import { parse, ThrFile } from 'flash-parser';
import { adaptThemeTemplateSection, adaptThemeVariantSection } from '../../src/dsl-parser/dsl-parser.js';
import { buildThemeShape } from '../../src/analysis/global-bindings.js';
import { compileTheme } from '../../src/codegen/theme-emitter.js';
import { ThemeTemplateAst, ThemeVariantAst } from '../../src/dsl-parser/dsl-ast.js';

function themeTemplate(body: string, defaultAttr = ''): ThemeTemplateAst {
  const result = parse(`<theme-template${defaultAttr}>\n${body}\n</theme-template>`);
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics[0].message);
  return adaptThemeTemplateSection(new ThrFile(result.root).themeTemplate);
}

function themeVariant(name: string, body: string): ThemeVariantAst {
  const result = parse(`<theme name="${name}">\n${body}\n</theme>`);
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics[0].message);
  return adaptThemeVariantSection(new ThrFile(result.root).themeVariant);
}

function assertValidBrs(brs: string): void {
  const result = parseBrightScript(brs);
  expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
}

function assertValidSceneGraphXml(xml: string): void {
  const element = parseSceneGraphXml(xml);
  expect(element, 'expected the generated XML to parse as a valid SceneGraph component').to.not.be.undefined;
  expect(element!.tagName).to.equal('component');
}

const TEMPLATE_BODY = ['colors: {', '  primary: string = "#FFFFFF"', '  surface: {', '    card: string = "#EEEEEE"', '  }', '}', 'fontSize: integer = 16'].join('\n');

describe('compileTheme', () => {
  it('emits one assocarray field per top-level group plus a switchTheme function', () => {
    const shape = buildThemeShape(themeTemplate(TEMPLATE_BODY), []);
    const compiled = compileTheme(shape, 'Theme');

    expect(compiled.xml).to.include('<field id="colors" type="assocarray" />');
    expect(compiled.xml).to.include('<field id="fontSize" type="assocarray" />');
    expect(compiled.xml).to.include('<function name="switchTheme" />');
    expect(compiled.xml).to.include('<component name="Theme" extends="Node">');
    assertValidSceneGraphXml(compiled.xml);
  });

  it('never emits a value= on a theme group field — values are set in init()', () => {
    const shape = buildThemeShape(themeTemplate(TEMPLATE_BODY), []);
    const compiled = compileTheme(shape, 'Theme');
    expect(compiled.xml).to.not.include('value=');
  });

  it('with no variants, init() assigns each group straight from the template defaults, and switchTheme is a no-op', () => {
    const shape = buildThemeShape(themeTemplate(TEMPLATE_BODY), []);
    const compiled = compileTheme(shape, 'Theme');

    expect(compiled.brs).to.include('m.top.fontSize = 16');
    expect(compiled.brs).to.include('m.currentThemeName = ""');
    expect(compiled.brs).to.include('this app has no theme variants');
    assertValidBrs(compiled.brs);
  });

  it('generates one private per-(group,variant) table and switches every group field via switchTheme', () => {
    const template = themeTemplate(TEMPLATE_BODY);
    const dark = themeVariant('dark', 'colors: {\n  primary: string = "#000000"\n}');
    const light = themeVariant('light', 'fontSize: integer = 14');
    const shape = buildThemeShape(template, [dark, light]);
    const compiled = compileTheme(shape, 'Theme');

    expect(compiled.brs).to.include('m.private_colors_dark = {');
    expect(compiled.brs).to.include('primary: "#000000"');
    expect(compiled.brs).to.include('m.private_fontSize_dark = 16'); // fell back to template default
    expect(compiled.brs).to.include('m.private_fontSize_light = 14');

    expect(compiled.brs).to.include('if (name = "dark") then');
    expect(compiled.brs).to.include('m.top.colors = m.private_colors_dark');
    expect(compiled.brs).to.include('m.top.fontSize = m.private_fontSize_dark');
    expect(compiled.brs).to.include('if (name = "light") then');
    expect(compiled.brs).to.include('unknown theme variant');
    assertValidBrs(compiled.brs);
  });

  it('initial theme is the first-declared variant when no default= attribute is given', () => {
    const template = themeTemplate(TEMPLATE_BODY);
    const dark = themeVariant('dark', 'fontSize: integer = 20');
    const light = themeVariant('light', 'fontSize: integer = 14');
    const shape = buildThemeShape(template, [dark, light]);
    const compiled = compileTheme(shape, 'Theme');

    expect(compiled.brs).to.include('m.top.fontSize = m.private_fontSize_dark');
    expect(compiled.brs).to.include('m.currentThemeName = "dark"');
    assertValidBrs(compiled.brs);
  });

  it('initial theme honors an explicit default="name" attribute over discovery order', () => {
    const template = themeTemplate(TEMPLATE_BODY, ' default="light"');
    const dark = themeVariant('dark', 'fontSize: integer = 20');
    const light = themeVariant('light', 'fontSize: integer = 14');
    const shape = buildThemeShape(template, [dark, light]);
    const compiled = compileTheme(shape, 'Theme');

    expect(compiled.brs).to.include('m.top.fontSize = m.private_fontSize_light');
    expect(compiled.brs).to.include('m.currentThemeName = "light"');
    assertValidBrs(compiled.brs);
  });

  it('prints nested AA literals for a multi-level group', () => {
    const template = themeTemplate(TEMPLATE_BODY);
    const dark = themeVariant('dark', 'colors: {\n  primary: string = "#000000"\n  surface: {\n    card: string = "#111111"\n  }\n}');
    const shape = buildThemeShape(template, [dark]);
    const compiled = compileTheme(shape, 'Theme');

    expect(compiled.brs).to.include('m.private_colors_dark = {\n    primary: "#000000"\n    surface: {\n      card: "#111111"\n    }\n  }');
    assertValidBrs(compiled.brs);
  });
});
