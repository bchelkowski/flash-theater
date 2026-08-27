import { expect } from 'chai';
import { emitXml } from '../../src/codegen/xml-emitter.js';
import { FieldDecl, TemplateElement, TemplateNode, ThrScriptAst, ThrTemplateAst } from '../../src/dsl-parser/dsl-ast.js';
import { analyzeConditionalBlocks } from '../../src/analysis/conditional-blocks.js';
import { compileThrSource } from '../../src/compile.js';

const SPAN = { line: 0 };

function field(name: string, type: FieldDecl['type'], defaultLiteral: string): FieldDecl {
  return { kind: 'field', name, type, defaultLiteral, span: SPAN };
}

function script(fields: FieldDecl[]): ThrScriptAst {
  return { imports: [], fields, derived: [], state: [], reads: [], watches: [], streams: [], request: null, animations: [], functions: [], extends: null };
}

function element(tagName: string, id: string | null, children: TemplateNode[] = []): TemplateElement {
  return { kind: 'element', tagName, id, attributes: [], children };
}

function ifBlock(mode: 'toggle' | 'destroy', expression: string, children: TemplateNode[] = []): TemplateNode {
  return { kind: 'if', mode, expression, children };
}

describe('emitXml', () => {
  it('omits value= for a node-typed field and never adds onChange when the field is unused', () => {
    const s = script([field('itemContent', 'node', 'invalid'), field('unused', 'integer', '0')]);
    const template: ThrTemplateAst = { root: element('Group', 'root') };

    const xml = emitXml(s, template, new Set(), 'Widget');

    expect(xml).to.include('<field id="itemContent" type="node" />');
    expect(xml).to.include('<field id="unused" type="integer" value="0" />');
    expect(xml).to.not.include('onChange');
  });

  it('omits value= for array/assocarray-typed fields too — no representable XML literal for either', () => {
    const s = script([field('items', 'array', '[1, 2, 3]'), field('config', 'assocarray', '{ a: 1 }')]);
    const template: ThrTemplateAst = { root: element('Group', 'root') };

    const xml = emitXml(s, template, new Set(), 'Widget');

    expect(xml).to.include('<field id="items" type="array" />');
    expect(xml).to.include('<field id="config" type="assocarray" />');
  });

  it('adds onChange only for fields present in fieldsNeedingOnChange', () => {
    const s = script([field('a', 'integer', '0'), field('b', 'integer', '0')]);
    const template: ThrTemplateAst = { root: element('Group', 'root') };

    const xml = emitXml(s, template, new Set(['b']), 'Widget');

    expect(xml).to.include('<field id="a" type="integer" value="0" />');
    expect(xml).to.include('<field id="b" type="integer" value="0" onChange="on_bChange" />');
  });

  it('emits a self-closing tag for a childless element and a nested tag for one with children', () => {
    const template: ThrTemplateAst = {
      root: element('Rectangle', 'background', [element('Label', 'title')]),
    };

    const xml = emitXml(script([]), template, new Set(), 'Widget');

    expect(xml).to.include('<Rectangle id="background">');
    expect(xml).to.include('  <Label id="title" />');
    expect(xml).to.include('</Rectangle>');
  });

  it('references the component name in both the component tag and the script uri', () => {
    const template: ThrTemplateAst = { root: element('Group', 'root') };
    const xml = emitXml(script([]), template, new Set(), 'MyWidget');

    expect(xml).to.include('<component name="MyWidget" extends="Group">');
    expect(xml).to.include('<script type="text/brightscript" uri="MyWidget.brs" />');
  });

  it('emits the given extends option verbatim in the <component> tag, overriding the "Group" default', () => {
    const template: ThrTemplateAst = { root: element('Group', 'root') };

    expect(emitXml(script([]), template, new Set(), 'MainScene', { extends: 'Scene' })).to.include('<component name="MainScene" extends="Scene">');
    expect(emitXml(script([]), template, new Set(), 'MyTask', { extends: 'Task' })).to.include('<component name="MyTask" extends="Task">');
  });

  it('emits a <function> interface entry for each name in interfaceFunctions, after the fields', () => {
    const s = script([field('a', 'integer', '0')]);
    const template: ThrTemplateAst = { root: element('Group', 'root') };

    const xml = emitXml(s, template, new Set(), 'Widget', { interfaceFunctions: ['load', 'addDay'] });

    expect(xml).to.include('<field id="a" type="integer" value="0" />\n    <function name="load" />\n    <function name="addDay" />');
  });

  describe('{#if}/{#if:destroy} conditional blocks', () => {
    it('emits a toggle-mode block as an always-present synthetic Group wrapping its children', () => {
      const root = element('Rectangle', 'root', [ifBlock('toggle', 'visible', [element('Label', 'inner')])]);
      const conditionalBlocks = analyzeConditionalBlocks(root);
      const xml = emitXml(script([]), { root }, new Set(), 'Widget', { conditionalBlocks });

      expect(xml).to.include('<Group id="ft_if_1">');
      expect(xml).to.include('<Label id="inner" />');
      expect(xml).to.include('</Group>');
    });

    it('never emits a destroy-mode block or any of its children into the static XML', () => {
      const root = element('Rectangle', 'root', [ifBlock('destroy', 'visible', [element('Label', 'inner')])]);
      const conditionalBlocks = analyzeConditionalBlocks(root);
      const xml = emitXml(script([]), { root }, new Set(), 'Widget', { conditionalBlocks });

      expect(xml).to.not.include('inner');
      expect(xml).to.not.include('ft_if_1');
      expect(xml).to.include('<Rectangle id="root" />');
    });

    it('emits a compiler-synthesized id onto a real element that only needed one to serve as a destroy-mode block\'s parent', () => {
      const inner = element('Rectangle', null, [ifBlock('destroy', 'visible', [element('Label', 'a')])]);
      const root = element('Group', 'root', [inner]);
      const conditionalBlocks = analyzeConditionalBlocks(root);
      const xml = emitXml(script([]), { root }, new Set(), 'Widget', { conditionalBlocks });

      expect(xml).to.include('<Rectangle id="ft_parent_1" />');
    });

    it('keeps a static/dynamic sibling of a destroy-mode block in the static tree, unaffected', () => {
      const root = element('Rectangle', 'root', [element('Label', 'before'), ifBlock('destroy', 'visible', [element('Label', 'hidden')]), element('Label', 'after')]);
      const conditionalBlocks = analyzeConditionalBlocks(root);
      const xml = emitXml(script([]), { root }, new Set(), 'Widget', { conditionalBlocks });

      expect(xml).to.include('<Label id="before" />');
      expect(xml).to.include('<Label id="after" />');
      expect(xml).to.not.include('hidden');
    });
  });
});

