import { expect } from 'chai';
import { parse, ThrFile } from 'flash-parser';
import {
  rewriteExpression,
  rewriteStatement,
  rewriteStorePathRead,
  validateAndRewriteGlobalPaths,
  isRouterNavigationStatement,
} from '../../src/analysis/identifier-rewrite.js';
import { buildScriptBindings, FunctionScope, NO_FUNCTION_SCOPE } from '../../src/analysis/scope-resolution.js';
import { buildThemeShape, GlobalBindingsContext } from '../../src/analysis/global-bindings.js';
import { adaptThemeTemplateSection } from '../../src/dsl-parser/dsl-parser.js';
import { CompileError, FieldDecl, FunctionDecl, DerivedDecl, StateDecl, StreamDecl, AnimationDecl, ThrScriptAst } from '../../src/dsl-parser/dsl-ast.js';

const SPAN = { line: 0 };

function field(name: string): FieldDecl {
  return { kind: 'field', name, type: 'float', defaultLiteral: '0.0', span: SPAN };
}

function derived(name: string): DerivedDecl {
  return { kind: 'derived', name, type: 'float', expression: '', span: SPAN };
}

function state(name: string): StateDecl {
  return { kind: 'state', name, type: 'float', defaultLiteral: '0.0', span: SPAN };
}

function stream(name: string): StreamDecl {
  return { kind: 'stream', name, type: 'string', span: SPAN };
}

function animation(name: string): AnimationDecl {
  return { kind: 'animation', name, configText: '{}', span: SPAN };
}

function fn(name: string, visibility: 'private' | 'public'): FunctionDecl {
  return { kind: 'function', visibility, name, params: [], returnType: 'string', body: '', span: SPAN };
}

function script(overrides: Partial<ThrScriptAst>): ThrScriptAst {
  return { imports: [], fields: [], derived: [], state: [], reads: [], watches: [], streams: [], request: null, animations: [], functions: [], ...overrides };
}

/** Test-only stand-in for a real BrightScript scope — `buildFunctionScope` itself is exercised via brs-emitter's golden fixtures. */
function scopeWithLocals(...names: string[]): FunctionScope {
  const set = new Set(names);
  return { hasLocal: (name) => set.has(name), isUnused: () => false };
}

