' Backs the DSL's `request Http { ... }` declaration (see GRAMMAR.md's "Requests" section) — a
' roUrlTransfer wrapper called from the generated `ft_runRequest()` work function, which runs on
' the owning `request {}` component's own Task thread (that component always declares
' `<component extends="Task">` — see compile.ts's `request/declaration-requires-task-extends`
' check). Blocking here is safe and intentional: a Task exists specifically so work like this can
' block its own thread without stalling the render thread. Simplified for a first phase with no
' interceptors and no cancellation (see the approved plan's phased roadmap — those are later
' phases, layered on top of the taskManager singleton, not on this file). Response caching
' (`request Http { cache: {...} }`)
' shipped in phase 2 — see this file's own "HTTP response caching" section below.
'
' Uses the ASYNC roUrlTransfer methods (AsyncGetToString/AsyncPostFromString) plus a message port
' and a single blocking Wait() — not the synchronous GetToString()/PostFromString() variants —
' specifically so the real HTTP status code is available afterward via roUrlEvent.GetResponseCode().
' This is still blocking from the calling code's point of view (Wait() with no timeout
' argument blocks until the message arrives), exactly as intended on a Task's own thread.
'
' Not a per-component copy — every component whose own compiled `.brs` declares `request Http {}`
' gets exactly one <script uri="..."> pointing at this single shared file (app-compiler.ts, same
' dedup convention as FlashTheaterStream.brs).
'
' Confirmed live end to end (Roku Ultra, apps/sample-app's GetPosts.thr/RequestDemoScreen.thr):
' AsyncGetToString() + Wait(0, port) correctly returns a real roUrlEvent with GetResponseCode()/
' GetString() populated; ParseJson() on the response body correctly yields an roArray for a JSON
' array payload.

' `options` = { method: string, url: string, headers: object, query: object (optional),
'   body: object|invalid (optional), cache: object (optional, { disabled: boolean,
'   ttlSeconds: integer|invalid }) }. `query` is a flat AA of query-string key/values, appended to
' `url` (URI-encoded, merged with any query string already present in `url` itself) — see
' `ft_httpBuildUrl` below. Response caching for a GET request is ON BY DEFAULT (follows the real
' response's own `Cache-Control`, see the "HTTP response caching" section below) — `options.cache`
' is only ever an override: `{ disabled: true }` forces it off, `{ ttlSeconds: <n> }` forces that
' exact lifetime; an absent/`invalid` `options.cache` (a hand-written caller that never set it)
' behaves exactly like the default `{ disabled: false, ttlSeconds: invalid }`. Ignored entirely for
' any non-GET method (`request-config.ts`/`compile.ts` already reject a non-GET `cache` config at
' compile time, but this function stays defensive regardless, since it's also reachable from
' hand-written BrightScript, not just `request Http {}`-generated code).
' Returns { isSuccess: boolean, httpStatusCode: integer, data: dynamic, headers: object,
'   rawBody: string, failureReason: string, fromCache: boolean }. `data` is the response body
' parsed as JSON when the body is non-empty and valid JSON, otherwise the raw string — an app's own
' `parseResponse(...)` hook (see GRAMMAR.md) decides what to do with either shape. `fromCache` is
' true only for a cache hit (see the "HTTP response caching" section below) — false for every real
' network response (success or failure) and for a request with caching disabled.
function ft_httpFetch(options as object) as object
  method = options.method
  if method = invalid or method = "" then method = "GET"

  query = options.query
  if query = invalid then query = {}
  finalUrl = ft_httpBuildUrl(options.url, query)

  cacheConfig = options.cache
  if cacheConfig = invalid then cacheConfig = { disabled: false, ttlSeconds: invalid }
  isCacheable = method = "GET" and cacheConfig.disabled <> true

  if isCacheable then
    cached = ft_httpCacheRead(finalUrl)
    if cached <> invalid then return cached
  end if

  port = CreateObject("roMessagePort")
  transfer = CreateObject("roUrlTransfer")
  transfer.SetMessagePort(port)
  transfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
  transfer.InitClientCertificates()
  transfer.EnableEncodings(true)
  transfer.SetUrl(finalUrl)

  headers = options.headers
  if headers = invalid then headers = {}

  body = invalid
  if options.body <> invalid then body = options.body

  bodyString = ""
  if body <> invalid then
    bodyString = FormatJson(body)
    if ft_httpHeaderValue(headers, "Content-Type") = invalid then
      headers.AddReplace("Content-Type", "application/json")
    end if
  end if

  for each headerKey in headers
    transfer.AddHeader(headerKey, headers[headerKey])
  end for

  requestStarted = false
  if method = "GET" then
    requestStarted = transfer.AsyncGetToString()
  else
    transfer.SetRequest(method)
    requestStarted = transfer.AsyncPostFromString(bodyString)
  end if

  if not requestStarted then
    return ft_httpFailureResponse(-1, "Failed to start request")
  end if

  event = wait(0, port)
  if Type(event) <> "roUrlEvent" then
    return ft_httpFailureResponse(-1, "No response received")
  end if

  statusCode = event.GetResponseCode()
  rawBody = event.GetString()
  responseHeaders = event.GetResponseHeaders()
  isSuccess = statusCode >= 200 and statusCode < 300

  data = rawBody
  if rawBody <> "" then
    parsed = ParseJson(rawBody)
    if parsed <> invalid then data = parsed
  end if

  response = {
    isSuccess: isSuccess,
    httpStatusCode: statusCode,
    data: data,
    headers: responseHeaders,
    rawBody: rawBody,
    failureReason: "",
    fromCache: false
  }

  if isSuccess and isCacheable then
    ft_httpCacheWrite(finalUrl, response, cacheConfig.ttlSeconds)
  end if

  return response
end function

' Appends `query` (a flat AA of key/values) onto `url` as a URI-encoded query string: no
' roArray-of-{key,value} input shape, since this DSL's own `query {}` config/override is always a
' plain AA. Appends with "&" if `url` already contains "?" (a static `url` config value can
' legitimately carry its own query string already), otherwise "?". A value with no `ifToStr`
' interface (an AA/array/invalid) is skipped, not stringified, rather than crashing on a bad
' `query` entry.
function ft_httpBuildUrl(url as string, query as object) as string
  if query = invalid or query.Count() = 0 then return url

  paramParts = []
  for each key in query
    value = query[key]
    if value <> invalid and GetInterface(value, "ifToStr") <> invalid then
      paramParts.Push(key.EncodeUriComponent() + "=" + value.ToStr().EncodeUriComponent())
    end if
  end for

  if paramParts.Count() = 0 then return url

  separator = "?"
  if url.InStr("?") > -1 then separator = "&"
  return url + separator + paramParts.Join("&")
end function

' Case-sensitive AA key lookup in BrightScript doesn't have a built-in "get ignoring key case"
' helper — headers are conventionally capitalized consistently by callers of this file (this DSL's
' own `headers: {...}` config and `buildRequest(data)` override both write literal keys), so a
' plain direct lookup is enough for the one place this file needs it (deciding whether to default
' Content-Type) — not a general-purpose case-insensitive header accessor.
function ft_httpHeaderValue(headers as object, key as string) as dynamic
  if headers = invalid then return invalid
  return headers[key]
end function

function ft_httpFailureResponse(statusCode as integer, reason as string) as object
  return {
    isSuccess: false,
    httpStatusCode: statusCode,
    data: invalid,
    headers: {},
    rawBody: "",
    failureReason: reason,
    fromCache: false
  }
end function

' --- HTTP response caching (ON by default for GET; request Http { cache: false|{ttlSeconds} } overrides) ---
'
' GET-only (see ft_httpFetch's own `isCacheable` gate). Storage: `cachefs:/FlashTheaterHttpCache/`
' — Roku's own purpose-built, OS-clearable per-channel cache filesystem (a real, documented Roku
' URI scheme, not a made-up path). The cache key is the FINAL resolved url (after
' `ft_httpBuildUrl`'s query-string merge), so two different `query` values for the same endpoint
' never collide in the cache.
'
' Caching is opt-OUT, not opt-in: a GET request with no `cache` config at all still consults and
' populates the cache, following whatever the real response's own `Cache-Control` header says (see
' `ft_httpResponseMaxAge`) — no `cache` declaration needed just to respect the server's own
' instructions. `cache: false` forces it off entirely. `cache: { ttlSeconds: <n> }` FORCES that
' exact lifetime instead, bypassing `Cache-Control` entirely (including an explicit
' "no-store"/"no-cache" — a deliberate override once the DSL author explicitly asks for a specific
' duration).
'
' Known limitations (see GRAMMAR.md's "Requests" section and findings/requests-caching.md): `Expires` is
' NOT parsed (only `Cache-Control: max-age`) — a real HTTP-date parser is a meaningfully large,
' separate piece of work, deferred rather than half-implemented; there is no ETag/conditional-GET
' revalidation — an expired entry is just a plain cache miss.

