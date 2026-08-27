# `scale` — compile-time config and codegen (`flash-theater.config.json`, `packages/compiler/src/`)

Compile-time module responsibilities and design rationale for the `scale` modifier and the config
mechanism it introduced. See `packages/compiler/GRAMMAR.md`'s "`scale`" section for the grammar/API
itself — this file is the *why* and the non-obvious implementation traps it hit. For live-device
verification lessons (manifest tiers, `query/app-ui` bounds, cold-restart discipline), see
`findings/scale-device-verification.md`.

## First compiler config file this repo has ever had

Before this feature, `packages/compiler/src/cli.ts`/`compile.ts`/`app-compiler.ts` had **no**
config-file mechanism of any kind — every compile-time decision came from CLI flags or plain
function parameters. `scale`'s entire meaning depends on knowing which resolution an app's `.thr`
sizes were authored for, so it needed one: `flash-theater.config.json` at the app root — sibling to
`src/`/`out/`/`package.json`, **not** sibling to `manifest` (manifest lives inside `src/` since the
src/out project-layout split, see `findings/build-layout.md`) — `{ "designResolution": "hd" | "fhd"
}`, loaded by a new `src/config.ts` (kept out of `compile.ts`/`app-compiler.ts` — neither touches
`fs`, per `findings/compiler-pipeline-and-build.md`'s "no `fs` inside `compile.ts`" rule) and threaded
through `compileApp`'s new fourth parameter (now that `srcRoot`/`outRoot` are the two parameters
ahead of it — see `findings/build-layout.md`). Using `scale` anywhere with no config present (or an
invalid one) is a hard compile error (`dsl/scale-requires-config`) — there is no implicit default
resolution, since guessing one would silently mis-scale every value with no signal to the author.
This same config file later grew `srcDir`/`outDir`/`exclude` (see `findings/build-layout.md`) —
still one monolithic file, so an app that only wants to customize its layout still needs a valid
`designResolution` present if the file exists at all (existing behavior, not new).

## Two separate grammar-interception points, not one — a plain local assignment had no AST node at all

`scale` needed to work both as a script-level declaration modifier (`scale field`/`state`/
`derived`/`watch`/`read`) AND as a function-body statement (`scale <local> = <expr>`/`scale state
<name> = <expr>`). The script-level half is a straightforward index-shift, mirroring
`ClassStreamFieldDeclaration`'s own precedent for a leading modifier token (`ast.ts`) — a new
`Scale*Declaration` `SyntaxKind` per kind, produced by the SAME parse method with the already-
consumed `scale` token prepended.

The statement-level half was the surprising one: **a plain, ordinary local assignment (`x = 10`)
has NO flash-parser AST node today** — confirmed by reading `token-stream-parser.ts`'s
`parseBlockContent`. Unlike `state <name> = <expr>`/`store(<key>) = <expr>` (both get real
structural interception via `parseStateAssignment`/`parseStoreWriteStatement`), a bare assignment
falls through to the opaque bracket-depth-gated `StatementRegion` scan and is handed to the
vendored BrightScript grammar purely for later scope-analysis passes — never a structured node
codegen can hook a wrapper onto. **Fix**: add `TokenKind.Scale` as a new, EARLY branch in
`parseBlockContent`'s dispatch (before the `Identifier` ternary/anon-function lookahead, and in the
opaque-scan's own stop-keyword list so a `scale ...` line on a later line within an otherwise-opaque
run gets split out correctly) — `scale` itself is a distinct token kind, so it never risks falling
into the identifier-shaped checks at all.

## A new AST statement kind needs registering in `Block.statements`, not just `wrapNode`

