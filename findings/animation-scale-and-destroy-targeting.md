# Animation — deferred hide/removal, focus safety, `{#if:destroy}` targeting, and `scaled: true`

Design rationale for `animation {}`'s interaction with `{#if}`/`{#if:destroy}` block transitions
(`codegen/conditional-block-emitter.ts`) — deferred hide/removal safety, focus-system safety, and
`target:` reachability inside a destroy-mode block — plus the `scaled: true` scale-integration
design. See `packages/compiler/GRAMMAR.md`'s "animation" section for the grammar/API itself and its
own "Known limitations" for the user-facing version of the limitations below. For the live-device
narrative and the three real device-found bugs, see [animation.md](animation.md). For config-parsing
and other codegen design notes, see
[animation-config-codegen.md](animation-config-codegen.md).

## Deferred hide/removal needs a stale-completion guard, not just "wait for state=stopped"

If a block's condition flips hide→show before its exit animation has actually finished, the OLD
exit animation keeps running in the background (nothing cancels it just by the condition flipping)
and will eventually fire `state = "stopped"` on its own — which, if the handler blindly trusted
"stopped means hide/destroy now," would incorrectly hide/destroy a block that has since been
re-shown. The fix, in `codegen/conditional-block-emitter.ts`'s `emitExitAnimationStateChangeHandler`:
re-check the block's own condition (`not (<condition>)`) at the moment the handler fires, not just
`event.GetData() = "stopped"` alone. The "show" cascade branch also explicitly cancels a
still-in-flight exit (`m["$$ft_anim_<out>"].control = "stop"`) so a rapid hide→show doesn't leave
two animations visually fighting over the same field — that `stop` call itself also fires a
`state = "stopped"` event, which the condition re-check above correctly ignores (the condition is
already true again by then).

## Focus-safety: unregister/`recoverFocusFor` fire at exit-START, deferred hide/removal do NOT

`FlashTheaterFocusManager`'s `absoluteRect()`/`bestCandidate()` have no `visible` check at all (nor
does anything else in candidate scoring) — confirmed by reading the runtime source, not assumed.
A block mid-exit-animation is, by design, still `visible=true`/still attached for the whole
animation duration — meaning a focusable element inside it would remain a fully live LRUD
candidate, and keep receiving key input if it held focus, for that entire window if nothing
intervened. The fix: for a block with an `out:` animation and focusable content, every focusable
element in the subtree is unregistered (and `recoverFocusFor(m.top)` called once, if any were
actually unregistered) at the MOMENT the exit animation starts — mirroring `{#if:destroy}`'s
pre-existing `unregister`-before-`removeChild` ordering constraint (the node must still be
attached for `IsInFocusChain()`/`BoundingRect()` to be valid) — NOT deferred to match the delayed
`visible=false`/`removeChild`. On re-entry (show), the same focusable elements are re-registered
(`register()` is idempotent, confirmed safe to call again even if a block was never actually
hidden). This fix is scoped ONLY to blocks that declare an `out:` animation — a block with no
transition, or an `in:`-only transition (still-instant hide), keeps today's exact pre-existing
behavior unchanged (including the KNOWN, un-fixed gap that a toggle-mode block's focusable content
stays registered even while hidden — see GRAMMAR.md's "Conditional rendering" → "Known
limitations"; this feature does not fix that gap generally, only for blocks that opt into a
transition).

`{#if:destroy}`'s own pre-existing `emitConditionalDestroySub` already did unregister-before-
removeChild correctly — this feature's only change there is a `skipFocusHandling: true` flag so a
transitioning block's destroy sub doesn't redundantly re-run the same unregister/`recoverFocusFor`
pair a second time (harmless either way, since both are idempotent, but confusing to read).

## `target:` inside a `{#if:destroy}` block is validated for existence, never for reachability

`collectElementIds` (`codegen/template-bindings.ts`) recurses into `{#if}`/`{#if:destroy}`
subtrees, so `animation-config.ts`'s `target: card` validation happily accepts an id that only
exists while that block's condition is true — it only checks the id is real and unique in the
template, never whether the *trigger call site* can only run while the block is mounted. Layer 2
(`transition:`/`in:`/`out:`) never has this problem because its enter/exit animation is generated
as part of the same create/destroy sub as the target itself — timing is correct by construction,
not by validation, and (since the `fieldToInterp`-staleness bug documented in
[animation.md](animation.md) was found and fixed) also correctly RE-BINDS to a fresh target on
every cycle. Layer 1's `.start()`/`.stop()`/etc. has no such coupling: it's an ordinary statement,
callable from anywhere, with zero connection to the template location(s) whose `on:key`/etc.
actually reach it. No static reachability check was implemented — doing this correctly would need
tracing every call path from a `.start()`-containing function back to every `on:key`/handler
attribute that can reach it, then checking each one is either inside the same `{#if:destroy}`
subtree as the target or provably unreachable while it's torn down; the DSL has no existing
call-graph analysis of that shape, and building one just for this diagnostic was judged out of
scope.

