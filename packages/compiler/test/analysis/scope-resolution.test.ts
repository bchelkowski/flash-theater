import { expect } from 'chai';
import { parse, ThrFile } from 'flash-parser';
import { buildFunctionScope, buildConstructorScope, buildScriptBindings, resolveIdentifier, NO_FUNCTION_SCOPE, extendTemplateScope } from '../../src/analysis/scope-resolution.js';
import { buildThemeShape, GlobalBindingsContext } from '../../src/analysis/global-bindings.js';
import { adaptThemeTemplateSection } from '../../src/dsl-parser/dsl-parser.js';
import { parseScriptFixture } from '../helpers/parseScriptFixture.js';
import { parseClassFixture } from '../helpers/parseClassFixture.js';

function themeOnlyCtx(): GlobalBindingsContext {
  const result = parse('<theme-template>\nfontSize: integer = 16\n</theme-template>');
  return { theme: buildThemeShape(adaptThemeTemplateSection(new ThrFile(result.root).themeTemplate), []) };
}

describe('buildFunctionScope', () => {
  function functionScopeFor(scriptBody: string, functionName = 'f') {
    const script = parseScriptFixture(scriptBody);
    const fn = script.functions.find((f) => f.name === functionName)!;
    return buildFunctionScope(fn);
  }

  it('recognizes a plain local assignment as a local, even when it shadows a field name', () => {
    const scope = functionScopeFor(
      ['field total: integer = 0', 'private function f(): integer {', '  total = 5', '  return total', '}'].join('\n'),
    );

    expect(scope.hasLocal('total')).to.be.true;
  });

  it('recognizes a parameter as a local', () => {
    const scope = functionScopeFor(['private function f(value: integer): integer {', '  return value', '}'].join('\n'));

    expect(scope.hasLocal('value')).to.be.true;
  });

  it('recognizes a for each loop variable as a local', () => {
    const scope = functionScopeFor(
      ['private function f() {', '  for each (item in [1, 2, 3]) {', '    print item', '  }', '}'].join('\n'),
    );

    expect(scope.hasLocal('item')).to.be.true;
  });

  it('recognizes a numeric for loop variable as a local', () => {
    const scope = functionScopeFor(['private function f() {', '  for (i = 0 to 10) {', '    print i', '  }', '}'].join('\n'));

    expect(scope.hasLocal('i')).to.be.true;
  });

  it('recognizes a catch variable as a local', () => {
    const scope = functionScopeFor(
      ['private function f() {', '  try {', '    risky()', '  } catch (e) {', '    print e', '  }', '}'].join('\n'),
    );

    expect(scope.hasLocal('e')).to.be.true;
  });

  it('does not consider a state assignment target a local — it stays a state reference for later reads', () => {
    const scope = functionScopeFor(
      ['state count: integer = 0', 'private function f() {', '  state count = count + 1', '}'].join('\n'),
    );

    expect(scope.hasLocal('count')).to.be.false;
  });

  it('reports false for an unrelated name', () => {
    const scope = functionScopeFor(['private function f(): integer {', '  return 1', '}'].join('\n'));

    expect(scope.hasLocal('somethingElse')).to.be.false;
  });

  it('isUnused: true for a parameter never read in the body', () => {
    const scope = functionScopeFor(['private function f(value: integer) {', '  print "hi"', '}'].join('\n'));

    expect(scope.isUnused('value')).to.be.true;
  });

  it('isUnused: false for a parameter that is read', () => {
    const scope = functionScopeFor(['private function f(value: integer): integer {', '  return value', '}'].join('\n'));

    expect(scope.isUnused('value')).to.be.false;
  });

  it('isUnused: true for a local that is only ever written, never read', () => {
    const scope = functionScopeFor(['private function f() {', '  total = 0', '}'].join('\n'));

    expect(scope.isUnused('total')).to.be.true;
  });

  it('isUnused: false for a local that is written and later read', () => {
    const scope = functionScopeFor(['private function f(): integer {', '  total = 0', '  return total', '}'].join('\n'));

    expect(scope.isUnused('total')).to.be.false;
  });

  it('isUnused: false for a name that is compound-assigned — a compound assignment also reads', () => {
    const scope = functionScopeFor(['private function f(value: integer) {', '  value += 1', '}'].join('\n'));

    expect(scope.isUnused('value')).to.be.false;
  });

  it('isUnused: false for a name that is not a declared local/parameter at all', () => {
    const scope = functionScopeFor(['private function f() {', '  print "hi"', '}'].join('\n'));

    expect(scope.isUnused('somethingElse')).to.be.false;
  });
});

