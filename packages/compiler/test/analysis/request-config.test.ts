import { expect } from 'chai';
import { parseRequestConfig } from '../../src/analysis/request-config.js';
import { parseScriptFixture } from '../helpers/parseScriptFixture.js';

function config(scriptBody: string) {
  const request = parseScriptFixture(scriptBody).request!;
  return parseRequestConfig(request, 'request {} declaration');
}

function throwsCode(scriptBody: string, code: string): void {
  expect(() => config(scriptBody)).to.throw().with.property('diagnostic').that.deep.include({ code });
}

describe('parseRequestConfig — Http', () => {
  it('parses method/url/headers into a structured, literal-only value tree', () => {
    const parsed = config('request Http { method: "POST", url: "https://example.com", headers: { "Content-Type": "application/json" } }');
    expect(parsed.requestKind).to.equal('Http');
    expect(parsed.entries).to.deep.equal({
      method: { kind: 'string', value: 'POST' },
      url: { kind: 'string', value: 'https://example.com' },
      headers: { kind: 'object', entries: { 'Content-Type': { kind: 'string', value: 'application/json' } } },
    });
  });

  it('accepts an omitted method/url/headers — no defaults are injected at this layer', () => {
    const parsed = config('request Http {}');
    expect(parsed.entries).to.deep.equal({});
  });

  it('accepts every documented HTTP method', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => config(`request Http { method: "${method}" }`)).to.not.throw();
    }
  });

  it('throws request/invalid-http-method for an unrecognized method', () => {
    throwsCode('request Http { method: "TRACE" }', 'request/invalid-http-method');
  });

  it('throws request/invalid-http-method when method is not a string literal', () => {
    throwsCode('request Http { method: 5 }', 'request/invalid-http-method');
  });

  it('throws request/invalid-config-value-type when url is not a string literal', () => {
    throwsCode('request Http { url: 5 }', 'request/invalid-config-value-type');
  });

  it('throws request/invalid-config-value-type when headers is not an object literal', () => {
    throwsCode('request Http { headers: "nope" }', 'request/invalid-config-value-type');
  });

  it('throws request/unknown-config-key for a key outside the closed Http set', () => {
    throwsCode('request Http { bogus: "nope" }', 'request/unknown-config-key');
  });

  it('parses a static cache config with a positive integer ttlSeconds', () => {
    const parsed = config('request Http { cache: { ttlSeconds: 60 } }');
    expect(parsed.entries.cache).to.deep.equal({ kind: 'object', entries: { ttlSeconds: { kind: 'number', value: 60 } } });
  });

  it('throws request/cache-requires-get-method when cache is combined with a non-GET method', () => {
    throwsCode('request Http { method: "POST", cache: { ttlSeconds: 60 } }', 'request/cache-requires-get-method');
  });

  it('throws request/cache-requires-get-method for cache: false combined with a non-GET method too — the method check runs before branching on the cache value\'s own shape', () => {
    throwsCode('request Http { method: "POST", cache: false }', 'request/cache-requires-get-method');
  });

  it('throws request/invalid-cache-config when cache is neither "false" nor an object literal', () => {
    throwsCode('request Http { cache: 60 }', 'request/invalid-cache-config');
  });

  it('throws request/invalid-cache-config when cache is "true" — true has no defined meaning (omit cache, or use {}, to cache automatically per the server)', () => {
    throwsCode('request Http { cache: true }', 'request/invalid-cache-config');
  });

  it('parses cache: false — forces caching off entirely for this endpoint', () => {
    const parsed = config('request Http { cache: false }');
    expect(parsed.entries.cache).to.deep.equal({ kind: 'boolean', value: false });
  });

  it('accepts cache: {} with no ttlSeconds — a no-op, explicit spelling of the default (caching is already on by default, following only the server\'s own Cache-Control)', () => {
    const parsed = config('request Http { cache: {} }');
    expect(parsed.entries.cache).to.deep.equal({ kind: 'object', entries: {} });
  });

  it('throws request/invalid-cache-config when cache.ttlSeconds is zero, non-numeric, or a non-integer', () => {
    throwsCode('request Http { cache: { ttlSeconds: 0 } }', 'request/invalid-cache-config');
    throwsCode('request Http { cache: { ttlSeconds: "60" } }', 'request/invalid-cache-config');
  });

  // A negative literal (`-5`) isn't a single literal TOKEN in BrightScript — it's a unary minus
  // expression wrapping the literal `5` — but `literal-value.ts`'s `walkLiteralValue` unwraps a
  // one-level unary minus on a numeric operand (added for the `animation` feature's translation
  // offsets, e.g. `translation: [-300, 0]`), so `-5` now reaches cache-specific validation as an
  // ordinary negative number, same as `0`/`"60"` above — still rejected, just by the more specific
  // "must be positive" check rather than the generic "not a literal" one.
  it('rejects a negative ttlSeconds via cache-specific validation, not the generic literal check', () => {
    throwsCode('request Http { cache: { ttlSeconds: -5 } }', 'request/invalid-cache-config');
  });

  it('throws request/invalid-cache-config for an unknown key inside cache {}', () => {
    throwsCode('request Http { cache: { ttlSeconds: 60, staleWhileRevalidate: true } }', 'request/invalid-cache-config');
  });

  it('parses a static query object literal', () => {
    const parsed = config('request Http { query: { userId: "1", page: 2 } }');
    expect(parsed.entries.query).to.deep.equal({ kind: 'object', entries: { userId: { kind: 'string', value: '1' }, page: { kind: 'number', value: 2 } } });
  });

  it('throws request/invalid-config-value-type when query is not an object literal', () => {
    throwsCode('request Http { query: "nope" }', 'request/invalid-config-value-type');
  });

  it('accepts an object literal body', () => {
    const parsed = config('request Http { body: { title: "hi" } }');
    expect(parsed.entries.body).to.deep.equal({ kind: 'object', entries: { title: { kind: 'string', value: 'hi' } } });
  });

  it('accepts an array literal body — body is deliberately unrestricted, unlike headers/query', () => {
    const parsed = config('request Http { body: [1, 2, 3] }');
    expect(parsed.entries.body).to.deep.equal({ kind: 'array', items: [{ kind: 'number', value: 1 }, { kind: 'number', value: 2 }, { kind: 'number', value: 3 }] });
  });

  it('throws request/config-must-be-literal for a non-literal value', () => {
    throwsCode('request Http { url: 1 + 1 }', 'request/config-must-be-literal');
  });

  // A config that isn't `{`-delimited at all is rejected by flash-parser's own grammar
  // (dsl/invalid-request — see packages/flash-parser/test/parser/parser.test.ts) before
  // parseRequestConfig is ever reached; request/config-must-be-literal's own "not a BsAALiteral"
  // branch exists as defense-in-depth for that same case, not something the DSL grammar can
  // currently produce (every `{...}`-delimited BrightScript expression that parses at all parses as
  // an AA literal — there's no other valid expression shape starting with `{`).
  it('rejects a config that is not {}-delimited at the flash-parser grammar layer, before ever reaching request-config.ts', () => {
    throwsCode('request Http 5', 'dsl/invalid-request');
  });
});

describe('parseRequestConfig — Kind validation', () => {
  it('throws request/unknown-kind for a Kind outside Http', () => {
    throwsCode('request Bogus {}', 'request/unknown-kind');
  });
});
