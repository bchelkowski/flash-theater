import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import AdmZip from 'adm-zip';
import { expect } from 'chai';
import { writeAppZip } from '../src/packaging.js';
import { CompileError } from '../src/dsl-parser/dsl-ast.js';

const SAMPLE_MANIFEST = ['title=Sample', 'major_version=1', 'minor_version=0', 'build_version=00001', ''].join('\n');

/** Creates a fresh temp app root with an already-built `out/` (manifest + one component), cleaned up afterward. */
function withAppRoot(fn: (appRoot: string, outRoot: string) => void): void {
  const appRoot = mkdtempSync(join(tmpdir(), 'flash-theater-packaging-'));
  const outRoot = join(appRoot, 'out');
  try {
    mkdirSync(join(outRoot, 'components'), { recursive: true });
    writeFileSync(join(outRoot, 'manifest'), SAMPLE_MANIFEST);
    writeFileSync(join(outRoot, 'components', 'Widget.xml'), '<component name="Widget" extends="Group"></component>\n');
    fn(appRoot, outRoot);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}

describe('writeAppZip', () => {
  it('zips outRoot into dist/<appName>.zip, named from package.json\'s "name" field, when no environment is active', () => {
    withAppRoot((appRoot, outRoot) => {
      writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'sample-app' }));

      const { zipPath } = writeAppZip({ appRoot, outRoot, envName: null });

      expect(zipPath).to.equal(join(appRoot, 'dist', 'sample-app.zip'));
      expect(existsSync(zipPath)).to.equal(true);
    });
  });

  it('falls back to the appRoot directory basename when package.json is absent', () => {
    withAppRoot((appRoot, outRoot) => {
      const { zipPath } = writeAppZip({ appRoot, outRoot, envName: null });
      expect(zipPath).to.equal(join(appRoot, 'dist', `${basename(appRoot)}.zip`));
    });
  });

  it('--app-name overrides both package.json\'s "name" and the directory basename', () => {
    withAppRoot((appRoot, outRoot) => {
      writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'sample-app' }));

      const { zipPath } = writeAppZip({ appRoot, outRoot, envName: null, appName: 'custom-name' });

      expect(zipPath).to.equal(join(appRoot, 'dist', 'custom-name.zip'));
    });
  });

  it('names the zip dist/<appName>-<env>-<major>.<minor>.<build>.zip and reads the version from outRoot\'s manifest when an environment is active', () => {
    withAppRoot((appRoot, outRoot) => {
      writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'sample-app' }));
      writeFileSync(join(outRoot, 'manifest'), ['title=Sample', 'major_version=2', 'minor_version=3', 'build_version=00042', ''].join('\n'));

      const { zipPath } = writeAppZip({ appRoot, outRoot, envName: 'staging' });

      expect(zipPath).to.equal(join(appRoot, 'dist', 'sample-app-staging-2.3.00042.zip'));
      expect(existsSync(zipPath)).to.equal(true);
    });
  });

  it('throws manifest/missing-version-key when an environment is active but outRoot\'s manifest lacks a version key', () => {
    withAppRoot((appRoot, outRoot) => {
      writeFileSync(join(outRoot, 'manifest'), 'title=Sample\n');
      expect(() => writeAppZip({ appRoot, outRoot, envName: 'staging' }))
        .to.throw(CompileError)
        .with.property('diagnostic')
        .that.deep.include({ code: 'manifest/missing-version-key' });
    });
  });

  it('the produced zip contains outRoot\'s files at its root, with no leading directory segment', () => {
    withAppRoot((appRoot, outRoot) => {
      const { zipPath } = writeAppZip({ appRoot, outRoot, envName: null, appName: 'sample-app' });

      const zip = new AdmZip(zipPath);
      const entryNames = zip.getEntries().map((e) => e.entryName);
      expect(entryNames).to.include('manifest');
      expect(entryNames).to.include('components/Widget.xml');

      const manifestEntry = zip.getEntry('manifest');
      expect(manifestEntry).to.not.equal(null);
      expect(readFileSync(join(outRoot, 'manifest'), 'utf8')).to.equal(SAMPLE_MANIFEST);
    });
  });

  it('creates dist/ when it does not already exist', () => {
    withAppRoot((appRoot, outRoot) => {
      expect(existsSync(join(appRoot, 'dist'))).to.equal(false);
      writeAppZip({ appRoot, outRoot, envName: null, appName: 'sample-app' });
      expect(existsSync(join(appRoot, 'dist'))).to.equal(true);
    });
  });
});
