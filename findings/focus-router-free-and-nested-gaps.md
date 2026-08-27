# Focus system — router-free apps and nested-component gaps

Three related gaps in `FlashTheaterFocusManager`'s coverage: a router-free Scene's own default
focus needing an explicit claim, `{#if:destroy}`'s generated teardown being blind to a nested
custom component's own focusable content, and `navigate()`'s cross-owner fallback matching hidden
toggle-mode content. See [focus-system.md](focus-system.md) for compile-time module ownership and
confirmed platform facts, and [focus-runtime-registry.md](focus-runtime-registry.md) for the
standing registry design these gaps sit on top of (`register`, `navigate()`, `claimFocusIfVacant`).

**Both original live-verification apps for this file have since been converted to router-based
chapters** (`findings/demo-app-conventions.md` — router-free demo apps are no longer this repo's
convention): `apps/animation-demo`'s `MainScene.thr` no longer has an
`unregisterCurrentDemoFocus`/`claimActiveDemoFocus` pair at all (superseded outright by
`router.navigate()`'s own automatic proposal+claim+unregister), and `apps/focus-demo`'s own
`MainScene.thr` is router-mounted too. The underlying platform facts below remain true and
worth keeping — they'd still bite any genuinely router-free app, and the mechanism they describe
is exactly what `router.navigate()`'s own compiler-emitted `applyPendingFocus()` follow-up now
does automatically for every `.thr`-compiled app — but neither section's original "here's the
live demo reproducing it" citation is current; see each section's own note for the live app that
now demonstrates the still-relevant HALF of each gap (the hand-authored-component case, since a
non-`.thr` routed screen still has no compiler-generated registration/follow-up of its own).

## Router-free apps: default focus needs an explicit claim

**Originally live-verified on a real Roku Ultra**, via `apps/animation-demo`'s own `MainScene.thr`
— at the time, the first-ever Scene-rooted `.thr` component in this repo with focusable content
but no `router`; not reproducible in this repo anymore now that app is router-mounted (see the
note above). `register(node, owner, isDefault=true)` only ever *proposes* a pending default-focus
candidate — nothing applies it into a real vacuum on its own. A `router.navigate()`-mounted `.thr`
screen gets this for free because the compiler always emits an `applyPendingFocus()` follow-up
right after the author's own `navigate()`/`back()` call (see `identifier-rewrite.ts`'s own doc
comment); a router-free app, or a hand-authored (non-`.thr`) routed screen with no such
compiler-generated call, never gets this follow-up, so a `register(..., isDefault=true)` proposal
— if one even exists — just sits there forever. Historical symptom (router-free case): literally
no key did anything from a cold boot — OK's own `IsInFocusChain()` guard silently failed, and
since Roku only delivers key events to whatever currently holds focus, with nothing holding it,
every key event had nowhere to go at all.

