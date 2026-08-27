# Requests — config & codegen (`request Http { ... }` declaration, options, generated fields)

Compile-time module responsibilities and design rationale for the `request {}` DSL declaration's
config surface and the fields/functions it generates. See `packages/compiler/GRAMMAR.md`'s
"Requests" section for the grammar/API itself — this file is the *why*, and the platform facts
that cost real debugging time to confirm. For the runtime/transport behavior and platform gotchas
(async fetch, `observeFieldScoped` callback naming, `buildRequest` threading, AA-literal
case-folding), see [requests-runtime.md](requests-runtime.md). For HTTP response caching, see
[requests-caching.md](requests-caching.md).

## Unified into `taskManager`, not a new global — by explicit user requirement

The feature was originally planned around a brand-new `requests`/`http` global. The user
pushed back mid-design: everything routes through the existing `taskManager` namespace instead —
`request {}` generates an ordinary `<component extends="Task">`, consumed via the exact same
`taskManager.run(task)` + `observeFieldScoped(...)` idiom
[findings/task-manager-core.md](task-manager-core.md) already documents, with zero new
`taskManager.*` surface added in phase 1. Promise-style sugar shipped as the first exception to
"zero new `taskManager.*` surface": `taskManager.onResult(<task>, onSuccess, [onError])`,
expanding entirely on the calling component's own thread — see
`findings/task-manager-onresult.md`'s own "`taskManager.onResult(...)` — promise-style sugar"
section for the full design (including a live platform bug that killed its first design entirely)
and its live-verification. Global interceptors (`taskManager.onRequestSent`/`onResponseReceived`)
shipped as the second exception — see `findings/task-manager-request-interceptors.md`'s own section on them
for the full design, including why the ORIGINAL plan for these two (also a manager-side `callFunc`
registration) was abandoned before it was ever implemented, once `onResult`'s own postmortem proved
that shape broken.
HTTP response caching (`cache: { ttlSeconds }`) shipped in phase 2 — see
[requests-caching.md](requests-caching.md) — still with zero new `taskManager.*` surface beyond
`onResult`/`onRequestSent`/`onResponseReceived`; caching itself is entirely `request Http {}`/
`FlashTheaterHttp.brs`'s own concern.

## `resolvedOptions`/`rawResponse`/`ft_isRequestComponent` are now unconditional, not `buildRequest`-gated

