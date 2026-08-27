/**
 * Shape tables and path validation for the app's global `theme` singleton —
 * the cross-file counterpart to `scope-resolution.ts` (which resolves a
 * *single file's* bindings). `theme.a.b` is validated against this table by
 * `resolveThemePath`, then rewritten by `analysis/identifier-rewrite.ts`'s
 * `validateAndRewriteGlobalPaths` — see findings/compiler-pipeline-and-build.md
 * for why theme validation has to live at the whole-app level
 * (`app-compiler.ts`) rather than inside the existing single-file
 * `compileThrSource`.
 *
 * The `store` singleton has no shape table here at all — it's a built-in
 * runtime primitive (never user-authored in the DSL, see GRAMMAR.md's
 * "Global store" section), so it's schemaless from the compiler's point of
 * view. `store(<path>)` reads/writes are validated structurally at parse
 * time (flash-parser rejects a multi-segment write target) and otherwise
 * pass through unchecked — see `identifier-rewrite.ts`'s
 * `rewriteStoreWriteStatement`/`rewriteStorePathRead`.
 *
 * `router` is schemaless too (same reasoning as `store` — there's no way to
 * know a route's `params` shape at compile time), but unlike `store` it's
 * reached through the *generic* `theme`-style dot-chain scanner
 * (`GLOBAL_ROOT_NAMES` in `identifier-rewrite.ts`/`expression-region.ts`),
 * not a fixed three-production grammar form — because, unlike a store write
 * (restricted to exactly one shape, `store(<key>) = <expr>`), the router
 * exposes several distinct *actions* (`navigate`, `back`, `resetHistory`,
 * `appendBackJourneyData`, `updateBackJourneyData`) callable as ordinary
 * method-call syntax (`router.navigate(...)`), which only the generic
 * call-target-aware scanner already built for `theme` can represent. See
 * `resolveRouterPath` below — it's the one place a *bare* member name is
 * classified as one of those actions vs. an ordinary schemaless data read
 * (`router.path`, `router.params.x`).
 *
 * `taskManager` is the third root reached through this same generic scanner — like `router`, it
 * needs both actions (`run`/`cancel`/`setMaxConcurrent`) and data reads (`runningCount`/
 * `queuedCount`) under one namespace (see findings/router.md's "next global-singleton feature"
 * lesson). Unlike `router`'s fully schemaless data reads, though, `taskManager`'s data surface is
 * small and fixed — `resolveTaskManagerPath` validates both sides against a closed list, closer to
 * `resolveThemePath`'s discipline than `resolveRouterPath`'s "anything past segment 1 passes".
 */
import { CompileError, FieldType, ThemeMemberDecl, ThemeTemplateAst, ThemeVariantAst } from '../dsl-parser/dsl-ast.js';
import type { GlobalAccessRoot } from '../codegen/global-fields.js';

export type ThemeShapeNode = { kind: 'leaf'; type: FieldType } | { kind: 'group'; children: Map<string, ThemeShapeNode> };

/** One variant's fully-resolved values at every leaf path — the template's own default, overridden per-path by whatever the variant explicitly provides. Keyed by `.`-joined path (e.g. `"colors.primary"`). */
export interface ResolvedThemeVariant {
  name: string;
  values: Map<string, string>;
}

export interface ThemeShape {
  topLevelGroups: Map<string, ThemeShapeNode>;
  /** In file-discovery order — feeds the "first variant" tier of the initial-active-theme fallback chain. */
  variantNames: string[];
  defaultVariantName: string | null;
  resolvedVariants: Map<string, ResolvedThemeVariant>;
  /** The template's own literal defaults, keyed the same way as a `ResolvedThemeVariant.values` — the third and last tier of the initial-active-theme fallback chain (no variants declared at all), see `codegen/theme-emitter.ts`. */
  templateDefaults: ReadonlyMap<string, string>;
}

