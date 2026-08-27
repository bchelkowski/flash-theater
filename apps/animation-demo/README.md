# animation-demo

A dedicated Roku app showcasing flash-theater's `animation` feature end to end
— split out of `apps/sample-app` simply to keep a clean, uncluttered place to
grow several animation examples, not because anything app-wide needs
isolating the way `apps/focus-demo`'s LRUD registry does.

Six screens, switched with LEFT/RIGHT (see `src/components/MainScene.thr`):

1. **`BounceButtonDemo`** — a custom `animation {}` declaration, triggered
   imperatively via `.start()` from an `on:key[OK]` handler.
2. **`SequentialDemo`** — `sequential: true` composition: fade in, then slide
   down.
3. **`ParallelDemo`** — `parallel: true` composition: scale and opacity pulse
   together.
4. **`TogglePresetDemo`** — `transition:fade` (a built-in preset) on a
   toggle-mode `{#if}` block, with focusable content proving the
   deferred-`visible=false` + focus-safety retrofit.
5. **`DestroyCustomDemo`** — a custom `in:` animation paired with a built-in
   `out:` preset on a destroy-mode `{#if:destroy}` block, with focusable
   content proving the deferred-`removeChild` + retimed focus-safety fix.
6. **`AnimateAttrDemo`** — `animate:opacity` auto-animating an ordinary
   reactive attribute write instead of an instant snap.

## Building

From the repo root (builds the compiler first, then all three apps):

```bash
npm run build:roku
```

## Sideloading onto a real Roku device

Requires developer mode enabled on the device (see
[developer setup](https://developer.roku.com/dev/docs/developer-setup)) and
these environment variables:

```bash
export ROKU_HOST=192.168.x.x
export ROKU_PASSWORD=your-developer-password
npm run build:roku
npm run sideload
```

Sideloading replaces whatever dev-mode channel is currently installed — this
app, `apps/sample-app`, and `apps/focus-demo` can't all be installed at once,
same as any two sideloaded channels on one device.
