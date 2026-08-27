# `.onFinish(callback)` — findings

Design notes for the animation-finished hook (`bounce.onFinish(callback)`). See
`packages/compiler/GRAMMAR.md`'s "animation" section (the "`.onFinish(callback)`" subsection) for
the grammar/API itself, and [animation.md](animation.md) for the rest of the `animation`/
`transition:`/`in:`/`out:`/`animate:` feature's own live-verification narrative and known
limitations.

## Design

Sixth piece of Layer 1 trigger sugar (`bounce.onFinish(cb)`), lowering to
`m["$$ft_animFinish_<name>"] = <cb>`, read back by a shared `ObserveFieldScoped("state", ...)`
handler (`codegen/conditional-block-emitter.ts`'s `emitAnimationStateChangeHandler`, registered by
`codegen/naming.ts`'s `animationStateChangeHandlerName`) that fires on every `state = "stopped"`
event, not just the first — unlike `taskManager.onResult`'s fire-once/auto-unregister shape, an
animation is commonly retriggered (a bounce button pressed repeatedly), so `onFinish` never
unregisters. Registering `.onFinish()` again for the same name just replaces the previous callback
(plain assignment semantics, no diagnostic). Rejected (`animation/repeat-not-supported-with-onfinish`,
`compile.ts`) when the target's own declaration has `repeat: true` anywhere in its step tree — same
reasoning as `repeat: true`'s existing rejection on an exit (`out:`) transition (see
[animation.md](animation.md)): `state` never reports `"stopped"` for a looping animation.
`ObserveFieldScoped` (not plain `ObserveField`) ties the observer's lifetime to the observing
component node, so no `ft_unmount`-style manual teardown is needed the way Timer needed one.

## A wrong assumption from the initial design, caught by a failing test, not by review

The design was originally built expecting a REAL collision — that a custom (non-preset) animation
name used as BOTH an `.onFinish()` target AND a Layer 2 `out:`/`transition:` target would resolve
to the exact same node, since Roku only keeps the last `ObserveFieldScoped` registration per
(node, field, observing script). This turned out to be false: `analysis/animation-presets.ts`'s
`resolveTransitionAnimation` ALWAYS returns a freshly synthesized per-block-direction name
(`transitionAnimationName`, e.g. `if_1_out`) for a Layer 2 usage, copying the referenced step tree —
never the literal declared name's own node. So `.onFinish()`'s real node and any Layer 2 usage of
the same declared name are always on two distinct nodes with two independent handlers; two
different blocks referencing the same custom `out:` name are likewise always on two distinct
synthesized nodes, never colliding.

The per-animation-name-keyed handler (rather than the previous per-block-id keying) shipped anyway
as a harmless generalization/simplification — it still correctly handles a longer consumer list if
one is ever possible in the future — but it is NOT fixing a real bug, and nothing in the current
feature set ever produces more than one consumer for a given name.

Caught by `test/codegen/golden.test.ts`'s own "merge" test asserting two fragments lived in the
SAME generated sub, which failed with 0 occurrences once actually run against real compiler output
— a reminder that an assumption about how two features interact, formed from reading `GRAMMAR.md`
prose rather than the actual resolver code, is worth a quick manual compile-and-read check before
committing to a design built around it. Since live-verified on real hardware too — see below.

## Live-verified

**⚠️ Live-verified on a real Roku Ultra, 2026-08-17.** Two separate device passes:

1. **Basic fire-every-time semantics** (`apps/animation-demo`'s `BounceButtonDemo.thr`, demo 1/7) —
   `bounce.onFinish(onBounceFinished)` shows a running "Bounced N times" count on the card's own
   label. Sideloaded and driven via ECP (`EcpClient.keypress(ip, 'Select', ...)` — the ECP key name
   for the on-device OK button — then `queryAppUi` to read `cardLabel`'s live `text=`): 4 consecutive
   OK presses produced `"Bounced 4 times"` → `5` → `6` → `7`, one increment per press, confirming the
   callback fires on EVERY completion, not just the first — the core design point that distinguishes
   this from `taskManager.onResult`'s fire-once shape. A screenshot (`InstallerClient.takeScreenshot`)
   taken immediately after matched the `queryAppUi` reading exactly, for this check at least not
   exhibiting the staleness `findings/dev-environment.md` warns `takeScreenshot` can have —
   `queryAppUi` was still the primary signal.

2. **The "no real collision" claim above, confirmed on-device too** — a dedicated 7th demo screen,
   `apps/animation-demo`'s `SharedAnimationHookDemo.thr`, declares one animation (`glow`, `target:
   card`) used BOTH as `out:glow` on a toggle-mode `{#if}` block AND via a separate `glow.start()` +
   `glow.onFinish(onGlowFinished)` trigger, tracked as an independent `pulseFinishCount`. Driven via
   ECP (`Select` toggles the block, `InstantReplay` triggers the direct `.start()`+`onFinish()` pulse):
   the sequence init(`0`) → hide(`0`) → show(`0`) → Replay(`1`) → Replay(`2`) → four interleaved
   toggles(`2`, unchanged) → Replay(`3`) confirms the `out:` exit transition NEVER touches
   `pulseFinishCount`, and only the direct `.start()`/`.onFinish()` pair does — on real hardware, not
   just in the generated `.brs` text. Screenshot after the sequence read `"Pulse finishes: 3"`,
   matching `queryAppUi` exactly.

**Gotcha hit during both passes**: `EcpClient.launchApp(ip, 'dev')` on an already-running dev channel
resumes it (Instant Resume) rather than cold-restarting — neither demo's counter was reset by
relaunching alone, same "doesn't guarantee a cold restart" gotcha `findings/dev-environment.md`
documents for `installChannel`. Navigating between `MainScene`'s demo screens (`Rev`/`Fwd`) also needs
a real settle wait per press (each switch tears down/rebuilds a whole child component tree via
`{#if:destroy}`) — a fixed ~150ms delay was too fast and produced screens that hadn't actually
switched yet; ~500ms plus an explicit "does the queried XML contain the target component's own tag
name" retry loop was reliable.
