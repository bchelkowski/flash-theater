import { expect } from 'chai';
import {
  privateFunctionName,
  brsStringLiteral,
  fieldChangeHandlerName,
  externalFieldChangeHandlerName,
  bindChangeHandlerName,
  themeGroupVariantTableName,
  RESERVED_IDENTIFIER_PREFIX,
  isReservedIdentifier,
  mFieldAccess,
  conditionalBlockElementId,
  conditionalParentElementId,
  conditionalCreateSubName,
  conditionalDestroySubName,
  eachBlockElementId,
  eachReconcileSubName,
  eachCreateItemSubName,
  eachUpdateItemSubName,
  eachKeyNormalizerName,
  FOCUSABLE_ATTRIBUTE_NAME,
  DEFAULT_FOCUS_ATTRIBUTE_NAME,
  brsTypeAnnotation,
} from '../../src/codegen/naming.js';

describe('brsTypeAnnotation', () => {
  // Regression test for a real "Install Failure: Compilation Failed" hit sideloading to an actual
  // Roku device: `function foo() as node` is NOT valid BrightScript — only `as object` is — even
  // though it parses cleanly through kopytko-brightscript-parser and no golden fixture caught it
  // (none happened to exercise a `: node` function param/return type). See findings/router.md.
  it('translates node to object', () => {
    expect(brsTypeAnnotation('node')).to.equal('object');
  });

  it('leaves every other type name unchanged', () => {
    expect(brsTypeAnnotation('string')).to.equal('string');
    expect(brsTypeAnnotation('integer')).to.equal('integer');
    expect(brsTypeAnnotation('float')).to.equal('float');
    expect(brsTypeAnnotation('boolean')).to.equal('boolean');
    expect(brsTypeAnnotation('object')).to.equal('object');
    expect(brsTypeAnnotation('SomeCustomClass')).to.equal('SomeCustomClass');
  });
});

describe('DEFAULT_FOCUS_ATTRIBUTE_NAME', () => {
  it('is the literal attribute name "default-focus"', () => {
    expect(DEFAULT_FOCUS_ATTRIBUTE_NAME).to.equal('default-focus');
  });
});

describe('privateFunctionName', () => {
  it('prefixes with private_', () => {
    expect(privateFunctionName('increment')).to.equal('private_increment');
  });
});

describe('brsStringLiteral', () => {
  it('wraps a plain value in double quotes', () => {
    expect(brsStringLiteral('hello')).to.equal('"hello"');
  });

  it('doubles an embedded double quote — BrightScript\'s own string-escaping convention', () => {
    expect(brsStringLiteral('say "hi"')).to.equal('"say ""hi"""');
  });

  it('leaves an empty string as an empty pair of quotes', () => {
    expect(brsStringLiteral('')).to.equal('""');
  });
});

describe('fieldChangeHandlerName', () => {
  it('generates on_<field>Change', () => {
    expect(fieldChangeHandlerName('count')).to.equal('on_countChange');
  });
});

describe('externalFieldChangeHandlerName', () => {
  it('generates on_store_<field>Change for a store source', () => {
    expect(externalFieldChangeHandlerName('store', 'count')).to.equal('on_store_countChange');
  });

  it('generates on_theme_<field>Change for a theme source', () => {
    expect(externalFieldChangeHandlerName('theme', 'colors')).to.equal('on_theme_colorsChange');
  });
});

describe('bindChangeHandlerName', () => {
  it('carries a bind_ segment, distinct from externalFieldChangeHandlerName\'s shape', () => {
    expect(bindChangeHandlerName('searchBox', 'text')).to.equal('on_bind_searchBox_textChange');
  });

  it('never collides with externalFieldChangeHandlerName even when elementId is exactly "store" or "theme"', () => {
    expect(bindChangeHandlerName('store', 'text')).to.not.equal(externalFieldChangeHandlerName('store', 'text'));
    expect(bindChangeHandlerName('theme', 'text')).to.not.equal(externalFieldChangeHandlerName('theme', 'text'));
  });
});

describe('themeGroupVariantTableName', () => {
  it('generates private_<group>_<variant>', () => {
    expect(themeGroupVariantTableName('colors', 'light')).to.equal('private_colors_light');
  });
});

describe('isReservedIdentifier / RESERVED_IDENTIFIER_PREFIX', () => {
  it('is true for anything starting with ft_', () => {
    expect(isReservedIdentifier(`${RESERVED_IDENTIFIER_PREFIX}if_1`)).to.be.true;
  });

  it('is false for a DSL-author id', () => {
    expect(isReservedIdentifier('detailTitle')).to.be.false;
  });
});

describe('mFieldAccess', () => {
  it('uses ordinary dot syntax for a DSL-author id', () => {
    expect(mFieldAccess('detailTitle')).to.equal('m.detailTitle');
  });

  it('uses $$-prefixed bracket syntax for a compiler-synthesized id — a real dot identifier can never start with $', () => {
    expect(mFieldAccess('ft_if_1')).to.equal('m["$$ft_if_1"]');
  });

  it('appends an optional bookkeeping suffix for a reserved id', () => {
    expect(mFieldAccess('ft_each_1', '_keys')).to.equal('m["$$ft_each_1_keys"]');
  });

  it('appends an optional suffix for a DSL-author id too', () => {
    expect(mFieldAccess('detailTitle', '_keys')).to.equal('m.detailTitle_keys');
  });
});

describe('conditionalBlockElementId / conditionalParentElementId', () => {
  it('assigns ft_if_<ordinal>', () => {
    expect(conditionalBlockElementId(1)).to.equal('ft_if_1');
    expect(conditionalBlockElementId(3)).to.equal('ft_if_3');
  });

  it('assigns ft_parent_<ordinal>, a distinct sequence from conditionalBlockElementId', () => {
    expect(conditionalParentElementId(1)).to.equal('ft_parent_1');
  });
});

describe('eachBlockElementId', () => {
  it('assigns ft_each_<ordinal>', () => {
    expect(eachBlockElementId(2)).to.equal('ft_each_2');
  });
});

describe('conditionalCreateSubName / conditionalDestroySubName', () => {
  it('strips the reserved ft_ prefix from blockId before combining with componentName', () => {
    expect(conditionalCreateSubName('ScheduleList', 'ft_if_1')).to.equal('ScheduleList__create_if_1');
    expect(conditionalDestroySubName('ScheduleList', 'ft_if_1')).to.equal('ScheduleList__destroy_if_1');
  });
});

describe('eachReconcileSubName / eachCreateItemSubName / eachUpdateItemSubName / eachKeyNormalizerName', () => {
  it('strips the reserved ft_ prefix from blockId, mirroring the conditional-block naming scheme', () => {
    expect(eachReconcileSubName('ScheduleList', 'ft_each_1')).to.equal('ScheduleList__reconcile_each_1');
    expect(eachCreateItemSubName('ScheduleList', 'ft_each_1')).to.equal('ScheduleList__create_item_each_1');
    expect(eachUpdateItemSubName('ScheduleList', 'ft_each_1')).to.equal('ScheduleList__update_item_each_1');
  });

  it('eachKeyNormalizerName is component-scoped only, not per-block', () => {
    expect(eachKeyNormalizerName('ScheduleList')).to.equal('ScheduleList__each_key_to_string');
  });
});

describe('FOCUSABLE_ATTRIBUTE_NAME', () => {
  it('is the literal attribute name "focusable" — reuses SceneGraph\'s own native field, not a DSL invention', () => {
    expect(FOCUSABLE_ATTRIBUTE_NAME).to.equal('focusable');
  });
});
