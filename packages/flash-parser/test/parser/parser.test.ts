import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile } from '../../src/ast.js';
import { TemplateElementNode, TemplateNode } from '../../src/templateModel.js';

function asElement(node: TemplateNode): TemplateElementNode {
  if (node.kind !== 'element') throw new Error(`expected an element node, got kind "${node.kind}"`);
  return node;
}

const SCHEDULE_DATE_MENU_ITEM_THR = fileURLToPath(
  new URL('../../../../apps/sample-app/src/components/ScheduleDateMenuItem/ScheduleDateMenuItem.thr', import.meta.url),
);

function wrap(source: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
  const result = parse(source);
  return { file: new ThrFile(result.root), diagnostics: result.diagnostics };
}

const TEMPLATE = '<Rectangle id="a" width="{width}" />';

function thr(scriptBody: string, templateMarkup: string = TEMPLATE): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${templateMarkup}\n</component>\n`;
}

describe('parse — round-trip fidelity', () => {
  it('reproduces the real ScheduleDateMenuItem.thr fixture byte-for-byte, with zero diagnostics', () => {
    const source = readFileSync(SCHEDULE_DATE_MENU_ITEM_THR, 'utf8');
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });

  it('reproduces a file with comments and blank lines byte-for-byte', () => {
    const source = [
      '<script>',
      "' a comment about width",
      'field width: integer = 0',
      '',
      "' another comment",
      'derived isWide: boolean = width > 100',
      '</script>',
      '',
      '<component>',
      '<Rectangle id="a" width="{width}" />',
      '</component>',
      '',
    ].join('\n');

    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });

  it('reproduces a file where </script> sits inside a string literal, without splitting early', () => {
    const source = thr('private function describe(): string {\n  return "not a real </script> tag"\n}');
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });

  it('reproduces a file with a state declaration and a state assignment byte-for-byte', () => {
    const source = thr('state count: integer = 0\nprivate function bump() {\n  state count = count + 1\n}');
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});

describe('parse — ScheduleDateMenuItem.thr (real fixture, structured)', () => {
  const source = readFileSync(SCHEDULE_DATE_MENU_ITEM_THR, 'utf8');
  const { file } = wrap(source);

  it('parses all five field declarations, in order, with correct types and defaults', () => {
    expect(file.script.fields.map((f) => [f.name, f.type, f.defaultLiteral])).to.deep.equal([
      ['width', 'integer', '0'],
      ['height', 'integer', '0'],
      ['focusPercent', 'float', '0.0'],
      ['gridHasFocus', 'boolean', 'false'],
      ['itemContent', 'node', 'invalid'],
    ]);
  });

  it('parses all seven derived declarations, in order, with their type and the trimmed expression text', () => {
    expect(file.script.derived.map((d) => [d.name, d.type])).to.deep.equal([
      ['isGridFocused', 'boolean'],
      ['highlightColor', 'string'],
      ['highlightOpacity', 'float'],
      ['textColor', 'string'],
      ['contentOpacity', 'float'],
      ['titleText', 'string'],
      ['dayNameText', 'string'],
    ]);
    expect(file.script.derived[0].expression).to.equal('focusPercent > 0.5');
    expect(file.script.derived[1].expression).to.equal('pickColor(gridHasFocus, "0x0057FFFF", "0x3A3A3AFF")');
  });

  it('parses all five private functions with params, return type, and structured if statements', () => {
    expect(file.script.functions.map((f) => f.name)).to.deep.equal([
      'pickColor',
      'pickOpacity',
      'pickContentOpacity',
      'itemContentTitle',
      'itemContentDayName',
    ]);
    expect(file.script.functions.every((f) => f.visibility === 'private')).to.be.true;

    const pickColor = file.script.functions[0];
    expect(pickColor.parameters).to.deep.equal([
      { name: 'condition', type: 'boolean' },
      { name: 'whenTrue', type: 'string' },
      { name: 'whenFalse', type: 'string' },
    ]);
    expect(pickColor.returnType).to.equal('string');
    expect(pickColor.bodyText).to.include('if (condition) {');

    const [ifStatement, elseishReturn] = pickColor.block.statements;
    expect(ifStatement.node.kind).to.equal('IfStatement');
    expect((ifStatement as import('../../src/ast.js').IfStatement).condition.text).to.equal('condition');
    expect((ifStatement as import('../../src/ast.js').IfStatement).thenBlock!.statements[0].text).to.equal('return whenTrue');
    expect(elseishReturn.text).to.equal('return whenFalse');
  });

  it('parses the template into a static/dynamic-classified element tree with correct nesting', () => {
    const root = file.template!.children[0];
    expect(root.tagName).to.equal('Rectangle');
    expect(root.id).to.equal('background');
    expect(root.children).to.have.lengthOf(2);
    const highlight = asElement(root.children[0]);
    const layoutGroup = asElement(root.children[1]);
    expect(highlight.tagName).to.equal('Rectangle');
    expect(highlight.id).to.equal('highlight');
    expect(layoutGroup.tagName).to.equal('LayoutGroup');
    expect(layoutGroup.children.map((c) => asElement(c).tagName)).to.deep.equal(['Label', 'Label']);
  });
});

describe('parse — field declarations (isolated)', () => {
  it('throws dsl/invalid-field-type for an unknown field type', () => {
    const { diagnostics } = wrap(thr('field x: color = 0'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-field-type']);
  });

  it('throws dsl/invalid-field for a malformed field line', () => {
    const { diagnostics } = wrap(thr('field x integer 0'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-field']);
  });

  it('parses an array field with a bracketed literal default', () => {
    const { file, diagnostics } = wrap(thr('field items: array = [1, 2, 3]'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.fields.map((f) => [f.name, f.type, f.defaultLiteral])).to.deep.equal([['items', 'array', '[1, 2, 3]']]);
  });

  it('parses an assocarray field with a bracketed literal default', () => {
    const { file, diagnostics } = wrap(thr('field config: assocarray = { a: 1, b: "two" }'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.fields.map((f) => [f.name, f.type, f.defaultLiteral])).to.deep.equal([['config', 'assocarray', '{ a: 1, b: "two" }']]);
  });

  it('parses a nested array/assocarray literal spanning multiple lines', () => {
    const { file, diagnostics } = wrap(thr(['field config: assocarray = {', '  nested: [1, 2],', '  flag: true', '}'].join('\n')));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.fields[0].defaultLiteral).to.equal('{\n  nested: [1, 2],\n  flag: true\n}');
  });

  it('throws dsl/invalid-field for an unbalanced array literal default', () => {
    const { diagnostics } = wrap(thr('field items: array = [1, 2, 3'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-field']);
  });
});

describe('parse — derived declarations (isolated)', () => {
  it('parses a derived declaration with its required type', () => {
    const { file, diagnostics } = wrap(thr('field width: integer = 0\nderived isWide: boolean = width > 100'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.derived.map((d) => [d.name, d.type, d.expression])).to.deep.equal([['isWide', 'boolean', 'width > 100']]);
  });

  it('throws dsl/invalid-derived for a malformed derived line', () => {
    const { diagnostics } = wrap(thr('derived x'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-derived']);
  });

  it('throws dsl/invalid-derived when the required type annotation is missing', () => {
    const { diagnostics } = wrap(thr('derived x = 5'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-derived']);
  });
});

describe('parse — stream declarations (isolated)', () => {
  it('parses a stream declaration with its required type and no expression', () => {
    const { file, diagnostics } = wrap(thr('stream dataLoaded: string'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.streams.map((s) => [s.name, s.type])).to.deep.equal([['dataLoaded', 'string']]);
  });

  it('throws dsl/invalid-stream for a malformed stream line (missing colon/type)', () => {
    const { diagnostics } = wrap(thr('stream x'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-stream']);
  });

  it('throws dsl/invalid-stream when trailing content follows the type on the same line', () => {
    const { diagnostics } = wrap(thr('stream x: string = "nope"'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-stream']);
  });

  it('throws dsl/void-not-a-type for stream x: void', () => {
    const { diagnostics } = wrap(thr('stream x: void'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/void-not-a-type']);
  });
});

describe('parse — request declarations (isolated)', () => {
  it('parses a request declaration with its Kind and single-line config literal', () => {
    const { file, diagnostics } = wrap(thr('request Http { method: "GET", url: "https://example.com" }'));
    expect(diagnostics).to.deep.equal([]);
    const request = file.script.request;
    expect(request).to.not.equal(null);
    expect(request!.kind).to.equal('Http');
    expect(request!.config).to.equal('{ method: "GET", url: "https://example.com" }');
  });

  it('parses a config literal spanning several lines, including a nested object', () => {
    const { file, diagnostics } = wrap(
      thr(
        [
          'request Http {',
          '  method: "POST",',
          '  url: "https://example.com",',
          '  headers: { "Content-Type": "application/json" }',
          '}',
        ].join('\n'),
      ),
    );
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.request!.kind).to.equal('Http');
  });

  it('parses an empty config literal', () => {
    const { file, diagnostics } = wrap(thr('request Bogus {}'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.request!.kind).to.equal('Bogus');
    expect(file.script.request!.config).to.equal('{}');
  });

  it('does not validate Kind at this layer — an unknown Kind still parses cleanly', () => {
    const { file, diagnostics } = wrap(thr('request Bogus {}'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.request!.kind).to.equal('Bogus');
  });

  it('exposes every request {} declared, in source order, via .requests — "at most one" is validated in packages/compiler, not here', () => {
    const { file, diagnostics } = wrap(thr('request Http {}\nrequest Bogus {}'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.requests.map((r) => r.kind)).to.deep.equal(['Http', 'Bogus']);
  });

  it('throws dsl/invalid-request when Kind is missing', () => {
    const { diagnostics } = wrap(thr('request { method: "GET" }'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-request']);
  });

  it('throws dsl/invalid-request when the config literal is missing entirely', () => {
    const { diagnostics } = wrap(thr('request Http'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-request']);
  });

  it('throws dsl/invalid-request when the config literal never closes', () => {
    const { diagnostics } = wrap(thr('request Http { method: "GET"'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-request']);
  });
});

describe('parse — animation declarations (isolated)', () => {
  it('parses an animation declaration with its name and single-line config literal', () => {
    const { file, diagnostics } = wrap(thr('animation bounce { target: card, duration: 400 }'));
    expect(diagnostics).to.deep.equal([]);
    const animations = file.script.animations;
    expect(animations.map((a) => a.name)).to.deep.equal(['bounce']);
    expect(animations[0].config).to.equal('{ target: card, duration: 400 }');
  });

  it('parses a config literal spanning several lines, including a nested array', () => {
    const { file, diagnostics } = wrap(
      thr(['animation bounce {', '  target: card,', '  duration: 400,', '  scale: [1, 1.15, 1]', '}'].join('\n')),
    );
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.animations[0].name).to.equal('bounce');
  });

  it('parses an empty config literal', () => {
    const { file, diagnostics } = wrap(thr('animation noop {}'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.animations[0].name).to.equal('noop');
    expect(file.script.animations[0].config).to.equal('{}');
  });

  it('exposes every animation {} declared, in source order — any number allowed, unlike request', () => {
    const { file, diagnostics } = wrap(thr('animation bounce {}\nanimation fadeOut {}'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.animations.map((a) => a.name)).to.deep.equal(['bounce', 'fadeOut']);
  });

  it('throws dsl/invalid-animation when the name is missing', () => {
    const { diagnostics } = wrap(thr('animation { duration: 400 }'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-animation']);
  });

  it('throws dsl/invalid-animation when the config literal is missing entirely', () => {
    const { diagnostics } = wrap(thr('animation bounce'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-animation']);
  });

  it('throws dsl/invalid-animation when the config literal never closes', () => {
    const { diagnostics } = wrap(thr('animation bounce { duration: 400'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-animation']);
  });

  it('reserves "animation" globally — unusable as a plain identifier', () => {
    const { diagnostics } = wrap(thr('field animation: integer = 0'));
    expect(diagnostics.length).to.be.greaterThan(0);
  });
});

describe('parse — state declarations (isolated)', () => {
  it('parses a state declaration with name, type, and default literal', () => {
    const { file, diagnostics } = wrap(thr('state count: integer = 0'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.state.map((s) => [s.name, s.type, s.defaultLiteral])).to.deep.equal([['count', 'integer', '0']]);
  });

  it('accepts an unrestricted type identifier, unlike field', () => {
    const { file, diagnostics } = wrap(thr('state cache: object = invalid'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.state[0].type).to.equal('object');
  });

  it('parses an array literal default, with an unrestricted type identifier', () => {
    const { file, diagnostics } = wrap(thr('state items: object = [1, 2, 3]'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.state[0].defaultLiteral).to.equal('[1, 2, 3]');
  });

  it('parses an assocarray literal default', () => {
    const { file, diagnostics } = wrap(thr('state config: object = { a: 1, b: "two" }'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.state[0].defaultLiteral).to.equal('{ a: 1, b: "two" }');
  });

  it('throws dsl/invalid-state for an unbalanced array literal default', () => {
    const { diagnostics } = wrap(thr('state items: object = [1, 2, 3'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-state']);
  });

  it('throws dsl/invalid-state for a malformed state line', () => {
    const { diagnostics } = wrap(thr('state x = 0'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-state']);
  });
});

describe('parse — state assignment (isolated)', () => {
  function body(bodySource: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
    return wrap(thr(`private function f(): integer {\n${bodySource}\n}`));
  }

  it('parses a state assignment as a StateAssignment statement', () => {
    const { file, diagnostics } = body('state count = count + 1\nreturn count');
    expect(diagnostics).to.deep.equal([]);
    const [assign, tail] = file.script.functions[0].block.statements;
    expect(assign.node.kind).to.equal('StateAssignment');
    expect((assign as import('../../src/ast.js').StateAssignment).name).to.equal('count');
    expect((assign as import('../../src/ast.js').StateAssignment).expression).to.equal('count + 1');
    expect(tail.text).to.equal('return count');
  });

  it('throws statement/invalid-state-assignment for a malformed state write (no equals)', () => {
    const { diagnostics } = body('state count\nreturn 1');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/invalid-state-assignment']);
  });

  it('throws statement/invalid-state-assignment when nothing follows the equals on the same line', () => {
    const { diagnostics } = body('state count =\nreturn 1');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/invalid-state-assignment']);
  });

  it('leaves the word "state" inside a string literal untouched', () => {
    const { file, diagnostics } = body('return "state x = 5"');
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions[0].block.statements.map((s) => s.node.kind)).to.deep.equal(['StatementRegion']);
  });
});

describe('parse — script-level (isolated)', () => {
  it('throws dsl/unexpected-token for content that is not field/derived/state/read/watch/stream/function', () => {
    const { diagnostics } = wrap(thr('bogus x = 0'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/unexpected-token']);
  });

  it('parses back-to-back field, derived, stream, request, and function declarations in one pass', () => {
    const { file, diagnostics } = wrap(
      thr(
        [
          'field width: integer = 0',
          'derived isWide: boolean = width > 100',
          'stream dataLoaded: string',
          'request Http { method: "GET", url: "https://example.com" }',
          'public function label(): string {',
          '  return "wide"',
          '}',
        ].join('\n'),
      ),
    );

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.fields).to.have.lengthOf(1);
    expect(file.script.derived).to.have.lengthOf(1);
    expect(file.script.streams).to.have.lengthOf(1);
    expect(file.script.request).to.not.equal(null);
    expect(file.script.functions).to.have.lengthOf(1);
    expect(file.script.functions[0].visibility).to.equal('public');
  });
});

describe('parse — import declaration in a <script> section (isolated)', () => {
  it('parses one or more imports before other declarations', () => {
    const { file, diagnostics } = wrap(thr(['import Counter from "../Classes/Counter.flsh"', 'field width: integer = 0'].join('\n')));

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.imports).to.have.lengthOf(1);
    expect(file.script.imports[0].className).to.equal('Counter');
    expect(file.script.imports[0].path).to.equal('../Classes/Counter.flsh');
    expect(file.script.fields).to.have.lengthOf(1);
  });

  it('throws dsl/invalid-import for a malformed import (missing "from")', () => {
    const { diagnostics } = wrap(thr('import Counter "../Classes/Counter.flsh"'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-import']);
  });

  it('throws dsl/invalid-import when the path is not a string literal', () => {
    const { diagnostics } = wrap(thr('import Counter from somewhere'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-import']);
  });
});

describe('parse — function declarations (isolated)', () => {
  it('does not terminate a function body early on a nested associative-array literal', () => {
    const { file, diagnostics } = wrap(thr('private function build(): object {\n  return { a: 1, b: { c: 2 } }\n}'));

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions).to.have.lengthOf(1);
    expect(file.script.functions[0].bodyText.trim()).to.equal('return { a: 1, b: { c: 2 } }');
  });

  it('does not terminate a function body early on a string literal containing braces', () => {
    const { file, diagnostics } = wrap(thr('private function describe(): string {\n  return "a } b { c"\n}'));

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions[0].bodyText.trim()).to.equal('return "a } b { c"');
  });

  it('throws dsl/unterminated-function when the closing brace is missing', () => {
    const { diagnostics } = wrap(thr('private function build(): object {\n  return {}'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/unterminated-function']);
  });

  it('throws dsl/invalid-param for a malformed parameter', () => {
    const { diagnostics } = wrap(thr('private function build(x): object {\n  return {}\n}'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-param']);
  });

  it('parses a function with no return-type clause at all — returnType is null', () => {
    const { file, diagnostics } = wrap(thr('private function log(message: string) {\n  print message\n}'));

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions[0].returnType).to.equal(null);
    expect(file.script.functions[0].parameters).to.deep.equal([{ name: 'message', type: 'string' }]);
  });

  it('still parses a function with a return-type clause — returnType is the declared type', () => {
    const { file, diagnostics } = wrap(thr('private function describe(): string {\n  return "hi"\n}'));

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions[0].returnType).to.equal('string');
  });

  it('throws dsl/void-not-a-type for an explicit ": void" return type', () => {
    const { diagnostics } = wrap(thr('private function bump(): void {\n  print "x"\n}'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/void-not-a-type']);
  });

  it('throws dsl/void-not-a-type for "void" as a parameter type', () => {
    const { diagnostics } = wrap(thr('private function bump(x: void) {\n  print "x"\n}'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/void-not-a-type']);
  });

  it('throws dsl/void-not-a-type for "void" as a state type', () => {
    const { diagnostics } = wrap(thr('state count: void = invalid'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/void-not-a-type']);
  });

  it('throws dsl/void-not-a-type for "void" as a derived type', () => {
    const { diagnostics } = wrap(thr('field count: integer = 0\nderived doubled: void = count * 2'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/void-not-a-type']);
  });
});

describe('parse — if statements', () => {
  function body(bodySource: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
    return wrap(thr(`private function f(): integer {\n${bodySource}\n}`));
  }

  it('parses a block-form if into a structured IfStatement with a Block then-branch', () => {
    const { file, diagnostics } = body('if (condition) {\n  return 1\n}\nreturn 2');
    expect(diagnostics).to.deep.equal([]);
    const [ifStmt, tail] = file.script.functions[0].block.statements;
    expect(ifStmt.node.kind).to.equal('IfStatement');
    expect((ifStmt as import('../../src/ast.js').IfStatement).thenBlock!.statements[0].text).to.equal('return 1');
    expect(tail.text).to.equal('return 2');
  });

  it('parses an inline if into a structured IfStatement with a single then-statement', () => {
    const { file, diagnostics } = body('if (condition) return 1');
    expect(diagnostics).to.deep.equal([]);
    const [ifStmt] = file.script.functions[0].block.statements;
    expect((ifStmt as import('../../src/ast.js').IfStatement).thenStatement!.text).to.equal('return 1');
  });

  it('strips an optional trailing semicolon from an inline if statement', () => {
    const { file, diagnostics } = body('if (condition) return 1;');
    expect(diagnostics).to.deep.equal([]);
    const [ifStmt] = file.script.functions[0].block.statements;
    expect((ifStmt as import('../../src/ast.js').IfStatement).thenStatement!.text).to.equal('return 1');
  });

  it('parses two sequential top-level ifs independently', () => {
    const { file, diagnostics } = body('if (a = invalid) {\n  return 1\n}\nif (b) {\n  return 2\n}\nreturn 3');
    expect(diagnostics).to.deep.equal([]);
    const statements = file.script.functions[0].block.statements;
    expect(statements.map((s) => s.node.kind)).to.deep.equal(['IfStatement', 'IfStatement', 'StatementRegion']);
  });

  it('parses a nested if inside a block, innermost included', () => {
    const { file, diagnostics } = body('if (a) {\n  if (b) {\n    return 1\n  }\n  return 2\n}');
    expect(diagnostics).to.deep.equal([]);
    const [outer] = file.script.functions[0].block.statements as [import('../../src/ast.js').IfStatement];
    const [inner, tail] = outer.thenBlock!.statements;
    expect(inner.node.kind).to.equal('IfStatement');
    expect(tail.text).to.equal('return 2');
  });

  it('leaves the word "if" inside a string literal untouched', () => {
    const { file, diagnostics } = body('return "if (x) { y }"');
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions[0].block.statements.map((s) => s.node.kind)).to.deep.equal(['StatementRegion']);
  });

  it('leaves the word "if" inside a line comment untouched', () => {
    const { file, diagnostics } = body("' if (x) { this is a comment }\nreturn 1");
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions[0].block.statements.map((s) => s.node.kind)).to.deep.equal(['StatementRegion']);
  });

  it('does not mistake an identifier containing "if" for the keyword', () => {
    const { file, diagnostics } = body('ifValue = myif(1)\nreturn 1');
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions[0].block.statements.map((s) => s.node.kind)).to.deep.equal(['StatementRegion']);
  });

  it('throws statement/if-requires-parens when if is not followed by (', () => {
    const { diagnostics } = body('if condition then return 1');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/if-requires-parens']);
  });

  it('throws statement/unterminated-if-condition when the condition paren never closes', () => {
    const { diagnostics } = body('if (condition\n  return 1');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/unterminated-if-condition']);
  });

  it('throws statement/empty-inline-if when nothing follows the condition', () => {
    const { diagnostics } = body('if (condition)\nreturn 1');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/empty-inline-if']);
  });

  it('parses else after a block-form if into an ElseClause with a Block', () => {
    const { file, diagnostics } = body('if (condition) {\n  return 1\n} else {\n  return 2\n}');
    expect(diagnostics).to.deep.equal([]);
    const [ifStmt] = file.script.functions[0].block.statements as [import('../../src/ast.js').IfStatement];
    expect(ifStmt.thenBlock!.statements[0].text).to.equal('return 1');
    expect(ifStmt.elseClause!.block!.statements[0].text).to.equal('return 2');
    expect(ifStmt.elseClause!.elseIf).to.equal(null);
    expect(ifStmt.elseClause!.statement).to.equal(null);
  });

  it('parses else after an inline if into an ElseClause with an inline statement, even on the next line', () => {
    const { file, diagnostics } = body('if (condition) return 1\nelse return 2');
    expect(diagnostics).to.deep.equal([]);
    const [ifStmt] = file.script.functions[0].block.statements as [import('../../src/ast.js').IfStatement];
    expect(ifStmt.thenStatement!.text).to.equal('return 1');
    expect(ifStmt.elseClause!.statement!.text).to.equal('return 2');
  });

  it('parses a fully single-line inline if/else, stopping the then-statement scan at "else"', () => {
    const { file, diagnostics } = body('if (condition) return 1 else return 2');
    expect(diagnostics).to.deep.equal([]);
    const [ifStmt] = file.script.functions[0].block.statements as [import('../../src/ast.js').IfStatement];
    expect(ifStmt.thenStatement!.text).to.equal('return 1');
    expect(ifStmt.elseClause!.statement!.text).to.equal('return 2');
  });

  it('parses an else-if chain as nested IfStatements, terminated by a plain else block', () => {
    const { file, diagnostics } = body(
      'if (a) {\n  return 1\n} else if (b) {\n  return 2\n} else {\n  return 3\n}',
    );
    expect(diagnostics).to.deep.equal([]);
    const [outer] = file.script.functions[0].block.statements as [import('../../src/ast.js').IfStatement];
    const elseIf = outer.elseClause!.elseIf!;
    expect(elseIf.condition.text).to.equal('b');
    expect(elseIf.thenBlock!.statements[0].text).to.equal('return 2');
    expect(elseIf.elseClause!.block!.statements[0].text).to.equal('return 3');
  });

  it('throws statement/dangling-else for an else with no matching if', () => {
    const { diagnostics } = body('return 1\nelse return 2');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/dangling-else']);
  });

  it('throws statement/empty-else when nothing follows else', () => {
    const { diagnostics } = body('if (condition) return 1\nelse\nreturn 2');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/empty-else']);
  });

  it('passes a body with no if statements through as a single StatementRegion', () => {
    const { file, diagnostics } = body('return content.title');
    expect(diagnostics).to.deep.equal([]);
    expect(file.script.functions[0].block.statements.map((s) => s.node.kind)).to.deep.equal(['StatementRegion']);
  });
});

describe('parse — template markup', () => {
  it('classifies static attributes and excludes id from the attribute list', () => {
    const { file, diagnostics } = wrap(thr('field width: integer = 0', '<Rectangle id="background" color="0x1A1A1AFF" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([{ kind: 'static', name: 'color', value: '0x1A1A1AFF' }]);
  });

  it('classifies a quoted {expr} attribute as dynamic and extracts the expression text', () => {
    const { file, diagnostics } = wrap(thr('field width: integer = 0', '<Rectangle id="background" width="{width}" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([{ kind: 'dynamic', name: 'width', expression: 'width' }]);
  });

  it('extracts a multi-token expression such as an array literal untouched', () => {
    const { file, diagnostics } = wrap(
      thr('field width: integer = 0\nfield height: integer = 0', '<LayoutGroup id="a" translation="{[width / 2, height / 2]}" />'),
    );
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([{ kind: 'dynamic', name: 'translation', expression: '[width / 2, height / 2]' }]);
  });

  it('throws template/missing-id when a dynamic attribute has no id on its element', () => {
    const { diagnostics } = wrap(thr('field width: integer = 0', '<Rectangle width="{width}" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/missing-id']);
  });

  it('throws template/invalid-xml on malformed markup', () => {
    const { diagnostics } = wrap(thr('field width: integer = 0', '<Rectangle id="a"><Label id="b"></Rectangle>'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/invalid-xml']);
  });

  it('throws expression/parse-error for a malformed dynamic attribute expression', () => {
    const { diagnostics } = wrap(thr('field width: integer = 0', '<Rectangle id="a" width="{width >}" />'));
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.every((d) => d.code === 'expression/parse-error')).to.be.true;
  });

  it('classifies a bind:<field>="{expr}" attribute as bind and strips the "bind:" prefix from its name', () => {
    const { file, diagnostics } = wrap(thr('state text: string = ""', '<TextEditBox id="input" bind:text="{text}" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([{ kind: 'bind', name: 'text', expression: 'text' }]);
  });

  it('throws template/missing-id when a bind: attribute has no id on its element', () => {
    const { diagnostics } = wrap(thr('state text: string = ""', '<TextEditBox bind:text="{text}" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/missing-id']);
  });

  it('throws template/invalid-bind-target when a bind: attribute is not a quoted {expression}', () => {
    const { diagnostics } = wrap(thr('state text: string = ""', '<TextEditBox id="input" bind:text="text" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/invalid-bind-target']);
  });

  it('classifies transition:<name>="{{...}}" with an override config, direction "both"', () => {
    const { file, diagnostics } = wrap(thr('', '<Rectangle id="panel" transition:fade="{{duration: 250}}" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([
      { kind: 'transition', direction: 'both', animationRef: 'fade', overrideConfigText: '{duration: 250}' },
    ]);
  });

  it('classifies in:<name> and out:<name> with independent directions on the same element', () => {
    const { file, diagnostics } = wrap(thr('', '<Rectangle id="panel" in:fly="{{y: 40}}" out:fade="{{duration: 150}}" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([
      { kind: 'transition', direction: 'in', animationRef: 'fly', overrideConfigText: '{y: 40}' },
      { kind: 'transition', direction: 'out', animationRef: 'fade', overrideConfigText: '{duration: 150}' },
    ]);
  });

  it('classifies a bare transition:<name>="" (empty value) with no override config', () => {
    const { file, diagnostics } = wrap(thr('', '<Rectangle id="panel" transition:fade="" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([{ kind: 'transition', direction: 'both', animationRef: 'fade', overrideConfigText: null }]);
  });

  it('classifies transition:<name>="{{}}" (empty override object) the same as an explicit empty override', () => {
    const { file, diagnostics } = wrap(thr('', '<Rectangle id="panel" transition:fade="{{}}" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([{ kind: 'transition', direction: 'both', animationRef: 'fade', overrideConfigText: '{}' }]);
  });

  it('throws template/missing-id when a transition: attribute has no id on its element', () => {
    const { diagnostics } = wrap(thr('', '<Rectangle transition:fade="" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/missing-id']);
  });

  it('throws template/invalid-transition-syntax for a single-brace value (not a real {{...}} object literal)', () => {
    const { diagnostics } = wrap(thr('', '<Rectangle id="panel" transition:fade="{300}" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/invalid-transition-syntax']);
  });

  it('throws template/invalid-transition-syntax for an unquoted bare value', () => {
    const { diagnostics } = wrap(thr('', '<Rectangle id="panel" transition:fade="fade" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/invalid-transition-syntax']);
  });

  it('classifies navigate-out:/navigate-in:/back-out:/back-in: with independent directions on the same element', () => {
    const { file, diagnostics } = wrap(
      thr('', '<FlashTheaterRouterOutlet id="outlet" navigate-out:slideOutLeft="" navigate-in:slideInFromRight="{{duration: 0.3}}" back-out:fade="" back-in:fly="{{y: 20}}" />'),
    );
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([
      { kind: 'routerTransition', navDirection: 'navigate', phase: 'out', animationRef: 'slideOutLeft', overrideConfigText: null },
      { kind: 'routerTransition', navDirection: 'navigate', phase: 'in', animationRef: 'slideInFromRight', overrideConfigText: '{duration: 0.3}' },
      { kind: 'routerTransition', navDirection: 'back', phase: 'out', animationRef: 'fade', overrideConfigText: null },
      { kind: 'routerTransition', navDirection: 'back', phase: 'in', animationRef: 'fly', overrideConfigText: '{y: 20}' },
    ]);
  });

  it('classifies a bare navigate-out:<name>="" (empty value) with no override config', () => {
    const { file, diagnostics } = wrap(thr('', '<FlashTheaterRouterOutlet id="outlet" navigate-out:slide="" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([
      { kind: 'routerTransition', navDirection: 'navigate', phase: 'out', animationRef: 'slide', overrideConfigText: null },
    ]);
  });

  it('throws template/missing-id when a navigate-out: attribute has no id on its element', () => {
    const { diagnostics } = wrap(thr('', '<FlashTheaterRouterOutlet navigate-out:slide="" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/missing-id']);
  });

  it('throws template/invalid-transition-syntax for a router-transition attribute with a single-brace value', () => {
    const { diagnostics } = wrap(thr('', '<FlashTheaterRouterOutlet id="outlet" navigate-out:slide="{0.3}" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/invalid-transition-syntax']);
  });

  it('classifies animate:<field>="{{...}}" with an override config', () => {
    const { file, diagnostics } = wrap(thr('field level: integer = 0', '<Rectangle id="poster" opacity="{level}" animate:opacity="{{duration: 200}}" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([
      { kind: 'dynamic', name: 'opacity', expression: 'level' },
      { kind: 'animate', fieldName: 'opacity', overrideConfigText: '{duration: 200}' },
    ]);
  });

  it('classifies a bare animate:<field>="" with no override config', () => {
    const { file, diagnostics } = wrap(thr('field level: integer = 0', '<Rectangle id="poster" opacity="{level}" animate:opacity="" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes[1]).to.deep.equal({ kind: 'animate', fieldName: 'opacity', overrideConfigText: null });
  });

  it('throws template/missing-id when an animate: attribute has no id on its element', () => {
    const { diagnostics } = wrap(thr('field level: integer = 0', '<Rectangle opacity="{level}" animate:opacity="" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/missing-id']);
  });

  it('throws template/invalid-animate-syntax for a single-brace value', () => {
    const { diagnostics } = wrap(thr('field level: integer = 0', '<Rectangle id="poster" opacity="{level}" animate:opacity="{200}" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/invalid-animate-syntax']);
  });

  it('classifies a single-key on:key[Key]="{expr}" attribute as onKey with a one-element keys list', () => {
    const { file, diagnostics } = wrap(thr('private function selectItem(key: string, press: boolean) {}', '<Rectangle id="card" on:key[OK]="{selectItem(key, press)}" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([{ kind: 'onKey', keys: ['OK'], expression: 'selectItem(key, press)' }]);
  });

  it('classifies a multi-key on:key[K1,K2,K3]="{expr}" attribute, trimming whitespace around each key', () => {
    const { file, diagnostics } = wrap(
      thr('private function startVideo(key: string, press: boolean) {}', '<Rectangle id="card" on:key[OK, play, replay]="{startVideo(key, press)}" />'),
    );
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([{ kind: 'onKey', keys: ['OK', 'play', 'replay'], expression: 'startVideo(key, press)' }]);
  });

  it('classifies the on:key[*] wildcard segment as the literal "*" in the keys list', () => {
    const { file, diagnostics } = wrap(thr('private function fallback(key: string, press: boolean) {}', '<Rectangle id="card" on:key[*]="{fallback(key, press)}" />'));
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([{ kind: 'onKey', keys: ['*'], expression: 'fallback(key, press)' }]);
  });

  it('allows a specific-key and a wildcard on:key attribute side by side on the same element', () => {
    const { file, diagnostics } = wrap(
      thr(
        'private function selectItem(key: string, press: boolean) {}\nprivate function fallback(key: string, press: boolean) {}',
        '<Rectangle id="card" on:key[OK]="{selectItem(key, press)}" on:key[*]="{fallback(key, press)}" />',
      ),
    );
    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children[0].attributes).to.deep.equal([
      { kind: 'onKey', keys: ['OK'], expression: 'selectItem(key, press)' },
      { kind: 'onKey', keys: ['*'], expression: 'fallback(key, press)' },
    ]);
  });

  it('throws template/missing-id when an on:key attribute has no id on its element', () => {
    const { diagnostics } = wrap(thr('private function selectItem(key: string, press: boolean) {}', '<Rectangle on:key[OK]="{selectItem(key, press)}" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/missing-id']);
  });

  it('throws template/on-key-invalid-syntax when an on:key attribute is not a quoted {expression}', () => {
    const { diagnostics } = wrap(thr('private function selectItem(key: string, press: boolean) {}', '<Rectangle id="card" on:key[OK]="selectItem(key, press)" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/on-key-invalid-syntax']);
  });

  it('throws template/on-key-invalid-syntax when an on:key attribute\'s bracket is never closed', () => {
    const { diagnostics } = wrap(thr('private function selectItem(key: string, press: boolean) {}', '<Rectangle id="card" on:key[OK="{selectItem(key, press)}" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/on-key-invalid-syntax']);
  });

  it('throws template/on-key-empty-key-name for an empty on:key[] key list', () => {
    const { diagnostics } = wrap(thr('private function fallback(key: string, press: boolean) {}', '<Rectangle id="card" on:key[]="{fallback(key, press)}" />'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/on-key-empty-key-name']);
  });

  it('throws template/on-key-empty-key-name for a doubled separator like on:key[OK,,play]', () => {
    const { diagnostics } = wrap(
      thr('private function selectItem(key: string, press: boolean) {}', '<Rectangle id="card" on:key[OK,,play]="{selectItem(key, press)}" />'),
    );
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/on-key-empty-key-name']);
  });

  it('round-trips a .thr file containing on:key[...] markup byte-for-byte despite the internal transliteration pass', () => {
    const source = thr(
      'private function selectItem(key: string, press: boolean) {}',
      '<Rectangle id="card" on:key[OK, play]="{selectItem(key, press)}" />',
    );
    const result = parse(source);
    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});

describe('parse — top-level .thr structure', () => {
  it('throws thr/unrecognized-root when the file does not start with a known root tag', () => {
    const { diagnostics } = wrap('<Label id="a" />');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['thr/unrecognized-root']);
  });

  it('throws thr/unterminated-script when </script> is never found', () => {
    const { diagnostics } = wrap('<script>\nfield width: integer = 0\n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['thr/unterminated-script']);
  });

  it('throws thr/missing-template when there is no markup after </script>', () => {
    const { diagnostics } = wrap('<script>\nfield width: integer = 0\n</script>\n   \n');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['thr/missing-template']);
  });

  it('throws thr/expected-component-tag when the markup after </script> is not wrapped in <component>', () => {
    const source = '<script>\nfield width: integer = 0\n</script>\n<Rectangle id="a" />\n';
    const { diagnostics } = wrap(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['thr/expected-component-tag']);
  });

  it('extracts the optional extends="..." attribute off <component>', () => {
    const source = thr('field width: integer = 0').replace('<component>', '<component extends="Scene">');
    const { file, diagnostics } = wrap(source);

    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.extends).to.equal('Scene');
  });

  it('has a null extends when the attribute is absent, the plain <component> form', () => {
    const { file, diagnostics } = wrap(thr('field width: integer = 0'));

    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.extends).to.equal(null);
  });

  it('reproduces a file with <component extends="Task"> byte-for-byte, with zero diagnostics', () => {
    const source = thr('field width: integer = 0').replace('<component>', '<component extends="Task">');
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });

  it('tolerates extra whitespace inside the <component extends="..."> opening tag', () => {
    const source = thr('field width: integer = 0').replace('<component>', '<component  extends="Scene" >');
    const { file, diagnostics } = wrap(source);

    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.extends).to.equal('Scene');
  });

  it('extracts on:key[...] attributes declared directly on <component>', () => {
    const source = thr('private function handleKey(key: string, press: boolean) { print key }').replace(
      '<component>',
      '<component on:key[OK,up]="{handleKey()}">',
    );
    const { file, diagnostics } = wrap(source);

    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.onKeyAttributes).to.deep.equal([{ keys: ['OK', 'up'], expression: 'handleKey()' }]);
  });

  it('has an empty onKeyAttributes array when <component> declares none', () => {
    const { file, diagnostics } = wrap(thr('field width: integer = 0'));

    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.onKeyAttributes).to.deep.equal([]);
  });

  it('allows 2+ top-level siblings directly inside <component>, no wrapper element required', () => {
    const source = thr('field width: integer = 0', '<Rectangle id="a" /><Rectangle id="b" />');
    const { file, diagnostics } = wrap(source);

    expect(diagnostics).to.deep.equal([]);
    expect(file.template!.children.map((c) => (c.kind === 'element' ? c.id : c.kind))).to.deep.equal(['a', 'b']);
  });

  it('throws template/component-cannot-have-id when <component> itself declares an id', () => {
    const source = thr('field width: integer = 0').replace('<component>', '<component id="root">');
    const { diagnostics } = wrap(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/component-cannot-have-id']);
  });

  it('throws template/component-invalid-attribute for an attribute other than extends/on:key on <component>', () => {
    const source = thr('field width: integer = 0').replace('<component>', '<component color="red">');
    const { diagnostics } = wrap(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['template/component-invalid-attribute']);
  });
});
