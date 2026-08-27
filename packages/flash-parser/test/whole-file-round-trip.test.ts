import { expect } from 'chai';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { parseThr, parseFlsh } from '../src/parser.js';

/**
 * Phase 0's own concrete acceptance criterion (see
 * findings/compiler-parser-architecture.md / the flash-parser-owns-the-grammar
 * plan): `parseThr(source).root.getText() === source` /
 * `parseFlsh(source).root.getText() === source`, byte-for-byte, for every
 * *real* `.thr`/`.flsh` source file this repo has — not just synthetic
 * snippets. This is what "CST is correctly built" actually means, made
 * concrete and permanently regression-tested.
 */
function findSourceFiles(dir: string, extensions: readonly string[]): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findSourceFiles(full, extensions));
    } else if (extensions.includes(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

const REPO_ROOT = join(__dirname, '../../..');
const SEARCH_ROOTS = [join(REPO_ROOT, 'apps'), join(REPO_ROOT, 'packages/compiler/test')];

const files = SEARCH_ROOTS.flatMap((root) => findSourceFiles(root, ['.thr', '.flsh']));

describe('whole-file lossless round-trip — every real .thr/.flsh file in the repo', () => {
  it('found real source files to test against', () => {
    expect(files.length).to.be.greaterThan(0);
  });

  for (const file of files) {
    const relPath = file.slice(REPO_ROOT.length);
    const isFlsh = file.endsWith('.flsh');

    it(`${relPath}: getText() reproduces the source byte-for-byte`, () => {
      const source = readFileSync(file, 'utf8');
      const { root } = isFlsh ? parseFlsh(source) : parseThr(source);
      expect(root.getText()).to.equal(source);
    });
  }
});