⚠️ **This entry originally reasoned (without device confirmation) that calling `.start()` on an
unmounted target would be a harmless silent no-op, and recommended scoping the trigger call inside
the same `{#if:destroy}` subtree as the safe pattern — that reasoning was live-confirmed wrong**:
even a CORRECTLY-scoped trigger call, one that only ever fires while the block is genuinely mounted,
used to break starting on the block's SECOND construction, since `.start()` has no fixed call site
the compiler could hook a targeted reset into the way Layer 2's exactly-two create/hide call sites
allow (see the `fieldToInterp`-caches-its-target-on-first-use bug documented in
[animation.md](animation.md)). **Since fixed**, generalizing Layer 2's own fix rather than
special-casing around it: `compile.ts` now computes, per `animation {}` declaration, the set of its
own effective target ids (`analysis/animation-config.ts`'s `collectEffectiveTargetIds`) that resolve
inside a `{#if:destroy}` block (`conditionalBlocks.nearestDestroyAncestorById`), and any interpolator
whose target is in that set gets the exact same synthesized-id + blank-then-reset `fieldToInterp`
treatment as a Layer 2 transition. The difference from Layer 2 is WHERE the reset gets injected:
since Layer 1's `.start()` has no fixed call site, `identifier-rewrite.ts`'s
`rewriteAnimationControlCalls` (via `ScriptBindings.animationFieldRefreshByName`) injects the reset
at EVERY `.start()` call site for such an animation, unconditionally — safe even when a given call
happens to fire while the target isn't actually mounted (the reset is then just a no-op on an
otherwise-valid interpolator, not a new failure mode). The reset lines themselves are built as plain
unindented text in `analysis/identifier-rewrite.ts` (`collectAnimationFieldRefreshLines`) and hoisted
as properly `${indent}`-prefixed sibling lines by `codegen/brs-emitter.ts`'s
`lowerAnonymousFunctionsInText` — the SAME hoisting mechanism an extracted anon-function literal or
a lowered ternary already uses, and the only place print depth is actually known. **Lesson from a
false start while building this**: an earlier version tried splicing the two extra lines directly
into `rewriteAnimationControlCalls`'s own replacement text (unindented, relying on the caller to
prefix the WHOLE multi-line blob with one `indent`) — this broke unrelated golden tests, because
`printStatement`'s existing fallback only ever indents the FIRST line of a multi-line `rewrittenText`
by design: some OTHER multi-line shapes reaching that same code path (an already fully, correctly
self-indented hoisted anon-function literal; a raw multi-statement blob preserving the *author's
own* original relative indentation) must never be re-indented again. The fix had to move to the one
layer that both knows `depth` AND already has a "list of extra sibling lines" concept —
`hoistedLines` — not try to fake that context inside the text-splicing layer.

**Live-verified on a real Roku Ultra.** `apps/animation-demo`'s `DestroyCustomDemo.thr` (demo 5/6)
now also declares a Layer 1 `animation pulse { target: card, scale: [1, 1.2, 1] }`, triggered via
`pulse.start()` from `trigger`'s own `on:key[replay]` handler — `trigger` persists across every
`showCard` cycle, unlike `card` itself, so this exercises exactly the previously-broken combination
(a Layer 1 trigger call reachable from outside the `{#if:destroy}` block, targeting content inside
it). Driven end to end via `EcpClient` (`Select` to show, `InstantReplay` to pulse, `Select` to hide,
`Select` to show again — a genuine SECOND `CreateObject` under the same `card` id — `InstantReplay`
to pulse again) and confirmed via `queryAppUi` polling the live `scale`/`bounds` attributes through
each pulse: cycle 1 showed `scale` climbing to ~1.17-1.19 then settling back to exactly `1.0`
(`bounds` tracking from `{760,420,443,240}` up to `{760,420,~517,~280}` and back), and — the case
that used to silently do nothing — **cycle 2 showed the measurably identical curve** (scale peaking
at ~1.16, `bounds` following the same shape, settling back to the exact same `{760,420,443,240}`),
confirming the second construction now animates correctly, not just the first.

## `scaled: true` — `scale` reaching into `animation {}` config, added after the gap above was found

