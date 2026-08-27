# Caching has no `Expires`/ETag/conditional-GET support

**Type:** Gap
**Area:** requests
**Status:** Open

## Problem

`request Http { cache: { ttlSeconds } }`'s response caching only understands a fixed client-side TTL
and `Cache-Control: max-age` — it doesn't parse `Expires` headers, and has no ETag/`If-None-Match`
conditional-GET revalidation flow (send a cached ETag, accept a `304 Not Modified` to avoid
re-downloading a body that hasn't changed).

## Impact

Every cache expiry forces a full re-fetch even when the server would have said "unchanged" via a
conditional GET — wastes bandwidth and time for any API that supports ETags/conditional requests.
Deferred deliberately as "separate, meaningfully large work" when caching first shipped.

## Where

- `findings/requests-caching.md` — the current `cachefs:/` TTL-based caching design.
- `GRAMMAR.md:3104` area — the original deferral note.

## Suggested fix

A real conditional-GET flow needs: (1) storing the response's `ETag`/`Last-Modified` header alongside
the cached body in `cachefs:/`; (2) on a subsequent request past TTL, sending `If-None-Match`/
`If-Modified-Since` instead of skipping the network call entirely; (3) treating a `304` response as
"serve the cached body, refresh its TTL" rather than a normal response. This is a genuine feature
addition to `findings/requests-caching.md`'s design, not a small tweak — worth a dedicated design pass
given the original deferral called it "meaningfully large."

## Related

- `findings/requests-caching.md`
