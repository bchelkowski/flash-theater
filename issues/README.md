# issues/ — bug and gap tracker

What's broken or missing, and how to go about fixing it. Not the same job as `findings/` (which
explains *why* the code behaves the way it does) or `docs/`/`GRAMMAR.md`/`site/` (which document
intended, shipped behavior for users). `issues/` is the backlog: one file per outstanding item,
written so a future session can pick it up and start fixing without re-deriving context.

Every item is one of two `Type`s:

- **Bug** — behavior that's wrong relative to intent. Something is broken.
- **Gap** — a feature or edge case knowingly not built yet. Nothing is broken; it just doesn't
  exist. (`docs/features.md`/`GRAMMAR.md` may also mention these in passing — this is where the
  fix-ready detail lives.)

## Open

| Area | Type | Issue |
|---|---|---|
| focus-system | Bug | [focus-default-focus-not-auto-claimed.md](focus-default-focus-not-auto-claimed.md) — router-free scenes never auto-claim a static `default-focus` |
| animation | Bug | [animation-toggle-mode-focus-leak.md](animation-toggle-mode-focus-leak.md) — a toggle-mode block's focusable content leaks registration; `scaled: true` doesn't fix it generally |
| build-layout | Bug | [build-missing-main-brs-not-validated.md](build-missing-main-brs-not-validated.md) — a missing `source/Main.brs` compiles and zips silently |
| streams | Bug | [streams-no-unsubscribe-api.md](streams-no-unsubscribe-api.md) — no way to remove a subscriber from a stream |
| tooling | Bug | [tooling-site-build-uv-handle-crash.md](tooling-site-build-uv-handle-crash.md) — `site/`'s `npm run build` crashes on exit with `UV_HANDLE_CLOSING` |
| reactive-state | Gap | [reactive-state-no-direct-field-write.md](reactive-state-no-direct-field-write.md) — no grammar for writing a `field` directly from component code |
| reactive-state | Gap | [reactive-state-nested-store-write-rejected.md](reactive-state-nested-store-write-rejected.md) — `store(a.b) = x` rejected; only whole top-level keys are writable |
| reactive-state | Gap | [reactive-state-derived-unknown-type-boundary.md](reactive-state-derived-unknown-type-boundary.md) — `derived` type inference has a permanent "unknown" boundary |
| template | Gap | [template-bind-one-directional-only.md](template-bind-one-directional-only.md) — `bind:` is one-directional only despite the "two-way" name |
| template | Gap | [template-bind-rejected-in-each.md](template-bind-rejected-in-each.md) — `bind:` inside an `{#each}` body is a compile error |
| template | Gap | [template-each-no-index-variable.md](template-each-no-index-variable.md) — `{#each}` has no built-in loop-index variable |
| router | Gap | [router-no-route-guards.md](router-no-route-guards.md) — no middleware/route guards (`canActivate`, redirects) |
| router | Gap | [router-no-forward.md](router-no-forward.md) — no `forward()`; `back()` pops a plain stack only |
| router | Gap | [router-no-per-route-transition-override.md](router-no-per-route-transition-override.md) — outlet transitions/`loadingComponent` are outlet-wide, not per-route |
| router | Gap | [router-no-dynamic-default-focus.md](router-no-dynamic-default-focus.md) — `default-focus` must be a static literal, no `{expr}` form |
| router | Gap | [router-no-url-params.md](router-no-url-params.md) — no dynamic path segments (`:id`-style URL composition) |
| theme | Gap | [theme-single-template-per-app.md](theme-single-template-per-app.md) — at most one `<theme-template>` per app |
| theme | Gap | [theme-no-runtime-selection.md](theme-no-runtime-selection.md) — no manifest-file or runtime-decided initial theme |
| classes | Gap | [classes-no-reactive-lifecycle.md](classes-no-reactive-lifecycle.md) — `store`/`state`/`focus(...)` entirely unreachable from a `.flsh` class body |
| classes | Gap | [classes-no-class-body-animation.md](classes-no-class-body-animation.md) — no `.flsh` class-body `animation` declaration form |
| task-manager | Gap | [task-manager-no-stuck-task-timeout.md](task-manager-no-stuck-task-timeout.md) — no timeout for a task whose `state` never leaves `"init"` |
| task-manager | Gap | [task-manager-no-preemption.md](task-manager-no-preemption.md) — high-priority work still waits behind running low-priority tasks |
| task-manager | Gap | [task-manager-no-reprioritization.md](task-manager-no-reprioritization.md) — re-running an already-queued task never moves it between priority tiers |
| task-manager | Gap | [task-manager-no-watch-on-counts.md](task-manager-no-watch-on-counts.md) — `runningCount`/`queuedCount`/`alertLevel` aren't `watch`-able |
| requests | Gap | [requests-only-http-kind-supported.md](requests-only-http-kind-supported.md) — `request` only supports `Kind: Http` |
| requests | Gap | [requests-no-retry-cancel-timeout.md](requests-no-retry-cancel-timeout.md) — no retry, cancellation, or timeout on an in-flight request |
| requests | Gap | [requests-no-etag-conditional-get.md](requests-no-etag-conditional-get.md) — caching has no `Expires`/ETag/conditional-GET support |
| animation | Gap | [animation-no-class-body-form.md](animation-no-class-body-form.md) — no `.flsh` class-body `animation` form (same root cause as the classes gap) |
| animation | Gap | [animation-scale-invisible-to-focus-hit-testing.md](animation-scale-invisible-to-focus-hit-testing.md) — a `scale` animation doesn't resize a node's LRUD hit-testing footprint |
| animation | Gap | [animation-fly-slide-reject-dynamic-translation.md](animation-fly-slide-reject-dynamic-translation.md) — `fly`/`slide` presets reject a target with a dynamic resting `translation` |
| timers | Gap | [timers-not-usable-in-derived-template-or-class-body.md](timers-not-usable-in-derived-template-or-class-body.md) — timer statements can't appear in `derived`/template/`{#if}`/`{#each}` expressions or a class body |
| environments | Gap | [environments-string-only-values.md](environments-string-only-values.md) — `env.<name>` is always a plain string; no numbers/booleans/nested groups |
| environments | Gap | [environments-no-per-env-build-config-override.md](environments-no-per-env-build-config-override.md) — `designResolution`/`srcDir`/`outDir` can't be overridden per environment |
| statements | Gap | [statements-no-finally.md](statements-no-finally.md) — `try`/`catch` has no `finally` clause |
| statements | Gap | [statements-catch-variable-mandatory.md](statements-catch-variable-mandatory.md) — `catch`'s variable is mandatory; no catch-less `try` |
| statements | Gap | [statements-ternary-eager-and-restricted.md](statements-ternary-eager-and-restricted.md) — ternary evaluates both branches eagerly and is restricted to two host positions |

