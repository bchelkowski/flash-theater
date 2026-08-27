import { expect } from 'chai';
import { GLOBAL_FIELD_NAMES, globalFieldRef } from '../../src/codegen/global-fields.js';

describe('globalFieldRef', () => {
  it('defaults to m.global — every existing .thr call site is unaffected by the accessRoot parameter', () => {
    expect(globalFieldRef('router')).to.equal('m.global.ft_router');
  });

  it('accepts an explicit m.global root, identical to the default', () => {
    expect(globalFieldRef('theme', 'm.global')).to.equal('m.global.ft_theme');
  });

  it('accepts GetGlobalAA().global — the .flsh class access root', () => {
    expect(globalFieldRef('taskManager', 'GetGlobalAA().global')).to.equal('GetGlobalAA().global.ft_taskManager');
  });

  it('every GLOBAL_FIELD_NAMES key produces the expected ft_-prefixed field under either root', () => {
    for (const key of Object.keys(GLOBAL_FIELD_NAMES) as (keyof typeof GLOBAL_FIELD_NAMES)[]) {
      expect(globalFieldRef(key)).to.equal(`m.global.${GLOBAL_FIELD_NAMES[key]}`);
      expect(globalFieldRef(key, 'GetGlobalAA().global')).to.equal(`GetGlobalAA().global.${GLOBAL_FIELD_NAMES[key]}`);
    }
  });
});