export interface GlobalBindingsContext {
  theme: ThemeShape | null;
  /**
   * Which expression reaches the shared global-singleton AA — omitted (⇒ `'m.global'`) for every
   * existing `.thr` component call site, so none of them need to change. Only the `.flsh` class
   * pipeline (`class-identifier-rewrite.ts`) sets this explicitly, to `'GetGlobalAA().global'` — see
   * `codegen/global-fields.ts`'s `GlobalAccessRoot` for why. Deliberately optional rather than
   * required: this interface is constructed as a `NO_GLOBAL_BINDINGS`/`EMPTY_GLOBAL_BINDINGS` literal
   * in roughly a dozen files across this package, and none of those `.thr`-side call sites should
   * have to know or care about class codegen.
   */
  accessRoot?: GlobalAccessRoot;
  /**
   * Whether the app supplied a `flash-theater.config.json` with a valid `designResolution` —
   * `compile.ts` uses this to reject any `scale` usage (`dsl/scale-requires-config`) when absent,
   * since `scale`'s entire meaning depends on knowing which resolution the author's sizes were
   * authored for; there is no sane implicit default. Optional/undefined ⇒ not configured, same
   * "omit ⇒ off" convention as `accessRoot`.
   */
  designResolutionConfigured?: boolean;
  /**
   * Declared variable names for the active environment (`--env`/`FLASH_THEATER_ENV`) — `undefined`
   * means no environment is active at all, which is *distinct* from an active environment that
   * simply declares zero variables (an empty-but-present `Set`). `resolveEnvPath` uses this
   * distinction to give a specific "no active environment" diagnostic rather than a generic
   * "unknown variable" one. Optional, same "omit ⇒ off" convention as `accessRoot`/
   * `designResolutionConfigured` — see GRAMMAR.md's "Environments" section.
   */
  envVariableNames?: ReadonlySet<string>;
}

export const EMPTY_GLOBAL_BINDINGS: GlobalBindingsContext = { theme: null };

/**
 * Builds the theme's shape tree from the template and validates every
 * variant against it: a variant may omit any member (falling back to the
 * template's own default at that exact path), but a member it *does*
 * provide must exist at that path in the template, be the same kind (group
 * vs. leaf), and have the same declared type — never inferred/inherited
 * silently, matching `derived`'s own required-type precedent.
 */
export function buildThemeShape(template: ThemeTemplateAst, variants: readonly ThemeVariantAst[]): ThemeShape {
  const topLevelGroups = buildShapeNodes(template.members);
  const templateDefaults = resolveMemberDefaults(template.members, []);

  const resolvedVariants = new Map<string, ResolvedThemeVariant>();
  const variantNames: string[] = [];

  for (const variant of variants) {
    if (resolvedVariants.has(variant.variantName)) {
      throw new CompileError({
        code: 'theme/duplicate-variant-name',
        message: `Two <theme name="${variant.variantName}"> files declare the same variant name — each variant name must be unique within the app.`,
      });
    }
    variantNames.push(variant.variantName);
    const values = new Map(templateDefaults);
    applyVariantOverrides(variant.members, [], topLevelGroups, values);
    resolvedVariants.set(variant.variantName, { name: variant.variantName, values });
  }

  return { topLevelGroups, variantNames, defaultVariantName: template.defaultVariantName, resolvedVariants, templateDefaults };
}

function buildShapeNodes(members: readonly ThemeMemberDecl[]): Map<string, ThemeShapeNode> {
  const nodes = new Map<string, ThemeShapeNode>();
  for (const member of members) {
    nodes.set(member.name, member.kind === 'theme-group' ? { kind: 'group', children: buildShapeNodes(member.members) } : { kind: 'leaf', type: member.type });
  }
  return nodes;
}

function resolveMemberDefaults(members: readonly ThemeMemberDecl[], pathPrefix: readonly string[]): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const member of members) {
    const path = [...pathPrefix, member.name];
    if (member.kind === 'theme-leaf') {
      defaults.set(path.join('.'), member.defaultLiteral);
    } else {
      for (const [k, v] of resolveMemberDefaults(member.members, path)) defaults.set(k, v);
    }
  }
  return defaults;
}

