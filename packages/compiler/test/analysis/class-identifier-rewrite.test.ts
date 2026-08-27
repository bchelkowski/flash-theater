import { expect } from 'chai';
import { parse, ThrFile } from 'flash-parser';
import { ClassMemberInfo, ClassShape } from '../../src/analysis/class-shape.js';
import { rewriteClassExpression, rewriteClassMemberAccesses, rewriteClassStatement } from '../../src/analysis/class-identifier-rewrite.js';
import { buildClassScriptBindings, FunctionScope } from '../../src/analysis/scope-resolution.js';
import { buildThemeShape, ThemeShape } from '../../src/analysis/global-bindings.js';
import { adaptThemeTemplateSection } from '../../src/dsl-parser/dsl-parser.js';
import { CompileError, ThrClassAst } from '../../src/dsl-parser/dsl-ast.js';

function themeFixture(): ThemeShape {
  const result = parse('<theme-template>\nfontSize: integer = 16\n</theme-template>');
  return buildThemeShape(adaptThemeTemplateSection(new ThrFile(result.root).themeTemplate), []);
}

function shape(members: Record<string, ClassMemberInfo>, baseName: string | null = null): ClassShape {
  const map = new Map(Object.entries(members));
  return { className: 'C', baseName, ownMembers: map, allMembers: map };
}

const EMPTY_CLASS_AST: ThrClassAst = { name: 'C', baseName: null, imports: [], fields: [], streamFields: [], constructorDecl: null, methods: [] };

describe('rewriteClassMemberAccesses', () => {
  it('leaves a public member untouched when selfExpr is "m"', () => {
    const s = shape({ x: { name: 'x', kind: 'field', visibility: 'public', returnType: null } });
    expect(rewriteClassMemberAccesses('m.x', 'expression', s, 'm', 'ctx')).to.equal('m.x');
  });

  it('prefixes a private member with private_ when selfExpr is "m"', () => {
    const s = shape({ x: { name: 'x', kind: 'field', visibility: 'private', returnType: null } });
    expect(rewriteClassMemberAccesses('m.x', 'expression', s, 'm', 'ctx')).to.equal('m.private_x');
  });

  it('protected compiles identically to public — no prefix', () => {
    const s = shape({ x: { name: 'x', kind: 'field', visibility: 'protected', returnType: null } });
    expect(rewriteClassMemberAccesses('m.x', 'expression', s, 'm', 'ctx')).to.equal('m.x');
  });

  it('THE critical case: inside the constructor (selfExpr "self"), both the root and a private member are rewritten to self.private_<name>', () => {
    const s = shape({ x: { name: 'x', kind: 'field', visibility: 'private', returnType: null } });
    expect(rewriteClassMemberAccesses('m.x', 'expression', s, 'self', 'ctx')).to.equal('self.private_x');
  });

  it('a public member inside the constructor still gets the root swapped to self, but no prefix', () => {
    const s = shape({ x: { name: 'x', kind: 'field', visibility: 'public', returnType: null } });
    expect(rewriteClassMemberAccesses('m.x', 'expression', s, 'self', 'ctx')).to.equal('self.x');
  });

  it('rewrites every independent m.<name> access, leaving a nested chain\'s second hop untouched', () => {
    const s = shape({ a: { name: 'a', kind: 'field', visibility: 'private', returnType: null }, b: { name: 'b', kind: 'field', visibility: 'public', returnType: null } });
    expect(rewriteClassMemberAccesses('m.a.foo + m.b', 'expression', s, 'm', 'ctx')).to.equal('m.private_a.foo + m.b');
  });

  it('rewrites a call target', () => {
    const s = shape({ helper: { name: 'helper', kind: 'method', visibility: 'private', returnType: null } });
    expect(rewriteClassMemberAccesses('m.helper(1, 2)', 'expression', s, 'm', 'ctx')).to.equal('m.private_helper(1, 2)');
  });

  it('rewrites an assignment target inside a statement', () => {
    const s = shape({ x: { name: 'x', kind: 'field', visibility: 'private', returnType: null } });
    expect(rewriteClassMemberAccesses('m.x = 5', 'statement', s, 'self', 'ctx')).to.equal('self.private_x = 5');
  });

  it('throws class/unresolved-member for an m.<name> not declared on the class (own or inherited)', () => {
    const s = shape({});
    expect(() => rewriteClassMemberAccesses('m.nope', 'expression', s, 'm', 'my context')).to.throw(CompileError).with.property('diagnostic').that.deep.includes({ code: 'class/unresolved-member' });
  });

  it('resolves an inherited member the same way as an own one', () => {
    const s = shape({ b: { name: 'b', kind: 'field', visibility: 'private', returnType: null } }, 'Base');
    expect(rewriteClassMemberAccesses('m.b', 'expression', s, 'self', 'ctx')).to.equal('self.private_b');
  });
});

