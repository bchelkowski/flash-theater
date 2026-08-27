/**
 * Interprets a `request <Kind> { ... }` declaration's config-literal text into a structured,
 * literal-only value tree, and validates it against the closed key set for its `Kind` — see
 * `dsl-parser/dsl-ast.ts`'s `RequestDecl` and GRAMMAR.md's "Requests" section.
 *
 * The actual "parse a literal span, walk it structurally" machinery lives in
 * `analysis/literal-value.ts` (shared with `field-state-literals.ts`, which validates `field`/
 * `state` array/AA defaults the identical way) — this module owns only the `request {}`-specific
 * closed key sets and per-key shape validation.
 */
import { CompileError, RequestDecl } from '../dsl-parser/dsl-ast.js';
import { LiteralValue, parseLiteralRoot, unquoteKey, walkLiteralValue } from './literal-value.js';
import { BsAALiteral } from 'flash-parser';

export type RequestConfigValue = LiteralValue;

export const REQUEST_KINDS = ['Http'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Closed key set validated structurally. `query`/`body` are static defaults, mergeable at call time with `buildRequest(data)`'s own `ft_overrides.query`/`.body` — call-site wins, same "static config as the base, hook as the override" shape `headers` already established (see `codegen/request-emitter.ts`). `cache` is GET-only and NOT overridable via `buildRequest` — a caching policy is a property of the endpoint, not a per-call choice. */
const HTTP_CONFIG_KEYS = new Set(['method', 'url', 'headers', 'query', 'body', 'cache']);

export interface ParsedRequestConfig {
  requestKind: RequestKind;
  entries: Record<string, RequestConfigValue>;
}

function requireEntry(entries: Record<string, RequestConfigValue>, key: string): RequestConfigValue | undefined {
  return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined;
}

function validateKeys(entries: Record<string, RequestConfigValue>, allowedKeys: ReadonlySet<string>, requestKind: string, contextLabel: string): void {
  for (const key of Object.keys(entries)) {
    if (!allowedKeys.has(key)) {
      throw new CompileError({
        code: 'request/unknown-config-key',
        message: `Unknown request ${requestKind} config key "${key}" in ${contextLabel} — allowed: ${[...allowedKeys].join(', ')}.`,
      });
    }
  }
}

function validateHttpConfig(entries: Record<string, RequestConfigValue>, contextLabel: string): void {
  validateKeys(entries, HTTP_CONFIG_KEYS, 'Http', contextLabel);

  const method = requireEntry(entries, 'method');
  if (method !== undefined) {
    if (method.kind !== 'string' || !HTTP_METHODS.has(method.value)) {
      throw new CompileError({
        code: 'request/invalid-http-method',
        message: `Invalid request Http "method" in ${contextLabel} — expected one of ${[...HTTP_METHODS].join(', ')}.`,
      });
    }
  }

  const url = requireEntry(entries, 'url');
  if (url !== undefined && url.kind !== 'string') {
    throw new CompileError({ code: 'request/invalid-config-value-type', message: `request Http "url" in ${contextLabel} must be a string literal.` });
  }

  const headers = requireEntry(entries, 'headers');
  if (headers !== undefined && headers.kind !== 'object') {
    throw new CompileError({ code: 'request/invalid-config-value-type', message: `request Http "headers" in ${contextLabel} must be an object literal.` });
  }

  const query = requireEntry(entries, 'query');
  if (query !== undefined && query.kind !== 'object') {
    throw new CompileError({ code: 'request/invalid-config-value-type', message: `request Http "query" in ${contextLabel} must be an object literal (query-string keys/values).` });
  }

  // `body` is deliberately unrestricted — a real request body can legitimately be an object, an
  // array, or even a bare string/number literal, unlike `headers`/`query` (always key/value maps).

  // Caching is ON BY DEFAULT for a GET request — no `cache` key needed at all, it just follows
  // whatever the real response's own `Cache-Control` says (see GRAMMAR.md's "Requests" section and
  // `runtime-assets/Http/FlashTheaterHttp.brs`'s own "HTTP response caching" section). `cache` here
  // is only ever an OVERRIDE of that default, in one of two directions:
  // - `cache: false` — forces caching OFF entirely for this endpoint, ignoring any Cache-Control
  //   the server sends.
  // - `cache: { ttlSeconds: <n> } }` — forces the cache lifetime to exactly `n` seconds, ignoring
  //   the server's own Cache-Control entirely (including an explicit "no-store"/"no-cache" — a
  //   deliberate override, since the DSL author explicitly asked for this exact duration).
  // `ttlSeconds` itself stays optional inside the object form — `cache: {}` is accepted and is
  // simply a no-op spelling of the same default ("cache automatically per the server").
  const cache = requireEntry(entries, 'cache');
  if (cache !== undefined) {
    if (method !== undefined && (method.kind !== 'string' || method.value !== 'GET')) {
      throw new CompileError({
        code: 'request/cache-requires-get-method',
        message: `request Http "cache" in ${contextLabel} is only valid for method "GET" (caching a non-idempotent request doesn't make sense) — found method "${method.kind === 'string' ? method.value : '<non-literal>'}".`,
      });
    }
    if (cache.kind === 'boolean' && cache.value === false) {
      // Valid — forces caching off entirely. Nothing further to validate for this shape.
    } else if (cache.kind === 'object') {
      const cacheKeys = Object.keys(cache.entries);
      if (cacheKeys.some((k) => k !== 'ttlSeconds')) {
        throw new CompileError({
          code: 'request/invalid-cache-config',
          message: `request Http "cache" in ${contextLabel} only accepts a "ttlSeconds" key — found ${cacheKeys.filter((k) => k !== 'ttlSeconds').join(', ')}.`,
        });
      }
      const ttlSeconds = cache.entries.ttlSeconds;
      if (ttlSeconds !== undefined && (ttlSeconds.kind !== 'number' || !Number.isInteger(ttlSeconds.value) || ttlSeconds.value <= 0)) {
        throw new CompileError({
          code: 'request/invalid-cache-config',
          message: `request Http "cache.ttlSeconds" in ${contextLabel}, when present, must be a positive integer literal — it FORCES the cache lifetime, overriding the server's own Cache-Control entirely.`,
        });
      }
    } else if (cache.kind === 'boolean') {
      throw new CompileError({
        code: 'request/invalid-cache-config',
        message: `request Http "cache" in ${contextLabel}, when a boolean, must be "false" (forces caching off) — "true" has no defined meaning; omit "cache" entirely (or use {}) to cache automatically per the server's own Cache-Control instead.`,
      });
    } else {
      throw new CompileError({ code: 'request/invalid-cache-config', message: `request Http "cache" in ${contextLabel} must be "false", or an object literal — { ttlSeconds?: <positive integer> }.` });
    }
  }
}

/**
 * Parses and validates one `request {}` declaration's `requestKind` + `configText` into a
 * `ParsedRequestConfig`. Throws `CompileError` on the first problem — an unrecognized `Kind`, a
 * non-literal value anywhere in the config, an unknown key, or a key with the wrong value shape.
 */
export function parseRequestConfig(decl: RequestDecl, contextLabel: string): ParsedRequestConfig {
  if (!(REQUEST_KINDS as readonly string[]).includes(decl.requestKind)) {
    throw new CompileError({
      code: 'request/unknown-kind',
      message: `Unknown request kind "${decl.requestKind}" in ${contextLabel} — expected one of ${REQUEST_KINDS.join(', ')}.`,
    });
  }
  const requestKind = decl.requestKind as RequestKind;

  const configNode = parseLiteralRoot(decl.configText, 'request/config-parse-error', `request ${requestKind} {} config in ${contextLabel}`);
  if (!(configNode instanceof BsAALiteral)) {
    throw new CompileError({
      code: 'request/config-must-be-literal',
      message: `request ${requestKind} {} in ${contextLabel} must be an object literal, e.g. request ${requestKind} { ... }.`,
    });
  }

  const entries: Record<string, RequestConfigValue> = {};
  for (const field of configNode.fields) {
    entries[unquoteKey(field.key)] = walkLiteralValue(field.value, 'request/config-must-be-literal', contextLabel);
  }

  validateHttpConfig(entries, contextLabel);

  return { requestKind, entries };
}
