/**
 * Naming conventions for generated .brs — visibility, see GRAMMAR.md.
 *
 * This DSL's own original design draft assumed a `$$`-prefix for `private`, but
 * BrightScript doesn't allow `$` at the start of an identifier — the lexer
 * accepts `[a-zA-Z_]` as the first character, `$`/`%`/`!`/`#` only as a type
 * suffix at the END of an identifier (e.g. `name$` = string). A leading `_`
 * is also off the table for any *identifier* (locals, sub names, ids) —
 * it's an established Roku/BrightScript ecosystem convention (~3 years old)
 * for *intentionally unused* variables, mirroring this repo's own
 * `argsIgnorePattern: '^_'` in eslint.config.cjs, and this codebase's own
 * house style additionally avoids a leading underscore on any
 * compiler-generated name (readability — nothing here should visually read
 * as "unused" or "private-by-convention"). Hence `private_` for visibility
 * and the plain `ft_` reserved prefix below for everything else. There's no
 * cross-component name collision risk — every SceneGraph component has its
 * own isolated BrightScript context.
 *
 * The `$$`-prefix idea wasn't wasted, though: it's reused, bracket-syntax
 * only, for a *value stored on `m`* that belongs to the compiler rather than
 * the DSL author (see `mFieldAccess` below) — `m["$$ft_foo"]` is a plain
 * string-keyed associative-array lookup, so the `$`-as-first-character
 * lexer restriction (which only applies to a real identifier, i.e. dot
 * syntax) doesn't apply to it.
 */
export function privateFunctionName(name: string): string {
  return `private_${name}`;
}