describe('rewriteClassExpression / rewriteClassStatement — full pipeline', () => {
  it('rewrites a private member reference inside a larger expression', () => {
    const s = shape({ count: { name: 'count', kind: 'field', visibility: 'private', returnType: null } });
    const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);
    expect(rewriteClassExpression('m.count + 1', s, bindings, 'm', 'ctx')).to.equal('m?.private_count + 1');
  });

  it('resolves a bare imported class name left untouched (verbatim call)', () => {
    const s = shape({});
    const classAst: ThrClassAst = { ...EMPTY_CLASS_AST, imports: [{ className: 'Helper', path: './Helper.flsh', span: { line: 0 } }] };
    const bindings = buildClassScriptBindings(classAst);
    expect(rewriteClassExpression('Helper(1, 2)', s, bindings, 'm', 'ctx')).to.equal('Helper(1, 2)');
  });

  it('rewriteClassStatement handles a statement-shaped assignment', () => {
    const s = shape({ x: { name: 'x', kind: 'field', visibility: 'private', returnType: null } });
    const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);
    expect(rewriteClassStatement('m.x = 5', s, bindings, 'self', 'ctx')).to.equal('self.private_x = 5');
  });

  it('lowers == / != to ft_equals(...), resolving a private member operand through the normal m./self. path', () => {
    const s = shape({ count: { name: 'count', kind: 'field', visibility: 'private', returnType: null } });
    const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);
    expect(rewriteClassExpression('m.count == 5', s, bindings, 'm', 'ctx')).to.equal('ft_equals(m?.private_count, 5)');
    expect(rewriteClassExpression('m.count != 5', s, bindings, 'self', 'ctx')).to.equal('Not ft_equals(self?.private_count, 5)');
  });

  it('rewriteClassStatement lowers a comparison inside a statement', () => {
    const s = shape({ x: { name: 'x', kind: 'field', visibility: 'public', returnType: null } });
    const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);
    expect(rewriteClassStatement('return m.x == 1', s, bindings, 'm', 'ctx')).to.equal('return ft_equals(m?.x, 1)');
  });

  it('lowers ! to ft_not(...), resolving a private member operand through the normal m./self. path', () => {
    const s = shape({ isReady: { name: 'isReady', kind: 'field', visibility: 'private', returnType: null } });
    const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);
    expect(rewriteClassExpression('!m.isReady', s, bindings, 'm', 'ctx')).to.equal('ft_not(m?.private_isReady)');
    expect(rewriteClassExpression('!m.isReady', s, bindings, 'self', 'ctx')).to.equal('ft_not(self?.private_isReady)');
  });

  it('rewriteClassStatement lowers a safe NOT inside a statement', () => {
    const s = shape({ x: { name: 'x', kind: 'field', visibility: 'public', returnType: null } });
    const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);
    expect(rewriteClassStatement('return !m.x', s, bindings, 'm', 'ctx')).to.equal('return ft_not(m?.x)');
  });

  it('lowers double negation !!m.x, resolving the private member exactly once', () => {
    const s = shape({ isReady: { name: 'isReady', kind: 'field', visibility: 'private', returnType: null } });
    const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);
    expect(rewriteClassExpression('!!m.isReady', s, bindings, 'm', 'ctx')).to.equal('ft_not(ft_not(m?.private_isReady))');
  });

  it('lowers a stream .subscribe(m.methodName) bound reference to a { target, action } descriptor, private-prefixing the action', () => {
    const s = shape({
      publisher: { name: 'publisher', kind: 'field', visibility: 'public', returnType: null },
      onChanged: { name: 'onChanged', kind: 'method', visibility: 'private', returnType: null },
    });
    const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);
    expect(rewriteClassStatement('m.publisher.subscribe(m.onChanged)', s, bindings, 'm', 'ctx')).to.equal('m.publisher.subscribe({ target: m, action: "private_onChanged" })');
  });

  it('lowers a bound reference to ANOTHER object entirely (not m/self) unchanged, since a plain local needs no rewriting in a class body', () => {
    const s = shape({ notifier: { name: 'notifier', kind: 'field', visibility: 'public', returnType: null } });
    const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);
    const scope: FunctionScope = { hasLocal: (name) => name === 'subscriber', isUnused: () => false };
    expect(rewriteClassStatement('m.notifier.subscribe(subscriber.onNotifierChanged)', s, bindings, 'm', 'ctx', scope)).to.equal(
      'm.notifier.subscribe({ target: subscriber, action: "onNotifierChanged" })',
    );
  });

  it('does not touch a called expression argument to .subscribe(...)', () => {
    const s = shape({
      publisher: { name: 'publisher', kind: 'field', visibility: 'public', returnType: null },
      makeCallback: { name: 'makeCallback', kind: 'method', visibility: 'public', returnType: null },
    });
    const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);
    expect(rewriteClassStatement('m.publisher.subscribe(m.makeCallback())', s, bindings, 'm', 'ctx')).to.equal('m.publisher.subscribe(m?.makeCallback?())');
  });
});