describe('emitXml — extends threading through the full compileThrSource pipeline', () => {
  it('a <component extends="Scene"> source compiles to a <component extends="Scene"> — not just at the emitXml unit level', () => {
    const source = '<script>\nfield count: integer = 0\n</script>\n<component extends="Scene">\n<Group id="root" />\n</component>\n';
    const { xml } = compileThrSource(source, 'MainScene');

    expect(xml).to.include('<component name="MainScene" extends="Scene">');
  });

  it('a plain <component> (no extends attribute) still compiles to <component extends="Group">', () => {
    const source = '<script>\nfield count: integer = 0\n</script>\n<component>\n<Group id="root" />\n</component>\n';
    const { xml } = compileThrSource(source, 'Widget');

    expect(xml).to.include('<component name="Widget" extends="Group">');
  });

  it('a <component> with 2+ top-level children emits them directly into <children>, no wrapper tag', () => {
    const source = '<script>\nfield count: integer = 0\n</script>\n<component>\n<Rectangle id="a" />\n<Rectangle id="b" />\n</component>\n';
    const { xml } = compileThrSource(source, 'Widget');

    expect(xml).to.include('<Rectangle id="a" />');
    expect(xml).to.include('<Rectangle id="b" />');
    expect(xml).to.not.include('ft_multi_root');
  });
});
