import { expect } from 'chai';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { isExcluded, resolveProjectLayout, walkSrcTree } from '../src/project-layout.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'flash-theater-layout-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `resolveProjectLayout` combines appRoot with srcDir/outDir via `path.resolve`, not `path.join`
// (see its own doc comment) — on Windows, `path.resolve('/app', ...)` folds in the current drive
// letter (a leading `/` with no drive is only "root-relative"), so a bare '/app' fixture wouldn't
// round-trip through a plain `join`-based expectation. Resolving APP_ROOT once up front makes it
// fully drive-qualified, so downstream `join`-based expectations agree with `resolveProjectLayout`'s
// own `resolve`-based output on every platform.
const APP_ROOT = resolvePath('/app');

describe('resolveProjectLayout', () => {
  it('defaults to src/out siblings of appRoot when no config or overrides are given', () => {
    const layout = resolveProjectLayout(APP_ROOT, null);
    expect(layout.srcRoot).to.equal(join(APP_ROOT, 'src'));
    expect(layout.outRoot).to.equal(join(APP_ROOT, 'out'));
    expect(layout.exclude).to.deep.equal([]);
  });

  it('uses config.srcDir/outDir/exclude when no override is given', () => {
    const layout = resolveProjectLayout(APP_ROOT, { designResolution: 'hd', srcDir: 'project', outDir: 'generated', exclude: ['**/*.tmp'] });
    expect(layout.srcRoot).to.equal(join(APP_ROOT, 'project'));
    expect(layout.outRoot).to.equal(join(APP_ROOT, 'generated'));
    expect(layout.exclude).to.deep.equal(['**/*.tmp']);
  });

  it('a CLI override takes priority over config', () => {
    const layout = resolveProjectLayout(APP_ROOT, { designResolution: 'hd', srcDir: 'project' }, { srcDir: 'override-src' });
    expect(layout.srcRoot).to.equal(join(APP_ROOT, 'override-src'));
  });

  it('an absolute override replaces appRoot entirely rather than nesting under it', () => {
    const elsewhere = resolvePath('/elsewhere/src');
    const layout = resolveProjectLayout(APP_ROOT, null, { srcDir: elsewhere });
    expect(layout.srcRoot).to.equal(elsewhere);
  });

  it('leaves outRoot and exclude/include unchanged when no environment is active', () => {
    const layout = resolveProjectLayout(APP_ROOT, null, {}, null, null);
    expect(layout.outRoot).to.equal(join(APP_ROOT, 'out'));
    expect(layout.exclude).to.deep.equal([]);
    expect(layout.include).to.deep.equal([]);
  });

  it('suffixes outRoot with -<env> when an environment is active', () => {
    const layout = resolveProjectLayout(APP_ROOT, null, {}, {}, 'staging');
    expect(layout.outRoot).to.equal(join(APP_ROOT, 'out-staging'));
  });

  it('suffixes whatever outDir already resolved to, not a hardcoded "out"', () => {
    const layout = resolveProjectLayout(APP_ROOT, { designResolution: 'hd', outDir: 'generated' }, {}, {}, 'staging');
    expect(layout.outRoot).to.equal(join(APP_ROOT, 'generated-staging'));
  });

  it('concatenates the base config exclude with the active environment exclude', () => {
    const layout = resolveProjectLayout(APP_ROOT, { designResolution: 'hd', exclude: ['a/**'] }, {}, { exclude: ['b/**'] }, 'staging');
    expect(layout.exclude).to.deep.equal(['a/**', 'b/**']);
  });

  it('takes include from the active environment config only', () => {
    const layout = resolveProjectLayout(APP_ROOT, null, {}, { include: ['images/staging-only/**'] }, 'staging');
    expect(layout.include).to.deep.equal(['images/staging-only/**']);
  });
});

describe('isExcluded', () => {
  it('matches a literal relative path', () => {
    expect(isExcluded('components/Foo.thr', ['components/Foo.thr'])).to.equal(true);
    expect(isExcluded('components/Bar.thr', ['components/Foo.thr'])).to.equal(false);
  });

  it('matches * against a single path segment, not across /', () => {
    expect(isExcluded('components/Foo.thr', ['components/*.thr'])).to.equal(true);
    expect(isExcluded('components/Nested/Foo.thr', ['components/*.thr'])).to.equal(false);
  });

  it('matches ** across any number of path segments', () => {
    expect(isExcluded('components/Experimental/Deep/Foo.thr', ['components/Experimental/**'])).to.equal(true);
    expect(isExcluded('components/Experimental', ['components/Experimental/**'])).to.equal(true);
  });

  it('returns false when no pattern matches', () => {
    expect(isExcluded('components/Foo.thr', [])).to.equal(false);
  });
});