describe('rewriteClassExpression / rewriteClassStatement — Timer functions are not supported in a class body', () => {
  const s = shape({});
  const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);

  it('rejects clearTimeout(...) in a class statement', () => {
    expect(() => rewriteClassStatement('clearTimeout(m.handle)', s, bindings, 'm', 'class C method "go"'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/timer-not-supported' });
  });

  it('rejects clearInterval(...) in a class statement', () => {
    expect(() => rewriteClassStatement('clearInterval(m.handle)', s, bindings, 'm', 'class C method "go"'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/timer-not-supported' });
  });

  it('rejects a bare setTimeout(...) reached through rewriteClassExpression too, not just the statement-printer structural guard', () => {
    expect(() => rewriteClassExpression('setTimeout(onFire, 1000)', s, bindings, 'm', 'class C method "go"'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/timer-not-supported' });
  });

  it('rejects a bare setInterval(...) reached through rewriteClassExpression too', () => {
    expect(() => rewriteClassExpression('setInterval(onPoll, 500)', s, bindings, 'm', 'class C method "go"'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/timer-not-supported' });
  });
});

describe('rewriteClassExpression / rewriteClassStatement — global singletons via GetGlobalAA()', () => {
  // Regression coverage for a real, live-device-confirmed fix: a class method's own `m` is
  // BrightScript-auto-bound to the class instance (a plain AA), never a SceneGraph node, so
  // `m.global` (a `.thr` component's own access root) has no meaning there — but `GetGlobalAA()` is
  // confirmed live to expose a `"global"` key aliasing the exact same content node `m.global` points
  // at, reachable identically from a class method. `router`/`taskManager` used to compile SILENTLY
  // into crashing BrightScript before this fix (`m.global` reading a nonexistent key off the
  // instance's own AA); `theme` used to fail only by accident (a generic, unhelpful
  // expression/unresolved-identifier). All three now compile correctly via `ft_globalAA.global`
  // (a hoisted local, not a literal `GetGlobalAA()` call — see codegen/class-emitter.ts's
  // `hoistGlobalAAIfNeeded`; these unit tests exercise the rewrite pipeline directly, not the
  // hoist-line emission, which is a class-emitter.ts-level concern covered by class-golden.test.ts).
  const s = shape({});
  const bindings = buildClassScriptBindings(EMPTY_CLASS_AST);

  it('rewrites a bare "theme" reference to ft_globalAA.global.ft_theme', () => {
    expect(rewriteClassExpression('theme', s, bindings, 'm', 'method "go"', undefined, themeFixture())).to.equal('ft_globalAA?.global?.ft_theme');
  });

  it('rewrites a "theme.a.b" dot-chain reference, leaving the validated member chain untouched', () => {
    expect(rewriteClassExpression('theme.fontSize', s, bindings, 'm', 'method "go"', undefined, themeFixture())).to.equal('ft_globalAA?.global?.ft_theme?.fontSize');
  });

  it('rewrites a "router.navigate(...)" call, including the sibling focus hand-off, as a statement', () => {
    const result = rewriteClassStatement('router.navigate("/home")', s, bindings, 'm', 'method "go"');
    expect(result).to.equal('ft_globalAA.global.ft_router.callFunc("navigate", {path: "/home", params: {}, skipInHistory: false})');
  });

  it('rewrites a "taskManager.run(...)" call, as a statement, defaulting priority to "normal"', () => {
    expect(rewriteClassStatement('taskManager.run(m.node)', shape({ node: { name: 'node', kind: 'field', visibility: 'public', returnType: null } }), bindings, 'm', 'method "go"')).to.equal(
      'ft_globalAA.global.ft_taskManager.callFunc("runTask", m?.node, "normal")',
    );
  });

  it('a router.navigate(...) argument referencing a private class field is rewritten through the class member-access pipeline, not left untouched', () => {
    const withField = shape({ path: { name: 'path', kind: 'field', visibility: 'private', returnType: null } });
    expect(rewriteClassStatement('router.navigate(m.path)', withField, bindings, 'm', 'method "go"')).to.equal(
      'ft_globalAA.global.ft_router.callFunc("navigate", {path: m?.private_path, params: {}, skipInHistory: false})',
    );
  });

  it('still rejects a bare "taskManager.onAlertChanged(...)" reference — deliberately unsupported from a class body', () => {
    expect(() => rewriteClassStatement('taskManager.onAlertChanged(cb)', s, bindings, 'm', 'method "go"'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/task-manager-on-alert-changed-not-supported' });
  });

  it('still rejects a bare "router.markReady()" reference — a .flsh class instance has no SceneGraph node of its own for "its own top" to mean', () => {
    expect(() => rewriteClassStatement('router.markReady()', s, bindings, 'm', 'method "go"'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/router-mark-ready-not-supported' });
  });

  it('the onAlertChanged diagnostic message explains why and points at the .thr-side workaround', () => {
    try {
      rewriteClassStatement('taskManager.onAlertChanged(cb)', s, bindings, 'm', 'method "go"');
      expect.fail('expected a CompileError');
    } catch (err) {
      expect(err).to.be.instanceOf(CompileError);
      const message = (err as CompileError).diagnostic.message;
      expect(message).to.include('taskManager.onAlertChanged');
      expect(message).to.include('.thr component');
    }
  });

  it('a bare "theme" reference is unresolved (not rewritten) when the app has no <theme-template>, mirroring .thr behavior', () => {
    expect(() => rewriteClassExpression('theme', s, bindings, 'm', 'method "go"'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/unresolved-identifier' });
  });
});
