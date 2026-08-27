# Router `setup()` lifecycle gotcha pair

Two sides of the same rule about when `public function setup()` is (and isn't) auto-invoked by the
router/outlet machinery. See [router.md](router.md) for the namespace/codegen-mechanics core and
[router-outlet-runtime.md](router-outlet-runtime.md) for outlet runtime behavior generally.

## `setup()` is NOT auto-called for a plain, non-router-mounted child component — and the failure mode can be a real render-thread hang, not just a silent no-op

The "every router-mounted component gets an automatic `setup()` hook" convention below (and
`MainScene`'s own hand-called `scene.callFunc("setup")` from `Main.brs`) covers exactly two cases:
a router-mounted screen, and the root Scene. **A plain child component instantiated directly in a
parent's own template — `<MyWidget id="foo" />`, or one constructed inside a `{#if:destroy}`
block — gets NEITHER.** Nothing calls `setup()` for it at all; declaring `public function setup()`
on such a component silently does nothing, exactly like any other never-invoked function.

**Live-confirmed 2026-08-14** (`apps/async-demo`, Roku Ultra) that "silently does nothing" is the
BEST case, not the only one. `PriorityQueueDemo.thr` (a plain child component in a router-less
app's `MainScene`, constructed inside a `{#if:destroy}` block) declared `public function setup()`
to initialize `m.taskIds = []` and start a polling `Timer` — copying the convention from
sample-app's `TaskDemoScreen.thr` without checking that `TaskDemoScreen` is *router-mounted*
(reached via `router.navigate("/browse/tasks")`), which is exactly why its own identical-looking
`setup()` DOES fire automatically there. In `PriorityQueueDemo`, `setup()` never ran, so
`m.taskIds` stayed `invalid` — and the first `m.taskIds.Push(id)`, reached from an `on:key[OK]`
handler via a nested private-function call, threw mid-`onKeyEvent`. That uncaught exception, on the
render thread, in the middle of SceneGraph's own event dispatch, left the render thread in a state
where every ECP endpoint that needs to walk the live node tree (`query/app-ui`, `query/sgnodes`)
hung indefinitely afterward — while endpoints that don't touch the tree (`query/active-app`,
`query/app-state`) kept responding normally, `checkDeviceAlive` reported the device fine, and the
app still showed as `state: active`. This split (tree-walking ECP queries dead, everything else
alive) is what made the actual bug bisectable at all — a full device hang or app crash would have
looked completely different, and the several-minutes-long bisection (removing one line/call at a
time, rebuilding, resideloading, retesting) that found this is worth remembering as the diagnostic
playbook for this exact symptom shape.

**Fix, and the general lesson**: don't reach for `setup()` on a plain child component at all — it
reads like it should work (same DSL syntax, same "one-time construction hook" mental model as the
router-mounted/Scene-rooted case) but silently doesn't, and if the body touches an `m.`-scoped value
from a NESTED function call reached later (a button press, not `init()` itself), the failure isn't
even "nothing happens," it's a real crash with a genuinely confusing symptom. Two real fixes,
usually both wanted together: (1) move anything that can become a **declarative default** — `state
taskIds: array = []` instead of `m.taskIds = []` — since `state`'s own default IS applied by the
generated `init()`, which runs for every component unconditionally, regardless of how it's mounted;
(2) for anything that's genuinely **imperative, one-time setup** (a `Timer`, an
`ObserveFieldScoped` registration) that can't become a declarative default, give it a differently-
named `public function` (e.g. `startDemo()`, not `setup()` — the misleading name is exactly what
caused the copy-paste mistake here) and have the PARENT call it explicitly via `callFunc(...)`
right after constructing the child (`callFunc` on an undeclared interface function is already
confirmed to fail silently, not crash, so per-child branching on whether a sibling actually
declares the function is a clarity choice, not a safety requirement) — **or**, simpler still where
it applies, make the child itself router-mounted instead of a plain `{#if:destroy}`-toggled one, so
the router's own automatic `setup()` call reaches it directly and no parent-side forwarding is
needed at all. `PriorityQueueDemo.thr` itself took this second path once `apps/async-demo` was
split into router-mounted chapter apps (see `findings/demo-app-conventions.md`) — it's now
`apps/task-manager-demo`'s `RunCancelDemo.thr`, a real `public function setup()` that the router
calls automatically, no `startDemo()`/parent-forwarding needed. `apps/timers-demo`'s own
`findings/timers-demo-app.md` documents the same `startDemo()`→`setup()` conversion applied across
several other migrated screens, including which nested (non-route-mounted) children still need the
first, parent-forwarding fix instead.

## Every router-mounted component gets an automatic `setup()` hook

A router-mounted screen has no equivalent to `MainScene`'s own hand-called `scene.callFunc("setup")`
— nothing else external ever calls it, since the outlet creates it anonymously. The outlet calls
`m.currentChild.callFunc("setup")` unconditionally, right after `AppendChild`, for every route it
mounts — safe even when the mounted component declares no `setup` at all (`callFunc` on an
undeclared interface function fails silently). `apps/sample-app/src/components/ScheduleScreen.thr`'s own
`setup()` calling `ScheduleList`'s `load()` is the real, worked example.

**This hand-written `Main.brs` line is easy to drop by omission, with a symptom that looks
component-specific but isn't.** Confirmed live 2026-08-25: `apps/focus-demo/src/source/Main.brs`
was missing `scene.callFunc("setup")` entirely (every other app's `Main.brs` has it —
`grep -n 'callFunc("setup")' apps/*/src/source/Main.brs` across all 14 apps found only this one
gap). Effect: `MainScene.thr`'s own `setup()` (which calls `router.setRouting(...)` and the initial
`router.navigate(...)`) never ran, so the router had zero routes and mounted nothing — every
chapter, not just one. This was found while device-verifying an unrelated, single-component
`load()`→`setup()` naming bug (see [focus-demo-app.md](focus-demo-app.md)'s own "Device-verified
fix" section) — renaming that one component's function made no visible difference, which is what
exposed the real, app-wide cause. Both bugs produce the same visible symptom ("router-mounted
content never appears"); `query/sgnodes --scope all` is what tells them apart — a single mis-named
component leaves the OUTLET populated but that one route's `{#if:destroy}` content empty, while a
missing `Main.brs` hookup leaves the outlet itself with zero children on every route.

## Third variant: a hand-written component's own `setup()` never runs because its `.xml` never declares it as a callable interface function

**Confirmed live 2026-08-25** (`apps/focus-demo`'s `CrossSiblingRelayDemo`). A `.thr`-compiled
component always gets its own `<interface><function name="setup" /></interface>` generated
automatically from its `public function setup()` declaration — but a HAND-WRITTEN component (no
compiler involved) has no such thing unless the author writes it into the `.xml` by hand.
`CrossSiblingRelayDemo.xml` declared a `sub setup()` in its own `.brs` but never added the matching
`<interface>` entry — so `FlashTheaterRouterOutlet`'s unconditional
`m.currentChild.callFunc("setup")` silently no-op'd every time this chapter mounted (same
"`callFunc` on an undeclared interface function fails silently" rule as above, just triggered by a
missing XML declaration instead of a missing DSL/`Main.brs` call). Symptom: nothing was ever
focused on entry, and — since this file's own `setup()` also forwarded into a child's own grid
population — that child's content never rendered either. A screenshot (not just `query/sgnodes`)
is what surfaced it: the JSON tree looked structurally fine (nodes existed) but `focused="true"`
appeared nowhere in the whole scene.

**Fix**: add the interface function declaration by hand:
```xml
<component name="CrossSiblingRelayDemo" extends="Group">
  <interface>
    <function name="setup" />
  </interface>
  ...
```
**General lesson**: whenever a hand-written (non-`.thr`) component declares `sub setup()` (or any
other function the framework/router calls via `callFunc`), grep its own `.xml` for a matching
`<interface><function name="...">` entry — the compiler can't catch a missing one for you here,
and the failure is completely silent at every layer (compile, `callFunc`, and the SG node tree
itself all look fine).
