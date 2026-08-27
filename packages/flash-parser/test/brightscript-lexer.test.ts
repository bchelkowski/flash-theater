import { expect } from 'chai';
import { tokenizeBrightScript } from '../src/brightscript-lexer.js';
import { TokenKind } from '../src/tokenKind.js';
import { tokensToText } from '../src/token.js';

function kinds(source: string): TokenKind[] {
  return tokenizeBrightScript(source).map((t) => t.kind);
}

describe('tokenizeBrightScript — lossless round-trip', () => {
  const samples = [
    'x = 1 + 2 * 3',
    'if a > 0 then\n  print "hi"\nend if',
    'for i = 0 to 10 step 2\n  x = x + i\nend for',
    'for each item in items\n  print item\nend for',
    'function add(a as integer, b as integer) as integer\n  return a + b\nend function',
    'sub doStuff()\n  x = "he said ""hi""" \nend sub',
    'x = &HFF\ny = 9876543210&\nz = 2.01\nw = 1.23E+5\nv = 1.23D-12\nu = 2!\nt = 2.3#',
    'x = a?.b?["c"]?(d)?@e',
    'x = a == b\ny = a != b',
    '#if debug\nprint "d"\n#else if release\nprint "r"\n#else\nprint "n"\n#end if',
    "x = 1 ' a comment\ny = 2 rem another comment",
    'x = a and b or not c',
    'x = a mod b',
    'x++\nx--\nx += 1\nx -= 1\nx *= 2\nx /= 2\nx \\= 2',
    'x = [1, 2, 3]\ny = {a: 1, b: 2}',
  ];

  for (const source of samples) {
    it(`reproduces ${JSON.stringify(source.slice(0, 40))} byte-for-byte`, () => {
      const tokens = tokenizeBrightScript(source);
      expect(tokensToText(tokens)).to.equal(source);
    });
  }
});

describe('tokenizeBrightScript — keyword case sensitivity (DSL vs BrightScript)', () => {
  it('recognizes lowercase "if"/"for"/"end if" as BrightScript keywords', () => {
    expect(kinds('if a then\nend if')).to.deep.equal([TokenKind.If, TokenKind.Identifier, TokenKind.Then, TokenKind.EndIf, TokenKind.EndOfFile]);
  });

  it('recognizes case-varied BrightScript keywords case-insensitively', () => {
    expect(kinds('IF a THEN\nEND IF')).to.deep.equal([TokenKind.If, TokenKind.Identifier, TokenKind.Then, TokenKind.EndIf, TokenKind.EndOfFile]);
  });

  it('does NOT let a case-varied "Field" match the DSL-only Field keyword', () => {
    // "field" is a DSL-only keyword (never a real BrightScript reserved
    // word) — GRAMMAR.md requires exact-lowercase for DSL keywords, so a
    // differently-cased spelling must fall through to a plain Identifier,
    // not be case-folded into TokenKind.Field.
    expect(kinds('Field = 1')).to.deep.equal([TokenKind.Identifier, TokenKind.Equals, TokenKind.IntegerLiteral, TokenKind.EndOfFile]);
  });

  it('never produces a DSL-only keyword kind at all, even exact-lowercase-spelled — this lexer tokenizes BrightScript content only', () => {
    // "store"/"field"/"class"/... are DSL declaration keywords ONLY at the
    // separate DSL-shell level (lexer.ts) — inside embedded BrightScript
    // content (what this lexer tokenizes), the identical spelling is always
    // an ordinary identifier, e.g. `store.count`'s "store". Confirmed live:
    // this is exactly the bug that broke findGlobalPathAccesses before the
    // exact-match branch also excluded DSL-only kinds.
    expect(kinds('field')).to.deep.equal([TokenKind.Identifier, TokenKind.EndOfFile]);
    expect(kinds('store.count')).to.deep.equal([TokenKind.Identifier, TokenKind.Dot, TokenKind.Identifier, TokenKind.EndOfFile]);
    expect(kinds('class')).to.deep.equal([TokenKind.Identifier, TokenKind.EndOfFile]);
  });
});

describe('tokenizeBrightScript — compound keywords', () => {
  it('tokenizes spaced "end if" as one EndIf token', () => {
    const tokens = tokenizeBrightScript('end if');
    expect(tokens[0].kind).to.equal(TokenKind.EndIf);
    expect(tokens[0].text).to.equal('end if');
  });

  it('tokenizes compact "endif" as one EndIf token', () => {
    const tokens = tokenizeBrightScript('endif');
    expect(tokens[0].kind).to.equal(TokenKind.EndIf);
  });

  it('does not treat "end" followed by an unrelated word as a compound', () => {
    expect(kinds('end foo')).to.deep.equal([TokenKind.End, TokenKind.Identifier, TokenKind.EndOfFile]);
  });
});