' Hex sha1 digest of `text` — turns an arbitrary cache key (a full request URL) into a safe
' filename. `roEVPDigest` is a real, documented Roku component (OpenSSL EVP digest support), not a
' hand-rolled hash.
function ft_httpCacheHash(text as string) as string
  digest = CreateObject("roEVPDigest")
  digest.Setup("sha1")
  bytes = CreateObject("roByteArray")
  bytes.FromAsciiString(text)
  return digest.Process(bytes)
end function

sub ft_httpCacheEnsureFolder()
  fs = CreateObject("roFileSystem")
  if not fs.Exists("cachefs:/FlashTheaterHttpCache") then
    fs.CreateDirectory("cachefs:/FlashTheaterHttpCache")
  end if
end sub

' Reads a cached response for `url` — invalid on a cache miss OR an expired entry (no
' revalidation in this phase, an expired entry is simply treated as absent). On a hit, returns the
' exact same shape `ft_httpFetch` itself returns, so a caller can return it as-is.
function ft_httpCacheRead(url as string) as object
  path = "cachefs:/FlashTheaterHttpCache/" + ft_httpCacheHash(url)
  fs = CreateObject("roFileSystem")
  if not fs.Exists(path) then return invalid

  content = ReadAsciiFile(path)
  if content = "" then return invalid

  entry = ParseJson(content)
  if entry = invalid then return invalid

  now = CreateObject("roDateTime")
  if now.AsSeconds() >= entry.expiresAt then return invalid

  return {
    isSuccess: true,
    httpStatusCode: entry.httpStatusCode,
    data: entry.data,
    headers: entry.headers,
    rawBody: entry.rawBody,
    failureReason: "",
    fromCache: true
  }