**Fix**: a `public function setup()` (hand-written, or `.thr`-declared) calling
`m.global.ft_focus.callFunc("claimFocusIfVacant", <owner>)`. **The owner argument must be
the EXACT node passed as `register()`'s own `owner` parameter** — `firstRegistrantOfOwner` matches
by `IsSameNode`, not by ownership/ancestry, so passing the enclosing component's own `m.top` (when
the actual focusable content lives inside a nested custom component) matches nothing and silently
no-ops — no error, just nothing happens. The correct owner is the mounted CHILD component instance
itself (the exact node that component's own `init()` passed to `register()`). **Currently
demonstrated by** `apps/focus-demo`'s `CrossSiblingRelayDemo.brs` — the one remaining
hand-authored, non-`.thr` component in this repo, now used as a router route's own `component:`
rather than as a root Scene; its `setup()` (called unconditionally by
`FlashTheaterRouterOutlet`, the same as any `.thr`-compiled router-mounted screen) calls
`claimFocusIfVacant(m.simpleItem)` — `m.simpleItem` being the exact owner node its own
`SimpleFocusItem` child's compiled `init()` registered. **Not independently live-device-confirmed
for this specific call site** (a hand-written component's own router-invoked `setup()`, rather
than the original router-free-Scene-at-boot case) — see
[findings/focus-demo-app.md](focus-demo-app.md).

This gap **recurs on every subsequent mount**, not just at boot, for the same underlying reason —
worth generalizing beyond the one-time `setup()` case: any `{#if:destroy}`/`{#each}`-driven mount of
a nested custom component with its own default-focus content needs the SAME explicit
`claimFocusIfVacant(<newly mounted instance>)` call, every time, in a router-free app (or from a
hand-authored routed screen's own internal `{#if:destroy}`-equivalent logic). `{#if:destroy}`'s
own generated teardown compounds this from the other side — see the next section.

## `{#if:destroy}`'s generated teardown can't see into a nested custom component's own focusable content

**Originally live-verified via `apps/animation-demo`'s own since-superseded flat-screen switching
(see the note at the top of this file) — currently demonstrated by `apps/focus-demo`'s
`DestroyNestedGapDemo.thr`**, a standalone chapter built specifically to keep this gap and its
fix live and demoed after the app-wide chapter/router conversion, instead of only living in
historical prose. `emitConditionalDestroySub`'s own unregister-before-removeChild logic (see
[focus-runtime-registry.md](focus-runtime-registry.md)) only walks the DESTROYED BLOCK'S OWN
template for focusable descendants — correctly, by construction, since a plain `<Rectangle
focusable="true">` living directly inside the block IS visible to that analysis. But a block whose
content is instead a nested custom component (`<BounceButtonDemo id="demo0" />`) is OPAQUE from the
enclosing component's own template analysis — BounceButtonDemo's own `card` is defined in a
completely separate `.thr` file, invisible to MainScene's compiler pass. The generated destroy sub
correctly emits no unregister call at all for such a block (there's nothing IT can see to unregister)
— this is not a bug in that codegen, it's operating on correct information.

The consequence, confirmed live via `apps/animation-demo`: destroying such a block while ITS own
nested focusable content currently holds focus leaves a DANGLING registry entry (the node is gone,
`removeChild`'d, but never `unregister()`'d) and — combined with the previous section's own gap — a
fresh vacuum for whatever mounts next, since nothing calls `claimFocusIfVacant` for the new content
either. Symptom: a demo-switch worked exactly ONCE (the boot-time `claimFocusIfVacant` fix still
applied to the very first mount) then went permanently dead — every subsequent switch destroyed the
current focus holder without recovery and never claimed the next one.

**Fix, applied in the switching handler itself (not in generated teardown)**: call
`m.global.ft_focus.callFunc("unregisterSubtree", <outgoing child instance>)` **before** the state
write that triggers the destroy/create cascade — `unregisterSubtree`/`unregister()` both require the
node still attached (`GetParent()`-based traversal), so this MUST run before, never after, the
cascade's own `removeChild`; by the time a cascade-triggered destroy sub has already run, it's too
late to clean up correctly (the node is orphaned, `isDescendantOrSelf` can no longer reach it via
`GetParent()`, and the registry entry survives as an unreachable ghost). Then call
`claimFocusIfVacant(<incoming child instance>)` after the state write (the create sub has by then
already run and registered the new content). See `apps/focus-demo/src/components/
DestroyNestedGapDemo/DestroyNestedGapDemo.thr`'s `toggleNested` for the current worked
implementation (`m.nestedGroup`/`m.toggle`, since `register()`'s owner argument must be the exact
node — the same constraint as the previous section); the pattern is otherwise unchanged from the
original `apps/animation-demo` implementation this section used to cite before that app's own
chapter/router conversion made the workaround unnecessary there (`router.navigate()` now handles
it automatically for every `.thr`-compiled route).

## `navigate()`'s cross-owner fallback can match hidden toggle-mode content

**Live-verified, and since fixed in the shared runtime asset itself — see below.**
`bestCandidate()`'s SAME-owner search (`navigate()`'s first attempt)
correctly scores candidates against the currently-FOCUSED element's own small rect — so a
same-owner sibling that doesn't Y/X-overlap that small rect is correctly excluded. But the
CROSS-owner fallback (tried only when the same-owner search finds nothing,
`bestCandidate(direction, focusedEntry, ownerBoundingRect(...), false)`) scores against the WHOLE
OWNER COMPONENT's own bounding rect instead — and does NOT exclude same-owner entries at all
(`sameOwnerOnly=false` only skips the owner-identity check, it doesn't add one). This means a
same-owner sibling REJECTED by the first search can still be picked up by the second, scored against
a much bigger reference rect.

Concretely: `TogglePresetDemo`'s own `panel` is registered unconditionally at `init()` despite
starting hidden (`visible=false`; toggle-mode content stays registered while hidden — an
already-known, separately-documented limitation, see GRAMMAR.md's "Conditional rendering" section
→ "Known limitations"). `panel` sits
geometrically "to the right of, and Y-overlapping" `TogglePresetDemo`'s own full-screen bounding
rect (even though it does NOT Y-overlap `trigger`'s own small rect, correctly excluding it from the
first search). `navigate("right")` from `trigger` therefore matched `panel` on the CROSS-owner
fallback and consumed the key — permanently blocking it from ever bubbling up to a parent's own
`on:key[right]` handler, even though `panel` was invisible the entire time. `Left` was unaffected
(nothing sits left of `trigger`), confirming this is specifically the cross-owner-fallback path, not
a general breakage.

**Fixed, in the shared runtime asset itself** (`packages/compiler/runtime-assets/FocusManager/
FlashTheaterFocusManager.brs`) — this was originally left as a call-site workaround (see below) on
the reasoning that fixing `bestCandidate` was "a change to a heavily-load-bearing shared function,
out of scope for a documentation/demo-app pass"; revisited and fixed properly once this was
recognized as a real, general bug rather than a demo-app-specific quirk. A new `isGenuinelyVisible(node)`
walks `node` up through every ancestor to the Scene root, checking each one's own `visible` field —
a single-node check on the candidate leaf alone isn't enough, since a toggle-mode block hides
descendants via its own synthetic wrapper `Group`'s `visible`, not the leaf's. `bestCandidate` now
gates on this for EVERY candidate, in both the same-owner and cross-owner passes — not just the
cross-owner one this bug was originally reported on — which also retroactively fixes the
separately-documented "toggle content is a live LRUD candidate while hidden" limitation (see
GRAMMAR.md's "Conditional rendering" section) for the `navigate()` path specifically: hidden content
can no longer win a directional search or silently consume a key press, though it does remain in
the registry (an explicit `focus(<id>)`/`focusComponent()` call can still target it directly — only
`navigate()`'s own candidate search is gated, deliberately, since an author-named explicit target is
a different, intentional act).

`apps/animation-demo` still keeps its own workaround (moved demo-switching off the D-pad entirely,
onto `on:key[rewind]`/`on:key[fastforward]` — a key pair `navigate()` never touches) since it was
already in place and harmless to leave, not because it's still needed for correctness. Also
discovered while diagnosing the original bug, via a temporary `on:key[*]` debug probe: Roku's ECP
key names (`Rev`/`Fwd`) do **not** match their own `onKeyEvent` key strings — the real values are
`"rewind"`/`"fastforward"`.
