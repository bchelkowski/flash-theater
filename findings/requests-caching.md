# Requests — HTTP response caching (`cache: { ttlSeconds }`, `cachefs:/`)

Design rationale for `request Http {}`'s HTTP response caching feature (phase 2). See
`packages/compiler/GRAMMAR.md`'s "Requests" section for the grammar/API itself. For the config
surface and generated fields/functions, see [requests-config.md](requests-config.md). For
transport/runtime platform gotchas, see [requests-runtime.md](requests-runtime.md).

## HTTP response caching — `cachefs:/`, `roEVPDigest`, and caching ON BY DEFAULT

Shipped GET-only (`request/cache-requires-get-method` for any other method), a from-scratch
implementation. Storage: `cachefs:/FlashTheaterHttpCache/<sha1(finalUrl)>` —
`cachefs:/` is Roku's own real, documented, OS-clearable per-channel cache filesystem
(`roFileSystem`/`ReadAsciiFile`/`WriteAsciiFile`); the hash comes from `roEVPDigest`
(`Setup("sha1")` + `Process(byteArray)`) — a real Roku OpenSSL-backed digest component, not a
hand-rolled hash.

**The default flipped from opt-in to opt-out mid-design, after user review, twice** — worth tracing
the full sequence since each round corrected a real usability problem with the previous one:

1. **First shipped**: `cache` required, always with a `ttlSeconds` (a plain fallback, only
   consulted when the real response had no usable `Cache-Control`). No `cache` key at all meant
   zero caching, full stop, regardless of what the server sent.
2. **Round 2**: `ttlSeconds` made optional — `cache: {}` (present, but no ttl) meant "cache this
   endpoint, but only when the server's own response actually says to." Still opt-in overall
   (no `cache` key still meant zero caching).
3. **Round 3 (current)**: caching flipped to **on by default** — a GET request with NO `cache` key
   at all now caches automatically, following the server's own `Cache-Control`, exactly the same as
   round 2's `cache: {}`. `cache` is now purely an *override* mechanism: `cache: false` **forces**
   caching off entirely (the new way to get round 1's original "never cache" behavior); `cache: {
   ttlSeconds: <n> }` **forces** exactly that lifetime, now bypassing `Cache-Control` ENTIRELY —
   including an explicit `no-store`/`no-cache` (previously, `Cache-Control` always won over
   `ttlSeconds` no matter what; now an explicit `ttlSeconds` always wins over `Cache-Control`,
   the opposite precedence — a real author, having explicitly asked for a specific duration, is
   assumed to mean it, even overriding what the server says).

`request-emitter.ts`'s `cacheOptionLiteral` reflects this: every generated `request Http {}`
prints a real `cache: { "disabled": ..., "ttlSeconds": ... }` AA now (never `invalid`) — the
runtime (`ft_httpFetch`) no longer has an "is caching declared at all" branch, only "is it
disabled." `ft_httpResponseMaxAge(headers, forcedTtlSeconds)` checks `forcedTtlSeconds <> invalid`
FIRST, before ever looking at `Cache-Control` — the override, not the header, is authoritative
when present. **Lesson for the next `request {}` config knob with a "does the server know best, or
does the DSL author's explicit config win" question**: get this precedence decision explicit and
confirmed early — it flipped three times here, and each flip touched validation, codegen, the
runtime, GRAMMAR.md, and every test asserting on the generated `cache: {...}` literal's exact
shape.

**Scope note**: the original implementation plan assumed ETag/`If-None-Match` conditional-GET
revalidation would be part of this. Shipped scope is simpler: just `Cache-Control: max-age`/
`Expires`-derived expiry, with a plain expired-means-miss fallback, no revalidation request — no
ETag, no `Expires` parsing either (a real HTTP-date parser is a separate, meaningfully large piece
of work).

**A real `Cache-Control` response header governs by default (no forced `ttlSeconds`)** — but has a
real, easy-to-miss consequence for testing: jsonplaceholder.typicode.com (the sample-app's own test
API) sends `Cache-Control: max-age=43200` (12 hours) on `/posts/1`, confirmed live via `curl -I`.
**Live verification of `GetPost.thr`'s `cache: { ttlSeconds: 30 }` demo initially looked wrong
because of this** (back when `Cache-Control` still always won over a configured `ttlSeconds`, round
1/2's precedence): after an earlier failed test run (see the `Chr(34)` bug below) had already
completed one real fetch and cached it, a LATER clean re-test's very first press already reported
`fromCache=true` — not because the 30-second `ttlSeconds` fallback was somehow still valid several
minutes later, but because the server's own real 12-hour `max-age` was what actually got stored and
was still nowhere near expired. **Lesson for testing this feature against a THIRD-PARTY test API in
the future**: check the real response headers first (`curl -I <url>`) before designing a live test
around a specific TTL number, and remember `cachefs:` persists across app reinstalls/cold restarts
(it's OS-managed on-disk storage, not in-process state) — a "fresh" sideload does not imply a cold
cache. (Under the CURRENT, round-3 precedence, a forced `ttlSeconds` would no longer have this
ambiguity — it always wins regardless of what the server sends — but the lesson about `cachefs:`
persisting across reinstalls still applies to demonstrating the DEFAULT, server-driven path.)

**`response.fromCache`** — a new field on every `ft_httpFetch`/`parseResponse`/`parseError`
response (`true` only on an actual cache hit, `false` for every real network response and for a
non-cached request) — added specifically because the above made it obvious that without some
explicit signal, there's no way for an app (or a test) to tell a cache hit from a fresh network
response just by looking at the returned data; both look identical otherwise.

**A real bug found while building the live demo, unrelated to caching itself**: `Chr(34) +
result.title + Chr(34) + ...` had to replace an original `"\"" + result.title + "\"" ...` —
BrightScript string literals don't support backslash-escaped quotes at all (unlike JS), and this
DSL's own string literals pass through to generated `.brs` verbatim with zero re-validation, so the
mistake compiled cleanly and only crashed at runtime (`Type Mismatch` on a stray `\` operator) —
see `findings/statement-grammar-features.md`'s own section on this for the general (not
request-specific) lesson.

**Live-verified 2026-08-12** (same Roku Ultra) — `apps/sample-app/src/components/GetPost/GetPost.thr`
(a minimal `cache`-only request, no `buildRequest`, proving caching needs no per-call
parameterization machinery at all) driven from a new second button on `RequestDemoScreen.thr`.
Confirmed: the cache read/write round-trip through `cachefs:/` + JSON serialization works
end-to-end on a real device (`entry.data`, itself a parsed JSON object from the original fetch,
survives a `FormatJson`/`ParseJson` round-trip through the cache file correctly), `roEVPDigest`
produces a stable, valid filename, and `fromCache` correctly reports `true` for a genuine cache
hit — confirmed via `queryAppUi`, not just "compiles."