Originally, `animation-config.ts` parsed every keyframe value with plain `walkLiteralValue`, the
same as `request-config.ts` — no `scale` keyword, no config-file awareness anywhere in the pipeline.
Discovered while retrofitting `apps/animation-demo` with `scale` (see that app's own
`flash-theater.config.json` + `findings/scale-config-and-codegen.md`): an absolute `translation` keyframe (or the
`fly`/`slide` presets' own `x`/`y` offset) stayed a fixed literal at every `ui_resolutions` tier,
drifting out of sync with everything else on the same screen using `scale field`/`scale derived`.
Fixed by adding a `scaled: true` key to the object form (`ParsedInterpolatorStep.scaled` in
`analysis/animation-config.ts`) that defers `keyValue` to runtime instead of baking it into static
XML — see GRAMMAR.md's "animation" section for the author-facing syntax. `apps/animation-demo`'s
`SequentialDemo.thr` (which first surfaced this gap) now demonstrates the real fix: its
`translation` step is back to the original absolute two-keyframe slide, with `scaled: true` added,
and its end keyframe (`[760, 450]`) is the exact same raw pair `cardTranslation`'s own `scale
derived` declaration uses for the card's static resting position — both resolve through the
identical `ft_scale([760, 450], factor)` call, so they can never drift apart at any resolution.

**Scoped to `translation` and the `field`/`as` escape hatch only** — `opacity`/`rotation`/`scale`
are relative or unitless quantities that `ft_scale` would silently corrupt (multiplying an opacity
of `1` by a `0.667` factor is not "no scaling needed", it's a real bug), so `scaled: true` on any of
those three is a hard compile error (`animation/scaled-not-supported-for-field`), and on `color` (or
the escape hatch's `as: "color"`) it's `animation/scaled-not-supported-for-color` — a packed color
integer scaled by a fractional factor is nonsense, not a no-op.

**`fly`/`slide` presets set `scaled: true` unconditionally, UNLESS the target has its own static
resting `translation`** (see [animation.md](animation.md)'s "flash bug" / fly-slide limitation
entries) — no author opt-in either way, since a preset's own offset is always a pixel quantity by
construction, unlike a custom `animation {}` field whose semantic meaning the compiler can't infer.
`fade`/`scale` presets never set it (opacity/relative multiplier, same reasoning as the shorthand
restriction above).

**Runtime mechanism**: a `scaled: true` interpolator gets its own synthesized `id` — `ft_anim_<name>_
ref_<n>`, NOT `_scaled_<n>` (this entry's own earlier text was stale/wrong on the exact suffix,
confirmed by reading the actual code, not assumed) — assigned by `codegen/animation-emitter.ts`'s
`emitInterpolatorXml` during the same tree walk that prints the XML — never a second, independent
counter that could drift out of sync. This is the SAME id/counter a destroy-mode `fieldToInterp`
refresh (see "target: inside a {#if:destroy} block" above) also uses — `needsId =
interp.scaled || needsFieldRefresh`, one shared id for either or both reasons, since a SceneGraph
node has exactly one `id` field. Every other interpolator stays anonymous, addressed only
positionally as an `Animation` node's child, since giving every interpolator an id it doesn't need
would be needless churn. `emitInitFunction` (`codegen/brs-emitter.ts`) then emits one
`m.top.findNode(id).keyValue = [...]` line per scaled interpolator, each `keyValue` entry wrapped in
`ft_scale(<entry>, m.global.ft_scaleFactor)` individually — never the whole array in one call. This
matters: `FlashTheaterScale.brs`'s own array branch scales one level deep only (see
`findings/scale-config-and-codegen.md`), and a Vector2D field's `keyValue` is a *2-level* nested array (`[[x,y], [x,y],
...]`) — wrapping the whole thing in one `ft_scale(...)` call would treat each `[x,y]` pair as an
opaque non-numeric element and leave it completely unscaled. Wrapping each entry individually keeps
every call exactly one level deep (`ft_scale([x,y], factor)` for Vector2D, `ft_scale(n, factor)` for
Float), matching the runtime helper's own documented contract.

**`compile.ts` calls `emitAnimationXml` exactly ONCE, up front, for a config that needs neither
`scaledInterpolatorRefs` nor a destroy-mode `fieldToInterp` refresh** (the ordinary case — most
`animation {}` declarations, `animate:` bindings, and every toggle-mode transition) — the single
call's own XML-text return value is reused directly in `emitXml`'s `extraChildrenXml`. A config that
DOES need either (a `scaled: true` interpolator, or a target inside a `{#if:destroy}` block) is
instead called TWICE: once early, purely to collect `scaledInterpolatorRefs`/`RefreshableInterpolatorRef[]`
(XML text discarded), and again later to produce the real XML text (reusing the same
`scaledInterpolatorRefs` array so ids can never drift, and recomputing the same deterministic
`destroyModeTargetIds` set the second time) — this is deliberate, not an oversight: `emitAnimationXml`
is a pure, deterministic function of its `(config, destroyModeTargetIds)` arguments, so calling it
twice with the same inputs is guaranteed to assign the exact same ids both times, letting `emitBrs`
(built from the FIRST call's refs) and the final XML (built from the SECOND call) agree without
having to thread one shared mutable pass between them.