Shipped alongside the interceptor feature. `resolvedOptions` used to exist only when a component
declared `buildRequest` — the global `taskManager.onRequestSent(...)` hook (see
`findings/task-manager-request-interceptors.md`) needs a reliable payload for EVERY `request Http {}`
component, not just ones overriding their options, so `request-emitter.ts`'s
`emitRequestInitLine` now unconditionally writes `m.top.resolvedOptions = <base options literal>`
in `init()`. A `buildRequest`-declaring component's caller still calls
`task.callFunc("prepareRequest", requestData)` before `taskManager.run(task)` exactly as before —
that call simply overwrites the same field with the merged result, the same "last write wins, both
happen before `RUN`" shape `SlowTask.thr`'s own "set input fields, then `control="RUN"`" convention
already relies on. No new `callFunc` was added to the manager to populate this field — an earlier
draft of the interceptor design considered having `FlashTheaterTaskManager.brs`'s `startNode()`
auto-`callFunc` `prepareRequest` itself when `resolvedOptions` was still unset, and a design review
caught that this would call the DSL author's own `buildRequest(requestData)` with `requestData =
invalid` on the render thread whenever a caller simply forgot the existing, silently-safe
`prepareRequest` step — turning today's documented graceful degrade (`buildRequest` just doesn't
run) into a real crash (`invalid.someField`), in exactly the case an app is most likely to hit by
accident. Writing the static value unconditionally in `init()` avoids this entirely.

`resolvedOptions` also always carries `buildSucceeded: true, buildErrorMessage: ""` as its own last
two literal keys (`buildBaseOptionsLiteral`), overwritten to `false`/the exception's `.message` by
`prepareRequest()`'s `try`/`catch` around `buildRequest` on a caught exception (added in a follow-up
round — see `findings/requests-runtime.md`'s "`buildRequest` exceptions are also caught" section for
the full design). Since `resolvedOptions` IS `onRequestSent`'s payload, this needed no new field on
the manager or new `taskManager.*` action — a registered interceptor sees build failures for free.

`rawResponse` (new) carries the RAW `ft_httpFetch` response — deliberately never the same value as
`result`/`error`, which hold each component's own `parseResponse`/`parseError`-transformed output
(an app-author-defined shape, inconsistent across components — wrong for a generic reporting hook).
It's written at the very END of `ft_runRequest()`, after parse status is known, by mutating the
`response` local in place (`response.parseSucceeded = ...`, `response.parseErrorMessage = ...`) 
rather than re-listing `ft_httpFetch`'s own response keys as a fresh literal — avoids duplicating
that shape a second time in a different file; if it ever gains a field, `rawResponse` picks it up
automatically.

`ft_isRequestComponent` (a boolean field, XML-defaulted `true`) is the marker
`FlashTheaterTaskManager.brs`'s `startNode()` checks before firing either interceptor or attaching
the `rawResponse` observer — chosen specifically so the manager never needs to find out whether
`ObserveFieldScoped` on a field an ordinary hand-written Task (`SlowTask.thr`) doesn't declare is a
safe no-op. This is a real, deliberate improvement over the ORIGINAL interceptor plan, which
proposed doing exactly that unconditionally for every task the manager ever runs (flagged there as
"Open risk #1: is observing a nonexistent field a safe no-op or a crash?") — gating on a
reliably-safe field READ (an established BrightScript fact — reading an undeclared field returns
`invalid`, not an error, the same fact `resolveTaskId()`'s own collision guard already relies on)
sidesteps that open question rather than needing to resolve it live.

## `assocarray` is a real SceneGraph field type but NOT a valid BrightScript `as`-clause type

Two different type systems, easy to conflate:

- **SceneGraph XML field type** — `<field id="requestData" type="assocarray" />` is correct and
  confirmed; this compiler's `codegen/request-emitter.ts`'s `requestInterfaceFields` emits it —
  see "`requestData`, not `data`" below for the naming rationale.
- **BrightScript `as` clause** — `assocarray` is NOT one of BrightScript's real type keywords
  (`Boolean`/`Integer`/`LongInteger`/`Float`/`Double`/`String`/`Object`/`Interface`/`Invalid`/
  `Dynamic`/`Void`, plus component/interface names). A DSL author's `buildRequest(data:
  assocarray): assocarray` would print `as assocarray` verbatim (this DSL's `state`/`derived`/
  function param/return types are unrestricted identifiers, never validated against a closed set —
  see `findings/reactivity-state.md`) — **use `object` instead**, the conventional BrightScript
  type for an associative array. Every hook signature in GRAMMAR.md's "Requests" section and the
  `apps/sample-app/src/components/GetPosts/GetPosts.thr` fixture uses `object`, deliberately, not
  `assocarray`.

## A full BrightScript expression parse tokenizes numbers differently than a DSL default literal

`analysis/request-config.ts`'s `parseRequestConfig` parses a `request {}` config literal via
flash-parser's own `parseEmbeddedExpression` (full BrightScript grammar), not the DSL-level literal
grammar `field`/`state` defaults use. A DSL default literal (`field x: integer = 5`) tokenizes as
the single, undifferentiated `TokenKind.NumberLiteral` — but the SAME text parsed as a full
BrightScript expression (a `request {}` config value) tokenizes into one of FOUR more precise kinds
instead: `IntegerLiteral`/`LongIntegerLiteral`/`FloatLiteral`/`DoubleLiteral` (see tokenKind.ts's own
doc comment on `NumberLiteral`, which flags this exact split). **Confirmed live via a failing
`{ method: 5 }` test** (silently misclassified as a non-literal), not assumed — `request-config.ts`'s
`literalTokenToValue` now switches on all five kinds, stripping a trailing BrightScript
numeric-literal suffix (`&`/`!`/`#`) before `Number(...)` parsing. **Lesson for the next feature that
walks a full BrightScript expression AST for DSL-level literal validation**: don't reuse the
DSL-literal token-kind assumptions from `expectLiteral()` (`token-stream-parser.ts`) — check against
a real parse first, the same "verify against `parseBrightScript`, not intuition" discipline
`findings/task-manager-core.md`'s own `run`-vs-`Run` finding already established.