function applyVariantOverrides(
  members: readonly ThemeMemberDecl[],
  pathPrefix: readonly string[],
  templateShape: ReadonlyMap<string, ThemeShapeNode>,
  values: Map<string, string>,
): void {
  for (const member of members) {
    const path = [...pathPrefix, member.name];
    const pathText = path.join('.');
    const templateNode = templateShape.get(member.name);

    if (!templateNode) {
      throw new CompileError({
        code: 'theme/variant-unknown-member',
        message: `Theme variant member "${pathText}" does not exist in the theme template.`,
        span: member.span,
      });
    }

    if (member.kind === 'theme-group') {
      if (templateNode.kind !== 'group') {
        throw new CompileError({
          code: 'theme/variant-kind-mismatch',
          message: `Theme variant member "${pathText}" is a group, but the template declares it as a leaf.`,
          span: member.span,
        });
      }
      applyVariantOverrides(member.members, path, templateNode.children, values);
      continue;
    }

    if (templateNode.kind !== 'leaf') {
      throw new CompileError({
        code: 'theme/variant-kind-mismatch',
        message: `Theme variant member "${pathText}" is a leaf, but the template declares it as a group.`,
        span: member.span,
      });
    }
    if (templateNode.type !== member.type) {
      throw new CompileError({
        code: 'theme/variant-type-mismatch',
        message: `Theme variant member "${pathText}" declares type "${member.type}", but the template declares "${templateNode.type}".`,
        span: member.span,
      });
    }

    values.set(pathText, member.defaultLiteral);
  }
}

export type GlobalPathResolution =
  | { kind: 'theme-leaf'; type: FieldType; topLevelGroup: string }
  | { kind: 'theme-group'; topLevelGroup: string }
  /** A schemaless read off the current route (`router.path`, `router.params.x`, ...) — see `resolveRouterPath` below. */
  | { kind: 'router-data' }
  /** A validated call to one of the router's known actions — `method` is the exact runtime `callFunc` name (`navigate`, `back`, `resetHistory`, `appendBackJourneyData`, `updateBackJourneyData`). */
  | { kind: 'router-action'; method: RouterActionMethod }
  /** A validated read of one of the task manager's two fixed counters (`runningCount`/`queuedCount`) — see `resolveTaskManagerPath` below. */
  | { kind: 'task-manager-data'; member: TaskManagerDataMember }
  /** A validated call to one of the task manager's known actions — `method` is the exact runtime `callFunc` name (`run`, `cancel`, `setMaxConcurrent`). */
  | { kind: 'task-manager-action'; method: TaskManagerActionMethod }
  /** A validated read of one of the active environment's declared variables (`env.apiKey`) — see `resolveEnvPath` below. */
  | { kind: 'env-data'; name: string }
  /** `code` is the `CompileError` code the caller should throw — see the diagnostic-code table in GRAMMAR.md's "Global store", theme, "Router", "Task manager", and "Environments" sections. */
  | { kind: 'invalid'; code: string; reason: string };

/**
 * The router's own known action methods, callable as `router.<method>(...)` — see `resolveRouterPath`
 * and `identifier-rewrite.ts`'s `buildRouterActionReplacement` for each one's argument shape.
 * `setRouting` is here too (not left as a raw `m.global.ft_router.callFunc("setRouting", ...)`) so
 * every router interaction, including the app's own one-time route-tree registration, goes through
 * the same `router.*` namespace — see GRAMMAR.md's "Router" section. `markReady` is the one entry
 * here that does NOT compile to a `callFunc` into the router singleton at all — `buildRouterActionReplacement`
 * special-cases it into a plain field assignment on the CALLING component's own top node
 * (`m.top.ft_routeReady = true`) — see that function's own doc comment for why (avoids needing a
 * global "which outlet is waiting" registry).
 */
export const ROUTER_ACTION_METHODS = ['setRouting', 'navigate', 'back', 'resetHistory', 'appendBackJourneyData', 'updateBackJourneyData', 'markReady'] as const;
export type RouterActionMethod = (typeof ROUTER_ACTION_METHODS)[number];
const ROUTER_ACTION_METHOD_SET: ReadonlySet<string> = new Set(ROUTER_ACTION_METHODS);

