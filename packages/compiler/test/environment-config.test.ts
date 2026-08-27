import { expect } from 'chai';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFlashTheaterEnvironmentConfig, mergeEnvironmentConfigs, resolveEnvironmentVariables } from '../src/config.js';
import { CompileError } from '../src/dsl-parser/dsl-ast.js';

describe('loadFlashTheaterEnvironmentConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flash-theater-environment-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(content: string): string {
    const path = join(dir, 'staging.config.json');
    writeFileSync(path, content);
    return path;
  }

  it('loads an empty config', () => {
    const path = writeConfig('{}');
    expect(loadFlashTheaterEnvironmentConfig(path)).to.deep.equal({});
  });

  it('loads variables/manifestOverrides/exclude/include when given', () => {
    const path = writeConfig(
      JSON.stringify({
        variables: { apiKey: { fromEnv: 'API_KEY' }, apiBaseUrl: { value: 'https://staging.example.com' } },
        manifestOverrides: { title: 'Staging' },
        exclude: ['images/production-only/**'],
        include: ['images/staging-only/**'],
      }),
    );
    expect(loadFlashTheaterEnvironmentConfig(path)).to.deep.equal({
      variables: { apiKey: { fromEnv: 'API_KEY' }, apiBaseUrl: { value: 'https://staging.example.com' } },
      manifestOverrides: { title: 'Staging' },
      exclude: ['images/production-only/**'],
      include: ['images/staging-only/**'],
    });
  });

  it('throws environment-config/malformed-json for invalid JSON', () => {
    const path = writeConfig('{ not valid json');
    expect(() => loadFlashTheaterEnvironmentConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/malformed-json' });
  });

  it('throws environment-config/unknown-key for an unrecognized top-level key', () => {
    const path = writeConfig('{ "designResolution": "hd" }');
    expect(() => loadFlashTheaterEnvironmentConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/unknown-key' });
  });

  it('throws environment-config/invalid-variables when variables is not an object', () => {
    const path = writeConfig('{ "variables": "nope" }');
    expect(() => loadFlashTheaterEnvironmentConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/invalid-variables' });
  });

  it('throws environment-config/invalid-variable-source when a variable declares neither fromEnv nor value', () => {
    const path = writeConfig('{ "variables": { "apiKey": {} } }');
    expect(() => loadFlashTheaterEnvironmentConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/invalid-variable-source' });
  });

  it('throws environment-config/invalid-variable-source when a variable declares both fromEnv and value', () => {
    const path = writeConfig('{ "variables": { "apiKey": { "fromEnv": "X", "value": "y" } } }');
    expect(() => loadFlashTheaterEnvironmentConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/invalid-variable-source' });
  });

  it('throws environment-config/invalid-variable-source when fromEnv/value is not a string', () => {
    const path = writeConfig('{ "variables": { "apiKey": { "fromEnv": 5 } } }');
    expect(() => loadFlashTheaterEnvironmentConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/invalid-variable-source' });
  });

  it('throws environment-config/invalid-manifest-overrides when manifestOverrides is not an object of strings', () => {
    const path = writeConfig('{ "manifestOverrides": "nope" }');
    expect(() => loadFlashTheaterEnvironmentConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/invalid-manifest-overrides' });

    const path2 = writeConfig('{ "manifestOverrides": { "title": 5 } }');
    expect(() => loadFlashTheaterEnvironmentConfig(path2))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/invalid-manifest-overrides' });
  });

  it('throws environment-config/invalid-exclude when exclude is not an array of strings', () => {
    const path = writeConfig('{ "exclude": "nope" }');
    expect(() => loadFlashTheaterEnvironmentConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/invalid-exclude' });
  });

  it('throws environment-config/invalid-include when include is not an array of strings', () => {
    const path = writeConfig('{ "include": [1, 2] }');
    expect(() => loadFlashTheaterEnvironmentConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/invalid-include' });
  });
});

describe('resolveEnvironmentVariables', () => {
  it('returns an empty map when variables is undefined', () => {
    expect(resolveEnvironmentVariables(undefined, {})).to.deep.equal(new Map());
  });

  it('passes a literal value through unchanged', () => {
    const resolved = resolveEnvironmentVariables({ apiBaseUrl: { value: 'https://example.com' } }, {});
    expect(resolved).to.deep.equal(new Map([['apiBaseUrl', 'https://example.com']]));
  });

  it('looks fromEnv up in the given processEnv, not the real process.env', () => {
    const resolved = resolveEnvironmentVariables({ apiKey: { fromEnv: 'MY_API_KEY' } }, { MY_API_KEY: 'secret-123' });
    expect(resolved).to.deep.equal(new Map([['apiKey', 'secret-123']]));
  });

  it('throws environment-config/missing-env-var when a fromEnv variable is unset', () => {
    expect(() => resolveEnvironmentVariables({ apiKey: { fromEnv: 'MISSING_VAR' } }, {}))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'environment-config/missing-env-var' });
  });

  it('resolves multiple variables, mixing fromEnv and value', () => {
    const resolved = resolveEnvironmentVariables(
      { apiKey: { fromEnv: 'MY_API_KEY' }, apiBaseUrl: { value: 'https://example.com' } },
      { MY_API_KEY: 'secret-123' },
    );
    expect(resolved).to.deep.equal(
      new Map([
        ['apiKey', 'secret-123'],
        ['apiBaseUrl', 'https://example.com'],
      ]),
    );
  });
});

describe('mergeEnvironmentConfigs', () => {
  it('returns base unchanged when local is null', () => {
    const base = { variables: { a: { value: '1' } }, exclude: ['x/**'] };
    expect(mergeEnvironmentConfigs(base, null)).to.equal(base);
  });

  it('lets local win on a shared variables key, without touching keys only base declares', () => {
    const base = { variables: { a: { value: 'base-a' }, b: { value: 'base-b' } } };
    const local = { variables: { a: { value: 'local-a' } } };
    expect(mergeEnvironmentConfigs(base, local)).to.deep.equal({
      variables: { a: { value: 'local-a' }, b: { value: 'base-b' } },
    });
  });

  it('lets local introduce a variable key base never declared', () => {
    const base = { variables: { a: { value: 'base-a' } } };
    const local = { variables: { c: { value: 'local-c' } } };
    expect(mergeEnvironmentConfigs(base, local)).to.deep.equal({
      variables: { a: { value: 'base-a' }, c: { value: 'local-c' } },
    });
  });

  it('lets local win on a shared manifestOverrides key', () => {
    const base = { manifestOverrides: { title: 'Base Title', build_version: '1' } };
    const local = { manifestOverrides: { title: 'Local Title' } };
    expect(mergeEnvironmentConfigs(base, local)).to.deep.equal({
      manifestOverrides: { title: 'Local Title', build_version: '1' },
    });
  });

  it('concatenates exclude/include, base first then local', () => {
    const base = { exclude: ['a/**'], include: ['b/**'] };
    const local = { exclude: ['c/**'], include: ['d/**'] };
    expect(mergeEnvironmentConfigs(base, local)).to.deep.equal({
      exclude: ['a/**', 'c/**'],
      include: ['b/**', 'd/**'],
    });
  });

  it('omits a key entirely when neither base nor local declares it', () => {
    expect(mergeEnvironmentConfigs({}, {})).to.deep.equal({});
  });
});
