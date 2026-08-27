import { expect } from 'chai';
import { parse } from '../../src/parser.js';
import { ThrFile, StoreWriteStatement } from '../../src/ast.js';

function wrap(source: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
  const result = parse(source);
  return { file: new ThrFile(result.root), diagnostics: result.diagnostics };
}

const TEMPLATE = '<Rectangle id="a" width="{width}" />';

function thr(scriptBody: string, templateMarkup: string = TEMPLATE): string {
  return `<script>\n${scriptBody}\n</script>\n<component>\n${templateMarkup}\n</component>\n`;
}

describe('parse — <store> root tag is no longer parseable', () => {
  it('throws thr/store-tag-removed instead of trying to parse a <store> file', () => {
    const source = ['<store>', 'field count: integer = 0', '</store>'].join('\n');
    const { diagnostics } = wrap(source);
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['thr/store-tag-removed']);
  });
});

describe('parse — read declaration (isolated)', () => {
  it('parses a single-segment read', () => {
    const { file, diagnostics } = wrap(thr('read favoriteCount = store(favoriteCount)'));

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.reads).to.have.lengthOf(1);
    const read = file.script.reads[0];
    expect(read.name).to.equal('favoriteCount');
    expect(read.path.segments).to.deep.equal(['favoriteCount']);
    expect(read.path.topLevelKey).to.equal('favoriteCount');
  });

  it('parses a nested (multi-segment) read path', () => {
    const { file, diagnostics } = wrap(thr('read nested = store(some.value)'));

    expect(diagnostics).to.deep.equal([]);
    const read = file.script.reads[0];
    expect(read.path.segments).to.deep.equal(['some', 'value']);
    expect(read.path.topLevelKey).to.equal('some');
    expect(read.path.text).to.equal('some.value');
  });

  it('throws dsl/invalid-read for a malformed read (missing equals)', () => {
    const { diagnostics } = wrap(thr('read favoriteCount store(favoriteCount)'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-read']);
  });

  it('throws dsl/invalid-read when store(...) is missing entirely', () => {
    const { diagnostics } = wrap(thr('read favoriteCount = 5'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-read']);
  });

  it('throws dsl/invalid-read for an unterminated store(...) path', () => {
    const { diagnostics } = wrap(thr('read favoriteCount = store(favoriteCount'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-read']);
  });
});

describe('parse — watch declaration (isolated)', () => {
  it('parses a single-segment watch, identically shaped to read', () => {
    const { file, diagnostics } = wrap(thr('watch favoriteCount = store(favoriteCount)'));

    expect(diagnostics).to.deep.equal([]);
    expect(file.script.watches).to.have.lengthOf(1);
    const watch = file.script.watches[0];
    expect(watch.name).to.equal('favoriteCount');
    expect(watch.path.topLevelKey).to.equal('favoriteCount');
  });

  it('throws dsl/invalid-watch for a malformed watch', () => {
    const { diagnostics } = wrap(thr('watch favoriteCount = store()'));
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['dsl/invalid-watch']);
  });
});

describe('parse — store(...) write statement (isolated)', () => {
  function body(bodySource: string): { file: ThrFile; diagnostics: readonly { code: string }[] } {
    return wrap(thr(`private function f() {\n${bodySource}\n}`));
  }

  it('parses a flat single-key write as a StoreWriteStatement', () => {
    const { file, diagnostics } = body('store(favoriteCount) = favoriteCount + 1');

    expect(diagnostics).to.deep.equal([]);
    const [statement] = file.script.functions[0].block.statements;
    expect(statement).to.be.instanceOf(StoreWriteStatement);
    const write = statement as StoreWriteStatement;
    expect(write.topLevelKey).to.equal('favoriteCount');
    expect(write.expression).to.equal('favoriteCount + 1');
  });

  it('throws statement/store-nested-write for a dotted write target', () => {
    const { diagnostics } = body('store(some.value) = 2');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/store-nested-write']);
  });

  it('throws statement/invalid-store-write for a malformed write (missing equals)', () => {
    const { diagnostics } = body('store(favoriteCount) 5');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/invalid-store-write']);
  });

  it('throws statement/invalid-store-write when the path is missing entirely', () => {
    const { diagnostics } = body('store() = 5');
    expect(diagnostics.map((d) => d.code)).to.deep.equal(['statement/invalid-store-write']);
  });
});

describe('parse — read/watch/store round-trip fidelity', () => {
  it('reproduces a file mixing read, watch, and a store write byte-for-byte', () => {
    const source = thr(
      ['read snapshot = store(favoriteCount)', 'watch live = store(favoriteCount)', 'public function bump() {', '  store(favoriteCount) = live + 1', '}'].join('\n'),
    );
    const result = parse(source);

    expect(result.diagnostics).to.deep.equal([]);
    expect(result.root.getText()).to.equal(source);
  });
});
