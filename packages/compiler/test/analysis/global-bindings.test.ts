import { expect } from 'chai';
import { parse, ThrFile } from 'flash-parser';
import { adaptThemeTemplateSection, adaptThemeVariantSection } from '../../src/dsl-parser/dsl-parser.js';
import { CompileError, ThemeTemplateAst, ThemeVariantAst } from '../../src/dsl-parser/dsl-ast.js';
import { buildThemeShape, resolveGlobalPath, GlobalBindingsContext } from '../../src/analysis/global-bindings.js';

function themeTemplateFixture(body: string): ThemeTemplateAst {
  const result = parse(`<theme-template>\n${body}\n</theme-template>`);
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics[0].message);
  return adaptThemeTemplateSection(new ThrFile(result.root).themeTemplate);
}

function themeVariantFixture(name: string, body: string): ThemeVariantAst {
  const result = parse(`<theme name="${name}">\n${body}\n</theme>`);
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics[0].message);
  return adaptThemeVariantSection(new ThrFile(result.root).themeVariant);
}

const TEMPLATE_BODY = ['colors: {', '  primary: string = "#FFFFFF"', '  surface: {', '    card: string = "#EEEEEE"', '  }', '}', 'fontSize: integer = 16'].join('\n');

describe('buildThemeShape', () => {
  it('resolves every leaf to the template default when a variant provides nothing', () => {
    const template = themeTemplateFixture(TEMPLATE_BODY);
    const shape = buildThemeShape(template, []);

    expect(shape.topLevelGroups.get('colors')).to.deep.equal({
      kind: 'group',
      children: new Map([
        ['primary', { kind: 'leaf', type: 'string' }],
        ['surface', { kind: 'group', children: new Map([['card', { kind: 'leaf', type: 'string' }]]) }],
      ]),
    });
    expect(shape.topLevelGroups.get('fontSize')).to.deep.equal({ kind: 'leaf', type: 'integer' });
  });

  it('a variant may omit members — they fall back to the template default at that exact path', () => {
    const template = themeTemplateFixture(TEMPLATE_BODY);
    const variant = themeVariantFixture('dark', 'colors: {\n  primary: string = "#000000"\n}');
    const shape = buildThemeShape(template, [variant]);

    const resolved = shape.resolvedVariants.get('dark')!;
    expect(resolved.values.get('colors.primary')).to.equal('"#000000"');
    expect(resolved.values.get('colors.surface.card')).to.equal('"#EEEEEE"'); // fell back to the template default
    expect(resolved.values.get('fontSize')).to.equal('16'); // fell back to the template default
  });

  it('records variant names in file-discovery order', () => {
    const template = themeTemplateFixture(TEMPLATE_BODY);
    const dark = themeVariantFixture('dark', 'fontSize: integer = 20');
    const light = themeVariantFixture('light', 'fontSize: integer = 14');
    const shape = buildThemeShape(template, [dark, light]);

    expect(shape.variantNames).to.deep.equal(['dark', 'light']);
  });

  it('carries the default variant name from the template', () => {
    const result = parse('<theme-template default="dark">\nfontSize: integer = 16\n</theme-template>');
    const template = adaptThemeTemplateSection(new ThrFile(result.root).themeTemplate);
    const shape = buildThemeShape(template, []);
    expect(shape.defaultVariantName).to.equal('dark');
  });

  it('throws theme/variant-unknown-member when a variant declares a member the template does not have', () => {
    const template = themeTemplateFixture(TEMPLATE_BODY);
    const variant = themeVariantFixture('dark', 'unknownMember: string = "x"');
    expect(() => buildThemeShape(template, [variant])).to.throw(CompileError).with.property('diagnostic').that.deep.includes({ code: 'theme/variant-unknown-member' });
  });

  it('throws theme/variant-kind-mismatch when a variant declares a leaf as a group', () => {
    const template = themeTemplateFixture(TEMPLATE_BODY);
    const variant = themeVariantFixture('dark', 'fontSize: {\n  x: integer = 1\n}');
    expect(() => buildThemeShape(template, [variant])).to.throw(CompileError).with.property('diagnostic').that.deep.includes({ code: 'theme/variant-kind-mismatch' });
  });

  it('throws theme/variant-kind-mismatch when a variant declares a group as a leaf', () => {
    const template = themeTemplateFixture(TEMPLATE_BODY);
    const variant = themeVariantFixture('dark', 'colors: string = "nope"');
    expect(() => buildThemeShape(template, [variant])).to.throw(CompileError).with.property('diagnostic').that.deep.includes({ code: 'theme/variant-kind-mismatch' });
  });

  it('throws theme/variant-type-mismatch when a variant leaf declares a different type than the template', () => {
    const template = themeTemplateFixture(TEMPLATE_BODY);
    const variant = themeVariantFixture('dark', 'fontSize: float = 16.5');
    expect(() => buildThemeShape(template, [variant])).to.throw(CompileError).with.property('diagnostic').that.deep.includes({ code: 'theme/variant-type-mismatch' });
  });
});