## `BsAstNode`'s underlying syntax-node property is `.syntax`, not `.node`

flash-parser has two, differently-named base AST classes that are easy to confuse when writing
compiler code that walks a full BrightScript expression tree (as opposed to this DSL's own
script-level grammar): the DSL-level `AstNode` (`ast.ts`) exposes the underlying CST node as
`.node`; the BrightScript-expression-level `BsAstNode` (`brightscript-ast.ts` — `BsAALiteral`,
`BsLiteralExpression`, `BsAssignmentStatement`, etc.) exposes it as `.syntax` instead. Accessing
`.node` on a `Bs*` wrapper silently returns `undefined` rather than erroring at the type level in a
plain script (caught here only via a runtime crash in a throwaway debug script, not TypeScript) —
worth double-checking on sight whenever new code mixes both AST layers, since nothing about the two
classes' shared `AstNode`/`BsAstNode` naming warns you which one you're holding.

## `requestData`, not `data` — avoids colliding in meaning with `response.data`

The generated per-call input was originally a field named `data`, read inside `buildRequest(data)`. Flagged in design review as confusing: `ft_httpFetch`'s
own response shape *also* uses `data` — but for the **parsed response body** (`response.data`, read
inside `parseResponse`/`parseError`). Same word, two unrelated meanings, one call's input and the
other's output, a few lines apart in the same generated function. Renamed to `requestData` —
`response.data` is untouched, since renaming that would mean diverging from `ft_httpFetch`'s own
return shape for no benefit (it's a generic HTTP response wrapper, not `request {}`-specific).
**Lesson**: when a feature introduces a field name, check it against every other field already
flowing through the same generated function, not just its own declaration site — `data`'s collision
wasn't visible from `request-emitter.ts` alone, only once `FlashTheaterHttp.brs`'s response shape
was considered side by side with it.

**Superseded, partially, by the rendezvous-avoidance redesign below**: `requestData` started life as
an actual `<field id="requestData">` the caller wrote (`task.requestData = {...}`) and
`buildRequest` read back via `m.top.requestData`. It is no longer a stored field at all — see
[requests-runtime.md](requests-runtime.md)'s "`buildRequest` moved out of the Task thread entirely"
section — `requestData` now only exists as `buildRequest`'s own parameter name and
`prepareRequest(requestData)`'s own parameter name, never a field on the interface. The naming
rationale above (avoiding the `response.data` collision) still applies to that parameter name; only
the "it's a field" half of the original finding is now stale.

## `query`/`body` config keys — completing the "how do I configure a request" story

Phase 1 shipped `method`/`url`/`headers` only; the only way to attach a request body or query
parameters was `buildRequest(requestData)` returning `{ body: {...} }}` (body) or hand-concatenating
onto `url` (query — no support at all). Flagged in design review as a real gap, not a hypothetical
one — filtering/paginating a GET request via query parameters is a baseline HTTP need. Added:

- **`query`** — a flat AA config key, merged with `buildRequest()`'s own `query` key-by-key
  (call-site wins), same shape/merge semantics `headers` already had. Appended onto `url` by a new
  `ft_httpBuildUrl(url, query)` in `FlashTheaterHttp.brs`: URI-encodes each key/value via
  BrightScript's real `roString` `ifToStr`/`ifStringOps` methods (`.EncodeUriComponent()`), skips
  a value with no
  `ifToStr` interface (an AA/array/invalid) rather than crashing, and appends with `&` instead of
  `?` when `url` already contains its own `?` (a static `url` config value can legitimately carry
  one already).
- **`body`** — now also a static config key (previously override-only via `buildRequest`), so a
  fixed POST/PUT body doesn't need a `buildRequest` hook at all. Deliberately unrestricted (any
  literal — object/array/string/number/boolean), unlike `headers`/`query` (always key/value maps) —
  a real request body isn't always a JSON object.

