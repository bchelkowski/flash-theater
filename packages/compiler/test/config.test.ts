import { expect } from 'chai';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFlashTheaterConfig } from '../src/config.js';
import { CompileError } from '../src/dsl-parser/dsl-ast.js';

describe('loadFlashTheaterConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flash-theater-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(content: string): string {
    const path = join(dir, 'flash-theater.config.json');
    writeFileSync(path, content);
    return path;
  }

  it('loads a valid fhd config', () => {
    const path = writeConfig('{ "designResolution": "fhd" }');
    expect(loadFlashTheaterConfig(path)).to.deep.equal({ designResolution: 'fhd' });
  });

  it('loads a valid hd config', () => {
    const path = writeConfig('{ "designResolution": "hd" }');
    expect(loadFlashTheaterConfig(path)).to.deep.equal({ designResolution: 'hd' });
  });

  it('throws config/malformed-json for invalid JSON', () => {
    const path = writeConfig('{ not valid json');
    expect(() => loadFlashTheaterConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'config/malformed-json' });
  });

  it('throws config/invalid-design-resolution when designResolution is missing', () => {
    const path = writeConfig('{}');
    expect(() => loadFlashTheaterConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'config/invalid-design-resolution' });
  });

  it('throws config/invalid-design-resolution when designResolution is not "hd"/"fhd"', () => {
    const path = writeConfig('{ "designResolution": "4k" }');
    expect(() => loadFlashTheaterConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'config/invalid-design-resolution' });
  });

  it('leaves srcDir/outDir/exclude undefined when not given', () => {
    const path = writeConfig('{ "designResolution": "hd" }');
    const config = loadFlashTheaterConfig(path);
    expect(config.srcDir).to.equal(undefined);
    expect(config.outDir).to.equal(undefined);
    expect(config.exclude).to.equal(undefined);
  });

  it('loads srcDir/outDir/exclude when given', () => {
    const path = writeConfig('{ "designResolution": "hd", "srcDir": "project", "outDir": "generated", "exclude": ["components/Experimental/**"] }');
    expect(loadFlashTheaterConfig(path)).to.deep.equal({
      designResolution: 'hd',
      srcDir: 'project',
      outDir: 'generated',
      exclude: ['components/Experimental/**'],
    });
  });

  it('throws config/invalid-src-dir when srcDir is not a string', () => {
    const path = writeConfig('{ "designResolution": "hd", "srcDir": 5 }');
    expect(() => loadFlashTheaterConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'config/invalid-src-dir' });
  });

  it('throws config/invalid-out-dir when outDir is not a string', () => {
    const path = writeConfig('{ "designResolution": "hd", "outDir": 5 }');
    expect(() => loadFlashTheaterConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'config/invalid-out-dir' });
  });

  it('throws config/invalid-exclude when exclude is not an array of strings', () => {
    const path = writeConfig('{ "designResolution": "hd", "exclude": "not-an-array" }');
    expect(() => loadFlashTheaterConfig(path))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'config/invalid-exclude' });

    const path2 = writeConfig('{ "designResolution": "hd", "exclude": [1, 2] }');
    expect(() => loadFlashTheaterConfig(path2))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'config/invalid-exclude' });
  });
});