describe('resolveGlobalPath', () => {
  function ctxWith(opts: { theme?: boolean } = { theme: true }): GlobalBindingsContext {
    const theme = opts.theme ? buildThemeShape(themeTemplateFixture(TEMPLATE_BODY), []) : null;
    return { theme };
  }

  it('resolves a nested theme leaf', () => {
    expect(resolveGlobalPath('theme', ['colors', 'surface', 'card'], false, ctxWith())).to.deep.equal({ kind: 'theme-leaf', type: 'string', topLevelGroup: 'colors' });
  });

  it('resolves a top-level theme leaf', () => {
    expect(resolveGlobalPath('theme', ['fontSize'], false, ctxWith())).to.deep.equal({ kind: 'theme-leaf', type: 'integer', topLevelGroup: 'fontSize' });
  });

  it('resolves a theme group reference (not indexed down to a leaf)', () => {
    expect(resolveGlobalPath('theme', ['colors'], false, ctxWith())).to.deep.equal({ kind: 'theme-group', topLevelGroup: 'colors' });
  });

  it('rejects indexing through a theme leaf', () => {
    const result = resolveGlobalPath('theme', ['fontSize', 'nested'], false, ctxWith());
    expect(result.kind).to.equal('invalid');
  });

  it('rejects an unknown theme member', () => {
    expect(resolveGlobalPath('theme', ['nope'], false, ctxWith()).kind).to.equal('invalid');
  });

  it('rejects "theme" when no <theme-template> exists in the app', () => {
    expect(resolveGlobalPath('theme', ['fontSize'], false, ctxWith({ theme: false })).kind).to.equal('invalid');
  });
});

describe('resolveGlobalPath — router', () => {
  const ctx: GlobalBindingsContext = { theme: null };

  it('resolves a router data read at any depth, schemaless', () => {
    expect(resolveGlobalPath('router', ['path'], false, ctx)).to.deep.equal({ kind: 'router-data' });
    expect(resolveGlobalPath('router', ['params', 'day'], false, ctx)).to.deep.equal({ kind: 'router-data' });
  });

  it('resolves a valid router action call', () => {
    expect(resolveGlobalPath('router', ['navigate'], true, ctx)).to.deep.equal({ kind: 'router-action', method: 'navigate' });
    expect(resolveGlobalPath('router', ['back'], true, ctx)).to.deep.equal({ kind: 'router-action', method: 'back' });
  });

  it('rejects a call to an unknown router member', () => {
    expect(resolveGlobalPath('router', ['bogus'], true, ctx).kind).to.equal('invalid');
  });

  it('rejects a call through a nested member (params is data, not an action namespace)', () => {
    expect(resolveGlobalPath('router', ['params', 'foo'], true, ctx).kind).to.equal('invalid');
  });

  it('rejects a bare "router" reference with no member', () => {
    expect(resolveGlobalPath('router', [], false, ctx).kind).to.equal('invalid');
  });
});

