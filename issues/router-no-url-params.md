# No dynamic path segments (`:id`-style URL composition)

**Type:** Gap
**Area:** router
**Status:** Open

## Problem

Routes are static paths only — there's no `:id`-style dynamic segment syntax (e.g. `/detail/:id`)
that captures a path portion into `router.params`. Passing data between routes today goes entirely
through `router.navigate(path, { params: {...} })`'s explicit params object, not through the path
string itself.

## Impact

Works fine for in-app navigation (the explicit-params form covers it), but there's no URL shape that
encodes state the way a web router's URL would — matters less on Roku (no visible/bookmarkable URL
bar) but would matter for any future deep-linking feature.

## Where

- `GRAMMAR.md:2503` area — documents the absence of dynamic path segments.
- `findings/router.md` — route declaration/matching mechanics.

## Suggested fix

Lower priority than other router gaps given Roku has no user-visible URL surface to make this valuable
today — mainly relevant if/when deep-linking (`roDeepLinkEvent` handling) becomes a feature. If
pursued, route matching (`findings/router-outlet-runtime.md`) would need pattern-based path matching
(`:name` segment capture into `router.params`) instead of exact-string matching.

## Related

- `findings/router.md`
- `findings/router-outlet-runtime.md`