describe('walkSrcTree', () => {
  it('separates .thr/.flsh compile targets from every other pass-through file', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'components', 'Classes'), { recursive: true });
      writeFileSync(join(dir, 'manifest'), 'title=Test\n');
      writeFileSync(join(dir, 'components', 'Widget.thr'), 'x');
      writeFileSync(join(dir, 'components', 'Classes', 'Counter.flsh'), 'x');
      writeFileSync(join(dir, 'components', 'MainScene.xml'), 'x');
      writeFileSync(join(dir, 'components', 'MainScene.brs'), 'x');

      const { compileTargets, passthroughFiles } = walkSrcTree(dir, []);

      expect(compileTargets.sort()).to.deep.equal([join(dir, 'components', 'Classes', 'Counter.flsh'), join(dir, 'components', 'Widget.thr')].sort());
      expect(passthroughFiles.sort()).to.deep.equal(
        [join(dir, 'manifest'), join(dir, 'components', 'MainScene.xml'), join(dir, 'components', 'MainScene.brs')].sort(),
      );
    });
  });

  it('skips a file matched by exclude', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'components'), { recursive: true });
      writeFileSync(join(dir, 'components', 'Widget.thr'), 'x');
      writeFileSync(join(dir, 'components', 'Skip.thr'), 'x');

      const { compileTargets } = walkSrcTree(dir, ['components/Skip.thr']);
      expect(compileTargets).to.deep.equal([join(dir, 'components', 'Widget.thr')]);
    });
  });

  it('skips an entire directory matched by exclude, without descending into it', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'components', 'Experimental'), { recursive: true });
      writeFileSync(join(dir, 'components', 'Widget.thr'), 'x');
      writeFileSync(join(dir, 'components', 'Experimental', 'Broken.thr'), 'this would fail to parse if compiled');

      const { compileTargets } = walkSrcTree(dir, ['components/Experimental/**']);
      expect(compileTargets).to.deep.equal([join(dir, 'components', 'Widget.thr')]);
    });
  });

  it('returns empty arrays for a src tree with nothing in it', () => {
    withTempDir((dir) => {
      const { compileTargets, passthroughFiles } = walkSrcTree(dir, []);
      expect(compileTargets).to.deep.equal([]);
      expect(passthroughFiles).to.deep.equal([]);
    });
  });

  it('include exempts a file directly matched by exclude', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'images'), { recursive: true });
      writeFileSync(join(dir, 'images', 'staging.png'), 'x');
      writeFileSync(join(dir, 'images', 'production.png'), 'x');

      const { passthroughFiles } = walkSrcTree(dir, ['images/*.png'], ['images/staging.png']);
      expect(passthroughFiles).to.deep.equal([join(dir, 'images', 'staging.png')]);
    });
  });

  it('include exempts a file nested under an excluded directory (forces descent)', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'images', 'staging-only'), { recursive: true });
      writeFileSync(join(dir, 'images', 'staging-only', 'badge.png'), 'x');

      // Without `include`, "images/staging-only/**" would skip the whole directory without ever
      // descending into it — `include` must force the walker to look inside anyway.
      const { passthroughFiles } = walkSrcTree(dir, ['images/staging-only/**'], ['images/staging-only/**']);
      expect(passthroughFiles).to.deep.equal([join(dir, 'images', 'staging-only', 'badge.png')]);
    });
  });

  it('a file matched by exclude but not by any include pattern stays excluded', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'images'), { recursive: true });
      writeFileSync(join(dir, 'images', 'production.png'), 'x');

      const { passthroughFiles } = walkSrcTree(dir, ['images/*.png'], ['images/staging.png']);
      expect(passthroughFiles).to.deep.equal([]);
    });
  });

  it('an empty include list behaves identically to omitting it (no environment active)', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'components', 'Experimental'), { recursive: true });
      writeFileSync(join(dir, 'components', 'Widget.thr'), 'x');
      writeFileSync(join(dir, 'components', 'Experimental', 'Broken.thr'), 'this would fail to parse if compiled');

      const withDefault = walkSrcTree(dir, ['components/Experimental/**']);
      const withExplicitEmpty = walkSrcTree(dir, ['components/Experimental/**'], []);
      expect(withExplicitEmpty).to.deep.equal(withDefault);
    });
  });
});
