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

## `{#if:destroy}`'s generated teardown can't see into a nested custom component's own focusable content — the UNREGISTER half is now automatic; RECLAIM still needs a manual call

**Originally live-verified via `apps/animation-demo`'s own since-superseded flat-screen switching
(see the note at the top of this file) — currently demonstrated by `apps/focus-demo`'s
`DestroyNestedGapDemo.thr`**, a standalone chapter built specifically to keep this gap and its
fix live and demoed after the app-wide chapter/router conversion, instead of only living in
historical prose. `emitConditionalDestroySub`'s own unregister-before-removeChild logic (see
[focus-runtime-registry.md](focus-runtime-registry.md)) only ever walked the DESTROYED BLOCK'S OWN
template for focusable descendants — correctly, by construction, since a plain `<Rectangle
focusable="true">` living directly inside the block IS visible to that analysis. But a block whose
content is instead a nested custom component (`<BounceButtonDemo id="demo0" />`) is OPAQUE from the
enclosing component's own template analysis — BounceButtonDemo's own `card` is defined in a
completely separate `.thr` file, invisible to MainScene's compiler pass. The generated destroy sub
used to correctly emit no unregister call at all for such a block (there was nothing IT could see to
unregister) — not a bug in that codegen, it was operating on correct information; the fix (below)
sidesteps needing that information at all.

The consequence, confirmed live via `apps/animation-demo` (historical) and reproduced again live
while verifying the fix below (`issues/task-manager-no-auto-cancel-on-teardown.md`'s own
live-verification session, incidentally, against `apps/task-manager-demo`'s `LongTaskWidget`):
destroying such a block while ITS own nested focusable content currently holds focus left a DANGLING
registry entry (the node gone, `removeChild`'d, but never `unregister()`'d) and — combined with the
previous section's own gap — a fresh vacuum for whatever mounts next, since nothing calls
`claimFocusIfVacant` for the new content either.

**Fixed, in the generated destroy sub itself, for the UNREGISTER half** — `emitConditionalDestroySub`
(`codegen/conditional-block-emitter.ts`) now also emits an unconditional
`m.global.ft_focus.callFunc("unregisterSubtree", <blockRef>, m.top)` before `removeChild` (and
`emitFocusPrepareLines` does the same at cascade time for a transitioning block) — see
`codegen/shared-emit.ts`'s `focusUnregisterSubtreeCall` for why this closes the gap without needing
any new compile-time visibility: `unregisterSubtree` walks the focus manager's own FLAT REGISTRY,
checking each entry's OWNER against `blockRef` via live `GetParent()` ancestry, not the compile-time
template tree — a nested custom component's own focusable content, registered under THAT
component's own `m.top` from inside its own generated `init()`, genuinely IS a descendant of
`blockRef` in the real SceneGraph tree, even though it's invisible to the enclosing component's own
template scan. Unconditional for the same "no cross-component template-tag registry, so this can't
be known at compile time" reason `ft_unmount`'s own cascade is unconditional (see
`findings/component-unmount-hook.md`). `recoverFocusFor(m.top)` at the end of the destroy sub is now
ALSO unconditional (previously gated on the compile-time scan finding at least one PLAIN focusable
id) for the identical reason — it needs to fire even when the only focusable content in the block was
an opaque nested component the scan couldn't see. **Scope note**: this does NOT close the DIFFERENT,
still-open "a `focusable` element inside an `{#each}` nested inside a `{#if:destroy}`, in the SAME
component" limitation GRAMMAR.md's Focus-system "Known limitations" documents — that element's own
`owner` is this component's `m.top` (an ANCESTOR of `blockRef`, not a descendant), so
`isDescendantOrSelf` never matches it; a genuinely different scenario from a nested CUSTOM
COMPONENT's own content.

**The RECOVER half needed a second, non-obvious fix, found only by live-testing the first attempt**
— unregistering the entry is not enough on its own. `unregisterSubtree`'s own `noteFocusLoss` call
records `m.focusLostFromOwner` as the EXACT registrant owner it just removed — for a nested custom
component's own focusable content, that's the NESTED component's own `m.top`, not the enclosing
component's. `recoverFocusFor(owner)`'s own match is `IsSameNode(m.focusLostFromOwner, owner)` — a
trivial reference compare, never a tree walk — so calling `recoverFocusFor(m.top)` (the ENCLOSING
component's own top) afterward silently no-ops: `m.focusLostFromOwner` (the nested owner) never
equals `m.top` (the enclosing one). **Live-confirmed as a real, distinct failure mode**: the first
fix attempt correctly removed the stale registry entry (confirmed via `queryAppUi` — the destroyed
node was gone, no crash) but left focus genuinely vacant afterward, the EXACT same visible symptom
as the original bug, for a different underlying reason. The natural-looking alternative — generalize
`recoverFocusFor`'s own match from `IsSameNode` to `isDescendantOrSelf(m.focusLostFromOwner, owner)`
— fails too, and for a subtle reason worth remembering: `recoverFocusFor` is deliberately called
AFTER `removeChild` (see its own doc comment — recovering too early risks targeting something a
LATER step in the same cascade is also about to remove), but by then `removeChild` has already cut
the exact tree link (`blockRef`'s own link to ITS former parent) that a walk from the nested owner
up to `m.top` would need to cross — the walk fails partway, right at that cut edge, every time.
**Actual fix**: `unregisterSubtree` now takes a second `recoveryOwner` parameter and, when it detects
the currently-focused entry among the ones it's removing, rewrites `m.focusLostFromOwner` to
`recoveryOwner` itself (guarded by `isDescendantOrSelf(root, recoveryOwner)`, always true for this
call site by construction) — done WHILE the subtree is still fully attached (before `removeChild`),
so the ancestry walk this rewrite needs is guaranteed to succeed, and `recoverFocusFor`'s own later
match stays a trivial, walk-free `IsSameNode()` compare exactly as before. The one existing caller
(`FlashTheaterRouterOutlet.brs`'s own whole-screen teardown) passes `invalid` explicitly — it
resolves its own post-mount focus separately and never calls `recoverFocusFor` afterward, so this
rewrite doesn't apply there. **Live-confirmed working, same device/app/chapter as the reproduction**:
after the `recoveryOwner` fix, destroying the same nested-component-holding-focus widget correctly
landed focus on `RunCancelDemo`'s own `burstButton` (`firstRegistrantOfOwner(m.top)`), with
`runningReadout` also reflecting the change — see
`issues/focus-destroy-nested-component-orphaned-registration.md`'s own "Live-confirmed AFTER the
fix" section for the full readout, and
`packages/compiler/test/runtime-assets.test.ts`'s "unregisterSubtree rewrites focusLostFromOwner to
recoveryOwner" `describe` block plus
`packages/compiler/test/codegen/conditional-block-emitter.test.ts`'s "unregisterSubtree closes the
opaque-nested-component gap" `describe` block for the compile-time contracts this pins down.

**The RECLAIM half is still a manual call** — applying automatically into `{#if:destroy}`'s own
create path was deliberately rejected (see the previous section: it would reintroduce the
`recoverFocusFor` ordering bug). Call `m.global.ft_focus.callFunc("claimFocusIfVacant", <incoming
child instance>)` after the state write that mounts the new content (the create sub has by then
already run and registered it). See `apps/focus-demo/src/components/
DestroyNestedGapDemo/DestroyNestedGapDemo.thr`'s `toggleNested` for the current worked example —
its own manual `unregisterSubtree(m.nestedGroup)` call, previously required before the state write,
is gone now that the generated destroy sub does it automatically; only the `claimFocusIfVacant`
call remains.

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