/** A plain BrightScript string literal, double-quote-escaped — shared by every emitter that prints a literal string into generated code (`conditional-block-emitter.ts`, `each-block-emitter.ts`, `brs-emitter.ts`'s `on:key` dispatch). */
export function brsStringLiteral(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function fieldChangeHandlerName(fieldName: string): string {
  return `on_${fieldName}Change`;
}

/** Handler name for a generated `ObserveFieldScoped` on a global `store`/`theme` field — e.g. `on_store_countChange`, `on_theme_colorsChange`. `root`/`fieldName` are the composite reactive-source key's two parts (see `analysis/expression-region.ts`'s `globalSources` — `"store.count"` → `root="store"`, `fieldName="count"`). */
export function externalFieldChangeHandlerName(root: 'store' | 'theme', fieldName: string): string {
  return `on_${root}_${fieldName}Change`;
}

/**
 * Handler name for a generated `ObserveFieldScoped` on a `bind:` target — a
 * *child* node's own field, not this component's. Deliberately carries a
 * `bind_` segment (`on_bind_<elementId>_<fieldName>Change`), not the
 * `on_<elementId>_<fieldName>Change` shape you'd naively expect: without the
 * `bind_` segment this would collide with `externalFieldChangeHandlerName`'s
 * `on_<root>_<fieldName>Change` whenever an element's own `id` happened to be
 * exactly `"store"` or `"theme"` — a plausible author choice — producing two
 * subs with the identical generated name.
 */
export function bindChangeHandlerName(elementId: string, fieldName: string): string {
  return `on_bind_${elementId}_${fieldName}Change`;
}

/** Name of the `m.`-scoped private AA-literal table holding one theme variant's fully-resolved values for one top-level group — e.g. `private_colors_light` for group `colors`, variant `light`. See `codegen/theme-emitter.ts`. */
export function themeGroupVariantTableName(groupName: string, variantName: string): string {
  return `private_${groupName}_${variantName}`;
}

/**
 * Fixed name of the generated `ObserveFieldScoped` trampoline sub for `taskManager.onAlertChanged(...)`
 * — one per subscribing component (emitted only when that component actually calls it at least
 * once, see `compile.ts`'s `usesTaskManagerAlertCallback`), registered exactly once, in `init()`
 * (mirroring `emitInitFunction`'s own store/theme field-observer registration), regardless of how
 * many separate `onAlertChanged(...)` call sites that component has. Unlike `fieldChangeHandlerName`/
 * `externalFieldChangeHandlerName`, this needs no per-field parameterization — `taskManager` has
 * exactly one observable field (`alertLevel`), so there's only ever one such sub per component.
 */
export const TASK_MANAGER_ALERT_TRAMPOLINE_SUB_NAME = 'on_taskManagerAlertChange';

/**
 * The local variable name a `.flsh` class method/constructor/anonymous-function body hoists
 * `GetGlobalAA()`'s own result into, whenever that body references any class-context global
 * singleton — see `codegen/class-emitter.ts`'s `hoistGlobalAAIfNeeded`. Confirmed live, real Roku
 * device: a bare (return-value-discarded) statement chained directly off `GetGlobalAA()`'s own call
 * result — `GetGlobalAA().global.ft_taskManager.callFunc("setMaxConcurrent", 5)` used as a plain
 * statement, nothing capturing its return — fails to install ("Compilation Failed"), while the exact
 * same call chained off a local variable holding that call's result (`aa = GetGlobalAA()` then
 * `aa.global.ft_taskManager.callFunc(...)`) compiles and runs fine. `router.navigate(...)`/
 * `router.back()` are ALWAYS emitted this way (a route action is never assigned to a variable in
 * this DSL — see `identifier-rewrite.ts`'s `checkRouterActionIsStandaloneStatement`), so this isn't
 * a rare edge case for a class that uses the router at all. See
 * findings/class-pipeline-global-singleton-access.md's `GetGlobalAA()` entry for the live-device bisection that found
 * this (`.thr`-side `m.global`-rooted bare statements are unaffected — this is specific to a bare
 * statement's receiver chain starting with a raw function CALL rather than a variable/`m`).
 */
export const CLASS_GLOBAL_AA_LOCAL_NAME = 'ft_globalAA';

/**
 * Reserved `m`-scope bookkeeping key holding the **array** of every callback function value ever
 * passed to `taskManager.onAlertChanged(<callback>)` in this component — read by
 * `TASK_MANAGER_ALERT_TRAMPOLINE_SUB_NAME`'s own generated body, which calls every entry. An array,
 * not a single overwritable slot: a component that calls `onAlertChanged(...)` more than once (a
 * legitimate thing to want — e.g. two independent pieces of UI logic each reacting to the same
 * alert) needs every one of those callbacks to actually run, not just the most recently registered
 * one silently clobbering the rest. Initialized once, in `init()`, alongside the ONE
 * `ObserveFieldScoped` registration this whole array backs — see `emitInitFunction`'s own
 * `usesTaskManagerAlertCallback` branch; a call site itself only ever `.Push()`es onto it.
 * Deliberately stored on `m` (this subscribing component's own instance scope), never a
 * shared/global table — `m` is already correctly per-component-instance-scoped for free (the exact
 * same scope the trampoline sub itself runs in when SceneGraph invokes it), so a second component
 * (or a second instance of the same component) subscribing independently can never collide with
 * this one's own array.
 */
export function taskManagerAlertCallbacksFieldAccess(): string {
  return mFieldAccess(`${RESERVED_IDENTIFIER_PREFIX}taskManagerAlertCallbacks`);
}

/**
 * Fixed names of the two generated `ObserveFieldScoped` trampoline subs backing
 * `taskManager.onResult(<task>, <onSuccess>, [<onError>])` — one per subscribing component
 * (emitted only when that component actually calls `onResult(...)` at least once, see
 * `compile.ts`'s `usesTaskManagerResultCallback`). Unlike `TASK_MANAGER_ALERT_TRAMPOLINE_SUB_NAME`
 * (registered exactly once, in `init()`, observing the ONE fixed manager singleton), these are
 * registered fresh at EVERY `onResult(...)` call site, each time on a DIFFERENT task node — see
 * `identifier-rewrite.ts`'s `buildTaskManagerOnResultReplacement`. Two separate subs (not one,
 * branching on field name) purely because `ObserveFieldScoped`'s target must be a literal string
 * per field — `result` and `error` each need their own registration call, so each needs its own
 * callback name to know which one fired without inspecting the event further.
 */
export const TASK_MANAGER_RESULT_TRAMPOLINE_SUB_NAME = 'on_taskManagerResult';
export const TASK_MANAGER_RESULT_ERROR_TRAMPOLINE_SUB_NAME = 'on_taskManagerResultError';

/**
 * Reserved `m`-scope bookkeeping key holding a callback-pair AA (`{onSuccess, onError}`) PER TASK
 * ID this component has called `taskManager.onResult(<task>, ...)` for — read by
 * `TASK_MANAGER_RESULT_TRAMPOLINE_SUB_NAME`/`TASK_MANAGER_RESULT_ERROR_TRAMPOLINE_SUB_NAME`'s own
 * generated bodies (`event.GetRoSGNode().id` is the lookup key). Deliberately an AA keyed by task
 * id, not an array — unlike `onAlertChanged`'s "every subscriber gets every event" shape, each
 * `onResult(...)` registration is for a DIFFERENT task and needs its OWN distinct callback pair,
 * looked up by which node's field actually changed.
 *
 * **Why this lives on the CALLING component's own `m`, not the task-manager singleton** —
 * confirmed live (not assumed): a Function value placed into an AA and handed across a `callFunc()`
 * boundary to a DIFFERENT SceneGraph node arrives as `invalid` on the other side (SceneGraph field/
 * argument marshaling does not carry raw Function values across a node boundary — only real SG
 * field-typed values, which a bare BrightScript function reference is not). The original design
 * tried exactly that (register on the manager via `callFunc`) and silently never fired any
 * callback — see `findings/task-manager-onresult.md`. Registering `ObserveFieldScoped` directly from THIS
 * component's own script instead (on the task node it already holds a live reference to) needs no
 * cross-node Function-value marshaling at all — the callback stays a plain local/`m`-scoped
 * BrightScript value the whole time, exactly like `onAlertChanged`'s own callback storage.
 */
export function taskManagerResultCallbacksFieldAccess(): string {
  return mFieldAccess(`${RESERVED_IDENTIFIER_PREFIX}taskManagerResultCallbacks`);
}

/**
 * Fixed names of the generated `ObserveFieldScoped` trampoline subs for
 * `taskManager.onRequestSent(<callback>)`/`taskManager.onResponseReceived(<callback>)` — the global
 * HTTP request/response interceptor hooks (see GRAMMAR.md's "Task manager" section and
 * `findings/task-manager-request-interceptors.md` for why these are shaped exactly like `onAlertChanged`, not `onResult`: a
 * global, register-once subscription with no per-task identity, observing one fixed field each on
 * the manager singleton — `lastRequestSent`/`lastResponseReceived` — rather than a field on a
 * per-call task node). One of each per subscribing component (emitted only when that component
 * actually calls the corresponding hook at least once — see `compile.ts`'s
 * `usesTaskManagerRequestSentCallback`/`usesTaskManagerResponseReceivedCallback`), each registered
 * exactly once, in `init()`, regardless of how many separate call sites that component has.
 */
export const TASK_MANAGER_REQUEST_SENT_TRAMPOLINE_SUB_NAME = 'on_taskManagerRequestSent';
export const TASK_MANAGER_RESPONSE_RECEIVED_TRAMPOLINE_SUB_NAME = 'on_taskManagerResponseReceived';

/**
 * Reserved `m`-scope bookkeeping keys holding the **array** of every callback function value ever
 * passed to `taskManager.onRequestSent(<callback>)`/`taskManager.onResponseReceived(<callback>)` in
 * this component — read by `TASK_MANAGER_REQUEST_SENT_TRAMPOLINE_SUB_NAME`/
 * `TASK_MANAGER_RESPONSE_RECEIVED_TRAMPOLINE_SUB_NAME`'s own generated bodies, which call every
 * entry. Arrays, not single overwritable slots or an id-keyed AA — mirrors
 * `taskManagerAlertCallbacksFieldAccess()` exactly (every subscriber gets every event; this is a
 * global reporting hook, not a per-task result pairing), for the identical reason: a component that
 * registers more than once needs every callback to actually run. Deliberately stored on `m` (this
 * subscribing component's own instance scope), never a shared/global table or anything reachable
 * via a `callFunc` boundary — see `taskManagerResultCallbacksFieldAccess`'s own doc comment for why
 * a callback Function value can never safely cross a `callFunc` call to a different node; these two
 * hooks were designed around that constraint from the start, never attempted the broken shape.
 */
export function taskManagerRequestSentCallbacksFieldAccess(): string {
  return mFieldAccess(`${RESERVED_IDENTIFIER_PREFIX}taskManagerRequestSentCallbacks`);
}
export function taskManagerResponseReceivedCallbacksFieldAccess(): string {
  return mFieldAccess(`${RESERVED_IDENTIFIER_PREFIX}taskManagerResponseReceivedCallbacks`);
}

/**
 * Fixed name of the compiler-manufactured "this component is about to be removed" hook — called on
 * every compiled component, unconditionally, right before it's actually detached: once by
 * `FlashTheaterRouterOutlet`'s own `_teardownCurrentChild()` on the outgoing screen, and once per
 * nested id by `{#if:destroy}`'s own generated destroy sub (`conditional-block-emitter.ts`) on every
 * id it's about to null. Emitted on EVERY component regardless of whether that component itself needs
 * any cleanup — see `codegen/brs-emitter.ts`'s `emitUnmountFunction` for why leaf-gating this (the
 * way every other trampoline in this file IS gated, e.g. `usesTaskManagerAlertCallback`) would be
 * unsound rather than merely leaner: this compiler has no cross-component template-tag registry (a
 * `<Foo/>` tag is an untyped, untracked string at every codegen site), so no single component can
 * know whether any of its own nested children, at any depth, need this hook — an ungated
 * intermediate component would silently break the cascade to a Timer-using descendant two levels
 * down, with no compile error. Named `ft_unmount` (not `__ft_unmount`) specifically so it falls under
 * `analysis/binding-collisions.ts`'s existing `checkReservedIdentifierPrefix` (`dsl/reserved-
 * identifier-prefix`), which already rejects any DSL-authored name starting with `ft_` — a `.thr`
 * author can never accidentally declare their own `ft_unmount` and shadow this hook, with zero new
 * enforcement code needed.
 */
export const UNMOUNT_FUNCTION_NAME = 'ft_unmount';

/**
 * Fixed name of the generated `ObserveFieldScoped("fire", ...)` trampoline sub backing BOTH
 * `setTimeout`/`setInterval` — one per component that ever calls either (see `compile.ts`'s
 * `usesTimerAnywhere`). A single shared sub, not two like the task-manager result pair, since both
 * register the exact same `"fire"` field on their own dynamically-created Timer node — the one-shot-
 * vs-repeat distinction is a runtime `entry.repeat` flag in the registry
 * (`timerCallbacksFieldAccess`), not a compile-time split.
 */
export const TIMER_FIRE_TRAMPOLINE_SUB_NAME = 'on_timerFire';

/**
 * Reserved `m`-scope bookkeeping key holding an AA of every PENDING `setTimeout`/`setInterval`
 * created by this component, keyed by the Timer node's OWN `.id` (assigned at creation time — see
 * `nextTimerTempName`'s own doc comment for why this id must be component-wide-unique). Each entry
 * is `{ node: <the Timer roSGNode itself>, callback: <Function>, repeat: <boolean> }`. Read by
 * `TIMER_FIRE_TRAMPOLINE_SUB_NAME`'s own body (`event.GetRoSGNode().id` is the lookup key, exactly
 * like `taskManagerResultCallbacksFieldAccess`), by `clearTimeout`/`clearInterval`'s own generated
 * `.Delete(...)` call, and by `UNMOUNT_FUNCTION_NAME`'s own generated body (iterates every remaining
 * entry and force-stops its node — see `codegen/brs-emitter.ts`'s `emitUnmountFunction`).
 *
 * Storing the node itself (`node: ...`), not just `{callback, repeat}`, is deliberate: every
 * hand-wired Timer example in this codebase (`SplashScreen.thr`, `TaskDemoScreen.thr`, ...) keeps its
 * node on `m` for the component's whole lifetime, not a function-local var, specifically to avoid
 * premature garbage collection before it ever fires — a `setTimeout(...)` call whose returned handle
 * is discarded by the DSL author needs the same guarantee, and this registry entry is the only other
 * place a reference to that node is kept.
 */
export function timerCallbacksFieldAccess(): string {
  return mFieldAccess(`${RESERVED_IDENTIFIER_PREFIX}timerCallbacks`);
}

/** Reserved prefix for every compiler-synthesized identifier (a `{#if}`/`{#if:destroy}` block's own wrapper `Group` id, a synthesized parent id, an expression-wrapper temp name, ...) — see `analysis/binding-collisions.ts`'s `dsl/reserved-identifier-prefix` check, which rejects any user-authored name starting with this prefix so nothing generated here can ever collide with DSL source. */
export const RESERVED_IDENTIFIER_PREFIX = 'ft_';

/** True iff `id` is compiler-synthesized (carries `RESERVED_IDENTIFIER_PREFIX`) rather than DSL-author-given. */
export function isReservedIdentifier(id: string): boolean {
  return id.startsWith(RESERVED_IDENTIFIER_PREFIX);
}

/**
 * True iff generated `brs` calls the named runtime helper (`ft_equals`, `ft_not`,
 * `ft_createStream`, `ft_scale`, `ft_relationalGuard`, ...) at least once — used to tally which
 * runtime helper `<script>` assets a component/class needs. Never `${helperName}?(` — a runtime
 * helper's own call is always assembled as a bare-identifier callee (`` `${helperName}(${args})`
 * ``), and `identifier-rewrite.ts`'s `rewriteOptionalChains` (see
 * findings/operators-optional-chaining.md) deliberately never puts `?` on a bare-identifier call's
 * own parens — Roku's real compiler rejects that (live-verified: "Install Failure: Compilation
 * Failed"), so this plain substring check is safe.
 */
export function usesRuntimeHelperCall(brs: string, helperName: string): boolean {
  return brs.includes(`${helperName}(`);
}

/**
 * Fresh, function-scoped temp-var name for one hoisted ternary lowering (`codegen/brs-emitter.ts`'s
 * `lowerTernaryRhs`) — `ft_ternary_1`, `ft_ternary_2`, ... `counter` is a plain mutable object
 * (not a closure-captured `let`) so `emitFunction`/`emitMethod` can create one per function and
 * thread it through their own print context, reset for every function body — safe since each
 * compiles to its own, independently-scoped BrightScript `sub`/`function`, so numbering restarting
 * per function carries no collision risk.
 */
export function nextTernaryTempName(counter: { value: number }): string {
  counter.value += 1;
  return `${RESERVED_IDENTIFIER_PREFIX}ternary_${counter.value}`;
}

/**
 * Fresh, function-scoped temp-var name for one hoisted Tier-2 anonymous function (a DSL anon
 * function nested inside an ordinary expression — a call argument, a condition, ... — rather
 * than Tier 1's whole-RHS-of-an-assignment/state-write host position, which needs no hoisting at
 * all, see `codegen/brs-emitter.ts`'s `printAnonymousFunctionExpression`'s own doc comment) —
 * `ft_anon_1`, `ft_anon_2`, ... Same counter shape and per-function-body reset rationale as
 * `nextTernaryTempName` above.
 */
export function nextAnonFunctionTempName(counter: { value: number }): string {
  counter.value += 1;
  return `${RESERVED_IDENTIFIER_PREFIX}anon_${counter.value}`;
}

/**
 * Fresh temp-var name for one `setTimeout`/`setInterval` call site — `ft_timer_1`, `ft_timer_2`, ...
 * **Deliberately NOT function-scoped/reset-per-function like `nextTernaryTempName`/
 * `nextAnonFunctionTempName`.** Those two only need uniqueness within ONE BrightScript local scope (a
 * function body); this name is used BOTH as the local variable AND, critically, as the created Timer
 * node's own `.id` field, which becomes the KEY into `timerCallbacksFieldAccess()`'s shared,
 * component-wide registry AA. If this counter reset per function, two DIFFERENT functions in the same
 * component could each mint `ft_timer_1` independently; if both timers were alive concurrently,
 * whichever registered SECOND would silently overwrite the FIRST's registry entry. `counter` must
 * therefore be created ONCE per whole component (`codegen/brs-emitter.ts`'s `emitBrs`) and threaded,
 * by reference, into every `emitFunction` call for that component — never rebuilt per function.
 */
export function nextTimerTempName(counter: { value: number }): string {
  counter.value += 1;
  return `${RESERVED_IDENTIFIER_PREFIX}timer_${counter.value}`;
}

/**
 * Access expression for an `m`-scope field keyed by `id`, with an optional
 * bookkeeping `suffix` (`_keys`/`_nodes`). A compiler-synthesized id (see
 * `isReservedIdentifier`) is written `$$`-prefixed via bracket syntax —
 * `m["$$ft_if_1"]` — since a real dot-accessed identifier can never start
 * with `$` (see this file's top doc comment). A DSL-author id keeps ordinary
 * dot syntax (`m.detailTitle`), unchanged from before. Used for every place
 * generated code caches a node reference or each-block bookkeeping dict
 * directly on the component's own `m` scope — never for a DSL-declared
 * `field`/`state`/`derived` name, which stays a plain `m.<name>` regardless
 * (those can never collide with `RESERVED_IDENTIFIER_PREFIX`, enforced by
 * `analysis/binding-collisions.ts`'s `dsl/reserved-identifier-prefix` check).
 */
export function mFieldAccess(id: string, suffix = ''): string {
  return isReservedIdentifier(id) ? `m["$$${id}${suffix}"]` : `m.${id}${suffix}`;
}

/** The synthetic `Group` wrapper id for the Nth `{#if}`/`{#if:destroy}` block encountered, in document order — e.g. `ft_if_1`. See `analysis/conditional-blocks.ts`. */
export function conditionalBlockElementId(ordinal: number): string {
  return `${RESERVED_IDENTIFIER_PREFIX}if_${ordinal}`;
}

/** A synthesized id for an element that has no author-given `id` but needs one purely so a `{#if:destroy}` block that's one of its direct children has a `findNode`-able parent reference to `appendChild`/`removeChild` onto. */
export function conditionalParentElementId(ordinal: number): string {
  return `${RESERVED_IDENTIFIER_PREFIX}parent_${ordinal}`;
}

/**
 * Every compiler-generated `{#if:destroy}`/`{#each}` plumbing `sub`/`function` is named
 * `<componentName>__<verb>_<suffix>` — distinct from the `private_`/`on_<field>Change` scheme
 * above (which stays untouched): those two are pre-existing, well-established, and readable as-is,
 * this one used to be a flat `ft_`-prefixed scheme (`ft_reconcile_ft_each_1`) that was hard
 * to read/debug — real-device debugging of a `{#each}`-nested-`{#if:destroy}` crash is what
 * surfaced this. `blockId` (e.g. `ft_if_1`) already carries the reserved prefix; this strips it
 * before combining with `componentName` so the result reads as one clean name, not two prefixes
 * stacked (`ScheduleList__create_if_1`, not `ScheduleList__create_ft_if_1`).
 */
function stripReservedPrefix(id: string): string {
  return id.startsWith(RESERVED_IDENTIFIER_PREFIX) ? id.slice(RESERVED_IDENTIFIER_PREFIX.length) : id;
}

/** Generated `sub` name that hand-constructs a `{#if:destroy}` block's subtree and inserts it into its parent — see `codegen/conditional-block-emitter.ts`. */
export function conditionalCreateSubName(componentName: string, blockId: string): string {
  return `${componentName}__create_${stripReservedPrefix(blockId)}`;
}

/** Generated `sub` name that removes a `{#if:destroy}` block's subtree from its parent and nulls every cached ref inside it — see `codegen/conditional-block-emitter.ts`. */
export function conditionalDestroySubName(componentName: string, blockId: string): string {
  return `${componentName}__destroy_${stripReservedPrefix(blockId)}`;
}

/** The synthetic `Group` wrapper id for the Nth `{#each}` block encountered, in document order — e.g. `ft_each_1`. Unlike a `{#if:destroy}` block's wrapper, this one is *always* statically present in the compiled XML (an `{#each}` list is 0..N items, never absent) — see `codegen/each-block-emitter.ts`. */
export function eachBlockElementId(ordinal: number): string {
  return `${RESERVED_IDENTIFIER_PREFIX}each_${ordinal}`;
}

/** Generated `sub` name that reconciles an `{#each}` block's rendered children against its current collection value — see `codegen/each-block-emitter.ts`. */
export function eachReconcileSubName(componentName: string, blockId: string): string {
  return `${componentName}__reconcile_${stripReservedPrefix(blockId)}`;
}

/** Generated `function ... as object` name that builds one new item's subtree from scratch and returns its root node — see `codegen/each-block-emitter.ts`. */
export function eachCreateItemSubName(componentName: string, blockId: string): string {
  return `${componentName}__create_item_${stripReservedPrefix(blockId)}`;
}

/** Generated `sub` name that re-runs an existing (key-persisted) item node's bindings against a possibly-changed item value — see `codegen/each-block-emitter.ts`. */
export function eachUpdateItemSubName(componentName: string, blockId: string): string {
  return `${componentName}__update_item_${stripReservedPrefix(blockId)}`;
}

/** One shared helper, emitted at most once per `.brs` file (gated on "at least one `{#each}` block exists") — normalizes a key expression's runtime value into a string, since `roAssociativeArray` keys must be strings but a `(key)` clause may evaluate to any scalar. See `codegen/each-block-emitter.ts`. */
export function eachKeyNormalizerName(componentName: string): string {
  return `${componentName}__each_key_to_string`;
}

/** The generated SceneGraph node id for one `animation <name> { ... }` declaration's own `<Animation>`/`<SequentialAnimation>`/`<ParallelAnimation>` XML subtree — e.g. `ft_anim_bounce`. Reserved-prefixed since it's compiler-synthesized (never a DSL-authored template id), so `.start()`/`.stop()`/... trigger sugar accesses it via `mFieldAccess`'s bracket-syntax convention, same as any other `ft_`-prefixed id. See `codegen/animation-emitter.ts`. */
export function animationNodeId(name: string): string {
  return `${RESERVED_IDENTIFIER_PREFIX}anim_${name}`;
}

/**
 * Synthetic per-use-site `animation` name for a `transition:`/`in:`/`out:` template attribute —
 * `ft_transition_<blockId>_<direction>` (e.g. `ft_transition_if_1_in`) — distinct from any
 * DSL-declared `animation` name by construction (reserved-prefixed), and unique per block+direction
 * so `in:`/`out:` on the same element never collide with each other. Fed into
 * `animationNodeId`/`resolveTransitionAnimation` the exact same way a real declared name is —
 * codegen never distinguishes "preset-backed" from "custom-animation-backed" beyond this point.
 */
export function transitionAnimationName(blockId: string, direction: 'in' | 'out'): string {
  return `${stripReservedPrefix(blockId)}_${direction}`;
}

/**
 * Synthetic per-outlet animation name for a `navigate-out:`/`navigate-in:`/`back-out:`/`back-in:`
 * template attribute on a `<FlashTheaterRouterOutlet>` — `<outletId>_<navDirection>_<phase>` (e.g.
 * `outlet_navigate_out`) — mirrors `transitionAnimationName`'s "one synthesized name per use site"
 * shape, fed into `animationNodeId`/`resolveTransitionAnimation` the same way. See
 * `analysis/router-transitions.ts`.
 */
export function routerOutletTransitionName(outletId: string, navDirection: 'navigate' | 'back', phase: 'in' | 'out'): string {
  return `${stripReservedPrefix(outletId)}_${navDirection}_${phase}`;
}

/**
 * The fixed interface field name on `FlashTheaterRouterOutlet.xml` (hand-authored runtime asset,
 * `runtime-assets/RouterOutlet/`) that `emitInitFunction` wires a resolved `navigate-out:`/
 * `navigate-in:`/`back-out:`/`back-in:` animation node reference onto — `ft_navigateOutAnim`/
 * `ft_navigateInAnim`/`ft_backOutAnim`/`ft_backInAnim`. Kept in sync BY HAND with that runtime
 * asset's own `<field>` declarations (same convention as `ROUTER_OUTLET_TAG_NAME` in
 * `analysis/router-transitions.ts` — a hand-authored runtime component has no generated-code
 * counterpart to import this from).
 */
export function routerOutletAnimFieldName(navDirection: 'navigate' | 'back', phase: 'in' | 'out'): string {
  return `${RESERVED_IDENTIFIER_PREFIX}${navDirection}${phase === 'in' ? 'In' : 'Out'}Anim`;
}

/**
 * Interface field every compiled `.thr` component declares, unconditionally, whenever the whole app
 * uses the router anywhere — mirrors `UNMOUNT_FUNCTION_NAME`'s own unconditional-per-component
 * inclusion (see that constant's own call site in `compile.ts` for why leaf-gating would be
 * unsound: a component's own template can't statically know whether it'll end up mounted under a
 * `loading:component`-gated `<FlashTheaterRouterOutlet>`). `router.markReady()` compiles to a plain
 * assignment on this field (`m.top.ft_routeReady = true`) rather than a `callFunc` into the router
 * singleton — see `identifier-rewrite.ts`'s `buildRouterActionReplacement`.
 */
export const ROUTE_READY_FIELD_NAME = 'ft_routeReady';

/**
 * Synthetic per-site `animation` name for an `animate:<field>` template attribute —
 * `ft_animate_<elementId>_<field>` — fed into `animationNodeId` the same way a real declared name
 * is. Unlike `transitionAnimationName`'s in/out pair, there is exactly one of these per
 * `animate:<field>` attribute (Layer 3 auto-animates a single reactive write, no enter/exit
 * split). See `analysis/animate-bindings.ts`.
 */
export function animateBindingAnimationName(elementId: string, fieldName: string): string {
  return `animate_${elementId}_${fieldName}`;
}

/**
 * Generated `ObserveFieldScoped("state", ...)` handler name for one ANIMATION NODE (by its declared
 * or synthetic name, e.g. `on_bounce_StateChange` / `on_if_1_out_StateChange`) — `on_<name>_StateChange`.
 * Registered exactly once, in `init()`, per animation name that has at least one "consumer": a
 * transitioning block whose `ResolvedBlockTransition.outConfig` resolves to this name, and/or a
 * `.onFinish(callback)` registration for this name.
 *
 * Keyed by animation name rather than block id purely as a generalization/simplification — NOT
 * because a real collision needs resolving. A Layer 2 `out:`/`transition:` attribute, even one
 * referencing a DECLARED (non-preset) `animation` name, never actually targets that declaration's own
 * node: `analysis/animation-presets.ts`'s `resolveTransitionAnimation` always returns a freshly
 * synthesized per-block-direction name (`transitionAnimationName`, e.g. `if_1_out`) copying the
 * referenced config, so Layer 1's `.onFinish()` (which DOES act on the real `animationNodeId(name)`
 * node) and any Layer 2 usage of that same declared name are always on two distinct nodes with two
 * distinct handlers — see `codegen/conditional-block-emitter.ts`'s `emitAnimationStateChangeHandler`
 * doc comment for the same point. Name-keying still generalizes cleanly to a hypothetical future
 * mechanism that DID reuse a literal node, and happens to also let two blocks that both reference the
 * same synthetic-in-practice-always-unique name share one handler for free — but nothing in the
 * current feature set actually exercises that. For a synthetic preset/transition name this is a
 * straight rename from the old block-id-keyed name (already unique per block+direction).
 */
export function animationStateChangeHandlerName(name: string): string {
  return `on_${stripReservedPrefix(name)}_StateChange`;
}

/**
 * Reserved `m`-scope field holding the callback registered via `<name>.onFinish(callback)` —
 * `m["$$ft_animFinish_<name>"]`. A plain top-level `m` key, not a nested-AA registry keyed by node id
 * like `taskManagerResultCallbacksFieldAccess` needs — unlike a Task node (dynamically created, many
 * live instances per declared kind), a Layer 1 `animation <name> { ... }` declaration has exactly ONE
 * static node per component, so its own fixed, name-derived `m` key is all the keying it needs.
 * Written by `identifier-rewrite.ts`'s onFinish splice (`m["$$ft_animFinish_bounce"] = <callback>`),
 * read back by `animationStateChangeHandlerName`'s generated handler body — always extracted to a
 * local (`cb = m["$$ft_animFinish_bounce"]`) before being invoked, never called via direct AA
 * dot-access, for the same reason `taskManagerResultCallbacksFieldAccess`'s own doc comment gives
 * (calling a stored Function value via AA dot-access rebinds `m` inside it to the AA itself).
 */
export function animationFinishCallbackFieldAccess(name: string): string {
  return mFieldAccess(`${RESERVED_IDENTIFIER_PREFIX}animFinish_${name}`);
}

/** Attribute name that opts an element into the focus system — reuses SceneGraph's own native field name (`ifSGNodeFocus`), not a DSL invention. See `analysis/focusable-elements.ts` and GRAMMAR.md's "Focus system". Shared by every emitter that special-cases a `focusable` attribute assignment, so the string literal exists exactly once. */
export const FOCUSABLE_ATTRIBUTE_NAME = 'focusable';

/**
 * Translates a DSL type name into the type keyword that belongs in a real BrightScript `as
 * <Type>` clause (a function/method/constructor parameter or return type) — the ONE place this
 * translation is needed, since `field`/`state`/`derived`'s own `node` type is a completely
 * different context (an XML `<field type="node">` attribute, a native SceneGraph field-type
 * keyword that has nothing to do with BrightScript's own `as`-clause type grammar) and must stay
 * "node" unchanged there.
 *
 * `node` is the one DSL type name this repo has confirmed, live, is NOT a valid BrightScript `as`
 * type keyword — `function foo() as node` produces a genuine Roku "Install Failure: Compilation
 * Failed" on a real device, even though it parses cleanly through `kopytko-brightscript-parser`
 * (which doesn't validate `as`-clause type keywords against Roku's real closed set at all). `as
 * object` is the correct real BrightScript equivalent for "any SceneGraph node." See
 * findings/router.md for the full live-verified trace (bisected down from a much larger,
 * seemingly unrelated symptom).
 *
 * Every OTHER DSL type name (`string`/`integer`/`float`/`boolean`, or an unrestricted identifier
 * for `state`/`derived`/a function param/return type — including a `.flsh` class name) passes
 * through unchanged: those already are (or are trusted to be, the same "unrestricted, unvalidated,
 * surfaces as a real Roku error if wrong" treatment this DSL already gives `<component
 * extends="...">` and a template element's own `tagName`) valid BrightScript `as`-clause types.
 */
export function brsTypeAnnotation(dslType: string): string {
  return dslType === 'node' ? 'object' : dslType;
}

/**
 * Attribute name declaring a component's explicit default focus target — unlike `focusable`, this
 * is a pure DSL-level/compiler-internal marker with NO corresponding native SceneGraph field on
 * any node type. It must never be passed through to generated XML (`codegen/xml-emitter.ts`) or
 * assigned as a runtime field (`conditional-block-emitter.ts`/`each-block-emitter.ts`'s own
 * per-element static-attribute construction paths) the way an ordinary attribute is — confirmed
 * live: emitting it as a real `<Rectangle default-focus="true">` attribute produces a genuine Roku
 * "Install Failure: Compilation Failed" (an unrecognized field name on a native node type), even
 * though it parses cleanly with `kopytko-brightscript-parser`/an XML well-formedness check — see
 * findings/router.md. Every codegen site that walks an element's raw attributes to decide what
 * becomes a real field/XML attribute must explicitly skip this name, the same way each already
 * must recognize (but specially handle, never pass through) `FOCUSABLE_ATTRIBUTE_NAME`.
 */
export const DEFAULT_FOCUS_ATTRIBUTE_NAME = 'default-focus';