/**
 * The task manager's own known action methods, callable as `taskManager.<method>(...)` — see
 * `resolveTaskManagerPath` and GRAMMAR.md's "Task manager" section. Every one of these except `run`
 * (1 or 2 positional args — node, and an optional priority), `onAlertChanged`, `onResult`,
 * `onRequestSent`, and `onResponseReceived` takes exactly one positional argument, passed straight
 * through with no repacking (unlike `router.navigate`). The four `on*` methods are ALL
 * special-cased entirely in `identifier-rewrite.ts` (`buildTaskManagerOnAlertChangedReplacement`/
 * `buildTaskManagerOnResultReplacement`/`buildTaskManagerOnRequestSentReplacement`/
 * `buildTaskManagerOnResponseReceivedReplacement`) — none of them is a plain `callFunc` at all; each
 * expands to a callback registration on the CALLING component's own `m` scope instead, so none goes
 * through `buildTaskManagerActionReplacement`/`TASK_MANAGER_RUNTIME_METHOD_NAMES`. `onResult`'s own
 * registration additionally attaches `ObserveFieldScoped` directly on the task node the caller
 * already holds a reference to — confirmed live that the original design (registering the
 * callback pair on the MANAGER via `callFunc`) cannot work at all: a Function value placed in a
 * `callFunc` AA argument arrives as `invalid` on the other side of a cross-node `callFunc` call —
 * SceneGraph field/argument marshaling does not carry raw Function values across a node boundary.
 * See `findings/task-manager-onresult.md` for the live-discovered failure and the fix. `onRequestSent`/
 * `onResponseReceived` (global HTTP request/response interceptors, for reporting/telemetry) were
 * designed around this same constraint from the start — see GRAMMAR.md's "Task manager" section and
 * `findings/task-manager-request-interceptors.md` for why the ORIGINAL plan for these two (also a manager-side `callFunc`
 * registration) was abandoned before it was ever implemented, in favor of the exact
 * `onAlertChanged`-shaped "manager flips a shared field, each subscriber attaches its own
 * ObserveFieldScoped and stores its own callback locally" pattern instead.
 */
export const TASK_MANAGER_ACTION_METHODS = [
  'run',
  'cancel',
  'setMaxConcurrent',
  'setAlertThresholds',
  'onAlertChanged',
  'onResult',
  'onRequestSent',
  'onResponseReceived',
] as const;
export type TaskManagerActionMethod = (typeof TASK_MANAGER_ACTION_METHODS)[number];
const TASK_MANAGER_ACTION_METHOD_SET: ReadonlySet<string> = new Set(TASK_MANAGER_ACTION_METHODS);

/**
 * `onAlertChanged`/`onResult`/`onRequestSent`/`onResponseReceived` never reach
 * `TASK_MANAGER_RUNTIME_METHOD_NAMES`/`buildTaskManagerActionReplacement` at all — each expands
 * into its own special codegen shape (see `TASK_MANAGER_ACTION_METHODS`'s own doc comment), so all
 * four are excluded from this narrower type rather than given a (misleading, unused) map entry.
 */
export type TaskManagerCallFuncMethod = Exclude<TaskManagerActionMethod, 'onAlertChanged' | 'onResult' | 'onRequestSent' | 'onResponseReceived'>;

/**
 * Maps a DSL-facing task-manager action name to the actual runtime `callFunc` target name —
 * identical for every action except `run`, whose obvious runtime name collides with BrightScript's
 * own reserved `Run` statement keyword (running another compiled file at runtime) — confirmed via
 * `parseBrightScript`: a function literally named `run` fails to parse. The DSL keeps its own
 * natural `taskManager.run(node)` spelling; only the generated `callFunc("...")` string and the
 * runtime `.brs`'s own function name (`runTask`, see `runtime-assets/TaskManager`) differ.
 */
export const TASK_MANAGER_RUNTIME_METHOD_NAMES: Record<TaskManagerCallFuncMethod, string> = {
  run: 'runTask',
  cancel: 'cancel',
  setMaxConcurrent: 'setMaxConcurrent',
  setAlertThresholds: 'setAlertThresholds',
};

/** The task manager's own known data-read members, reached as a bare `taskManager.<member>` (never a call) — unlike `router.path`/`router.params.x`, this surface is small and fixed, so anything outside this list is `invalid` rather than passed through unchecked. */
export const TASK_MANAGER_DATA_READS = ['runningCount', 'queuedCount', 'alertLevel'] as const;
export type TaskManagerDataMember = (typeof TASK_MANAGER_DATA_READS)[number];
const TASK_MANAGER_DATA_READ_SET: ReadonlySet<string> = new Set(TASK_MANAGER_DATA_READS);