describe('rewriteExpression', () => {
  it('rewrites a field reference to m.top.<name>', () => {
    const result = rewriteExpression('focusPercent', buildScriptBindings(script({ fields: [field('focusPercent')] })), 'derived isGridFocused');

    expect(result).to.equal('m?.top?.focusPercent');
  });

  it('rewrites a derived reference to m.<name>', () => {
    const result = rewriteExpression('isGridFocused', buildScriptBindings(script({ derived: [derived('isGridFocused')] })), 'derived highlightOpacity');

    expect(result).to.equal('m?.isGridFocused');
  });

  it('rewrites a state reference to m.<name>, same as derived', () => {
    const result = rewriteExpression('count', buildScriptBindings(script({ state: [state('count')] })), 'derived doubled');

    expect(result).to.equal('m?.count');
  });

  it('rewrites a private function call to its private_-prefixed name and rewrites field args', () => {
    const result = rewriteExpression(
      'pickColor(gridHasFocus, "0x0057FFFF", "0x3A3A3AFF")',
      buildScriptBindings(script({ fields: [field('gridHasFocus')], functions: [fn('pickColor', 'private')] })),
      'derived highlightColor',
    );

    expect(result).to.equal('private_pickColor(m?.top?.gridHasFocus, "0x0057FFFF", "0x3A3A3AFF")');
  });

  it('leaves a public function name unchanged', () => {
    const result = rewriteExpression(
      'formatTitle(itemContent)',
      buildScriptBindings(script({ fields: [field('itemContent')], functions: [fn('formatTitle', 'public')] })),
      'x',
    );

    expect(result).to.equal('formatTitle(m?.top?.itemContent)');
  });

  it('leaves a BrightScript builtin and m untouched', () => {
    const result = rewriteExpression('UCase(m.top.dayName)', buildScriptBindings(script({})), 'itemContentDayName body');

    expect(result).to.equal('UCase(m?.top?.dayName)');
  });

  it('rewrites every field reference inside an array literal', () => {
    const result = rewriteExpression(
      '[width / 2, height / 2]',
      buildScriptBindings(script({ fields: [field('width'), field('height')] })),
      'translation binding',
    );

    expect(result).to.equal('[m?.top?.width / 2, m?.top?.height / 2]');
  });

  it('rewrites multiple distinct binding kinds within the same expression', () => {
    const result = rewriteExpression(
      'pickOpacity(isGridFocused)',
      buildScriptBindings(script({ derived: [derived('isGridFocused')], functions: [fn('pickOpacity', 'private')] })),
      'derived highlightOpacity',
    );

    expect(result).to.equal('private_pickOpacity(m?.isGridFocused)');
  });

  it('leaves a name unrewritten when it is a local, even though it also matches a field', () => {
    const result = rewriteExpression(
      'enabled',
      buildScriptBindings(script({ fields: [field('enabled')] })),
      'function echo if-condition',
      scopeWithLocals('enabled'),
    );

    expect(result).to.equal('enabled');
  });

  it('throws expression/unresolved-identifier for a name that is nothing at all', () => {
    expect(() => rewriteExpression('totallyUnknownName', buildScriptBindings(script({})), 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/unresolved-identifier' });
  });

  it('lowers a stream .subscribe(m.methodName) bound reference to a { target, action } descriptor', () => {
    const result = rewriteExpression('dataLoaded.subscribe(m.onDataLoaded)', buildScriptBindings(script({ streams: [stream('dataLoaded')] })), 'x');
    expect(result).to.equal('m?.dataLoaded?.subscribe?({ target: m, action: "onDataLoaded" })');
  });

  it('rewrites the target sub-expression through the full pipeline before splicing', () => {
    const result = rewriteExpression(
      'dataLoaded.subscribe(subscriberField.onChanged)',
      buildScriptBindings(script({ streams: [stream('dataLoaded')], fields: [field('subscriberField')] })),
      'x',
    );
    expect(result).to.equal('m?.dataLoaded?.subscribe?({ target: m?.top?.subscriberField, action: "onChanged" })');
  });

  it('does not touch a plain anonymous-function .subscribe(...) argument', () => {
    const result = rewriteExpression(
      'dataLoaded.subscribe(function (value: string) { return value })',
      buildScriptBindings(script({ streams: [stream('dataLoaded')] })),
      'x',
    );
    expect(result).to.equal('m?.dataLoaded?.subscribe?(function (value: string) { return value })');
  });

  it('rejects an animation .start() call nested inside a larger expression — a "control" write has no value to embed', () => {
    expect(() => rewriteExpression('not bounce.start()', buildScriptBindings(script({ animations: [animation('bounce')] })), 'derived x')).to.throw(
      /animation-control-call-must-be-statement|must be a statement of its own/,
    );
  });

  it('leaves a bare animation reference (no trailing .start()/etc.) resolved to the raw generated node', () => {
    const result = rewriteExpression('bounce', buildScriptBindings(script({ animations: [animation('bounce')] })), 'x');
    expect(result).to.equal('m?["$$ft_anim_bounce"]');
  });

  it('does not touch an unrelated .start() call on a non-animation object — ordinary passthrough, no rewrite applied', () => {
    const result = rewriteExpression('someTask.start()', buildScriptBindings(script({ fields: [field('someTask')], animations: [animation('bounce')] })), 'x');
    expect(result).to.equal('m?.top?.someTask?.start?()');
  });
});

describe('rewriteStatement', () => {
  it('rewrites a field reference inside a return statement', () => {
    const result = rewriteStatement('return score', buildScriptBindings(script({ fields: [field('score')] })), 'function describe');

    expect(result).to.equal('return m?.top?.score');
  });

  it('rewrites a derived reference nested inside a call argument', () => {
    const result = rewriteStatement(
      'return "on: " + str(doubled)',
      buildScriptBindings(script({ derived: [derived('doubled')] })),
      'function describe',
    );

    expect(result).to.equal('return "on: " + str(m?.doubled)');
  });

  it('leaves a parameter that shadows a field name unrewritten', () => {
    const result = rewriteStatement(
      'return score',
      buildScriptBindings(script({ fields: [field('score')] })),
      'function echoScore',
      scopeWithLocals('score'),
    );

    expect(result).to.equal('return score');
  });

  it('leaves a plain local variable (not a param, not a DSL binding) unrewritten', () => {
    const result = rewriteStatement(
      'return total',
      buildScriptBindings(script({ fields: [field('total')] })),
      'function tally',
      scopeWithLocals('total'),
    );

    expect(result).to.equal('return total');
  });

  it('throws expression/unresolved-identifier for a name that is nothing at all', () => {
    expect(() => rewriteStatement('return totallyUnknownName', buildScriptBindings(script({})), 'function describe'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/unresolved-identifier' });
  });

  it('lowers bounce.start() (its own statement line) to a control field write on the generated Animation node', () => {
    const result = rewriteStatement('bounce.start()', buildScriptBindings(script({ animations: [animation('bounce')] })), 'function play');
    expect(result).to.equal('m["$$ft_anim_bounce"].control = "start"');
  });

  it('supports every one of the five control methods, mapping 1:1 onto Roku\'s own control field values', () => {
    for (const method of ['start', 'stop', 'pause', 'resume', 'finish']) {
      const result = rewriteStatement(`bounce.${method}()`, buildScriptBindings(script({ animations: [animation('bounce')] })), 'function play');
      expect(result).to.equal(`m["$$ft_anim_bounce"].control = "${method}"`);
    }
  });

  it('rejects bounce.start() used as an assignment right-hand side — a "control" write is a statement, not a value', () => {
    expect(() => rewriteStatement('handled = bounce.start()', buildScriptBindings(script({ animations: [animation('bounce')] })), 'function play')).to.throw(
      /animation-control-call-must-be-statement|must be a statement of its own/,
    );
  });

  it('does not recognize a chained call as trigger sugar — only a bare, directly-named animation can be triggered, never x.y.start()', () => {
    // `someObject.bounce.start()`'s callee object (`someObject.bounce`) is a dot-chain, not a bare
    // identifier — findAnimationControlCalls requires a bare identifier immediately before the
    // final dot (see its own doc comment), so this is left completely untouched by the animation
    // rewrite and falls through to the ordinary identifier scan instead, where `someObject` is
    // genuinely unresolved. The failure mode proves the point: it's expression/unresolved-identifier,
    // never expression/animation-control-call-must-be-statement.
    expect(() => rewriteStatement('someObject.bounce.start()', buildScriptBindings(script({ animations: [animation('bounce')] })), 'function play'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/unresolved-identifier' });
  });
});

describe('rewriteStatement / rewriteExpression — clearTimeout / clearInterval', () => {
  const NO_TIMER_BINDINGS = buildScriptBindings(script({}));

  it('splices clearTimeout(<handle>) into a delete-then-stop colon-chain', () => {
    const result = rewriteStatement('clearTimeout(m.pollHandle)', NO_TIMER_BINDINGS, 'function halt');
    expect(result).to.equal('ft_timerHandle = m?.pollHandle : m["$$ft_timerCallbacks"].Delete(ft_timerHandle?.id) : ft_timerHandle.control = "stop"');
  });

  it('splices clearInterval(<handle>) the identical way', () => {
    const result = rewriteStatement('clearInterval(m.pollHandle)', NO_TIMER_BINDINGS, 'function halt');
    expect(result).to.equal('ft_timerHandle = m?.pollHandle : m["$$ft_timerCallbacks"].Delete(ft_timerHandle?.id) : ft_timerHandle.control = "stop"');
  });

  it('recurses the handle argument through rewriteExpression — a bare local resolves through the function scope', () => {
    const result = rewriteStatement('clearTimeout(t)', NO_TIMER_BINDINGS, 'function halt', scopeWithLocals('t'));
    expect(result).to.equal('ft_timerHandle = t : m["$$ft_timerCallbacks"].Delete(ft_timerHandle?.id) : ft_timerHandle.control = "stop"');
  });

  it('rejects clearTimeout(...) used as an assignment right-hand side — a "control" write is a statement, not a value', () => {
    expect(() => rewriteStatement('ok = clearTimeout(m.pollHandle)', NO_TIMER_BINDINGS, 'function halt')).to.throw(CompileError).with.property('diagnostic').that.deep.include({
      code: 'expression/timer-clear-call-must-be-statement',
    });
  });

  it('rejects clearTimeout(...) inside a derived/template expression — clearing a timer is a one-time action, not a computed value', () => {
    expect(() => rewriteExpression('clearTimeout(m.pollHandle)', NO_TIMER_BINDINGS, 'derived x')).to.throw(CompileError).with.property('diagnostic').that.deep.include({
      code: 'expression/timer-clear-call-in-reactive-expression',
    });
  });

  it('rejects the wrong argument count', () => {
    expect(() => rewriteStatement('clearTimeout(m.a, m.b)', NO_TIMER_BINDINGS, 'function halt')).to.throw(CompileError).with.property('diagnostic').that.deep.include({
      code: 'expression/invalid-clear-timeout-arguments',
    });
  });
});

function themeCtx(body: string): GlobalBindingsContext {
  const result = parse(`<theme-template>\n${body}\n</theme-template>`);
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics[0].message);
  return { theme: buildThemeShape(adaptThemeTemplateSection(new ThrFile(result.root).themeTemplate), []) };
}

const NO_THEME: GlobalBindingsContext = { theme: null };
const NO_BINDINGS = buildScriptBindings(script({}));

describe('validateAndRewriteGlobalPaths — theme (store is no longer a generic dot-chain scan target)', () => {
  it('rewrites a nested theme leaf read to m.global.ft_theme.<path>', () => {
    const ctx = themeCtx('colors: {\n  primary: string = "#fff"\n}');
    expect(validateAndRewriteGlobalPaths('theme.colors.primary', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, ctx, 'derived x')).to.equal('m.global.ft_theme.colors.primary');
  });

  it('leaves text with no theme access untouched', () => {
    expect(validateAndRewriteGlobalPaths('width + height', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'derived x')).to.equal('width + height');
  });

  it('throws expression/theme-path-through-leaf when indexing past a theme leaf', () => {
    const ctx = themeCtx('fontSize: integer = 16');
    expect(() => validateAndRewriteGlobalPaths('theme.fontSize.nested', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, ctx, 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/theme-path-through-leaf' });
  });

  it('throws expression/unknown-theme-member for an undeclared theme member', () => {
    const ctx = themeCtx('fontSize: integer = 16');
    expect(() => validateAndRewriteGlobalPaths('theme.nope', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, ctx, 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/unknown-theme-member' });
  });

  it('throws expression/unknown-theme-member when a theme path is called — theme has no functions', () => {
    const ctx = themeCtx('fontSize: integer = 16');
    expect(() => validateAndRewriteGlobalPaths('theme.fontSize()', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, ctx, 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/unknown-theme-member' });
  });

  it('throws expression/unknown-theme-member when no <theme-template> exists but theme is referenced', () => {
    expect(() => validateAndRewriteGlobalPaths('theme.fontSize', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/unknown-theme-member' });
  });
});

describe('validateAndRewriteGlobalPaths — env', () => {
  function envCtx(names: string[]): GlobalBindingsContext {
    return { theme: null, envVariableNames: new Set(names) };
  }

  it('rewrites a declared env variable read to m.global.ft_env.<name>', () => {
    const ctx = envCtx(['apiKey']);
    expect(validateAndRewriteGlobalPaths('env.apiKey', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, ctx, 'derived x')).to.equal('m.global.ft_env.apiKey');
  });

  it('leaves the rest of a larger expression untouched around the splice', () => {
    const ctx = envCtx(['apiBaseUrl']);
    expect(validateAndRewriteGlobalPaths('"API: " + env.apiBaseUrl', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, ctx, 'derived x')).to.equal(
      '"API: " + m.global.ft_env.apiBaseUrl',
    );
  });

  it('throws expression/env-requires-active-environment when no environment is active', () => {
    expect(() => validateAndRewriteGlobalPaths('env.apiKey', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/env-requires-active-environment' });
  });

  it('throws expression/unknown-env-variable for an undeclared variable', () => {
    const ctx = envCtx(['apiKey']);
    expect(() => validateAndRewriteGlobalPaths('env.notDeclared', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, ctx, 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/unknown-env-variable' });
  });

  it('throws expression/env-not-callable when an env variable is called like a function', () => {
    const ctx = envCtx(['apiKey']);
    expect(() => validateAndRewriteGlobalPaths('env.apiKey()', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, ctx, 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/env-not-callable' });
  });

  it('leaves text with no env access untouched', () => {
    const ctx = envCtx(['apiKey']);
    expect(validateAndRewriteGlobalPaths('width + height', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, ctx, 'derived x')).to.equal('width + height');
  });
});

describe('validateAndRewriteGlobalPaths — router', () => {
  it('rewrites a router data read to m.global.ft_router.activatedRoute.<path>', () => {
    expect(validateAndRewriteGlobalPaths('router.path', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'derived x')).to.equal(
      'm.global.ft_router.activatedRoute.path',
    );
    expect(validateAndRewriteGlobalPaths('router.params.day', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f')).to.equal(
      'm.global.ft_router.activatedRoute.params.day',
    );
  });

  it('rewrites router.isBackJourney the same schemaless way — no member whitelist restricts which activatedRoute field can be read', () => {
    expect(validateAndRewriteGlobalPaths('router.isBackJourney', 'expression', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f')).to.equal(
      'm.global.ft_router.activatedRoute.isBackJourney',
    );
  });

  it('rewrites router.navigate(path) — packing a single positional argument into {path:, params: {}, skipInHistory: false}', () => {
    expect(validateAndRewriteGlobalPaths('router.navigate("/browse")', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f')).to.equal(
      'm.global.ft_router.callFunc("navigate", {path: "/browse", params: {}, skipInHistory: false})',
    );
  });

  it('rewrites router.navigate(path, params) — packing both positional arguments into one AA argument', () => {
    expect(
      validateAndRewriteGlobalPaths('router.navigate("/browse/schedule", {day: "Mon"})', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f'),
    ).to.equal('m.global.ft_router.callFunc("navigate", {path: "/browse/schedule", params: {day: "Mon"}, skipInHistory: false})');
  });

  it('rewrites router.navigate(path, params, skipInHistory) — the three-argument form', () => {
    expect(
      validateAndRewriteGlobalPaths(
        'router.navigate("/browse/detail", {id: "5"}, true)',
        'statement',
        NO_BINDINGS,
        NO_FUNCTION_SCOPE,
        NO_THEME,
        'function f',
      ),
    ).to.equal('m.global.ft_router.callFunc("navigate", {path: "/browse/detail", params: {id: "5"}, skipInHistory: true})');
  });

  it('throws expression/invalid-router-navigate-arguments for more than three arguments', () => {
    expect(() => validateAndRewriteGlobalPaths('router.navigate("/x", {}, true, "extra")', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/invalid-router-navigate-arguments' });
  });

  it('rewrites router.back() — zero-argument callFunc, no trailing comma', () => {
    expect(validateAndRewriteGlobalPaths('router.back()', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f')).to.equal(
      'm.global.ft_router.callFunc("back")',
    );
  });

  it('rewrites router.resetHistory() and router.resetHistory(rootPath)', () => {
    expect(validateAndRewriteGlobalPaths('router.resetHistory()', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f')).to.equal(
      'm.global.ft_router.callFunc("resetHistory", "")',
    );
    expect(validateAndRewriteGlobalPaths('router.resetHistory("/home")', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f')).to.equal(
      'm.global.ft_router.callFunc("resetHistory", "/home")',
    );
  });

  it('rewrites router.setRouting(routes) — single argument passthrough, same treatment as appendBackJourneyData', () => {
    expect(
      validateAndRewriteGlobalPaths(
        'router.setRouting([{path: "browse", component: "Shell"}])',
        'statement',
        NO_BINDINGS,
        NO_FUNCTION_SCOPE,
        NO_THEME,
        'function f',
      ),
    ).to.equal('m.global.ft_router.callFunc("setRouting", [{path: "browse", component: "Shell"}])');
  });

  it('rewrites router.appendBackJourneyData(data)/router.updateBackJourneyData(data) — single argument passthrough', () => {
    expect(
      validateAndRewriteGlobalPaths('router.appendBackJourneyData({scrollPos: 40})', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f'),
    ).to.equal('m.global.ft_router.callFunc("appendBackJourneyData", {scrollPos: 40})');
    expect(
      validateAndRewriteGlobalPaths('router.updateBackJourneyData({scrollPos: 40})', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f'),
    ).to.equal('m.global.ft_router.callFunc("updateBackJourneyData", {scrollPos: 40})');
  });

  it('rewrites a field reference inside a router.navigate(...) argument through the normal identifier-rewrite path', () => {
    const result = validateAndRewriteGlobalPaths(
      'router.navigate(targetPath)',
      'statement',
      buildScriptBindings(script({ fields: [field('targetPath')] })),
      NO_FUNCTION_SCOPE,
      NO_THEME,
      'function f',
    );
    expect(result).to.equal('m.global.ft_router.callFunc("navigate", {path: m.top.targetPath, params: {}, skipInHistory: false})');
  });

  it('correctly rewrites a router data read nested inside a router.navigate(...) argument, without corrupting either span', () => {
    const result = validateAndRewriteGlobalPaths(
      'router.navigate("/x", {from: router.path})',
      'statement',
      NO_BINDINGS,
      NO_FUNCTION_SCOPE,
      NO_THEME,
      'function f',
    );
    expect(result).to.equal(
      'm.global.ft_router.callFunc("navigate", {path: "/x", params: {from: m.global.ft_router.activatedRoute.path}, skipInHistory: false})',
    );
  });

  it('throws expression/unknown-router-action for an unrecognized action name', () => {
    expect(() => validateAndRewriteGlobalPaths('router.bogus()', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/unknown-router-action' });
  });

  it('throws expression/invalid-router-navigate-arguments for zero arguments', () => {
    expect(() => validateAndRewriteGlobalPaths('router.navigate()', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/invalid-router-navigate-arguments' });
  });

  it('throws expression/invalid-router-back-arguments when back() is given an argument', () => {
    expect(() => validateAndRewriteGlobalPaths('router.back(true)', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/invalid-router-back-arguments' });
  });

  it('throws expression/invalid-router-action-arguments when appendBackJourneyData is given zero arguments', () => {
    expect(() => validateAndRewriteGlobalPaths('router.appendBackJourneyData()', 'statement', NO_BINDINGS, NO_FUNCTION_SCOPE, NO_THEME, 'function f'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/invalid-router-action-arguments' });
  });

});

describe('rewriteExpression / rewriteStatement — theme globalBindings threading', () => {
  it('rewrites a bare theme reference (no member) to m.global.ft_theme via resolveIdentifier', () => {
    const ctx = themeCtx('fontSize: integer = 16');
    const result = rewriteExpression('theme', buildScriptBindings(script({})), 'derived x', undefined, ctx);
    expect(result).to.equal('m?.global?.ft_theme');
  });

  it('a component field literally named "theme" shadows the bare global reference', () => {
    const ctx = themeCtx('fontSize: integer = 16');
    const result = rewriteExpression('theme', buildScriptBindings(script({ fields: [field('theme')] })), 'derived x', undefined, ctx);
    expect(result).to.equal('m?.top?.theme');
  });

  it('rewrites a full theme.leaf read end to end through rewriteExpression', () => {
    const ctx = themeCtx('fontSize: integer = 16');
    const result = rewriteExpression('theme.fontSize + 1', buildScriptBindings(script({})), 'derived x', undefined, ctx);
    expect(result).to.equal('m?.global?.ft_theme?.fontSize + 1');
  });
});

describe('rewriteExpression / rewriteStatement — router globalBindings threading', () => {
  it('rewrites a bare router reference (no member) to m.global.ft_router via resolveIdentifier', () => {
    const result = rewriteExpression('router', buildScriptBindings(script({})), 'derived x');
    expect(result).to.equal('m?.global?.ft_router');
  });

  it('a component field literally named "router" shadows the bare global reference', () => {
    const result = rewriteExpression('router', buildScriptBindings(script({ fields: [field('router')] })), 'derived x');
    expect(result).to.equal('m?.top?.router');
  });

  it('rewrites a full router.navigate(...) call end to end through rewriteStatement', () => {
    const result = rewriteStatement('router.navigate("/browse")', buildScriptBindings(script({})), 'function goToBrowse');
    expect(result).to.equal('m.global.ft_router.callFunc("navigate", {path: "/browse", params: {}, skipInHistory: false})');
  });

  it('rewrites a full router.back() call end to end through rewriteStatement', () => {
    const result = rewriteStatement('router.back()', buildScriptBindings(script({})), 'function goBack');
    expect(result).to.equal('m.global.ft_router.callFunc("back")');
  });

  it('rejects a route change nested inside a larger expression — it needs a sibling statement for the focus hand-off', () => {
    expect(() => rewriteExpression('not router.back()', buildScriptBindings(script({})), 'function goBack if-condition')).to.throw(
      /router-action-must-be-statement|must be a statement of its own/,
    );
  });

  it('rejects a route change used as an assignment right-hand side, for the same reason', () => {
    expect(() => rewriteStatement('handled = router.back()', buildScriptBindings(script({})), 'function goBack')).to.throw(
      /router-action-must-be-statement|must be a statement of its own/,
    );
  });

  it('still allows a non-mounting router action (updateBackJourneyData) nested in an expression — it changes no route, so it needs no focus hand-off', () => {
    const result = rewriteExpression('router.updateBackJourneyData({a: 1}) <> invalid', buildScriptBindings(script({})), 'derived x');
    expect(result).to.equal('m?.global?.ft_router?.callFunc?("updateBackJourneyData", {a: 1}) <> invalid');
  });
});

describe('isRouterNavigationStatement', () => {
  it('is true for a bare router.navigate(...) / router.back() statement', () => {
    expect(isRouterNavigationStatement('router.navigate("/browse")')).to.equal(true);
    expect(isRouterNavigationStatement('router.back()')).to.equal(true);
  });

  it('is false for a router action that mounts nothing, and for unrelated statements', () => {
    expect(isRouterNavigationStatement('router.updateBackJourneyData({a: 1})')).to.equal(false);
    expect(isRouterNavigationStatement('router.setRouting([])')).to.equal(false);
    expect(isRouterNavigationStatement('x = 1')).to.equal(false);
  });

  it('is false for a router data read — those never mount anything', () => {
    expect(isRouterNavigationStatement('x = router.params.day')).to.equal(false);
  });
});

describe('rewriteStorePathRead', () => {
  it('joins a single-segment path onto the fixed runtime Store node', () => {
    expect(rewriteStorePathRead(['favoriteCount'])).to.equal('m.global.ft_store.favoriteCount');
  });

  it('joins a multi-segment (nested) path unchecked — the store is schemaless past segment 1', () => {
    expect(rewriteStorePathRead(['some', 'nested', 'value'])).to.equal('m.global.ft_store.some.nested.value');
  });
});

describe('rewriteExpression / rewriteStatement — == / != crash-safe comparison sugar', () => {
  it('lowers == to ft_equals(left, right)', () => {
    expect(rewriteExpression('1 == 2', NO_BINDINGS, 'derived x')).to.equal('ft_equals(1, 2)');
  });

  it('lowers != to Not ft_equals(left, right)', () => {
    expect(rewriteExpression('1 != 2', NO_BINDINGS, 'derived x')).to.equal('Not ft_equals(1, 2)');
  });

  it('rewrites a field/derived operand on both sides, just like any other expression', () => {
    const result = rewriteExpression(
      'count == total',
      buildScriptBindings(script({ fields: [field('count')], derived: [derived('total')] })),
      'derived isDone',
    );
    expect(result).to.equal('ft_equals(m?.top?.count, m?.total)');
  });

  it('supports arbitrary expressions on both operands, not just identifiers/literals', () => {
    const result = rewriteExpression(
      '(count + 1) == (total * 2)',
      buildScriptBindings(script({ fields: [field('count')], derived: [derived('total')] })),
      'derived isDone',
    );
    expect(result).to.equal('ft_equals((m?.top?.count + 1), (m?.total * 2))');
  });

  it('lowers a comparison nested inside a call argument', () => {
    const result = rewriteExpression('pickColor(count == 5)', buildScriptBindings(script({ fields: [field('count')], functions: [fn('pickColor', 'private')] })), 'x');
    expect(result).to.equal('private_pickColor(ft_equals(m?.top?.count, 5))');
  });

  it('lowers two independent (sibling) comparisons combined with and/or', () => {
    const result = rewriteExpression('(a == 1) and (b != 2)', buildScriptBindings(script({ fields: [field('a'), field('b')] })), 'derived x');
    expect(result).to.equal('(ft_equals(m?.top?.a, 1)) and (Not ft_equals(m?.top?.b, 2))');
  });

  it('lowers a nested comparison inside another comparison operand', () => {
    const result = rewriteExpression('(a == 1) == b', buildScriptBindings(script({ fields: [field('a'), field('b')] })), 'derived x');
    expect(result).to.equal('ft_equals((ft_equals(m?.top?.a, 1)), m?.top?.b)');
  });

  it('rewrites a theme access nested inside a comparison operand', () => {
    const ctx = themeCtx('fontSize: integer = 16');
    const result = rewriteExpression('theme.fontSize == 16', NO_BINDINGS, 'derived x', undefined, ctx);
    expect(result).to.equal('ft_equals(m?.global?.ft_theme?.fontSize, 16)');
  });

  it('lowers == inside a function-body statement via rewriteStatement', () => {
    const result = rewriteStatement('return count == 5', buildScriptBindings(script({ fields: [field('count')] })), 'function isFive');
    expect(result).to.equal('return ft_equals(m?.top?.count, 5)');
  });

  it('throws expression/parse-error for a dangling comparison operator missing its right operand', () => {
    expect(() => rewriteExpression('count ==', buildScriptBindings(script({ fields: [field('count')] })), 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/parse-error' });
  });
});

describe('rewriteExpression / rewriteStatement — </>/<=/>= crash-safe relational sugar', () => {
  for (const op of ['<', '>', '<=', '>=']) {
    it(`lowers ${op} to ft_relationalGuard(left, right, "${op}")`, () => {
      expect(rewriteExpression(`1 ${op} 2`, NO_BINDINGS, 'derived x')).to.equal(`ft_relationalGuard(1, 2, "${op}")`);
    });
  }

  it('rewrites a field/derived operand on both sides, just like any other expression', () => {
    const result = rewriteExpression(
      'count < total',
      buildScriptBindings(script({ fields: [field('count')], derived: [derived('total')] })),
      'derived isUnderTotal',
    );
    expect(result).to.equal('ft_relationalGuard(m?.top?.count, m?.total, "<")');
  });

  it('leaves real BrightScript = and <> unguarded, unlike every relational/comparison operator', () => {
    const result = rewriteExpression('a = b', buildScriptBindings(script({ fields: [field('a'), field('b')] })), 'derived x');
    expect(result).to.equal('m?.top?.a = m?.top?.b');
  });

  it('lowers a mixed nested comparison — relational operand inside an equality comparison', () => {
    const result = rewriteExpression('(a < b) == c', buildScriptBindings(script({ fields: [field('a'), field('b'), field('c')] })), 'derived x');
    expect(result).to.equal('ft_equals((ft_relationalGuard(m?.top?.a, m?.top?.b, "<")), m?.top?.c)');
  });

  it('lowers >= inside a function-body statement via rewriteStatement', () => {
    const result = rewriteStatement('return count >= 5', buildScriptBindings(script({ fields: [field('count')] })), 'function isAtLeastFive');
    expect(result).to.equal('return ft_relationalGuard(m?.top?.count, 5, ">=")');
  });

  it('throws expression/parse-error for a dangling relational operator missing its right operand', () => {
    expect(() => rewriteExpression('count <', buildScriptBindings(script({ fields: [field('count')] })), 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/parse-error' });
  });
});

describe('rewriteExpression / rewriteStatement — ! crash-safe NOT sugar', () => {
  it('lowers ! to ft_not(operand)', () => {
    expect(rewriteExpression('!true', NO_BINDINGS, 'derived x')).to.equal('ft_not(true)');
  });

  it('rewrites a field/derived operand, just like any other expression', () => {
    const result = rewriteExpression('!isVisible', buildScriptBindings(script({ fields: [field('isVisible')] })), 'derived x');
    expect(result).to.equal('ft_not(m?.top?.isVisible)');
  });

  it('supports an arbitrary expression as the operand, not just an identifier', () => {
    const result = rewriteExpression('!(count == 0)', buildScriptBindings(script({ fields: [field('count')] })), 'derived x');
    expect(result).to.equal('ft_not((ft_equals(m?.top?.count, 0)))');
  });

  it('lowers a safe NOT nested inside a call argument', () => {
    const result = rewriteExpression('pickColor(!isReady)', buildScriptBindings(script({ fields: [field('isReady')], functions: [fn('pickColor', 'private')] })), 'x');
    expect(result).to.equal('private_pickColor(ft_not(m?.top?.isReady))');
  });

  it('lowers double negation !!x, each ! resolved independently', () => {
    const result = rewriteExpression('!!isReady', buildScriptBindings(script({ fields: [field('isReady')] })), 'derived x');
    expect(result).to.equal('ft_not(ft_not(m?.top?.isReady))');
  });

  it('lowers ! inside a function-body statement via rewriteStatement', () => {
    const result = rewriteStatement('return !isReady', buildScriptBindings(script({ fields: [field('isReady')] })), 'function notReady');
    expect(result).to.equal('return ft_not(m?.top?.isReady)');
  });

  it('throws expression/parse-error for a dangling ! missing its operand', () => {
    expect(() => rewriteExpression('!', NO_BINDINGS, 'derived x'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/parse-error' });
  });
});

