import { expect } from 'chai';
import { applyManifestOverrides, readManifestVersion } from '../src/manifest.js';
import { CompileError } from '../src/dsl-parser/dsl-ast.js';

const SAMPLE_MANIFEST = ['# comment', '', 'title=Sample', 'major_version=1', 'minor_version=0', 'build_version=00001', ''].join('\n');

describe('applyManifestOverrides', () => {
  it('replaces an existing key in place, preserving every other line', () => {
    const result = applyManifestOverrides(SAMPLE_MANIFEST, { title: 'Staging' });
    expect(result).to.equal(['# comment', '', 'title=Staging', 'major_version=1', 'minor_version=0', 'build_version=00001', ''].join('\n'));
  });

  it('appends a new key that did not already exist', () => {
    const result = applyManifestOverrides(SAMPLE_MANIFEST, { splash_color: '#000000' });
    expect(result).to.equal(
      ['# comment', '', 'title=Sample', 'major_version=1', 'minor_version=0', 'build_version=00001', 'splash_color=#000000', ''].join('\n'),
    );
  });

  it('preserves comments and blank lines untouched', () => {
    const result = applyManifestOverrides(SAMPLE_MANIFEST, {});
    expect(result).to.equal(SAMPLE_MANIFEST);
  });

  it('replaces multiple keys and appends multiple new ones in one call', () => {
    const result = applyManifestOverrides(SAMPLE_MANIFEST, { title: 'Staging', build_version: '00042', extra_key: 'x' });
    expect(result).to.equal(
      ['# comment', '', 'title=Staging', 'major_version=1', 'minor_version=0', 'build_version=00042', 'extra_key=x', ''].join('\n'),
    );
  });
});

describe('readManifestVersion', () => {
  it('reads major_version/minor_version/build_version', () => {
    expect(readManifestVersion(SAMPLE_MANIFEST)).to.deep.equal({ major: '1', minor: '0', build: '00001' });
  });

  it('reads version keys after applyManifestOverrides patches them', () => {
    const patched = applyManifestOverrides(SAMPLE_MANIFEST, { build_version: '00042' });
    expect(readManifestVersion(patched)).to.deep.equal({ major: '1', minor: '0', build: '00042' });
  });

  it('throws manifest/missing-version-key when a required key is absent', () => {
    const incomplete = 'title=Sample\nmajor_version=1\n';
    expect(() => readManifestVersion(incomplete))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'manifest/missing-version-key' });
  });
});
