import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { parse } from 'kopytko-brightscript-parser';
import { parse as parseThr, ThrFile } from 'flash-parser';
import { compileFlshSource, CompiledFlshFile } from '../../src/compile.js';
import { buildThemeShape, ThemeShape } from '../../src/analysis/global-bindings.js';
import { adaptThemeTemplateSection } from '../../src/dsl-parser/dsl-parser.js';
import { CompileError } from '../../src/dsl-parser/dsl-ast.js';

function themeFixture(): ThemeShape {
  const result = parseThr('<theme-template>\nfontSize: integer = 16\n</theme-template>');
  return buildThemeShape(adaptThemeTemplateSection(new ThrFile(result.root).themeTemplate), []);
}

function compileFixture(fixtureDir: string, fileName: string, baseShape: CompiledFlshFile['shape'] | null = null): CompiledFlshFile {
  const path = fileURLToPath(new URL(`${fixtureDir}/${fileName}`, import.meta.url));
  const source = readFileSync(path, 'utf8');
  return compileFlshSource(source, baseShape);
}

function readExpected(fixtureDir: string, fileName: string): string {
  const path = fileURLToPath(new URL(`${fixtureDir}/${fileName}`, import.meta.url));
  return readFileSync(path, 'utf8');
}

describe('codegen golden files — .flsh classes', () => {
  describe('class-basic (no extends — fields, a constructor, public/private methods)', () => {
    const fixtureDir = '../golden/class-basic';
    const actual = compileFixture(fixtureDir, 'input.flsh');

    it('matches expected.brs exactly', () => {
      expect(actual.compiled.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = parse(actual.compiled.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
    });
  });

  describe('class-extends (extends, override constructor + super(...), override method)', () => {
    const fixtureDir = '../golden/class-extends';
    const base = compileFixture(fixtureDir, 'base.flsh');
    const actual = compileFixture(fixtureDir, 'input.flsh', base.shape);

    it('matches expected-base.brs exactly', () => {
      expect(base.compiled.brs).to.equal(readExpected(fixtureDir, 'expected-base.brs'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.compiled.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('threads the base class constructor call through super(...)', () => {
      expect(actual.compiled.brs).to.include('prototype = MyClass(a, b)');
    });

    it('inherited private members stay private_-prefixed when read from the overriding method', () => {
      expect(actual.compiled.brs).to.include('m?.private_b + m?.private_c');
      expect(actual.compiled.brs).to.include('m?.private_a');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = parse(actual.compiled.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
    });
  });

  describe('constructor-control-flow (for each in a constructor, while + try-catch in methods)', () => {
    const fixtureDir = '../golden/constructor-control-flow';
    const actual = compileFixture(fixtureDir, 'input.flsh');

    it('matches expected.brs exactly', () => {
      expect(actual.compiled.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('prints a for each inside the constructor with self.-prefixed field writes', () => {
      expect(actual.compiled.brs).to.include('for each item in items\n      sum = sum + item\n    end for\n    self.private_total = sum');
    });

    it('prints a while loop inside a method with m.-prefixed field reads, nesting a DSL if correctly', () => {
      expect(actual.compiled.brs).to.include(
        'while ft_relationalGuard(tries, attempts, "<")\n      if (ft_relationalGuard(m?.private_total, 0, ">")) then\n        return m?.private_total\n      end if\n      tries = tries + 1\n    end while',
      );
    });

    it('prints a try/catch inside a method', () => {
      expect(actual.compiled.brs).to.include('try\n      result = m?.private_total\n    catch e\n      result = 0\n    end try');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = parse(actual.compiled.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
    });
  });

  describe('class-else-if-chain (a full if/else-if/else chain, and a bare-return inline else-if chain, in class methods)', () => {
    const fixtureDir = '../golden/class-else-if-chain';
    const actual = compileFixture(fixtureDir, 'input.flsh');

    it('matches expected.brs exactly', () => {
      expect(actual.compiled.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('flattens a block-bodied if/else-if/else chain, with m.-prefixed field reads', () => {
      expect(actual.compiled.brs).to.include(
        'if (ft_relationalGuard(m?.private_score, 90, ">=")) then\n      return "A"\n    else if (ft_relationalGuard(m?.private_score, 80, ">=")) then\n      return "B"\n    else\n      return "C"\n    end if',
      );
    });

    it('flattens an inline (bracket-free-bodied) if/else-if/else chain the same way', () => {
      expect(actual.compiled.brs).to.include(
        'if (ft_relationalGuard(m?.private_score, 0, ">")) then\n      return 1\n    else if (ft_relationalGuard(m?.private_score, 0, "<")) then\n      return -1\n    else\n      return 0\n    end if',
      );
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = parse(actual.compiled.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
    });
  });

  describe('class-ternary-basic (ternary assignment nested inside an if-body, chained, and embedded in a larger expression, in class methods)', () => {
    const fixtureDir = '../golden/class-ternary-basic';
    const actual = compileFixture(fixtureDir, 'input.flsh');

    it('matches expected.brs exactly', () => {
      expect(actual.compiled.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('lowers a chained ternary to nested hoisted ft_ternary_N temp vars, most-nested first', () => {
      expect(actual.compiled.brs).to.include(
        'ft_ternary_1 = Invalid\n      if (ft_relationalGuard(count, 0, ">")) then\n        ft_ternary_1 = "small"\n      else\n        ft_ternary_1 = "none"\n      end if\n      ft_ternary_2 = Invalid\n      if (ft_relationalGuard(count, 10, ">")) then\n        ft_ternary_2 = "big"\n      else\n        ft_ternary_2 = ft_ternary_1\n      end if\n      label = ft_ternary_2',
      );
    });

    it('lowers a parenthesized nested ternary operand to its own hoisted temp var', () => {
      expect(actual.compiled.brs).to.include('if (cond1) then\n      ft_ternary_2 = (ft_ternary_1)\n    else\n      ft_ternary_2 = c\n    end if');
    });

    it('lowers a ternary embedded inside a larger arithmetic expression', () => {
      expect(actual.compiled.brs).to.include('value = 1 + (ft_ternary_1)');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = parse(actual.compiled.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
    });
  });

  describe('class-anonymous-function-nested (Tier 2: an anonymous function nested inside a method\'s own call argument)', () => {
    const fixtureDir = '../golden/class-anonymous-function-nested';
    const actual = compileFixture(fixtureDir, 'input.flsh');

    it('matches expected.brs exactly', () => {
      expect(actual.compiled.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('hoists a call-argument-nested anonymous function to a ft_anon_N temp var inside the method', () => {
      expect(actual.compiled.brs).to.include('ft_anon_1 = function(item as integer) as boolean');
      expect(actual.compiled.brs).to.include('return m?.private_filterList?(items, ft_anon_1)');
    });

    it('rewrites a field reference inside the nested anonymous body via the inherited m.-prefixed selfExpr, private_-named', () => {
      expect(actual.compiled.brs).to.include('ft_relationalGuard(item, m?.private_threshold, ">")');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = parse(actual.compiled.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
    });
  });
});

describe('compileFlshSource — stream fields', () => {
  it('emits prototype.<name> = ft_createStream() for a public stream field, before the constructor', () => {
    const source = ['class Notifier {', '  public stream onChanged: string', '', '  public function change(value: string) {', '    m.onChanged.emit(value)', '  }', '}'].join('\n');
    const result = compileFlshSource(source, null);

    expect(result.compiled.brs).to.include('prototype.onChanged = ft_createStream()');
    expect(result.compiled.brs).to.include('m.onChanged.emit(value)');
    expect(result.compiled.usesStreamHelper).to.be.true;
  });

  it('private_-prefixes a private stream field, same as an ordinary private field', () => {
    const source = ['class Notifier {', '  private stream onChanged: string', '', '  public function change(value: string) {', '    m.onChanged.emit(value)', '  }', '}'].join('\n');
    const result = compileFlshSource(source, null);

    expect(result.compiled.brs).to.include('prototype.private_onChanged = ft_createStream()');
    expect(result.compiled.brs).to.include('m.private_onChanged.emit(value)');
  });

  it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
    const source = ['class Notifier {', '  public stream onChanged: string', '}'].join('\n');
    const result = compileFlshSource(source, null);
    const parsed = parse(result.compiled.brs);
    expect(parsed.diagnostics, JSON.stringify(parsed.diagnostics)).to.have.lengthOf(0);
  });

  it('does not set usesStreamHelper for a class with no stream field', () => {
    const source = ['class Plain {', '  private x: integer = 0', '}'].join('\n');
    const result = compileFlshSource(source, null);
    expect(result.compiled.usesStreamHelper).to.be.false;
  });

  it('lowers a .subscribe(m.methodName) bound reference to a { target, action } descriptor end to end', () => {
    const source = [
      'class Subscriber {',
      '  public function subscribeTo(publisher: object) {',
      '    publisher.onChanged.subscribe(m.onPublisherChanged)',
      '  }',
      '',
      '  public function onPublisherChanged(value: string) {',
      '    print value',
      '  }',
      '}',
    ].join('\n');
    const result = compileFlshSource(source, null);

    expect(result.compiled.brs).to.include('publisher.onChanged.subscribe({ target: m, action: "onPublisherChanged" })');
    const parsed = parse(result.compiled.brs);
    expect(parsed.diagnostics, JSON.stringify(parsed.diagnostics)).to.have.lengthOf(0);
  });

  it('lowers a bound reference to a DIFFERENT instance held in a local variable, not just m', () => {
    const source = [
      'class Router2 {',
      '  public function wire(notifier: object, subscriber: object) {',
      '    notifier.onChanged.subscribe(subscriber.onNotifierChanged)',
      '  }',
      '}',
    ].join('\n');
    const result = compileFlshSource(source, null);

    expect(result.compiled.brs).to.include('notifier.onChanged.subscribe({ target: subscriber, action: "onNotifierChanged" })');
  });
});

describe('compileFlshSource — global singletons (theme/router/taskManager) inside a class method compile via GetGlobalAA()', () => {
  // Confirmed live, before this fix: router.navigate(...)/taskManager.onAlertChanged(...) inside a
  // class method compiled SILENTLY, into m.global.ft_router.navigate(...)/m.global.ft_taskManager
  // .onAlertChanged(...) — wrong on two independent levels (no real callFunc/repacking/statement
  // expansion ever ran, AND "m" inside a class method is the instance's own plain AA, never a
  // SceneGraph node, so m.global reads a nonexistent key and crashes at runtime). GetGlobalAA() is
  // confirmed live (real device) to alias the exact same content node m.global points at, reachable
  // identically from a class method — see findings/class-pipeline-global-singleton-access.md for the full writeup.
  // Access is rooted at a hoisted `ft_globalAA` local, not a literal inline GetGlobalAA() call —
  // also confirmed live: a bare, return-discarding statement chained directly off GetGlobalAA()'s
  // own call result fails to install on a real device ("Compilation Failed"), while the identical
  // chain off a local variable holding that result compiles and runs fine — see
  // codegen/class-emitter.ts's hoistGlobalAAIfNeeded. This is the end-to-end regression guard for
  // both fixes; class-identifier-rewrite.test.ts has the unit-level coverage for the rewrite itself.
  it('compiles theme.<x> access via a hoisted ft_globalAA local', () => {
    const source = ['class Widget {', '  public function go() {', '    theme.fontSize', '  }', '}'].join('\n');
    const result = compileFlshSource(source, null, false, themeFixture());
    expect(result.compiled.brs).to.include('ft_globalAA = GetGlobalAA()');
    expect(result.compiled.brs).to.include('ft_globalAA?.global?.ft_theme?.fontSize');
  });

  it('compiles router.navigate(...) access via the hoisted ft_globalAA local, including the focus hand-off', () => {
    const source = ['class Widget {', '  public function go() {', '    router.navigate("/home")', '  }', '}'].join('\n');
    const result = compileFlshSource(source, null);
    expect(result.compiled.brs).to.include('ft_globalAA = GetGlobalAA()');
    expect(result.compiled.brs).to.include('ft_globalAA.global.ft_router.callFunc("navigate", {path: "/home", params: {}, skipInHistory: false})');
    expect(result.compiled.brs).to.include('if ft_globalAA.global.hasField("ft_focus") then ft_globalAA.global.ft_focus.callFunc("applyPendingFocus")');
    // The hoist appears exactly once for this method, before any use of it — never re-hoisted per
    // statement/line even though this method has two class-context global-singleton references.
    expect(result.compiled.brs.split('ft_globalAA = GetGlobalAA()')).to.have.lengthOf(2);
  });

  it('does NOT hoist ft_globalAA in a method that never references a class-context global singleton', () => {
    const source = ['class Widget {', '  public function go(): integer {', '    return 1 + 1', '  }', '}'].join('\n');
    const result = compileFlshSource(source, null);
    expect(result.compiled.brs).to.not.include('GetGlobalAA');
  });

  it('still rejects taskManager.onAlertChanged(...) access — deliberately unsupported from a class body', () => {
    const source = ['class Widget {', '  public function go(cb: dynamic) {', '    taskManager.onAlertChanged(cb)', '  }', '}'].join('\n');
    expect(() => compileFlshSource(source, null))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/task-manager-on-alert-changed-not-supported' });
  });

  it('still rejects taskManager.onResult(...) access — deliberately unsupported from a class body, same underlying reason as onAlertChanged (unverified ObserveFieldScoped-from-class-method scoping, plus a trampoline-name collision risk)', () => {
    const source = ['class Widget {', '  public function go(task: dynamic, onSuccess: dynamic, onError: dynamic) {', '    taskManager.onResult(task, onSuccess, onError)', '  }', '}'].join('\n');
    expect(() => compileFlshSource(source, null))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/task-manager-on-result-not-supported' });
  });

  it('still rejects taskManager.onRequestSent(...) access — deliberately unsupported from a class body, same underlying reason as onAlertChanged', () => {
    const source = ['class Widget {', '  public function go(cb: dynamic) {', '    taskManager.onRequestSent(cb)', '  }', '}'].join('\n');
    expect(() => compileFlshSource(source, null))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/task-manager-on-request-sent-not-supported' });
  });

  it('still rejects taskManager.onResponseReceived(...) access — deliberately unsupported from a class body, same underlying reason as onAlertChanged', () => {
    const source = ['class Widget {', '  public function go(cb: dynamic) {', '    taskManager.onResponseReceived(cb)', '  }', '}'].join('\n');
    expect(() => compileFlshSource(source, null))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/task-manager-on-response-received-not-supported' });
  });
});

describe('codegen golden files — .flsh raw BrightScript passthrough', () => {
  describe('raw-block-class (a raw block inside a constructor body and inside a method body)', () => {
    const fixtureDir = '../golden/raw-block-class';
    const actual = compileFixture(fixtureDir, 'input.flsh');

    it('matches expected.brs exactly', () => {
      expect(actual.compiled.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('prints the constructor-body raw block wrapped in both markers, after the field-init self.-prefixing but completely unrewritten itself', () => {
      expect(actual.compiled.brs).to.include(
        ['    self.private_a = a', "    ' flash-theater:raw", '    print "constructing"', "    ' flash-theater:end-raw", '    return self'].join('\n'),
      );
    });

    it('prints the method-body raw block wrapped in both markers, leaving its own m.a reference unrewritten (no m.-to-m.private_a rewrite inside a raw block)', () => {
      expect(actual.compiled.brs).to.include(
        ['  prototype.describe = function() as string', "    ' flash-theater:raw", '    result = "a is " + m.a', "    ' flash-theater:end-raw", '    return result'].join('\n'),
      );
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = parse(actual.compiled.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
    });
  });
});
