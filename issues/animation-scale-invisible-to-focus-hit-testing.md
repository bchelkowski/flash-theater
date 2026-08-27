# A `scale` animation doesn't resize a node's LRUD hit-testing footprint

**Type:** Gap
**Area:** animation
**Status:** Open

## Problem

`FlashTheaterFocusManager`'s geometry helper (`absoluteRect()`) never reads a node's `scale` field —
it only considers position/size. An `animation {}` block that animates a card's own `scale` (e.g. a
"grow on focus" effect) doesn't change what the focus system thinks that card's hit-testing rectangle
is, even though the card visually grew or shrank.

## Impact

Directional (LRUD) focus navigation between a scaled card and its neighbors can feel geometrically
wrong once scale is involved — e.g. a visually-enlarged focused card's real edges extend past what
the focus system still thinks its boundary is, so a D-pad press can skip past a visually-adjacent
neighbor or select one that doesn't look adjacent anymore.

## Where

- `findings/animation.md` — documents this explicitly as "a pre-existing limitation... not something
  this feature could safely change without risking a regression."
- `findings/focus-runtime-registry.md` — `absoluteRect()`'s geometry computation.

## Suggested fix

`findings/animation.md` already flags this as risky to change casually — `absoluteRect()` is used
throughout the focus system's LRUD candidate search, and changing what it returns for every node
(not just animated ones) risks regressing unrelated, currently-correct geometry. Any fix should scope
narrowly: read `scale` only when it's non-default (`[1,1]`) and apply it to the rect's width/height
around its center, then run the full focus-system test/demo suite (`apps/focus-demo`,
`apps/animation-demo`) before trusting the change — this is exactly the kind of change that needs a
real-device pass, not just unit tests, per this repo's own "Definition of done."

## Related

- `findings/animation.md`
- `findings/focus-runtime-registry.md`
