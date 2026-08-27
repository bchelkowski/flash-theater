# streams — `apps/streams-demo` chapter/router app

A genuinely new chapter app (no predecessor to split, unlike `apps/task-manager-demo`/
`apps/requests-demo`/`apps/timers-demo`) — the `stream` primitive was previously only shown
embedded in `apps/sample-app`'s `StreamDemo.thr`. For the underlying `stream` design/runtime
rationale, see [streams.md](streams.md); for the grammar itself, see `packages/compiler/GRAMMAR.md`'s
"`stream`" section.

## The app

`MainScene.thr` follows the standard chapter-app skeleton (`router.setRouting`,
`<FlashTheaterRouterOutlet>`, REWIND/FAST-FORWARD chapter advance — copied from
`apps/animation-demo`/`apps/task-manager-demo`), no outlet transitions (same choice
`apps/task-manager-demo` made — the outlet-transition deep-dive already lives in
`apps/animation-demo`'s own chapter 8, no need to repeat it here). 3 chapters:

- **`/emit-subscribe`** (`EmitSubscribeDemo.thr`) — plain script-level `stream`, no `.flsh` classes
  involved. Two independent streams keep the two demonstrations from muddying each other:
  - `lateJoinStream` — the **default** example. "Step 1: emit" and "Step 2: subscribe (late)" are
    deliberately two SEPARATE button presses (not one combined action), so the replay is visibly a
    consequence of subscribing after an emission already happened, not an artifact of both running
    in the same call. Pressing Step 2 shows the late subscriber's callback firing immediately,
    synchronously, with the value from Step 1 — the BehaviorSubject replay `findings/streams.md`
    describes.
  - `bridgeStream` — the **customized** addition: subscribed exactly once, in `setup()`, writing
    the received value into `state bridgeText`, the idiomatic bridge-into-state pattern
    GRAMMAR.md/streams.md describe as the way to reach template reactivity from a stream. A second
    button emits 3 times in a row (`bridgeStream.emit(...)` called three times back to back) —
    `bridgeFireCount` incrementing to 3 (not staying at 1) is the actual proof the callback fires
    for every emission, not just the first.
- **`/class-stream`** (`ClassStreamDemo.thr` + `Broadcaster.flsh`/`Listener.flsh`) — a
  class-declared `stream` field (`public stream onChanged: string`). Default: the component's own
  script subscribes directly to `m.broadcaster.onChanged` (component-to-class, zero special
  mechanism — same as `apps/sample-app`'s `StreamDemo.thr`). Customized: a SECOND, independent
  subscriber — `Listener`, a second class instance holding a reference to `Broadcaster` — proving
  multiple subscribers on the same class-instance stream all receive the same emission
  independently. One press of "Broadcast a value" updates the component's own readout immediately
  (state write rides the template cascade); `Listener`'s own readout needs an explicit "Refresh"
  press to pull a snapshot, since a class instance's private state isn't otherwise observable from
  outside it (mirrors `apps/sample-app`'s own `StreamDemo.thr` "Refresh subscriber readout" button).
- **`/bound-method-sugar`** (`BoundMethodSugarDemo.thr` + `SugarBroadcaster.flsh`/
  `RawDescriptorListener.flsh`/`SugarFormListener.flsh`) — the RAW, hand-written
  `{ target: m, action: "onPulse" }` descriptor (`RawDescriptorListener`) next to the
  `.subscribe(m.onPulse)` sugar form that lowers to it (`SugarFormListener`), both instances
  subscribed to the SAME `SugarBroadcaster.pulse` stream. One button fires one emission; both
  listeners' independently-tracked fire counts ("raw descriptor fired: N times" / "sugar form
  fired: N times") increment together on every press — live, visible proof both forms compile to
  identical working behavior, not just an assertion in a comment.

## Gotchas hit while building this app

- **`.flsh` files can carry a top-of-file doc comment before the `class` keyword** — confirmed
  legal (already true of `apps/sample-app`'s `GlobalAccessDemo.flsh`, reused here for all five new
  `.flsh` classes); no compiler change needed, just worth confirming since none of the earlier
  stream-focused fixtures (`Publisher.flsh`/`Subscriber.flsh`) happened to use one.
- **The bound-method sugar is a REQUIRED pattern for a class subscribing to another instance's
  stream, not a style choice** — `Listener.flsh` (chapter 2) and `RawDescriptorListener`/
  `SugarFormListener` (chapter 3) all avoid the inline-anonymous-function subscriber form
  entirely, per GRAMMAR.md's explicit warning (a `.flsh` instance's `m` binding does not survive
  being stored in a stream's subscriber list — see `streams.md` for the full live-device
  investigation). Chapter 3 is the one place this app deliberately writes the RAW `{ target, action
  }` form by hand (everywhere else uses the sugar), specifically to prove the two forms are
  interchangeable, not to recommend the raw form as a general pattern.
- **Everything else compiled clean on the first `npm run build:roku` pass** — no new compiler
  gotchas surfaced beyond what was already documented in `streams.md`/GRAMMAR.md before this app
  existed.

## Live-device-confirmed — all 3 chapters, zero bugs found

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`), all 3 chapters, default AND
customized examples. This app compiled correctly the first time and needed no fixes.

- **`/emit-subscribe`**: the late-join replay confirmed genuinely instantaneous —
  `lateEmitReadout` showed `emitted 'late-value' (no subscriber yet)`, then subscribing showed
  `late subscriber immediately saw: late-value` in the very same synchronous callback. The bridge
  pattern confirmed: one emit updated `bridgeReadout` to `single-emit`; "emit 3x" brought the
  cumulative fire count from 1 to 4 (not stuck at 1), confirming the callback fires per-emission.
- **`/class-stream`**: one "Broadcast a value" press updated the component's own readout
  immediately (`broadcast-1`); the class-to-class `Listener` readout stayed stale until "Refresh"
  was pressed, then correctly showed the SAME value (`broadcast-1 (received 1x)`) — both
  subscribers genuinely independent, both correct.
- **`/bound-method-sugar`**: 3 presses of "Fire pulse" brought BOTH `rawReadout` and `sugarReadout`
  to exactly `3 times` each, never diverging — live proof the raw `{ target, action }` descriptor
  and the `.subscribe(m.method)` sugar it lowers to are behaviorally identical, not just
  structurally similar in generated code.

Root `npm test`/`npm run lint`/`npm run build:roku` already green — no changes needed for this app.