describe('buildConstructorScope', () => {
  function constructorScopeFor(classBody: string) {
    const classAst = parseClassFixture(classBody);
    return buildConstructorScope(classAst.constructorDecl!);
  }

  it('recognizes a constructor parameter as a local', () => {
    const scope = constructorScopeFor(['class C {', '  private x: integer = 0', '  constructor(value: integer) {', '    private x: integer = value', '  }', '}'].join('\n'));

    expect(scope.hasLocal('value')).to.be.true;
  });

  it('does NOT consider a constructor field-init target a local — mirrors state assignment\'s own ft_discard reconstruction, for the same reason: the target name is a declared field, not a local, and reconstructing it as a real assignment would wrongly shadow a later read of a same-named parameter/local', () => {
    const scope = constructorScopeFor(['class C {', '  private x: integer = 0', '  constructor(x: integer) {', '    private x: integer = x', '  }', '}'].join('\n'));

    // The constructor's own parameter is named "x", same as the field being initialized — if the
    // field-init's target were wrongly reconstructed as a plain assignment, buildScopes would see
    // two conflicting declarations of "x" instead of one real parameter, potentially masking the
    // parameter itself. hasLocal must still report true here because "x" the *parameter* is real,
    // not because the field-init created a second one.
    expect(scope.hasLocal('x')).to.be.true;
  });

  it('isUnused: true for a constructor parameter never read in the body', () => {
    const scope = constructorScopeFor(['class C {', '  private x: integer = 0', '  constructor(value: integer) {', '    private x: integer = 0', '  }', '}'].join('\n'));

    expect(scope.isUnused('value')).to.be.true;
  });

  it('isUnused: false for a constructor parameter read inside a field-init expression', () => {
    const scope = constructorScopeFor(['class C {', '  private x: integer = 0', '  constructor(value: integer) {', '    private x: integer = value', '  }', '}'].join('\n'));

    expect(scope.isUnused('value')).to.be.false;
  });
});

describe('resolveIdentifier', () => {
  it('lets a local/parameter shadow a same-named DSL binding', () => {
    const script = parseScriptFixture('field x: integer = 0');
    const bindings = buildScriptBindings(script);
    const localScope = { hasLocal: (name: string) => name === 'x', isUnused: () => false };

    expect(resolveIdentifier('x', bindings, localScope)).to.deep.equal({ kind: 'local', replacement: null });
  });

  it('resolves m as special, never a hard error', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field x: integer = 0'));

    expect(resolveIdentifier('m', bindings, NO_FUNCTION_SCOPE)).to.deep.equal({ kind: 'special', replacement: null });
  });

  it('resolves a BrightScript builtin case-insensitively', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field x: integer = 0'));

    expect(resolveIdentifier('UCase', bindings, NO_FUNCTION_SCOPE).kind).to.equal('builtin');
    expect(resolveIdentifier('ucase', bindings, NO_FUNCTION_SCOPE).kind).to.equal('builtin');
  });

  it('resolves an unrelated name as unresolved', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field x: integer = 0'));

    expect(resolveIdentifier('totallyUnknown', bindings, NO_FUNCTION_SCOPE)).to.deep.equal({ kind: 'unresolved', replacement: null });
  });

  it('leaves an already-rewritten private-function name (private_<name>) untouched on a re-scan, rather than treating it as a fresh unresolved identifier', () => {
    // Regression coverage for a real bug: a bare/called private-function reference embedded inside
    // another rewrite's own composed replacement text (buildRouterActionReplacement's/
    // buildTaskManagerOnAlertChangedReplacement's argument pre-rewriting) gets scanned a SECOND time
    // by the outer applyIdentifierRewrite pass — confirmed live as `router.navigate(getPath())`
    // throwing expression/unresolved-identifier on "private_getPath" before this fix.
    const bindings = buildScriptBindings(parseScriptFixture('private function getPath() {\n  return "/browse"\n}'));
    expect(resolveIdentifier('private_getPath', bindings, NO_FUNCTION_SCOPE)).to.deep.equal({ kind: 'private-function', replacement: null });
  });

  it('still resolves a private function literally named private_<x> to its own rewritten name, not the fallback', () => {
    const bindings = buildScriptBindings(parseScriptFixture('private function private_getPath() {\n  return "/browse"\n}'));
    expect(resolveIdentifier('private_getPath', bindings, NO_FUNCTION_SCOPE)).to.deep.equal({ kind: 'private-function', replacement: 'private_private_getPath' });
  });

  it('resolves a bare "theme" to m.global.ft_theme when a theme-template exists in the app', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field x: integer = 0'));
    expect(resolveIdentifier('theme', bindings, NO_FUNCTION_SCOPE, themeOnlyCtx())).to.deep.equal({ kind: 'theme', replacement: 'm.global.ft_theme' });
  });

  it('resolves "theme" as unresolved when no <theme-template> exists in the app', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field x: integer = 0'));
    expect(resolveIdentifier('theme', bindings, NO_FUNCTION_SCOPE, { theme: null }).kind).to.equal('unresolved');
  });

  it('resolves a bare "store" as unresolved — it is a reserved keyword with no meaning as a plain identifier', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field x: integer = 0'));
    expect(resolveIdentifier('store', bindings, NO_FUNCTION_SCOPE, themeOnlyCtx()).kind).to.equal('unresolved');
  });

  it('resolves a bare "router" to m.global.ft_router unconditionally — no <theme-template> precondition, unlike "theme"', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field x: integer = 0'));
    expect(resolveIdentifier('router', bindings, NO_FUNCTION_SCOPE, { theme: null })).to.deep.equal({ kind: 'router', replacement: 'm.global.ft_router' });
  });

  it('resolves a bare "taskManager" to m.global.ft_taskManager unconditionally, same treatment as "router"', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field x: integer = 0'));
    expect(resolveIdentifier('taskManager', bindings, NO_FUNCTION_SCOPE, { theme: null })).to.deep.equal({ kind: 'taskManager', replacement: 'm.global.ft_taskManager' });
  });

  it('resolves bare "router"/"taskManager"/"theme" through GetGlobalAA().global when globalBindings.accessRoot says so — the .flsh class access root', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field x: integer = 0'));
    const classCtx = { theme: null, accessRoot: 'GetGlobalAA().global' as const };
    expect(resolveIdentifier('router', bindings, NO_FUNCTION_SCOPE, classCtx)).to.deep.equal({ kind: 'router', replacement: 'GetGlobalAA().global.ft_router' });
    expect(resolveIdentifier('taskManager', bindings, NO_FUNCTION_SCOPE, classCtx)).to.deep.equal({ kind: 'taskManager', replacement: 'GetGlobalAA().global.ft_taskManager' });
  });

  it('resolves a stream reference to m.<name>, same as derived, and excludes it from reactiveSourceNames', () => {
    const script = parseScriptFixture('stream dataLoaded: string');
    const bindings = buildScriptBindings(script);

    expect(resolveIdentifier('dataLoaded', bindings, NO_FUNCTION_SCOPE)).to.deep.equal({ kind: 'stream', replacement: 'm.dataLoaded' });
    expect(bindings.streamNames.has('dataLoaded')).to.be.true;
    expect(bindings.reactiveSourceNames.has('dataLoaded')).to.be.false;
  });

  it('resolves a compiler-synthesized ft_-prefixed name (a hoisted ternary temp var) as an already-valid local, before even consulting functionScope', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field x: integer = 0'));
    // A FunctionScope that would throw if ever asked about this name — proves the reserved-prefix
    // short-circuit in resolveIdentifier fires first, since ft_ternary_1 never appears in real DSL
    // source (see codegen/brs-emitter.ts's lowerTernaryRhs) and so could never be a genuine
    // buildFunctionScope-recognized local.
    const scopeThatWouldThrow = {
      hasLocal(): boolean {
        throw new Error('should never be asked about a reserved identifier');
      },
      isUnused: () => false,
    };
    expect(resolveIdentifier('ft_ternary_1', bindings, scopeThatWouldThrow)).to.deep.equal({ kind: 'local', replacement: null });
  });
});