/**
 * Resolves a `theme.`/`router.`/`taskManager.`-rooted path (from `findGlobalPathAccesses`) —
 * `root` picks which of the three this call is for (the same access shape serves all of them; the
 * caller already knows `access.root`). `store` never goes through this at all: `store(<path>)` is a
 * fixed, three-production grammar form (`read`/`watch`/a write statement) handled directly by
 * `identifier-rewrite.ts`, not a generic dot-chain scanned out of arbitrary expression text.
 */
export function resolveGlobalPath(root: string, segments: readonly string[], isCallTarget: boolean, ctx: GlobalBindingsContext): GlobalPathResolution {
  if (root === 'router') return resolveRouterPath(segments, isCallTarget);
  if (root === 'taskManager') return resolveTaskManagerPath(segments, isCallTarget);
  if (root === 'env') return resolveEnvPath(segments, ctx.envVariableNames);
  return resolveThemePath(segments, ctx.theme);
}

/**
 * Classifies an `env.`-rooted access: `env` is closed and validated at compile time (unlike
 * `store`/`router`'s schemaless reads), because — unlike a store key or a route's `params` shape — an
 * environment's whole variable set is known up front, from that environment's own config file. A bare
 * `env` with no active environment (`ctx.envVariableNames === undefined`) is its own distinct
 * diagnostic from "declared some other environment's variable" — see `GlobalBindingsContext.envVariableNames`'s
 * own doc comment. Env variables are flat (no nesting, no groups), so anything but exactly one
 * segment is invalid; call-target rejection (`env.apiKey(...)`) happens in `identifier-rewrite.ts`,
 * same as the theme-leaf precedent, since a resolved `env-data` value is a plain string, never callable.
 */
function resolveEnvPath(segments: readonly string[], envVariableNames: ReadonlySet<string> | undefined): GlobalPathResolution {
  if (envVariableNames === undefined) {
    return {
      kind: 'invalid',
      code: 'expression/env-requires-active-environment',
      reason: `"env.${segments.join('.')}" was referenced, but no environment is active — pass "--env <name>" (or set FLASH_THEATER_ENV) to select one, see GRAMMAR.md's "Environments" section.`,
    };
  }
  if (segments.length !== 1) {
    return { kind: 'invalid', code: 'expression/unknown-env-member', reason: `"env.${segments.join('.')}" — env variables are flat; expected exactly one segment (e.g. "env.apiKey").` };
  }
  if (!envVariableNames.has(segments[0])) {
    return { kind: 'invalid', code: 'expression/unknown-env-variable', reason: `"env.${segments[0]}" is not declared in the active environment's "variables".` };
  }
  return { kind: 'env-data', name: segments[0] };
}

/**
 * Classifies a `taskManager.`-rooted access: a call whose sole segment names a known action method
 * (`taskManager.run(...)`, `taskManager.cancel(...)`, `taskManager.setMaxConcurrent(...)`,
 * `taskManager.setAlertThresholds(...)`, `taskManager.onAlertChanged(...)`,
 * `taskManager.onResult(...)`, `taskManager.onRequestSent(...)`,
 * `taskManager.onResponseReceived(...)`) resolves as `task-manager-action`; a non-call access whose
 * sole segment names a known data member (`taskManager.runningCount`, `taskManager.queuedCount`,
 * `taskManager.alertLevel`) resolves as `task-manager-data`. Everything else — a bare `taskManager`
 * with no segments, an unknown member/action name, or more than one segment either way — is
 * `invalid`. Unlike `resolveRouterPath`, there is no schemaless fallthrough here: the task manager's
 * whole data surface is these three fixed members. `onAlertChanged`/`onResult`/`onRequestSent`/
 * `onResponseReceived` all still resolve to the plain `task-manager-action` kind here — each one's
 * special (non-`callFunc`) codegen is decided later, in `identifier-rewrite.ts`.
 */