`ft_httpFetch`'s own `options` shape gained `query` (defaults to `{}` when absent/`invalid`,
defensively, same as `headers` already does — safety net for hand-written BrightScript calling
`ft_httpFetch` directly, not just `request {}`-generated code).

## `<script uri="...">` is `pkg:/`-rooted absolute, not component-relative

Every cross-file `<script uri="...">` this compiler emits — a shared runtime helper
(SafeCompare/Stream/Http), or a `.flsh` class's own compiled `.brs` — used to be computed relative
to the *referencing* component's own directory (`./Classes/Counter.brs`,
`../FlashTheater/Stream/FlashTheaterStream.brs`, deeper for a more nested component). Flagged in
design review as worth switching to `pkg:/`-rooted absolute paths instead
(`pkg:/components/Classes/Counter.brs`) — reads identically regardless of how deeply nested the
referencing component is, and matches how Roku app code conventionally references other package
files. `app-compiler.ts`'s `toScriptUri(outRoot, absoluteBrsPath)` now computes the path relative to
`outRoot` (the directory `source/`/`components`/`manifest` all physically land under once
`flash-theater compile` writes them, and the actual `pkg:/` root once the app is packaged — see
`project-layout.ts`/`findings/build-layout.md`), not the referencing component's directory. A
component's **own** `<script uri="<Name>.brs">` (the file sitting right next to its own `.xml`) is
untouched — only cross-file references changed. **Gotcha hit while updating this** (and hit again,
in a sharper form, when the src/out project-layout split later separated `srcRoot` from `outRoot` —
see `findings/build-layout.md`): a test that never explicitly passes `outRoot` to `compileApp(...)`
(defaulting to `'.'`, i.e. `process.cwd()`) now needs one that actually lines up with its fixture's
own absolute-looking paths (`/app/...`) — the old component-relative scheme happened to work
regardless of whether the root was right, since it was never consulted for the URI itself; the new
scheme genuinely depends on it.

## The `<Node id="root" />` inside every Task fixture was always unnecessary

`SlowTask.thr` and (until this round) `GetPosts.thr` both declared a single throwaway
`<Node id="root" />` child inside `<component extends="Task">` — copied by convention from
UI-rendering components, where a real root element is obviously required. Flagged in design review:
a Task has no UI at all, so what was this for? Verified directly (not assumed): `<component>` with
**zero** top-level children compiles cleanly — `dsl-parser.ts`'s `adaptTemplateSection` treats
0 children the same as 2+ (the synthetic-multi-child-root branch, just with an empty `children`
array), and `xml-emitter.ts` prints an empty `<children>\n  </children>` block, which is valid,
harmless SceneGraph XML (confirmed via a throwaway `compileThrSource` call, then via the real
`request-http-basic` golden fixture and the sample-app rebuild). Nothing in this compiler's own
`init()` codegen (`m.<id> = m.top.findNode("<id>")`) is emitted unless the DSL author's own template
actually declares an element with that `id` — there's no hidden convention requiring a `root` id to
exist. **Fix**: removed the dead `<Node id="root" />` from both `SlowTask.thr` and `GetPosts.thr` —
a Task component's `<component extends="Task">` block can simply be empty. **Lesson**: a pattern
copied from one fixture to the next without re-deriving *why* it's there is exactly how dead
boilerplate spreads — worth a second look whenever a new fixture is about to copy an existing one's
shape verbatim.
