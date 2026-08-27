# statements — `apps/statements-demo` chapter/router app

A NEW, from-a-topic-not-a-migration chapter app (no predecessor to convert or split, unlike
`apps/task-manager-demo`/`apps/requests-demo`/`apps/timers-demo`) — same shape as
`apps/animation-demo`'s own `MainScene.thr` skeleton (`router.setRouting`,
`<FlashTheaterRouterOutlet>`, REWIND/FAST-FORWARD chapter advance). Built for the `statements`
doc-nav topic (`site/src/pages/docs/statements.astro`), covering `if`/`else if`/`else` + ternary,
crash-safe `==`/`!=`/`<`/`>`/`<=`/`>=`/`!`, automatic chain safety + `for`/`for each`/`while`
loops, and anonymous function expressions + the raw BrightScript passthrough escape hatch. See
[demo-app-conventions.md](demo-app-conventions.md) for the app-structure convention this
instantiates.

## Chapters

- **`/conditionals`** — `ConditionalsDemo.thr`. Default: "Bump streak" drives a `state` write
  through a block-form `if (streakCount < 3) { ... } else if (streakCount < 6) { ... } else { ... }`
  chain; "Reset streak" contrasts with the inline braceless single-statement `if` form. Customized:
  two independent booleans (`isHappy`/`isVeryHappy`), each toggled by its own button, drive a
  single `state` write through a NESTED, parenthesized ternary —
  `isHappy ? (isVeryHappy ? "ecstatic" : "content") : "grumpy"` — the exact shape GRAMMAR.md's own
  worked example documents.
- **`/safe-operators`** — `SafeOperatorsDemo.thr`. Default: `==`/`!=`/`!` used normally (a
  `describeCount()` helper using plain `==`, a `derived hasItems` built on `!=`, a `derived
  isOverLimit` built on a normal non-throwing `>`, and a boolean `state` toggled with `!`).
  Customized: "Trigger mismatch" deliberately compares a `String` local to the integer `itemCount`
  with `>` — a genuine, incompatible-type ordering comparison — inside `try`/`catch`, displaying
  the caught `e.code`/`e.message` directly. This is the one operator in the whole crash-safe family
  that can still crash if left uncaught (no safe fallback *value* exists for "is X greater than Y"
  the way `false` does for equality), so it's worth demonstrating explicitly.
- **`/chain-safety-and-loops`** — `ChainSafetyAndLoopsDemo.thr`. Chain safety: `field selectedItem:
  node = invalid` — a `derived`/function chain reading `selectedItem.label` resolves safely both
  while the node is genuinely `Invalid` (initial state) and once "Pick item" assigns a real node
  with a `label` field via `m.top.selectedItem = <node>` — no crash either way, since every member
  access in generated `.brs` is automatically `?.`-rewritten. Default: "Build list" uses a numeric
  `for` loop to build then join a list. Customized: "Sum collection" uses `for each` to sum a fixed
  array; "Count up" uses `while` to count up to a limit, updating a `state` value on every single
  loop iteration (not just once at the end) so the readout visibly re-renders per-iteration.
- **`/anonymous-functions-and-raw`** — `AnonymousFunctionsAndRawDemo.thr`. Default: "Schedule
  greeting" is Tier 1 — `greet = function () { ... }` is the whole right-hand side of a plain bare
  assignment, then that local is passed to `setTimeout` as an ordinary callback reference (defined
  via Tier 1, then used as a callback). Customized: "Keep evens" is Tier 2 — the anonymous function
  is nested directly inside `filterNumbers(numbers, function (n: integer): boolean { ... })`'s own
  call argument, the same shape as GRAMMAR.md's own `filterDays`/`removeToday` reference example.
  "Describe device" additionally demonstrates the raw BrightScript passthrough escape hatch
  (`CreateObject("roDeviceInfo").GetModel()` inside a `' flash-theater:raw` / `' flash-theater:
  end-raw` block, function-body statement form).

## Real gotchas hit this session

- **The inline braceless `if (condition) statement` form does NOT dispatch into the DSL's own
  `state`/`store`/`scale` statement forms** — only `token-stream-parser.ts`'s `{ }` block-body
  parser routes through the DSL statement dispatcher; the inline form's single statement is
  captured as a raw BrightScript statement region instead (`scanSameLogicalLine` +
  `makeStatementRegion`), the same passthrough treatment an ordinary assignment/call/`print`/etc.
  gets. Writing `if (press) state streakCount = 0` compiles, but fails with
  `expression/unresolved-identifier: Unresolved identifier "state" in function ... if-body` — the
  raw-passthrough parser sees `state` as a bare identifier being read, not the DSL keyword, since
  the block-body dispatch that recognizes `state <name> = <expr>` as its own statement kind never
  runs for the inline form. **This matches GRAMMAR.md's own inline example
  (`if (condition) doOneThing()`, a plain call) and site's own (`if (condition) doOneThing()`,
  same) — neither one ever shows a `state`/`store`/`scale` write in the inline position, which in
  hindsight was the tell.** Fix: keep the `state` write inside an ordinary function and call that
  function as the inline statement (`if (press) doResetStreak()`, where `doResetStreak()` is a
  `private function` doing the actual `state` writes) — this is also the more idiomatic shape once
  more than one `state` write is needed on a single condition, since the inline form allows only
  one statement per line anyway.