`ast.ts` has TWO separate node-wrapping mechanisms: a generic `wrapNode(node)` switch (used in a
few scattered places) and `Block.statements`'s own hand-written `switch`-via-if-chain with its OWN
explicit union return type. Adding `ScaleLocalAssignmentStatement`/`ScaleStateAssignmentStatement`
to `wrapNode` alone was not enough — `Block.statements` is what every function-body consumer
(`compile.ts`'s block-scanning helpers, `brs-emitter.ts`'s `printStatement`,
`scope-resolution.ts`'s `reconstructStatementForScope`, `class-emitter.ts`'s
`printClassStatement`) actually iterates, and it has its own separate dispatch that silently
falls through to `StatementRegion` for anything unrecognized. **Both** needed the two new kinds
added, or a `scale` statement would parse correctly but silently print/analyze as opaque text.

## Every `compile.ts` block-scanning helper needed a new branch — the `.text` catch-all is a trap

`compile.ts` has six near-identical recursive scanners (`blockHasStoreWrite`, `blockHasFocusCall`,
`blockHasRouterAccess`, `blockHasTaskManagerAccess`, `blockHasTaskManagerOnAlertChangedCall`,
`blockHasTaskManagerOnResultCall`) that walk `Block.statements`, each ending in a catch-all
`s.text`/`anyNestedAnonymousFunctionSatisfies(s.text, ...)` fallback. The moment
`ScaleLocalAssignmentStatement`/`ScaleStateAssignmentStatement` became members of
`Block.statements`'s union type, TypeScript caught every one of these six call sites at compile
time (`.text` doesn't exist on either new class) — a real, load-bearing safety net, not just
noise. **Lesson for the next new statement kind**: adding a member to `Block.statements`'s union
WILL surface every place that assumed the union was closed to the pre-existing kinds; each of
these six needed a branch mirroring `StateAssignment`'s own treatment — recurse into `.rhs` when
it's an `AnonymousFunctionExpression` (a nested anon-function body can still contain a real
`store(...)`/`focus(...)`/`router.*`/etc.), otherwise treat the RHS as an opaque expression (or,
for the two `onAlertChanged`/`onResult` scanners, `false` outright — those calls are restricted to
standalone-statement position and can never legally appear in an assignment's RHS expression).

## `scale field`'s default can't be scaled in XML — override it once in `init()` instead

A `field`'s default comes from the XML `value="..."` attribute, set by SceneGraph before `init()`
ever runs — XML has no way to call a function, so `scale field foo: integer = 10`'s XML still
prints the raw, unscaled `10`. The compiler appends `m.top.foo = ft_scale(10, ...)` as the very
first thing in the generated `init()` sub instead, overwriting the raw default before anything else
(a template binding, a `derived` computation) can read it. `state`/`read`'s scaled defaults are
simpler — they have no XML entry at all, so their `init()` assignment line is scaled directly, no
override step needed.

## The runtime factor is cached on one global field, never recomputed, and never read implicitly by the helper

`ft_scale(value, factor)` (`runtime-assets/Scale/FlashTheaterScale.brs`) takes the factor as an
explicit second argument — it never reaches into `m`/`m.global` itself. This is required, not a
style choice: inside a `.flsh` class method, `m` is a plain associative array, never a SceneGraph
node (see `findings/class-pipeline-global-singleton-access.md`'s `GetGlobalAA()` entry), so a helper that hardcoded
`m.global.ft_scaleFactor` would silently break there. The factor itself
(`roDeviceInfo().GetDisplaySize().w / <configured design-resolution width>`) is computed exactly
ONCE, at app boot, by reusing the existing `globalNode.addFields({...})` bootstrap pattern
`emitFlashTheaterGlobalsBrs` already uses for `ft_taskManager`/etc. — a plain cached number field
(`ft_scaleFactor`), not a new SceneGraph singleton component (unlike Router/TaskManager, `scale`
needs no behavior, no observers, just one number). Every `ft_scale(...)` call site passes in
`globalFieldRef('scaleFactor', accessRoot)` — `m.global` for a `.thr` component, `ft_globalAA.global`
for a `.flsh` class (via `CLASS_GLOBAL_ACCESS_ROOT`, hoisted the same way every other class-context
global access already is).

## `scale` becoming a reserved keyword breaks any pre-existing identifier literally named `scale`

Registering `scale` in `tokenKind.ts`'s `KEYWORD_MAP` makes it unusable as a plain identifier
ANYWHERE — including as a `store(<key>)` path segment — the same blanket reservation `store`/
`focus`/`stream`/`request` already have. One pre-existing test (`brs-emitter.test.ts`) used
`store(scale) = ...` as an arbitrary store key name and broke the moment this shipped; had to
rename the key. **Lesson for the next reserved keyword**: grep test fixtures for the bare word
before assuming a new reserved name is purely additive — it can silently invalidate source that
happened to use that word as an ordinary identifier.

## A raw `{#each}` item translation is a real, repeatable trap — hit twice now

`translation="{[40, w.y]}"` (a bare inline array literal in a template `{expr}` binding, `w.y` a
plain unscaled number carried on the item's own state data) looks identical to any other
`translation="{...}"` binding in a `.thr` file, but the two other kinds (a `scale state .../.thr`
field reference, or a raw literal in a component that itself has no `scale` config) are the common
case — nothing about the syntax visually signals "this one silently never gets multiplied by
`ft_scaleFactor`." `apps/sample-app/src/components/CardsScreen/CardsScreen.thr`'s own top comment
already named the fix (compute the scaled x/y once via the `scale <local> = <expr>` statement form,
inside the `{#each}` item's own factory function, and store it directly on the item's data — a
template `{expr}` binding itself can never be `scale`d, only a declaration or a function-body
assignment can) — but `NestedAndListTimerDemo.thr` (originally added in `apps/async-demo` for
[timer-statements.md](timer-statements.md)'s own `{#each}`-unmount-cascade demo, now migrated
as-is to `apps/timers-demo`) hit the exact same trap again anyway, storing
`state widgets: array = [{id: "w1", y: 400}, ...]` (raw,
unscaled `y`) and binding `translation="{[40, w.y]}"` directly. On this app's own dev device (Roku
Ultra reporting FHD against an `hd` `designResolution` — `ft_scaleFactor` = 1.5), every OTHER
translation in the component (all `scale derived` at the time) came out multiplied by 1.5, but the
list items' own `y` stayed raw — while `TimerLeafWidget`'s own `width`/`height` (correctly `scale
field`) DID
scale up. Size scaling up while position scaling didn't is what turned a merely-tight layout (70px
item height, 80px spacing, unscaled) into real, confirmed-live overlap (105px scaled item height,
still 80px raw spacing) — reported as "broken layout" with no more specific symptom, diagnosed from
the `.thr` source alone (matching raw numbers against `CardsScreen.thr`'s already-documented rule),
then confirmed both in generated `.brs` (`ft_scale(400 + index * 80, m.global.ft_scaleFactor)`
appearing only after the fix) and live via `query/app-ui` bounds on-device (each item's `y` now lands
600/720/840, evenly spaced, matching every sibling element's own scaled coordinates) before and
after. **Fixed** the same way `CardsScreen.thr` already does it: a `makeWidget(idStr, index)` factory
using `scale x = 40` / `scale y = 400 + index * 80`, called from `startDemo()` (not the `state`
declaration's own literal default, which can't call a function) to build the `widgets` array.
**Lesson**: this specific mistake is easy enough to repeat that it's worth grepping for
`{#each` + a bare inline array/object literal in a `translation`/position-bearing template attribute
whenever `scale` is in play for a component — the type checker and the compiler give zero signal
that a `scale`-configured component's own `{#each}` item positions silently aren't scaled.

## `scale derived <name> = <literal>` for a translation/size constant is a mislabel — `scale state` is correct, with one real exception

The layout-bug investigation above surfaced a wider issue while diagnosing it: grepping the whole
repo (`grep -rn "^\s*scale derived \w+:\s*\w+\s*=" apps --include="*.thr"`) found **156 `scale
derived` declarations across 28 `.thr` files, and every single one was a pure literal** (an array
like `[40, 20]`) — zero were ever actually computed from another `field`/`state`/`derived`. GRAMMAR.md
is explicit that `derived`'s whole reason to exist is being "computed from its own expression," with
dependencies "inferred statically from the top-level identifiers in the expression" — a literal has
none, so labeling it `derived` was never accurate; it just happened to compile to the same thing
(confirmed by reading generated `.brs`: a zero-dependency `derived` inlines directly into `init()`,
`m.x = ft_scale([40, 20], factor)`, with no separate recompute function or observer — byte-identical
in shape to what a `scale state` literal default produces). **Swept the entire `apps/` tree**,
converting all 156 `scale derived <name>: <Type> = <literal>` declarations to `scale state` (a
plain Node script matching that exact line shape, run twice to also catch untracked new files —
`git ls-files` alone misses those). Zero runtime/codegen difference; purely a correctness-of-intent
fix, matching `state`'s own documented purpose ("mutable, hand-assignable component data" — even
though in every one of these 156 cases it's in practice never hand-reassigned either, `state` is
still the honest label since nothing forbids it, where `derived` explicitly forbids ever being
hand-assigned).

**The one real exception found by the sweep, not just a style nit**: `apps/sample-app/src/components/
HomeScreen/HomeScreen.thr`'s `itemTranslation`/`promptTranslation` used `[(880 - 300) / 2, 60]` —
arithmetic on literal numbers, with no field/state/derived dependency either, but genuinely **not a
literal** (`state`'s grammar requires every leaf to be a literal; `dsl/state-default-not-literal`
fires on an arithmetic expression even with zero identifiers in it). `derived`'s RHS is "any
expression" — broader than "any expression with dependencies" — so it's still the only legal
declaration for a dependency-free but non-literal value. Left as `scale derived` deliberately, with a
comment explaining why (self-documenting centering math, not a missed conversion). **The actual rule,
sharper than "does it depend on anything"**: use `scale state` for a literal default; use `scale
derived` only when the RHS genuinely isn't literal syntax (an expression, even a dependency-free one)
— `read` never applies to either case, since its RHS is grammatically restricted to `store(<path>)`
only, not a literal or an arbitrary expression.

## Runtime dispatch decisions (all confirmed choices, not defaults left unexamined)

- **Integer scaling truncates toward zero** (`Int(value * factor)`), never rounds — `10 * 0.667 =
  6.67` becomes `6`. A deliberate choice (round-to-nearest was the alternative), not an accident of
  `Int()`'s own behavior.
- **Arrays scale element-wise, one level deep, never recursively into a nested array; AAs scale the
  same way, per-key** — numeric elements/values scale, non-numeric ones in the same mixed
  array/AA pass through unscaled. No error on a mixed array/AA. `ft_scale`'s `roArray` branch
  shipped in the same commit as `scale` itself, but was dead code from `field`/`state`'s own
  perspective until `array`/`assocarray` became valid `field`/`state` types (see below) — only the
  statement form (`scale x = [1, 2]`) could reach it before that. The `roAssociativeArray` branch is
  new; it didn't exist at all until AA support landed.
- **Everything else (string/boolean/`roSGNode`/`invalid`) passes through completely unscaled** — no
  compile-time type check exists for `scale derived`/`scale watch`/`scale read` (their `<Type>`
  annotation, like `derived`'s own, is free unvalidated text), so a `scale`d non-numeric expression
  is a silent no-op at runtime, not a diagnostic. `scale field`/`scale state` DO get a static check
  (`dsl/scale-invalid-field-type`/`dsl/scale-non-numeric-literal`) since their literal/type is known
  at parse time. `node` was never added to `SCALABLE_FIELD_TYPES` (`script-parser.ts`) and stays
  excluded even after `array`/`assocarray` joined it — confirmed by a dedicated regression test
  (`scale.test.ts`), not just left alone by omission.
- **`scale watch`/`scale read` double-scaling risk, left unresolved by design**: the store is
  schemaless, so nothing stops a store value from already being scaled by whichever component wrote
  it, while another component `scale`-reads the same key. Flagged in GRAMMAR.md rather than solved
  in code — fixing it for real would need a store-wide scaling contract this feature doesn't have.
