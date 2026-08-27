import { expect } from 'chai';
import { parse as parseBrightScript } from 'kopytko-brightscript-parser';
import { parse, ThrFile } from 'flash-parser';
import { compileThrSource } from '../../src/compile.js';
import { CompileError } from '../../src/dsl-parser/dsl-ast.js';
import { buildThemeShape, GlobalBindingsContext } from '../../src/analysis/global-bindings.js';
import { adaptThemeTemplateSection } from '../../src/dsl-parser/dsl-parser.js';

const TEMPLATE = '<Label id="out" text="{a}" />';

function thr(scriptBody: string): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${TEMPLATE}\n</component>\n`;
}

describe('emitBrs — state assignment validation', () => {
  it('throws statement/unknown-state when the assigned name is not declared at all', () => {
    const source = thr(
      ['derived a: integer = 1', 'public function bump() {', '  state notDeclared = 1', '}'].join('\n'),
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'statement/unknown-state' });
  });

  it('throws statement/unknown-state when the assigned name is a field, not a state', () => {
    const source = thr(
      ['field count: integer = 0', 'derived a: integer = 1', 'public function bump() {', '  state count = count + 1', '}'].join(
        '\n',
      ),
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'statement/unknown-state' });
  });

  it('throws expression/unresolved-identifier for a genuinely undeclared name anywhere in a function body', () => {
    const source = thr(
      ['derived a: integer = 1', 'public function bump() {', '  return totallyUnknownName', '}'].join('\n'),
    );

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/unresolved-identifier' });
  });
});

describe('emitBrs — stream initialization', () => {
  it('initializes each declared stream via ft_createStream() in init(), before any derived assignment that might read it', () => {
    const source = [
      '<script>',
      'stream dataLoaded: string',
      'derived label: string = "hi"',
      '</script>',
      '<component>',
      '<Label id="out" text="{label}" />',
      '</component>',
      '',
    ].join('\n');
    const compiled = compileThrSource(source, 'X');
    const initBody = compiled.brs.slice(compiled.brs.indexOf('sub init()'), compiled.brs.indexOf('end sub'));

    expect(initBody).to.include('m.dataLoaded = ft_createStream()');
    expect(initBody.indexOf('m.dataLoaded = ft_createStream()')).to.be.lessThan(initBody.indexOf('m.label ='));
  });

  it('lowers a .subscribe(m.methodName) bound reference to a { target, action } descriptor', () => {
    const source = [
      '<script>',
      'stream dataLoaded: string',
      '',
      'public function setup() {',
      '  dataLoaded.subscribe(m.onDataLoaded)',
      '}',
      '',
      'public function onDataLoaded(value: string) {',
      '  print value',
      '}',
      '</script>',
      '<component>',
      '<Label id="out" />',
      '</component>',
      '',
    ].join('\n');
    const compiled = compileThrSource(source, 'X');

    expect(compiled.brs).to.include('m.dataLoaded.subscribe({ target: m, action: "onDataLoaded" })');
  });

  it('sets usesStreamHelper only when the compiled .brs actually calls ft_createStream(', () => {
    const withStream = compileThrSource(thr('stream dataLoaded: string\nderived a: integer = 1'), 'X');
    expect(withStream.usesStreamHelper).to.be.true;

    const withoutStream = compileThrSource(thr('derived a: integer = 1'), 'X');
    expect(withoutStream.usesStreamHelper).to.be.false;
  });
});

describe('emitBrs — function vs sub codegen', () => {
  it('emits a sub, not a function, for a declaration with no return-type clause', () => {
    const source = thr(['derived a: integer = 1', 'public function log(message: string) {', '  print message', '}'].join('\n'));

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('sub log(message as string)');
    expect(brs).to.include('end sub');
    expect(brs).not.to.include('function log');
  });

  it('still emits a function ... as <Type> for a declaration with a return-type clause', () => {
    const source = thr(['derived a: integer = 1', 'public function describe(): string {', '  return "hi"', '}'].join('\n'));

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('function describe() as string');
    expect(brs).to.include('end function');
    expect(brs).not.to.include('sub describe');
  });

  it('emits both a sub and a function in the same component when mixed', () => {
    const source = thr(
      ['derived a: integer = 1', 'private function log(message: string) {', '  print message', '}', 'public function describe(): string {', '  return "hi"', '}'].join(
        '\n',
      ),
    );

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('sub private_log(message as string)');
    expect(brs).to.include('function describe() as string');
  });
});

describe('emitBrs — unused parameters get a "_" prefix in generated code only', () => {
  it('prefixes an unused parameter, leaving a used one alone', () => {
    const source = thr(['derived a: integer = 1', 'public function log(message: string, extra: integer) {', '  print message', '}'].join('\n'));

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('sub log(message as string, _extra as integer)');
  });

  it('does not double-prefix a parameter the author already named with a leading "_"', () => {
    const source = thr(['derived a: integer = 1', 'public function log(_extra: integer) {', '  print "hi"', '}'].join('\n'));

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('sub log(_extra as integer)');
  });

  it('throws dsl/param-prefix-collision when the "_"-prefixed name is already a parameter in the same function', () => {
    const source = thr(['derived a: integer = 1', 'public function log(y: integer, _y: integer) {', '  print _y', '}'].join('\n'));

    expect(() => compileThrSource(source, 'X'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'dsl/param-prefix-collision' });
  });
});

describe('emitBrs — unused local variables are elided from generated code', () => {
  it('drops a local that is only ever written with a pure (call-free) right-hand side', () => {
    const source = thr(['derived a: integer = 1', 'public function compute() {', '  total = 0', '}'].join('\n'));

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.not.include('total');
    expect(parseBrightScript(brs).diagnostics).to.have.lengthOf(0);
  });

  it('keeps a dead-store local whose right-hand side contains a call — a possible side effect', () => {
    const source = thr(
      ['derived a: integer = 1', 'public function compute() {', '  total = CreateObject("roAssociativeArray")', '}'].join('\n'),
    );

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('total = CreateObject("roAssociativeArray")');
  });

  it('elides only the unused line within a multi-line statement region, keeping the used ones', () => {
    const source = thr(
      ['derived a: integer = 1', 'public function compute(): integer {', '  total = 0', '  used = 5', '  return used', '}'].join('\n'),
    );

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.not.include('total');
    expect(brs).to.include('used = 5');
    expect(brs).to.include('return used');
  });

  it('elides every dead write to the same never-read name, not just the first', () => {
    const source = thr(['derived a: integer = 1', 'public function compute() {', '  total = 0', '  total = 5', '}'].join('\n'));

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.not.include('total');
    expect(parseBrightScript(brs).diagnostics).to.have.lengthOf(0);
  });
});

describe('emitBrs — setFields() batching for multiple field assignments to the same node', () => {
  it('batches 2+ dynamic bindings to the same element into one setFields() call in init()', () => {
    const source = ['<script>', 'field label: string = ""', 'field labelColor: string = ""', '</script>', '<component>', '<Label id="out" text="{label}" color="{labelColor}" />', '</component>'].join('\n');

    const { brs } = compileThrSource(source, 'X');
    const initSub = brs.slice(brs.indexOf('sub init()'), brs.indexOf('end sub') + 'end sub'.length);

    expect(initSub).to.include('m.out.setFields({text: m?.top?.label, color: m?.top?.labelColor})');
    expect(initSub).to.not.match(/m\.out\.text = /);
  });

  it('keeps a single dynamic binding on a node as plain dot-notation, not setFields()', () => {
    const source = ['<script>', 'field label: string = ""', '</script>', '<component>', '<Label id="out" text="{label}" />', '</component>'].join('\n');

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('m.out.text = m?.top?.label');
    expect(brs).to.not.include('setFields');
  });

  it('keeps a dynamic focusable attribute out of the batched setFields() call, alongside plain sibling attributes', () => {
    const source = ['<script>', 'field label: string = ""', 'field canFocus: boolean = false', '</script>', '<component>', '<Label id="out" text="{label}" focusable="{canFocus}" />', '</component>'].join('\n');

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('m.out.text = m?.top?.label');
    expect(brs).to.include('ft_focusable_out = m?.top?.canFocus');
    expect(brs).to.include('m.out.focusable = ft_focusable_out');
    expect(brs).to.not.include('setFields');
  });
});

describe('emitBrs — synthesized change-handler event param prefixing', () => {
  it('prefixes event as _event when the field-change handler body never references it', () => {
    const source = ['<script>', 'field label: string = ""', '</script>', '<component>', '<Label id="out" text="{label}" />', '</component>'].join('\n');

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('sub on_labelChange(_event as object)');
    expect(parseBrightScript(brs).diagnostics).to.have.lengthOf(0);
  });

  it('still prefixes as _event when a field literally named "event" only ever appears as m.event (member access, not the sub\'s own parameter)', () => {
    const source = ['<script>', 'field event: integer = 0', 'derived doubled: integer = event * 2', '</script>', '<component>', '<Label id="out" text="{doubled}" />', '</component>'].join('\n');

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('sub on_eventChange(_event as object)');
  });
});

describe('emitBrs — on:key[...] declared directly on <component> (unconditional, component-level dispatch)', () => {
  it('emits a component-level on:key branch after the LRUD fallback, with no IsInFocusChain() guard', () => {
    const source = [
      '<script>',
      'private function handleKey(key: string, press: boolean) {',
      '  print key',
      '}',
      '</script>',
      '<component on:key[OK,up]="{handleKey()}">',
      '<Rectangle id="a" focusable="true" />',
      '</component>',
    ].join('\n');

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('function onKeyEvent(key as string, press as boolean) as boolean');
    // The LRUD fallback (gated on hasFocusable) must appear before the new unconditional block.
    const lrudIndex = brs.indexOf('navigate');
    const okIndex = brs.indexOf('if key = "OK" then');
    expect(lrudIndex).to.be.greaterThan(-1);
    expect(okIndex).to.be.greaterThan(lrudIndex);
    expect(brs).to.include('  if key = "OK" then\n    private_handleKey(key, press)\n    return true\n  end if');
    expect(brs).to.include('  if key = "up" then\n    private_handleKey(key, press)\n    return true\n  end if');
    expect(brs).to.not.match(/if key = "OK" then\s*\n\s*if .*IsInFocusChain/);
    expect(parseBrightScript(brs).diagnostics).to.have.lengthOf(0);
  });

  it('still generates onKeyEvent for a component-level on:key even with no focusable elements and no per-element on:key at all', () => {
    const source = [
      '<script>',
      'private function handleKey(key: string, press: boolean) {',
      '  print key',
      '}',
      '</script>',
      '<component on:key[back]="{handleKey()}">',
      '<Rectangle id="a" />',
      '</component>',
    ].join('\n');

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('function onKeyEvent(key as string, press as boolean) as boolean');
    expect(brs).to.include('if key = "back" then');
    expect(brs).to.include('return false');
  });

  it('emits no onKeyEvent at all when neither <component> nor any element declares on:key, and nothing is focusable', () => {
    const source = ['<script>', 'field label: string = ""', '</script>', '<component>', '<Label id="out" text="{label}" />', '</component>'].join('\n');

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.not.include('onKeyEvent');
  });
});

describe('emitBrs — store(...) write and focus(...) statements', () => {
  it('wraps a store(...) write in a callFunc("set", ...) call, rewriting the right-hand side normally', () => {
    const source = thr(
      ['derived a: integer = 1', 'read favoriteCount = store(favoriteCount)', 'public function bump() {', '  store(favoriteCount) = favoriteCount + 1', '}'].join('\n'),
    );

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('m.global.ft_store.callFunc("set", "favoriteCount", m?.favoriteCount + 1)');
  });

  it('rewrites a theme access inside a store(...) write\'s own right-hand side', () => {
    const themeCtx: GlobalBindingsContext = { theme: buildThemeShape(adaptThemeTemplateSection(new ThrFile(parse('<theme-template>\nfontSize: integer = 16\n</theme-template>').root).themeTemplate), []) };
    const source = thr(['derived a: integer = 1', 'public function bump() {', '  store(zoom) = theme.fontSize * 2', '}'].join('\n'));

    const { brs } = compileThrSource(source, 'X', { globalBindings: themeCtx });

    expect(brs).to.include('m.global.ft_store.callFunc("set", "zoom", m?.global?.ft_theme?.fontSize * 2)');
  });

  it('wraps a focus(...) string-literal id argument in m.top.findNode(...), scoped to the calling component\'s own subtree', () => {
    const source = thr(['derived a: integer = 1', 'public function goToGroup() {', '  focus("focusGroup")', '}'].join('\n'));

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('m.global.ft_focus.callFunc("focusComponent", m.top.findNode("focusGroup"))');
  });

  it('rewrites a focus(...) identifier argument (a string-typed field holding an id) through the normal field resolution path, then wraps it in m.top.findNode(...)', () => {
    const source = thr(['field targetRowId: string = ""', 'derived a: integer = 1', 'public function jumpToRow() {', '  focus(targetRowId)', '}'].join('\n'));

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('m.global.ft_focus.callFunc("focusComponent", m.top.findNode(m?.top?.targetRowId))');
  });
});

describe('emitBrs — jumpFocus(...) statement', () => {
  it('prints the full if/else shape branching on the forwarded press value — press branch jumps and arms repeat, release branch stops it', () => {
    const source = thr(['derived a: integer = 1', 'public function jumpDown(key: string, press: boolean) {', '  jumpFocus("down", 5, press)', '}'].join('\n'));

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('if press then');
    expect(brs).to.include('if m.global.ft_focus.callFunc("navigateBy", "down", 5) then');
    expect(brs).to.include('m.global.ft_focus.callFunc("startRepeat", "down", 5)');
    expect(brs).to.include('else');
    expect(brs).to.include('m.global.ft_focus.callFunc("stopRepeat")');
  });

  it('rewrites all three arguments (direction, count, press) through the normal expression rewrite path', () => {
    const source = thr(
      ['field jumpSize: integer = 5', 'derived a: integer = 1', 'public function jumpDown(key: string, press: boolean) {', '  jumpFocus("down", jumpSize, press)', '}'].join('\n'),
    );

    const { brs } = compileThrSource(source, 'X');

    expect(brs).to.include('m.global.ft_focus.callFunc("navigateBy", "down", m?.top?.jumpSize)');
    expect(brs).to.include('m.global.ft_focus.callFunc("startRepeat", "down", m?.top?.jumpSize)');
  });
});