describe('extendTemplateScope', () => {
  it('resolves the item alias as a local, shadowing a same-named DSL binding', () => {
    const bindings = buildScriptBindings(parseScriptFixture('field item: integer = 0'));
    const scope = extendTemplateScope('item');

    expect(scope.hasLocal('item')).to.be.true;
    expect(resolveIdentifier('item', bindings, scope)).to.deep.equal({ kind: 'local', replacement: null });
  });

  it('does not resolve an unrelated name as a local', () => {
    const scope = extendTemplateScope('item');
    expect(scope.hasLocal('somethingElse')).to.be.false;
  });

  it('never reports the item alias as unused — there is no "_"-prefix pruning concept for a loop item', () => {
    const scope = extendTemplateScope('item');
    expect(scope.isUnused('item')).to.be.false;
  });

  it('nests correctly: an inner scope with the same alias name shadows the outer one', () => {
    const outer = extendTemplateScope('item');
    const inner = extendTemplateScope('item', outer);
    expect(inner.hasLocal('item')).to.be.true;
  });

  it('nests correctly: an inner scope with a different alias name still resolves the outer alias by delegating', () => {
    const outer = extendTemplateScope('day');
    const inner = extendTemplateScope('event', outer);
    expect(inner.hasLocal('event')).to.be.true;
    expect(inner.hasLocal('day')).to.be.true;
    expect(inner.hasLocal('somethingElse')).to.be.false;
  });

  it('composes with a parent FunctionScope — a real BrightScript local from the parent is still recognized', () => {
    const parent = { hasLocal: (name: string) => name === 'total', isUnused: () => false };
    const scope = extendTemplateScope('item', parent);
    expect(scope.hasLocal('item')).to.be.true;
    expect(scope.hasLocal('total')).to.be.true;
    expect(scope.hasLocal('somethingElse')).to.be.false;
  });
});