describe('resolveGlobalPath — task manager', () => {
  const ctx: GlobalBindingsContext = { theme: null };

  it('resolves each known action call', () => {
    expect(resolveGlobalPath('taskManager', ['run'], true, ctx)).to.deep.equal({ kind: 'task-manager-action', method: 'run' });
    expect(resolveGlobalPath('taskManager', ['cancel'], true, ctx)).to.deep.equal({ kind: 'task-manager-action', method: 'cancel' });
    expect(resolveGlobalPath('taskManager', ['setMaxConcurrent'], true, ctx)).to.deep.equal({ kind: 'task-manager-action', method: 'setMaxConcurrent' });
    expect(resolveGlobalPath('taskManager', ['setAlertThresholds'], true, ctx)).to.deep.equal({ kind: 'task-manager-action', method: 'setAlertThresholds' });
    expect(resolveGlobalPath('taskManager', ['onAlertChanged'], true, ctx)).to.deep.equal({ kind: 'task-manager-action', method: 'onAlertChanged' });
    expect(resolveGlobalPath('taskManager', ['onResult'], true, ctx)).to.deep.equal({ kind: 'task-manager-action', method: 'onResult' });
    expect(resolveGlobalPath('taskManager', ['onRequestSent'], true, ctx)).to.deep.equal({ kind: 'task-manager-action', method: 'onRequestSent' });
    expect(resolveGlobalPath('taskManager', ['onResponseReceived'], true, ctx)).to.deep.equal({ kind: 'task-manager-action', method: 'onResponseReceived' });
  });

  it('resolves each known data-read member', () => {
    expect(resolveGlobalPath('taskManager', ['runningCount'], false, ctx)).to.deep.equal({ kind: 'task-manager-data', member: 'runningCount' });
    expect(resolveGlobalPath('taskManager', ['queuedCount'], false, ctx)).to.deep.equal({ kind: 'task-manager-data', member: 'queuedCount' });
    expect(resolveGlobalPath('taskManager', ['alertLevel'], false, ctx)).to.deep.equal({ kind: 'task-manager-data', member: 'alertLevel' });
  });

  it('rejects a call to an unknown action', () => {
    expect(resolveGlobalPath('taskManager', ['bogus'], true, ctx).kind).to.equal('invalid');
  });

  it('rejects a read of an unknown data member', () => {
    expect(resolveGlobalPath('taskManager', ['bogus'], false, ctx).kind).to.equal('invalid');
  });

  it('rejects a call through more than one segment', () => {
    expect(resolveGlobalPath('taskManager', ['run', 'extra'], true, ctx).kind).to.equal('invalid');
  });

  it('rejects a data read through more than one segment — unlike router, this surface is not schemaless', () => {
    expect(resolveGlobalPath('taskManager', ['runningCount', 'extra'], false, ctx).kind).to.equal('invalid');
  });

  it('rejects a data-only member used as a call target', () => {
    expect(resolveGlobalPath('taskManager', ['runningCount'], true, ctx).kind).to.equal('invalid');
  });

  it('rejects a bare "taskManager" reference with no member', () => {
    expect(resolveGlobalPath('taskManager', [], false, ctx).kind).to.equal('invalid');
    expect(resolveGlobalPath('taskManager', [], true, ctx).kind).to.equal('invalid');
  });
});

describe('resolveGlobalPath — env', () => {
  it('rejects any env access when no environment is active (envVariableNames undefined)', () => {
    const ctx: GlobalBindingsContext = { theme: null };
    const result = resolveGlobalPath('env', ['apiKey'], false, ctx);
    expect(result.kind).to.equal('invalid');
    expect((result as { code: string }).code).to.equal('expression/env-requires-active-environment');
  });

  it('resolves a declared variable', () => {
    const ctx: GlobalBindingsContext = { theme: null, envVariableNames: new Set(['apiKey']) };
    expect(resolveGlobalPath('env', ['apiKey'], false, ctx)).to.deep.equal({ kind: 'env-data', name: 'apiKey' });
  });

  it('rejects an undeclared variable when an environment is active', () => {
    const ctx: GlobalBindingsContext = { theme: null, envVariableNames: new Set(['apiKey']) };
    const result = resolveGlobalPath('env', ['notDeclared'], false, ctx);
    expect(result.kind).to.equal('invalid');
    expect((result as { code: string }).code).to.equal('expression/unknown-env-variable');
  });

  it('rejects a multi-segment access — env variables are flat', () => {
    const ctx: GlobalBindingsContext = { theme: null, envVariableNames: new Set(['apiKey']) };
    expect(resolveGlobalPath('env', ['apiKey', 'nested'], false, ctx).kind).to.equal('invalid');
  });

  it('an environment active with zero declared variables is distinct from no environment at all', () => {
    const ctx: GlobalBindingsContext = { theme: null, envVariableNames: new Set() };
    const result = resolveGlobalPath('env', ['apiKey'], false, ctx);
    expect(result.kind).to.equal('invalid');
    expect((result as { code: string }).code).to.equal('expression/unknown-env-variable');
  });
});
