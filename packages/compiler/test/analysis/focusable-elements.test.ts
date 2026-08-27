import { expect } from 'chai';
import { checkAtMostOneDefaultFocus, checkNestedFocusableConflicts, collectFocusableElements } from '../../src/analysis/focusable-elements.js';
import { CompileError, TemplateAttribute, TemplateElement, TemplateNode } from '../../src/dsl-parser/dsl-ast.js';

function element(tagName: string, id: string | null, children: TemplateNode[] = [], attributes: TemplateAttribute[] = []): TemplateElement {
  return { kind: 'element', tagName, id, attributes, children };
}

function staticAttr(name: string, value: string): TemplateAttribute {
  return { kind: 'static', name, value };
}

function dynamicAttr(name: string, expression: string): TemplateAttribute {
  return { kind: 'dynamic', name, expression };
}

describe('collectFocusableElements', () => {
  it('collects a static focusable="true" element as isStaticTrue', () => {
    const root = element('Rectangle', 'card', [], [staticAttr('focusable', 'true')]);
    const found = collectFocusableElements(root);
    expect(found).to.deep.equal([{ elementId: 'card', isStaticTrue: true, isDefault: false }]);
  });

  it('collects a static focusable="false" element as NOT isStaticTrue', () => {
    const root = element('Rectangle', 'card', [], [staticAttr('focusable', 'false')]);
    const found = collectFocusableElements(root);
    expect(found).to.deep.equal([{ elementId: 'card', isStaticTrue: false, isDefault: false }]);
  });

  it('collects a dynamic focusable="{expr}" element as NOT isStaticTrue', () => {
    const root = element('Rectangle', 'card', [], [dynamicAttr('focusable', 'cardActive')]);
    const found = collectFocusableElements(root);
    expect(found).to.deep.equal([{ elementId: 'card', isStaticTrue: false, isDefault: false }]);
  });

  it('recurses into nested children', () => {
    const root = element('Rectangle', 'root', [element('Rectangle', 'child', [], [staticAttr('focusable', 'true')])]);
    const found = collectFocusableElements(root);
    expect(found).to.deep.equal([{ elementId: 'child', isStaticTrue: true, isDefault: false }]);
  });

  it('ignores an ordinary attribute that is not named focusable', () => {
    const root = element('Rectangle', 'card', [], [staticAttr('color', '0xFF0000FF')]);
    expect(collectFocusableElements(root)).to.deep.equal([]);
  });

  it('throws template/focusable-missing-id when a focusable element has no id', () => {
    const root = element('Rectangle', null, [], [staticAttr('focusable', 'true')]);
    expect(() => collectFocusableElements(root))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/focusable-missing-id' });
  });

  it('collects a static default-focus="true" element alongside static focusable="true" as isDefault', () => {
    const root = element('Rectangle', 'card', [], [staticAttr('focusable', 'true'), staticAttr('default-focus', 'true')]);
    const found = collectFocusableElements(root);
    expect(found).to.deep.equal([{ elementId: 'card', isStaticTrue: true, isDefault: true }]);
  });

  it('throws template/default-focus-must-be-static for a dynamic default-focus="{expr}"', () => {
    const root = element('Rectangle', 'card', [], [staticAttr('focusable', 'true'), dynamicAttr('default-focus', 'isPrimary')]);
    expect(() => collectFocusableElements(root))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/default-focus-must-be-static' });
  });

  it('throws template/default-focus-requires-static-focusable when default-focus pairs with a dynamic focusable', () => {
    const root = element('Rectangle', 'card', [], [dynamicAttr('focusable', 'cardActive'), staticAttr('default-focus', 'true')]);
    expect(() => collectFocusableElements(root))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/default-focus-requires-static-focusable' });
  });

  it('throws template/default-focus-requires-static-focusable when the element has no focusable attribute at all', () => {
    const root = element('Rectangle', 'card', [], [staticAttr('default-focus', 'true')]);
    expect(() => collectFocusableElements(root))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/default-focus-requires-static-focusable' });
  });
});

describe('checkAtMostOneDefaultFocus', () => {
  it('does not throw for zero or one default-focus element', () => {
    expect(() => checkAtMostOneDefaultFocus([])).to.not.throw();
    expect(() => checkAtMostOneDefaultFocus([{ elementId: 'a', isStaticTrue: true, isDefault: true }])).to.not.throw();
  });

  it('throws template/multiple-default-focus for two or more default-focus elements', () => {
    const elements = [
      { elementId: 'a', isStaticTrue: true, isDefault: true },
      { elementId: 'b', isStaticTrue: true, isDefault: true },
    ];
    expect(() => checkAtMostOneDefaultFocus(elements))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/multiple-default-focus' });
  });
});

describe('checkNestedFocusableConflicts', () => {
  it('does not throw for sibling focusable elements', () => {
    const root = element('Rectangle', 'root', [
      element('Rectangle', 'row1', [], [staticAttr('focusable', 'true')]),
      element('Rectangle', 'row2', [], [staticAttr('focusable', 'true')]),
    ]);
    expect(() => checkNestedFocusableConflicts(root)).to.not.throw();
  });

  it('does not throw when only one of a nested pair is focusable', () => {
    const root = element('Rectangle', 'card', [element('Rectangle', 'badge', [])], [staticAttr('focusable', 'true')]);
    expect(() => checkNestedFocusableConflicts(root)).to.not.throw();
  });

  it('does not throw when one side of a nested pair uses a reactive focusable expression', () => {
    const root = element(
      'Rectangle',
      'card',
      [element('Rectangle', 'row1', [], [dynamicAttr('focusable', 'not cardActive')])],
      [dynamicAttr('focusable', 'cardActive')],
    );
    expect(() => checkNestedFocusableConflicts(root)).to.not.throw();
  });

  it('throws template/nested-focusable-conflict when an ancestor and descendant are both statically focusable="true"', () => {
    const root = element('Rectangle', 'card', [element('Rectangle', 'badge', [], [staticAttr('focusable', 'true')])], [staticAttr('focusable', 'true')]);
    expect(() => checkNestedFocusableConflicts(root))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/nested-focusable-conflict' });
  });

  it('throws for a conflict nested arbitrarily deep, not just direct parent/child', () => {
    const root = element(
      'Rectangle',
      'card',
      [element('Rectangle', 'wrapper', [element('Rectangle', 'badge', [], [staticAttr('focusable', 'true')])])],
      [staticAttr('focusable', 'true')],
    );
    expect(() => checkNestedFocusableConflicts(root))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'template/nested-focusable-conflict' });
  });
});
