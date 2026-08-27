/**
 * Codegen for a `request <Kind> { ... }` declaration — the three interface fields
 * (`data`/`result`/`error`), the `Http` work-function wiring (`functionName` + the generated
 * `ft_runRequest()` sub calling into `runtime-assets/Http/FlashTheaterHttp.brs`'s `ft_httpFetch`),
 * and the author-overridable `buildRequest`/`parseResponse`/`parseError` hook detection. One
 * self-contained module per feature, same shape as `codegen/theme-emitter.ts`.
 */
import { ThrScriptAst } from '../dsl-parser/dsl-ast.js';
import { ParsedRequestConfig, RequestConfigValue } from '../analysis/request-config.js';
import { privateFunctionName } from './naming.js';

/**
 * The SceneGraph interface fields a `request {}` declaration generates, regardless of `Kind` —
 * `[]` when the component declares none. `assocarray` sits outside this DSL's own `field`/`state`
 * `FieldType` union on purpose (see `RequestDecl`'s doc comment), so these are printed directly
 * rather than routed through the ordinary `field` codegen path.
 *
 * `result`/`error` are always present. So, as of the global-interceptor feature
 * (`taskManager.onRequestSent`/`onResponseReceived`, see GRAMMAR.md's "Task manager" section), are
 * `resolvedOptions`, `rawResponse`, and `ft_isRequestComponent` — previously `resolvedOptions` only
 * existed when the component declared `buildRequest`; it's now unconditional because
 * `FlashTheaterTaskManager.brs`'s `startNode()` needs a reliable payload for `onRequestSent`
 * regardless of whether this component overrides its request options (see
 * `emitRequestInitLine`'s own doc comment for where it's actually written).
 *
 * - `resolvedOptions` also always carries `buildSucceeded`/`buildErrorMessage` (see
 *   `buildBaseOptionsLiteral`'s own doc comment) — `onRequestSent`'s payload IS this same AA, so a
 *   registered interceptor automatically sees whether this request's own `buildRequest` hook threw,
 *   the same orthogonal-signal shape `rawResponse.parseSucceeded` gives `onResponseReceived`.
 * - `rawResponse` (`assocarray`) is what `startNode()` observes for `onResponseReceived` — the RAW
 *   `ft_httpFetch` response (plus `parseSucceeded`/`parseErrorMessage`), deliberately never the
 *   app-author's own `parseResponse`/`parseError`-transformed `result`/`error` (see
 *   `emitRequestGeneratedFunctions`'s own doc comment).
 * - `ft_isRequestComponent` (`boolean`, XML-defaulted to `true`) is the marker `startNode()` reads
 *   to decide whether to fire the interceptors at all — gates that logic without ever needing to
 *   find out whether `ObserveFieldScoped` on a field an ordinary hand-written Task doesn't declare
 *   is a safe no-op.
 *
 * There is deliberately no `requestData` field — a caller no longer sets one. Per-call input flows
 * as `prepareRequest(requestData)`'s own parameter (a `callFunc` argument, never stored), not a
 * field a Task would otherwise have to read from its own background thread.
 */
export function requestInterfaceFields(hasRequest: boolean): readonly { id: string; type: string; value?: string }[] {
  if (!hasRequest) return [];
  return [
    { id: 'resolvedOptions', type: 'assocarray' },
    { id: 'rawResponse', type: 'assocarray' },
    { id: 'ft_isRequestComponent', type: 'boolean', value: 'true' },
    { id: 'result', type: 'assocarray' },
    { id: 'error', type: 'assocarray' },
  ];
}

