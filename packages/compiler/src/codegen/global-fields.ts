/**
 * Single source of truth for every field name hung directly off SceneGraph's
 * `m.global` node by this compiler's generated code. Every one is `ft_`-prefixed —
 * an app's own code writing an ordinary same-named field onto `m.global` (e.g. its
 * own `store` concept) would otherwise silently collide with/overwrite a built-in
 * runtime global. Any future built-in global singleton (a router, an analytics
 * primitive, ...) must go through `GLOBAL_FIELD_NAMES`/`globalFieldRef` too, never a
 * fresh string literal — see findings/compiler-architecture.md.
 */
export const GLOBAL_FIELD_NAMES = {
  store: 'ft_store',
  theme: 'ft_theme',
  focus: 'ft_focus',
  router: 'ft_router',
  taskManager: 'ft_taskManager',
  /** The app's once-computed `scale` factor (actual device display width / configured design-resolution width) — seeded by `emitFlashTheaterGlobalsBrs` at app boot, read by every `ft_scale(...)` call site. See findings/reactivity-state.md's "scale" entry. */
  scaleFactor: 'ft_scaleFactor',
  /** The active environment's declared variables (`--env`/`FLASH_THEATER_ENV`), baked as a flat AA of strings by `emitFlashTheaterGlobalsBrs` at app boot — absent entirely (no field at all) when no environment is active. Read via `env.<name>` in DSL code. See GRAMMAR.md's "Environments" section and findings/environments.md. */
  env: 'ft_env',
} as const;

export type GlobalFieldKey = keyof typeof GLOBAL_FIELD_NAMES;

/**
 * The expression a piece of generated code uses to reach the shared `roAssociativeArray` that
 * every global singleton is hung off. `'m.global'` for ordinary `.thr` component codegen (`m` is
 * the component's own SceneGraph node there). `'ft_globalAA.global'` for `.flsh` class codegen —
 * `m` inside a class method is the class instance's own plain AA, never a node, so `m.global` has
 * no meaning there; `GetGlobalAA()` is confirmed live (real device, both a `.thr` component and a
 * `.flsh` class method — see findings/class-pipeline-global-singleton-access.md) to return one AA shared app-wide
 * that SceneGraph automatically populates with a `"global"` key aliasing the exact same content
 * node `m.global` points at, with zero manual wiring. `ft_globalAA` (not a literal `GetGlobalAA()`
 * call inline) is deliberate, not stylistic — also confirmed live: a bare, return-discarding
 * statement chained directly off `GetGlobalAA()`'s own call result fails to compile on a real
 * device, while the identical chain off a local variable holding that result works — see
 * `codegen/naming.ts`'s `CLASS_GLOBAL_AA_LOCAL_NAME` and `codegen/class-emitter.ts`'s
 * `hoistGlobalAAIfNeeded`, which emits the `ft_globalAA = GetGlobalAA()` hoist this root assumes
 * is already in scope.
 */
export type GlobalAccessRoot = 'm.global' | 'ft_globalAA.global';

export function globalFieldRef(key: GlobalFieldKey, accessRoot: GlobalAccessRoot = 'm.global'): string {
  return `${accessRoot}.${GLOBAL_FIELD_NAMES[key]}`;
}
