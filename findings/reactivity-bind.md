# Reactivity — `bind:` (child → state one-directional binding)

Compile-time module responsibilities and design rationale for the `bind:` feature. See
`packages/compiler/GRAMMAR.md`'s `bind:` section for the grammar/semantics themselves — this file
is the *why*. See [reactivity-state.md](reactivity-state.md) for the `state`/`store`/`theme` design
this builds on (`bind:` targets are always a `state`), and
[template-blocks.md](template-blocks.md) for `{#if}`/`{#if:destroy}` reconciliation generally.

## `bind:` two-way binding is actually one-directional — reversed from an earlier draft, and why

`bind:<childField>={<stateName>}` reads a value *out of* a child SceneGraph node (built-in or a
user `.thr` component's own declared `field`) into a `state` whenever the child's field changes —
`analysis/bind-targets.ts` (validation), `codegen/naming.ts`'s `bindChangeHandlerName`, and the
`emitBindChangeHandler`/destroy-block wiring in `codegen/brs-emitter.ts`/
`codegen/conditional-block-emitter.ts`. Despite the "two-way binding" name carried over from
`docs/features.md`'s original roadmap entry, the shipped design is **one-directional only: child →
state.** `bind:` never pushes a value into the child.

**This was a real design reversal, not the original plan.** An earlier draft tried to fuse both
directions into one mechanism: `bind:` would both push a `state`'s value into the child field *and*
observe the child for changes, with a same-value equality guard in the generated reverse handler
specifically to stop the forward push from re-triggering its own observer in a synchronous loop
(`ObserveFieldScoped`'s same-thread, presumably-synchronous delivery makes this a real risk, not a
hypothetical one — see the `store`/`theme` observer pattern this reuses). That design was reversed
after user feedback made two things clear: (1) `state` is genuinely private/internal to one
component (per `reactivity-state.md`'s design fork), so fusing "the child's value" and "what gets
pushed back into the child" into one bidirectional slot doesn't compose the way a real two-way form
control needs to when a *child component's own field* (not just a built-in node's `value`) is the
target; (2) the simpler, more general mechanism reduces to *only ever pulling* — pushing a value
into a child field, when wanted at all, is already just an ordinary `attr="{expr}"` dynamic-attribute
binding on a separate XML attribute, fully decoupled and already fully general (nested field
access, arbitrary computation) via composition with an ordinary downstream `derived`. Once
`bind:` stopped pushing anything, the equality guard that motivated the fused design became
unnecessary — there's no compiler-introduced feedback loop left to guard against, so
`emitBindChangeHandler`'s generated handler is a plain, unguarded `m.<state> = event.GetData()` +
the existing cascade, deliberately matching this codebase's "don't add defensive code for a
scenario that can't happen" style once the scenario genuinely can't happen.

**`{#if:destroy}` support needs individually-guarded `UnobserveField` calls, not the same
unconditional nulling `nestedIds` already uses.** `codegen/conditional-block-emitter.ts`'s
`emitSubtreeConstruction` registers a bind target's `ObserveFieldScoped` inline, right where the
node itself is created — this needed no new parameters or threading, since a `bind` attribute is
already sitting right there on `node.attributes` at construction time, exactly like a `static`/
`dynamic` attribute is. Teardown is the subtler half: `emitConditionalDestroySub`'s existing
`block.nestedIds.map((id) => \`m.<id> = invalid\`)` loop is a plain assignment, safe to run
unconditionally even on an already-nulled id. A `.UnobserveField(...)` call is a **method** call —
calling one on `invalid` crashes. This matters because a torn-down subtree can contain a *nested*
destroy-mode block that already independently tore itself down earlier (still nested inside, but
its own id already `invalid`) — `removeChild` on the outer wrapper takes the whole surviving
subtree with it regardless, so the outer teardown's own `collectNestedBindAttributes` walk (which,
like `collectNestedIds`, recurses into nested `{#if}`/`{#if:destroy}` blocks but never into an
`{#each}` body) still finds that inner bind target and must still attempt to unobserve it — hence
every generated `UnobserveField` line is individually wrapped in its own
`if <ref> <> invalid then ... end if`, unlike every other line in the same teardown sub.

**`{#each}` is rejected, not silently dropped — this needed fixing `bind-targets.ts`'s own
collection walk, not just its validation.** The obvious way to write `collectBindTargets` — mirror
`template-bindings.ts`'s `collectBindings`, which deliberately returns early on an `each` node
without recursing into its body — turns out wrong for this feature specifically: it would make a
misplaced `bind:` attribute inside an `{#each}` body silently invisible to `checkBindTargets`'s
`nearestEachAncestorById` check entirely (never collected, so never validated, so never rejected —
caught by this feature's own golden/unit test, not by inspection). `collectBindTargets` recurses
into *everything*, `{#each}` bodies included, specifically so a bind target living somewhere it
can never work correctly gets an explicit `template/bind-inside-each` diagnostic instead of just
quietly doing nothing.

**Handler-naming collision, caught before it shipped, not after:** the natural first guess for the
reverse handler's name — `on_<elementId>_<fieldName>Change` — collides with
`externalFieldChangeHandlerName`'s `on_<root>_<fieldName>Change` (used for `store`/`theme`
`ObserveFieldScoped` registrations) whenever an element's own `id` happens to be exactly `"store"`
or `"theme"`, a plausible enough author choice (e.g. a settings panel literally named `id="theme"`)
that it wasn't safe to leave as a latent trap. `bindChangeHandlerName` uses
`on_bind_<elementId>_<fieldName>Change` instead — the `bind_` segment makes it structurally
impossible to collide with either existing generated-name scheme.

**Confirmed live on a real device (2026-08-04, Roku Ultra, via scripted ECP keypress + live
`/query/app-ui` inspection, not just visual spot-checking — see the focus-loss finding below for
why a screenshot-based check gave a false negative first)**: `UnobserveField("text")` on the
generated destroy sub works exactly as generated, and — the one genuinely new fact this feature
needed — re-`ObserveFieldScoped`-registering a field on a freshly-`CreateObject`'d node (the
construct → destroy → reconstruct cycle `apps/sample-app/src/components/ScheduleList/ScheduleList.thr`'s
`searchBox`/`unload()`/"back" key exercises) behaves cleanly: typing into the search box propagated
correctly to `searchEcho` both *before* the first teardown and *after* a full unmount/remount
cycle, with no stale-observer double-firing and no crash either time. Both are exactly the kind of
"confirmed live" facts this file's other findings (`AddFields`/`SetField` semantics, `findNode`
subtree-scoping, `InsertChild`'s reposition behavior) were only ever settled by sideloading onto a
physical Roku, not by compiling cleanly.