/**
 * The `init()` lines a `request Http {}` component needs — `functionName` wiring this Task to the
 * generated work function, plus an UNCONDITIONAL `resolvedOptions` write (the static base options,
 * regardless of whether `buildRequest` is declared). `null` when there's no `request {}` at all.
 *
 * **Why `resolvedOptions` is written here unconditionally, not just when `buildRequest` exists**:
 * `FlashTheaterTaskManager.brs`'s `startNode()` reads `node.resolvedOptions` as the payload for
 * `taskManager.onRequestSent(...)` (see GRAMMAR.md's "Task manager" section) — every
 * `request Http {}` component needs a reliable value there BEFORE `taskManager.run(task)` is ever
 * called, not just the ones overriding it via `buildRequest`. Writing it here, in `init()` (which
 * always runs on whichever thread creates the node — ordinarily the render thread, and always
 * BEFORE `control="RUN"` starts this Task's own background thread), costs nothing new: a
 * `buildRequest`-declaring component's caller still calls `task.callFunc("prepareRequest",
 * requestData)` exactly as before `taskManager.run(task)` — that call simply OVERWRITES this same
 * field with the merged result, the identical "last write wins, both happen before RUN" shape
 * `SlowTask.thr`'s own "set input fields, then control=RUN" convention already relies on for
 * ordinary Task input. No `callFunc` is added to the manager to populate this — see
 * `emitRequestGeneratedFunctions`'s own doc comment for why an earlier draft's "have the manager
 * auto-`callFunc` `prepareRequest` when `resolvedOptions` is still unset" idea was rejected (it
 * would call `buildRequest(invalid)` for any caller who simply forgot the existing, silently-safe
 * `prepareRequest` step — turning today's graceful degrade into a real crash).
 */
export function emitRequestInitLine(config: ParsedRequestConfig | null): string | null {
  if (!config || config.requestKind !== 'Http') return null;
  return ['  m.top.functionName = "ft_runRequest"', `  m.top.resolvedOptions = ${buildBaseOptionsLiteral(config)}`].join('\n');
}