end function

' The effective cache lifetime (seconds) for a response. `forcedTtlSeconds` (from `request Http {
' cache: { ttlSeconds: <n> } } }`), when not `invalid`, FORCES this exact lifetime — bypasses
' `Cache-Control` entirely, including "no-store"/"no-cache" (a deliberate override: the DSL author
' explicitly asked for this exact duration). When `forcedTtlSeconds` is `invalid` (the default,
' ordinary case — no `cache` key, or `cache: {}`), the real `Cache-Control` response header governs
' entirely: "no-store"/"no-cache" means never cache, "max-age=<n>" uses that value, anything else
' (including no `Cache-Control` header at all) means don't cache — no locally-assumed lifetime.
function ft_httpResponseMaxAge(headers as object, forcedTtlSeconds as dynamic) as integer
  if forcedTtlSeconds <> invalid then return forcedTtlSeconds

  cacheControl = ft_httpHeaderValue(headers, "Cache-Control")
  if cacheControl <> invalid then
    if cacheControl.InStr("no-store") > -1 or cacheControl.InStr("no-cache") > -1 then return 0
    maxAgeMatch = CreateObject("roRegex", "max-age=(\d+)", "i").Match(cacheControl)
    if maxAgeMatch.Count() > 1 then return maxAgeMatch[1].ToInt()
  end if
  return 0
end function

' Stores `response` for `url`, IF its effective max-age (`ft_httpResponseMaxAge`) is greater than
' 0 — a "no-store"/"no-cache" response with no forced `ttlSeconds`, or simply no `Cache-Control`
' header at all with no forced `ttlSeconds` either, both mean "don't cache this," a real,
' silently-honored possibility, not an error.
sub ft_httpCacheWrite(url as string, response as object, forcedTtlSeconds as dynamic)
  maxAge = ft_httpResponseMaxAge(response.headers, forcedTtlSeconds)
  if maxAge <= 0 then return

  ft_httpCacheEnsureFolder()
  now = CreateObject("roDateTime")
  entry = {
    httpStatusCode: response.httpStatusCode,
    data: response.data,
    headers: response.headers,
    rawBody: response.rawBody,
    expiresAt: now.AsSeconds() + maxAge
  }
  content = FormatJson(entry)
  if content <> "" then WriteAsciiFile("cachefs:/FlashTheaterHttpCache/" + ft_httpCacheHash(url), content)
end sub