## Resolved

| Area | Type | Issue |
|---|---|---|
| focus-system | Bug | [focus-navigate-cross-owner-hidden-match.md](focus-navigate-cross-owner-hidden-match.md) — `navigate()`'s cross-owner fallback matching hidden toggle-mode content; fixed via `isGenuinelyVisible()` in `FlashTheaterFocusManager.brs` |
| focus-system | Bug | [focus-destroy-nested-component-orphaned-registration.md](focus-destroy-nested-component-orphaned-registration.md) — `{#if:destroy}` never unregisters a nested custom component's own focusable content; fixed via `unregisterSubtree(root, recoveryOwner)` in `FlashTheaterFocusManager.brs`, called from the generated destroy sub |
| task-manager | Gap | [task-manager-no-auto-cancel-on-teardown.md](task-manager-no-auto-cancel-on-teardown.md) — no automatic cancel when a tracking component is destroyed; fixed via per-task owner tracking + `cancelOwnedBy(m.top)` in `FlashTheaterTaskManager.brs`, called from `ft_unmount()` |
| timers | Gap | [timers-task-manager-no-unmount-hook.md](timers-task-manager-no-unmount-hook.md) — `taskManager` hasn't opted into the `ft_unmount` teardown hook timers introduced; fixed alongside the entry above |

## Writing rules

1. **One file per issue**, kebab-case, prefixed by area (`focus-`, `router-`, `task-manager-`, ... —
   same prefixing convention `findings/` uses).
2. **Required sections**, in order: `Type`, `Area`, `Status` (as bold fields under the title), then
   `## Problem`, `## Impact`, `## Where`, `## Suggested fix`, `## Related`.
3. **`Status: Open` or `Status: Fixed`.** On fixing an issue, flip its status and add one line naming
   what changed (a commit/PR description, not a date — same "no dates" rule as `findings/`). The
   file stays in place; move its row from "Open" to "Resolved" in this README. Never delete a
   resolved issue file — it's a historical record of what was fixed and how.
4. **Link to `findings/` for the "why."** `issues/` doesn't re-explain mechanics `findings/` already
   owns — link to the relevant file(s) in `## Related` instead of restating them.
5. **`## Suggested fix` must be concrete** — likely files/functions to touch, not just "someone
   should fix this." This is what makes an issue file usable to start a fix without re-investigating
   from scratch.
6. **New bugs/gaps found during unrelated work get filed here**, per `CLAUDE.md`'s "Definition of
   done" — this directory grows the same way `findings/` does, as a side effect of normal work, not
   as a periodic separate audit.