describe('tokenizeBrightScript — numeric literal kinds', () => {
  it('classifies integer/long/float/double/hex literals correctly', () => {
    expect(kinds('255')).to.deep.equal([TokenKind.IntegerLiteral, TokenKind.EndOfFile]);
    expect(kinds('9876543210&')).to.deep.equal([TokenKind.LongIntegerLiteral, TokenKind.EndOfFile]);
    expect(kinds('2.01')).to.deep.equal([TokenKind.FloatLiteral, TokenKind.EndOfFile]);
    expect(kinds('1.23D-12')).to.deep.equal([TokenKind.DoubleLiteral, TokenKind.EndOfFile]);
    expect(kinds('&HFF')).to.deep.equal([TokenKind.IntegerLiteral, TokenKind.EndOfFile]);
    expect(kinds('&hABCD&')).to.deep.equal([TokenKind.LongIntegerLiteral, TokenKind.EndOfFile]);
  });
});

describe('tokenizeBrightScript — optional chaining and DSL-only comparison operators', () => {
  it('tokenizes ?. ?[ ?( ?@ distinctly from bare ?', () => {
    expect(kinds('a?.b')).to.deep.equal([TokenKind.Identifier, TokenKind.QuestionDot, TokenKind.Identifier, TokenKind.EndOfFile]);
    expect(kinds('a?[0]')).to.deep.equal([TokenKind.Identifier, TokenKind.QuestionBracket, TokenKind.IntegerLiteral, TokenKind.RBracket, TokenKind.EndOfFile]);
    expect(kinds('a?(b)')).to.deep.equal([TokenKind.Identifier, TokenKind.QuestionParen, TokenKind.Identifier, TokenKind.RParen, TokenKind.EndOfFile]);
    expect(kinds('a?@b')).to.deep.equal([TokenKind.Identifier, TokenKind.QuestionAt, TokenKind.Identifier, TokenKind.EndOfFile]);
  });

  it('tokenizes == and != as single DSL-only tokens, distinct from = and <>', () => {
    expect(kinds('a == b')).to.deep.equal([TokenKind.Identifier, TokenKind.EqualsEquals, TokenKind.Identifier, TokenKind.EndOfFile]);
    expect(kinds('a != b')).to.deep.equal([TokenKind.Identifier, TokenKind.BangEquals, TokenKind.Identifier, TokenKind.EndOfFile]);
    expect(kinds('a = b')).to.deep.equal([TokenKind.Identifier, TokenKind.Equals, TokenKind.Identifier, TokenKind.EndOfFile]);
    expect(kinds('a <> b')).to.deep.equal([TokenKind.Identifier, TokenKind.LessGreater, TokenKind.Identifier, TokenKind.EndOfFile]);
  });

  it('does not confuse == with a ternary-assignment-lookalike (two adjacent Equals)', () => {
    const tokens = kinds('a == b');
    expect(tokens.filter((k) => k === TokenKind.Equals)).to.have.length(0);
  });

  it('tokenizes a bare ! as a single DSL-only Bang token, distinct from !=', () => {
    expect(kinds('!a')).to.deep.equal([TokenKind.Bang, TokenKind.Identifier, TokenKind.EndOfFile]);
    expect(kinds('a != b')).to.deep.equal([TokenKind.Identifier, TokenKind.BangEquals, TokenKind.Identifier, TokenKind.EndOfFile]);
    expect(kinds('!!a')).to.deep.equal([TokenKind.Bang, TokenKind.Bang, TokenKind.Identifier, TokenKind.EndOfFile]);
  });
});

describe('tokenizeBrightScript — trivia is leading-only', () => {
  it('never produces trailing trivia', () => {
    const tokens = tokenizeBrightScript('x = 1 \' comment\ny = 2');
    for (const t of tokens) {
      expect(t.trailingTrivia).to.deep.equal([]);
    }
  });

  it('attaches a comment as the leading trivia of the following token', () => {
    const tokens = tokenizeBrightScript("x = 1 ' comment\ny = 2");
    const yToken = tokens.find((t) => t.text === 'y');
    expect(yToken).to.exist;
    expect(yToken!.leadingTrivia.some((tv) => tv.text === "' comment")).to.equal(true);
  });
});