function resolveTaskManagerPath(segments: readonly string[], isCallTarget: boolean): GlobalPathResolution {
  if (segments.length === 0) {
    return { kind: 'invalid', code: 'expression/unknown-task-manager-member', reason: 'A bare "taskManager" reference has no member to resolve.' };
  }

  if (isCallTarget) {
    if (segments.length !== 1 || !TASK_MANAGER_ACTION_METHOD_SET.has(segments[0])) {
      return {
        kind: 'invalid',
        code: 'expression/unknown-task-manager-action',
        reason: `"taskManager.${segments.join('.')}(...)" is not a valid task-manager action — expected one of ${TASK_MANAGER_ACTION_METHODS.join('/')}.`,
      };
    }
    return { kind: 'task-manager-action', method: segments[0] as TaskManagerActionMethod };
  }

  if (segments.length !== 1 || !TASK_MANAGER_DATA_READ_SET.has(segments[0])) {
    return {
      kind: 'invalid',
      code: 'expression/unknown-task-manager-member',
      reason: `"taskManager.${segments.join('.')}" is not a valid task-manager data member — expected one of ${TASK_MANAGER_DATA_READS.join('/')}.`,
    };
  }
  return { kind: 'task-manager-data', member: segments[0] as TaskManagerDataMember };
}

/**
 * Classifies a `router.`-rooted access: a call whose sole segment names a
 * known action method (`router.navigate(...)`, `router.back()`, ...)
 * resolves as `router-action`; anything else that isn't a call is a
 * schemaless data read off the current route (`router.path`,
 * `router.params.x`, arbitrarily deep — same "unchecked past segment 1"
 * philosophy `store(<path>)` already uses, since there's no way to know a
 * route's `params` shape at compile time). A call whose segment ISN'T a
 * known action (`router.foo(...)`), or that names more than one segment
 * (`router.params.foo(...)` — params is data, not an action namespace), is
 * invalid. Argument-count/shape validation for a resolved action happens
 * later, in `identifier-rewrite.ts` (it needs the call's actual argument
 * spans, which this function's `segments`-only input doesn't carry).
 */
function resolveRouterPath(segments: readonly string[], isCallTarget: boolean): GlobalPathResolution {
  if (segments.length === 0) {
    return { kind: 'invalid', code: 'expression/unknown-router-member', reason: 'A bare "router" reference has no member to resolve.' };
  }

  if (isCallTarget) {
    if (segments.length !== 1 || !ROUTER_ACTION_METHOD_SET.has(segments[0])) {
      return {
        kind: 'invalid',
        code: 'expression/unknown-router-action',
        reason: `"router.${segments.join('.')}(...)" is not a valid router action — expected one of ${ROUTER_ACTION_METHODS.join('/')}.`,
      };
    }
    return { kind: 'router-action', method: segments[0] as RouterActionMethod };
  }

  return { kind: 'router-data' };
}

function resolveThemePath(segments: readonly string[], theme: ThemeShape | null): GlobalPathResolution {
  if (!theme) return { kind: 'invalid', code: 'expression/unknown-theme-member', reason: 'No <theme-template> exists in this app, but "theme" was referenced.' };
  if (segments.length === 0) return { kind: 'invalid', code: 'expression/unknown-theme-member', reason: 'A bare "theme" reference has no member to resolve.' };

  const topLevelGroup = segments[0];
  let node: ThemeShapeNode | undefined = theme.topLevelGroups.get(topLevelGroup);
  if (!node) return { kind: 'invalid', code: 'expression/unknown-theme-member', reason: `"theme.${segments.join('.')}" — "${topLevelGroup}" is not a declared theme member.` };

  for (let i = 1; i < segments.length; i++) {
    if (node!.kind === 'leaf') {
      return {
        kind: 'invalid',
        code: 'expression/theme-path-through-leaf',
        reason: `"theme.${segments.join('.')}" indexes through "${segments.slice(0, i).join('.')}", which is a leaf value, not a group.`,
      };
    }
    const next: ThemeShapeNode | undefined = node!.children.get(segments[i]);
    if (!next) return { kind: 'invalid', code: 'expression/unknown-theme-member', reason: `"theme.${segments.join('.')}" — "${segments[i]}" is not a declared member of "${segments.slice(0, i).join('.')}".` };
    node = next;
  }

  if (node!.kind === 'leaf') return { kind: 'theme-leaf', type: node!.type, topLevelGroup };
  return { kind: 'theme-group', topLevelGroup };
}
