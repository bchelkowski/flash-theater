# No `forward()`; `back()` pops a plain stack only

**Type:** Gap
**Area:** router
**Status:** Open

## Problem

The router's history model is a plain stack: `navigate()` pushes, `back()` pops. There's no
`forward()` counterpart and no concept of a redo-style forward stack (popped entries are gone, not
parked for a forward move).

## Impact

Matches how most Roku remotes/UX actually work (there's no forward gesture on a typical remote), so
this may be intentional-by-platform-fit rather than a real gap — but it's worth tracking since an app
targeting a remote with dedicated FF/RW-as-navigation buttons (see `jumpFocus`'s own FF/RW framing in
`findings/jump-focus.md`) might want it.

## Where

- `findings/router.md` — the stack-based history model.
- `findings/router-outlet-runtime.md` — history/route-matching mechanics.

## Suggested fix

Lowest priority in this list given the platform-fit argument above — before implementing, confirm
there's an actual authoring need (a real app wanting it) rather than building speculatively. If
needed: `back()` would need to push the popped entry onto a separate forward stack instead of
discarding it, and `navigate()` would need to clear that forward stack (standard browser-history
semantics) since a fresh navigation invalidates any "redo" path.

## Related

- `findings/router.md`
- `findings/jump-focus.md`