function brsStringLiteral(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** Prints a validated `RequestConfigValue` back out as a BrightScript literal — normalizes defaults (e.g. an omitted `headers` prints as `{}`) rather than re-splicing the DSL author's own raw config text verbatim. */
function printBrsLiteral(value: RequestConfigValue): string {
  switch (value.kind) {
    case 'string':
      return brsStringLiteral(value.value);
    case 'number':
      return String(value.value);
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'invalid':
      return 'invalid';
    case 'array':
      return `[${value.items.map(printBrsLiteral).join(', ')}]`;
    case 'object':
      return `{${Object.entries(value.entries)
        .map(([key, v]) => ` ${brsStringLiteral(key)}: ${printBrsLiteral(v)}`)
        .join(',')} }`;
  }
}

const EMPTY_OBJECT: RequestConfigValue = { kind: 'object', entries: {} };

/** Resolves a possibly-`private` hook (`buildRequest`/`parseResponse`/`parseError`) declared in this script to the name that survives codegen — a `private function` becomes `private_<name>` (see `codegen/naming.ts`), so a hard-coded call to its literal DSL name would silently call an undefined global, the same class of bug `findings/requests-runtime.md` already documents for `observeFieldScoped`'s string-literal target. Returns `null` when the hook isn't declared at all. */
function resolveHookCallName(script: ThrScriptAst, name: string): string | null {
  const fn = script.functions.find((f) => f.name === name);
  if (!fn) return null;
  return fn.visibility === 'private' ? privateFunctionName(name) : name;
}

/** True whenever this script declares `buildRequest` — the one condition that decides whether `prepareRequest`/`resolvedOptions` exist at all (see `requestInterfaceFields`'s own doc comment). Exported so `compile.ts` can compute the same answer once, for `interfaceFunctions` (`prepareRequest` must be `<function name="...">`-declared, like any other `callFunc` target) without re-deriving it. */
export function requestDeclaresBuildRequest(script: ThrScriptAst): boolean {
  return resolveHookCallName(script, 'buildRequest') !== null;
}

/** Fixed name of the generated, always-`public`, `callFunc`-reachable interface function a caller invokes BEFORE `taskManager.run(task)` to resolve this request's final HTTP options ahead of time — see `emitRequestGeneratedFunctions`'s own doc comment. */
export const PREPARE_REQUEST_FUNCTION_NAME = 'prepareRequest';

/**
 * Prints `cache` into a literal `runtime-assets/Http/FlashTheaterHttp.brs`'s `ft_httpFetch` can
 * always read the same two keys from, regardless of whether the DSL author declared `cache` at
 * all — caching is ON BY DEFAULT for a GET request (follows the real response's own
 * `Cache-Control`), so there is no "absent" sentinel to preserve here the way there was before
 * this default flipped; every `request Http {}` gets a real `cache` AA in its generated options.
 *
 * - `disabled: true` only for an explicit `cache: false` — forces caching off for this endpoint.
 * - `ttlSeconds: <n>` only for an explicit `cache: { ttlSeconds: <n> }` — FORCES that exact
 *   lifetime, bypassing `Cache-Control` entirely (see `ft_httpResponseMaxAge`). `invalid`
 *   (BrightScript's own "no value") in every other case — including `cache: {}` and no `cache` key
 *   at all — meaning "no forced lifetime, defer entirely to the server's own header."
 */
function cacheOptionLiteral(config: ParsedRequestConfig): string {
  const cache = config.entries.cache;
  if (cache?.kind === 'boolean' && cache.value === false) {
    return '{ "disabled": true, "ttlSeconds": invalid }';
  }
  const ttlSeconds = cache?.kind === 'object' ? cache.entries.ttlSeconds : undefined;
  const ttlLiteral = ttlSeconds?.kind === 'number' ? String(ttlSeconds.value) : 'invalid';
  return `{ "disabled": false, "ttlSeconds": ${ttlLiteral} }`;
}

/**
 * Builds the base options literal — always includes `buildSucceeded: true, buildErrorMessage: ""`
 * as its last two keys, regardless of whether this component declares `buildRequest` at all. This
 * keeps `resolvedOptions`'s shape (and therefore `taskManager.onRequestSent(...)`'s payload —
 * `resolvedOptions` IS that payload, see `runtime-assets/TaskManager/FlashTheaterTaskManager.brs`'s
 * `startNode()`) consistent everywhere it's produced: the unconditional `init()` write
 * (`emitRequestInitLine`), `ft_buildBaseRequestOptions()` (only emitted when `buildRequest` exists),
 * and `prepareRequest()`'s own fallback path all reuse this exact literal, so an `onRequestSent`
 * subscriber never has to guess whether these two keys are present. `prepareRequest()` overwrites
 * both keys after a caught `buildRequest` exception (see `emitRequestGeneratedFunctions`'s own
 * "Build safety" doc comment) — the trivial `true`/`""` default here is what a request with no
 * `buildRequest` at all (nothing that could ever fail) keeps unconditionally.
 */
function buildBaseOptionsLiteral(config: ParsedRequestConfig): string {
  const method = config.entries.method?.kind === 'string' ? config.entries.method.value : 'GET';
  const url = config.entries.url?.kind === 'string' ? config.entries.url.value : '';
  const headers = config.entries.headers?.kind === 'object' ? config.entries.headers : EMPTY_OBJECT;
  const query = config.entries.query?.kind === 'object' ? config.entries.query : EMPTY_OBJECT;
  const body = config.entries.body;
  return `{ method: ${brsStringLiteral(method)}, url: ${brsStringLiteral(url)}, headers: ${printBrsLiteral(headers)}, query: ${printBrsLiteral(query)}, body: ${body ? printBrsLiteral(body) : 'invalid'}, cache: ${cacheOptionLiteral(config)}, buildSucceeded: true, buildErrorMessage: "" }`;
}

/**
 * Emits every generated sub/function a `request Http {}` component's own `.brs` needs beyond the
 * DSL author's own hook bodies (`buildRequest`/`parseResponse`/`parseError`, already emitted
 * elsewhere through the ordinary `script.functions` pipeline — this module never prints those,
 * only calls into them by their resolved name).
 *
 * **Why `buildRequest` is no longer called from inside `ft_runRequest()`**: `ft_runRequest()` runs
 * on this Task's own background thread (started the moment `taskManager.run()` sets
 * `control="RUN"`). If `buildRequest`'s own body ever reads something living outside this node —
 * `store`/`theme`/`m.global.*`/another node's field — doing that from a Task's background thread
 * triggers a real Roku **rendezvous** (the background thread blocks, synchronously waiting on the
 * render thread to service that foreign-node field access) — a genuine, documented Roku
 * performance concern, not a style nitpick. Flagged by design review: build the request BEFORE
 * starting the Task, while the node still lives on the thread that created it (i.e. before
 * `control="RUN"` ever runs — a Roku Task node is an ordinary, single-threaded node right up until
 * that field is set; nothing about `CreateObject("roSGNode", ...)` or an ordinary field write
 * spins up its background thread early). Concretely: a generated `public function
 * prepareRequest(requestData)` — reachable via `task.callFunc("prepareRequest", requestData)`,
 * called by the CALLER before `taskManager.run(task)` — resolves the final options AA (merging the
 * static config with `buildRequest(requestData)`'s override, exactly as before) entirely on
 * whichever thread the caller itself runs on (the render thread, in the ordinary case), then
 * stores the result on `m.top.resolvedOptions`. `ft_runRequest()` then just reads that
 * already-resolved field — an ordinary same-node field read from within a Task's own thread, which
 * is the standard, zero-rendezvous way a Task receives its input. A caller that forgets to call
 * `prepareRequest` still gets a working request (falls back to the static config, silently
 * skipping `buildRequest`'s own override) rather than a crash — `resolvedOptions` is `invalid`
 * until `prepareRequest` runs, and `ft_runRequest()` treats that as "use the static base options."
 *
 * **When `buildRequest` isn't declared at all**, `prepareRequest`/`ft_buildBaseRequestOptions` are
 * still never emitted (nothing to override) — but `resolvedOptions` itself is now unconditionally
 * on the interface either way (see `requestInterfaceFields`) and unconditionally written in
 * `init()` (see `emitRequestInitLine`), so `ft_runRequest()` can always just read it back rather
 * than rebuilding the static literal itself a second time.
 *
 * **Parsing safety**: `parseResponse`/`parseError` are the DSL author's own hook bodies — arbitrary
 * code that can throw. Per explicit design requirement, each is wrapped in a `try`/`catch` (only
 * when that hook is actually declared — a component with neither hook gets no `try`/`catch` at
 * all, matching this file's existing independent per-hook branching) so a bug there degrades to a
 * synthesized fallback error (`{message, parseFailed: true, httpStatusCode, raw}`, written to
 * `m.top.error`) instead of crashing the whole Task. `response` is mutated in place with
 * `parseSucceeded`/`parseErrorMessage` before being written to `m.top.rawResponse` — the payload
 * `taskManager.onResponseReceived(...)` interceptors observe (see
 * `runtime-assets/TaskManager/FlashTheaterTaskManager.brs`'s `startNode()`/
 * `on_ft_taskManagerRawResponse`) — specifically so a registered interceptor can tell "the HTTP call
 * itself failed" (`isSuccess: false`) apart from "this endpoint's own parse hook is buggy"
 * (`parseSucceeded: false`) as two orthogonal signals; either can be true independently of the
 * other.
 *
 * **Build safety**: `buildRequest` is the DSL author's own hook body too, and can throw just like
 * `parseResponse`/`parseError` — a bad `requestData` field access, most realistically. Its call
 * (plus the override-merge logic that reads its return value) is wrapped in `try`/`catch` inside
 * `prepareRequest()`, which runs on the CALLING thread (never the Task's own background thread —
 * see this function's own "Why `buildRequest` is no longer called from inside `ft_runRequest()`"
 * section above), so there's no rendezvous concern for the try/catch itself. On a caught exception,
 * `options` is left exactly as `ft_buildBaseRequestOptions()` produced it (none of the override
 * assignments ran, since the call that would have set them up is what threw) — the same graceful
 * "use the static base options" degrade a forgotten `prepareRequest` call already gets — and
 * `options.buildSucceeded`/`options.buildErrorMessage` are overwritten to `false`/the exception's
 * `.message`. Since `options` becomes `m.top.resolvedOptions`, and `resolvedOptions` IS what
 * `taskManager.onRequestSent(...)` fires with (see `FlashTheaterTaskManager.brs`'s `startNode()`),
 * a registered interceptor sees `buildSucceeded: false` automatically — no new hook, no new field
 * on the manager, reusing the exact reporting mechanism already built for
 * `parseSucceeded`/`parseErrorMessage` on the response side. The request itself still proceeds
 * (best-effort, with the static options) rather than being abandoned — consistent with every other
 * "a hook misbehaved" fallback in this file.
 */
export function emitRequestGeneratedFunctions(script: ThrScriptAst, config: ParsedRequestConfig): string {
  const buildRequestCall = resolveHookCallName(script, 'buildRequest');
  const parseResponseCall = resolveHookCallName(script, 'parseResponse');
  const parseErrorCall = resolveHookCallName(script, 'parseError');
  const baseOptionsLiteral = buildBaseOptionsLiteral(config);

  const sections: string[] = [];

  if (buildRequestCall) {
    sections.push(['function ft_buildBaseRequestOptions() as object', `  return ${baseOptionsLiteral}`, 'end function'].join('\n'));

    const prepareLines: string[] = [
      `function ${PREPARE_REQUEST_FUNCTION_NAME}(requestData as object) as object`,
      '  options = ft_buildBaseRequestOptions()',
      '  try',
      `    ft_overrides = ${buildRequestCall}(requestData)`,
      '    if ft_overrides <> invalid then',
      '      if ft_overrides.method <> invalid then options.method = ft_overrides.method',
      '      if ft_overrides.url <> invalid then options.url = ft_overrides.url',
      '      if ft_overrides.headers <> invalid then',
      '        for each ft_headerKey in ft_overrides.headers',
      '          options.headers[ft_headerKey] = ft_overrides.headers[ft_headerKey]',
      '        end for',
      '      end if',
      '      if ft_overrides.query <> invalid then',
      '        for each ft_queryKey in ft_overrides.query',
      '          options.query[ft_queryKey] = ft_overrides.query[ft_queryKey]',
      '        end for',
      '      end if',
      '      if ft_overrides.body <> invalid then options.body = ft_overrides.body',
      '    end if',
      '  catch ft_e',
      '    options.buildSucceeded = false',
      '    options.buildErrorMessage = ft_e.message',
      '  end try',
      '  m.top.resolvedOptions = options',
      '  return options',
      'end function',
    ];
    sections.push(prepareLines.join('\n'));
  }

  const runLines: string[] = ['sub ft_runRequest()'];
  // `resolvedOptions` is now unconditionally written in init() (see `emitRequestInitLine`), so this
  // is always a same-node field read — no fallback rebuild needed except as defensive
  // belt-and-suspenders for the `buildRequest`-declaring case, where `prepareRequest`'s own
  // overwrite could in principle race a caller who never calls it at all (see that function's own
  // doc comment on why the manager itself never auto-calls it).
  runLines.push('  options = m.top.resolvedOptions');
  if (buildRequestCall) {
    runLines.push('  if options = invalid then options = ft_buildBaseRequestOptions()');
  }
  runLines.push('  response = ft_httpFetch(options)');
  runLines.push('  ft_parseSucceeded = true');
  runLines.push('  ft_parseErrorMessage = ""');
  runLines.push('  if response.isSuccess then');
  runLines.push(...parseHookLines(parseResponseCall, 'result', 'parseResponse'));
  runLines.push('  else');
  runLines.push(...parseHookLines(parseErrorCall, 'error', 'parseError'));
  runLines.push('  end if');
  runLines.push('  response.parseSucceeded = ft_parseSucceeded');
  runLines.push('  response.parseErrorMessage = ft_parseErrorMessage');
  runLines.push('  m.top.rawResponse = response');
  runLines.push('end sub');
  sections.push(runLines.join('\n'));

  return sections.join('\n\n');
}

/**
 * The indented lines inside `ft_runRequest()`'s `if response.isSuccess then ... else ... end if`
 * branch — a 7-line `try`/`catch` block when `hookCall` is declared, or a single plain
 * `m.top.<field> = response` line when it isn't (shared by both branches: `resultField` is
 * `"result"`/`"error"`, `hookLabel` is `"parseResponse"`/`"parseError"`, used only in the caught
 * exception's own message text). With no hook declared, this can never throw, so wrapping it would
 * be pure noise — a component with neither hook gets zero `try`/`catch` anywhere in its generated
 * `.brs`. See `emitRequestGeneratedFunctions`'s own "Parsing safety" doc comment for the full
 * rationale.
 */
function parseHookLines(hookCall: string | null, resultField: 'result' | 'error', hookLabel: string): string[] {
  if (!hookCall) return [`    m.top.${resultField} = response`];
  return [
    '    try',
    `      m.top.${resultField} = ${hookCall}(response)`,
    '    catch ft_e',
    '      ft_parseSucceeded = false',
    '      ft_parseErrorMessage = ft_e.message',
    `      m.top.error = { message: "${hookLabel} threw: " + ft_e.message, parseFailed: true, httpStatusCode: response.httpStatusCode, raw: response }`,
    '    end try',
  ];
}