- **A `derived`/`state` name reused as its own display `Label`'s element `id` collides** — hit
  repeatedly this session (`selectionReadout`, `tierReadout`, `moodReadout`, `statusReadout`,
  `limitReadout`, `hintReadout` all had to be renamed to `<name>Label`/`<name>ReadoutLabel` on the
  XML element side). This is the same `template/id-collides-with-binding` gotcha CLAUDE.md's task
  brief already flagged going in, but it's easy to reintroduce it repeatedly across sibling
  components in one session — every `RunCancelDemo.thr`-style reference component in this repo
  deliberately names its `derived`/`state` value something like `xLabel`/`xText` and its element
  `id` something like `xReadout`, never the same string for both; worth following that naming
  split by default rather than discovering the collision at compile time each time.
- **`apps/requests-demo` and `apps/task-manager-demo` have no `src/source/Main.brs` of their
  own**, unlike `apps/statements-demo`/`apps/animation-demo`/`apps/timers-demo`/`apps/focus-demo`/
  `apps/sample-app` — GRAMMAR.md's "Project layout" section documents `source/Main.brs` as part of
  every app's 100%-hand-written `src/`. Not investigated further this session (out of scope for
  this task), but worth flagging: without it, `flash-theater compile` still succeeds (there's
  nothing that requires the file to exist), but the zipped package would have no BrightScript entry
  point at all, meaning the channel could not actually launch on a real device. `apps/
  statements-demo`'s own `Main.brs` was copied from `apps/timers-demo`'s (the most recently
  converted, most up-to-date version — includes the router-aware comment explaining why the ROOT
  Scene's own `setup()` needs one hand-written `scene.callFunc("setup")` call, unlike a
  router-mounted CHILD component which gets it automatically).
- **A ternary is genuinely unreachable from a `derived` default** — confirmed by construction, not
  just by reading GRAMMAR.md: every "which tier/mood is this" computation in `/conditionals` had to
  be a `state` written from a function body (`bumpStreak()`, `refreshMood()`), never a `derived`
  directly off the ternary, exactly as documented. No compiler diagnostic was actually triggered
  this session to re-confirm the error path (`expression/parse-error`) since the demo was written
  correctly the first time around this specific rule — GRAMMAR.md's own text was trusted directly.

## Live-device-confirmed — all 4 chapters, zero bugs found

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`), all 4 chapters, default AND
customized examples. This app compiled correctly the first time and needed no fixes.

- **`/conditionals`**: the block `if`/`else if`/`else` tier chain confirmed across all 3 tiers
  (streak 4 → "collector", streak 7 → "super fan"); the inline-braceless "Reset streak" button
  confirmed resetting both the counter and tier label back to "starting out". The nested-ternary
  mood label confirmed correct across all 4 `isHappy`/`isVeryHappy` combinations: `false/true` →
  "grumpy" (outer ternary short-circuits), `true/true` → "ecstatic", `true/false` → "content".
- **`/safe-operators`**: `hasItems`/`isOverLimit`/the `!`-toggle all confirmed reactive. "Trigger
  mismatch" confirmed the relational-guard throw is genuinely caught on real hardware — readout
  showed `caught relational/type-mismatch: flash-theater: cannot compare roString and roInt with
  '>' — relational operators require two numbers or two strings.`, no crash, no suspended debugger.
- **`/chain-safety-and-loops`**: chain safety confirmed both directions — "Pick item" resolves
  `selectedItem.label` through a real node (`Widget #1`), "Clear selection" resolves the same chain
  through `Invalid` safely (`"(nothing selected yet)"`, no crash). All 3 loop forms confirmed: `for`
  built `item-0, item-1, item-2, item-3, item-4`; `for each` summed `[4, 8, 15, 16, 23, 42] = 108`;
  `while` counted up with visible per-iteration updates (`counted: 1 2 3 4 5`).
- **`/anonymous-functions-and-raw`**: Tier 1 (`greet = function() {...}` passed to `setTimeout`)
  confirmed firing after its delay (`"Hello from a Tier 1 anonymous function!"`). Tier 2 (anonymous
  function as a direct call argument to `filterNumbers`) confirmed (`evens: 2 4 6 8 10`). The raw
  BrightScript passthrough confirmed reading a real device model string
  (`CreateObject("roDeviceInfo").GetModel()` → `"model: 4850X"`, the actual Roku Ultra's own model
  number).

Root `npm test`/`npm run lint`/`npm run build:roku` already green — no changes needed for this app.

**Device-found and fixed 2026-08-26**: `SafeOperatorsDemo.thr`'s own title and its "Trigger
mismatch" button label had both manually pre-escaped literal `<`/`>`/`&gt;` characters — rendered
as the literal entity codes on screen. See
[template-attribute-value-escaping.md](template-attribute-value-escaping.md) for the general rule;
fixed by writing the raw characters in both places.
