# classes — `apps/classes-demo` coverage

`apps/classes-demo` is a genuinely new chapter app (no predecessor to split, like
`apps/statements-demo`) for the `classes` doc-nav topic — previously the `.flsh`/`class` mechanic
was only shown embedded in `apps/sample-app` (`Classes/Counter.flsh`/`LabeledCounter.flsh`/
`GlobalAccessDemo.flsh`/`Publisher.flsh`/`Subscriber.flsh`, driven from `FavoriteCounter.thr`/
`TaskDemoScreen.thr`/`StreamDemo.thr`). See `findings/demo-app-conventions.md` for the router+scale
chapter-app convention this instantiates, and `packages/compiler/GRAMMAR.md`'s "Classes" section /
`site/src/pages/docs/classes.astro` for the feature itself.

**⚠️ Live-verified** against the dev Roku (serial `X02800C5FKLV`), all 3 chapters, four real bugs
found and fixed. See "Live-device results" below for the full writeup.

## Chapters

- **`/fields-and-methods`** — `FieldsAndMethodsDemo.thr` + `Classes/BankAccount.flsh`. Fields
  declared BOTH ways in the same class: `accountType`/`overdraftLimit` are top-level fields
  (literal defaults, evaluated before the constructor runs); `owner`/`balance` are the
  "assign a constructor parameter straight to a field" shorthand, entirely inside `constructor(...)`.
  All three visibility levels appear (`public accountType`/`owner`, `protected overdraftLimit`,
  `private balance`). Default: "Deposit $50" mutates the private `balance` field through a public
  method; the running summary is shown via a `derived` (`summaryLabel`) that depends on a
  `balanceVersion` `state` counter bumped after every mutating call — the same "private helper
  function takes the version number as its only parameter, ignores it, reads the real state through
  `m.<instance>` instead" pattern `apps/sample-app`'s `FavoriteCounter.thr` already uses for
  `milestoneLabel`. Customized: "Withdraw $200" deliberately exceeds `overdraftLimit`, contrasted
  against "Withdraw $30" (succeeds) via the same `lastWithdrawResult` readout — `withdraw()`'s own
  private-field guard (`m.balance - amount < 0 - m.overdraftLimit`) actually gates something
  observable, not just accepts every call. `BankAccount` has no direct public getter for `balance`
  at all — `summary()` is the only path to it from outside the class, the concrete "why the three
  levels matter" contrast this chapter exists to show (see the class file's own top comment for why
  this is a real, if narrow, guarantee: the generated field is literally named `private_balance`,
  not `balance` — nothing outside this file even knows the mangled name to try, though BrightScript
  itself still has no true access-control check backing it).
- **`/extends-override-super`** — `ExtendsOverrideSuperDemo.thr` + `Classes/ScoreTracker.flsh`
  (base) + `Classes/BonusScoreTracker.flsh` (`extends ScoreTracker`). Adapted from GRAMMAR.md's/
  `site/src/pages/docs/classes.astro`'s own `Counter.flsh`/`LabeledCounter.flsh` worked example
  into a scoring framing — not verbatim, per the task's own allowance. `BonusScoreTracker`'s
  overriding constructor's first statement is exactly one `super(start)` call; both `add` and
  `describe` are marked `override` and both reference `m.score` — a field declared **private on the
  base class** — proving an inherited private member is reachable from a subclass override,
  rewritten to `m.private_score` exactly like it would be inside `ScoreTracker` itself (confirmed by
  reading the generated `BonusScoreTracker.brs`: `m.private_score = m?.private_score + (points *
  m?.private_bonusMultiplier)`). Default: `ScoreTracker(0)` used directly (`baseTracker`).
  Customized: `BonusScoreTracker(0, 3)` (`bonusTracker`) constructed from the same starting score.
  Both instances live behind ONE button ("Add 10 points to both") so `override`'s actual effect is
  visible by direct comparison, not just asserted: the base label reads "Score: 10", the derived
  label reads "Score (x3 bonus): 30", from the identical `add(10)` call — `add`'s override
  multiplying by the bonus field is the only thing that could produce that divergence.
- **`/global-singletons-from-class`** — `GlobalSingletonsDemo.thr` + `Classes/GlobalAccessHelper.flsh`
  + `QuickTask.thr` (a minimal Task, existing purely to give `taskManager.run(...)` a real node) +
  `Theme/Theme.thr` (a minimal `<theme-template>`, added to this app specifically so the `theme.*`
  reach-from-class case has something real to read — no other chapter app before this one needed a
  theme). Default: "Read theme.colors.accent" calls `helper.accentColorLabel()`
  (`theme.colors.accent` read from inside the class method); "Start a background task" calls
  `helper.startQuickTask()` (`taskManager.run(...)` from inside the class method, against a real
  `QuickTask` node). Customized: "Go to Chapter 1" calls `helper.goToChapter("/fields-and-methods")`
  — `router.navigate(...)` called from INSIDE the class method itself (not from the `.thr`
  component's own script), still a standalone statement there, still triggers real navigation +
  the mandatory focus hand-off. **Known, deliberately-kept quirk**: this button bypasses
  `MainScene`'s own `activeChapterIndex` tracker (that `state` lives in `MainScene`, unreachable
  from a class body — `class/state-store-not-supported` — and unreachable from
  `router.navigate()` itself), so the NEXT REWIND/FAST-FORWARD press after using it computes from a
  now-stale index; physical BACK is unaffected (it walks the router's own history, not the index).
  Not a bug — this is the same "state, not the route, drives the chapter counter" shape every other
  chapter app already has, just newly observable because this chapter is the first anywhere in this
  app's own history to call `router.navigate()` from somewhere other than `MainScene`'s own
  `nextChapter()`/`prevChapter()`.

  The class's own doc comment documents (but never runs) the four things NOT reachable from a
  `.flsh` class body: `store`/`state`/`focus(...)`, and
  `taskManager.onAlertChanged`/`onResult`/`onRequestSent`/`onResponseReceived`. See "Verified, not
  just asserted" below for the one of these actually confirmed live this session.

## Verified, not just asserted — `taskManager.onResult(...)` from a class body

Per this task's own instruction to confirm at least one of the documented class-body exclusions
with a real compile, rather than just repeating GRAMMAR.md's prose: a scratch method was added
temporarily to `Classes/GlobalAccessHelper.flsh`:

```
public function scratchOnResultTest() {
  taskManager.onResult(CreateObject("roSGNode", "QuickTask"), function (t: dynamic) {
  }, function (t: dynamic) {
  })
}
```

`npm run compile --workspace apps/classes-demo` rejected it exactly as GRAMMAR.md documents, with
`class/task-manager-on-result-not-supported`:

```
ERROR  [class/task-manager-on-result-not-supported]  .../Classes/GlobalAccessHelper.flsh:
taskManager.onResult(...) is not supported in class GlobalAccessHelper method
"scratchOnResultTest" — whether ObserveFieldScoped's callback-scoping semantics even work when the
call site is a class method is unverified, and this feature's two fixed trampoline sub names would
collide the moment a second class needing them is imported into the same component. Call
taskManager.onResult(...) from the owning .thr component instead.
```

The scratch method was removed before shipping — `Classes/GlobalAccessHelper.flsh` in the final app
never contains it. An anonymous-function callback argument needed an explicit `: dynamic` parameter
type to get past parsing first (`statement/parse-error` — anonymous function parameters are never
inferred, same as a named function's) before reaching the class-body-specific rejection above.

## Real gotchas hit this session, not already in the task's own known-gotchas list

- **A `.flsh` class field's literal default is a single token — no unary minus.**
  `expectLiteral` (`packages/flash-parser/src/token-stream-parser.ts`) only accepts one of
  `StringLiteral`/`NumberLiteral`/`True`/`False`/`Invalid`; `-100` lexes as `Minus` + `NumberLiteral`,
  two tokens, and is rejected as `dsl/invalid-class-field` ("Expected: public|private|protected
  <name>: <Type> = <literal>"). This is narrower than `field`/`state`'s own widened literal grammar
  (`findings/reactivity-field-state-literals.md` — that one still doesn't cover unary minus either,
  confirmed by reading `classifyLiteralShape`, but this hadn't been hit head-on for a *class* field
  before). Worked around in `BankAccount.flsh` by storing `overdraftLimit` as a positive "how far
  below zero you may go" allowance (`= 100`) and writing the negation at the read site
  (`0 - m.overdraftLimit`) instead of trying to declare a negative default directly.
- **A bare `m.<name>` instance holder needs no `field`/`state` declaration at all** — confirmed
  reusable from this session's own chapters, following `apps/sample-app/src/components/StreamDemo/
  StreamDemo.thr`'s existing `m.publisher = Publisher()` idiom: `m.account`/`m.baseTracker`/
  `m.bonusTracker`/`m.helper` are all plain, undeclared `m` members set once in `setup()` and read
  from key handlers/`derived`-backing private functions later. `derived`'s own dependency graph
  never needs to see these — the `state`/`field` version counter each chapter bumps after a mutating
  call is what actually drives recompute; the private helper function it calls simply ignores its
  own (only-there-to-be-a-dependency) parameter and reads the real instance through `m` instead.
- **Adding a `<theme-template>` to a chapter app that never had one before needs zero wiring beyond
  the file itself** — `Theme/Theme.thr` (one `<theme-template default="classic">`, no `<theme
  name="...">` variant at all) was sufficient; the three-tier fallback's tier 3 ("no variants exist
  at all → the template's own literal defaults") covers a template-only theme cleanly.
  `FlashTheaterSetupGlobals` in the copied `Main.brs` already wires it unconditionally — no app-specific
  edit was needed there, matching how every other chapter app's `Main.brs` is identical regardless
  of whether that app declares a theme.

## Live-device results — four real bugs found and fixed

**⚠️ Live-verified**, all 3 chapters walked, default AND customized examples.

- **Real bug #1 (compiler-adjacent, app-source fix): `FieldsAndMethodsDemo.thr` crashed on its
  very first mount.** `derived summaryLabel: string = accountSummaryText(balanceVersion)` gets its
  initial value computed in `init()` — BEFORE `setup()` (which constructs `m.account =
  BankAccount(...)`) ever runs. `accountSummaryText()`'s `return m.account.summary()` compiles to
  `m?.account?.summary?()`, which optional chaining safely resolves to `Invalid` while `m.account`
  is still unset — but the function's own DECLARED `: string` return type still enforces a cast on
  whatever comes back, and `Type Mismatch. Unable to cast "Invalid" to "String"` crashed the app
  outright. Chain safety protects the member-access chain itself, never a function's own return-type
  enforcement when that chain safely resolves to `Invalid` — a distinct mechanism. Fixed with an
  explicit `if (m.account = invalid) { return "(not initialized yet)" }` guard.
- **Real bug #2, identical root cause: `ExtendsOverrideSuperDemo.thr` had the same crash**, in
  `baseTrackerText()`/`bonusTrackerText()` reading `m.baseTracker`/`m.bonusTracker` (also
  constructed in `setup()`, also read by a `derived`'s init-time default) — string-concatenating
  the Invalid these safely resolve to before construction. Fixed with the same guard pattern.
- **Real bug #3 (demo logic): "Withdraw $250" — originally $200 — never actually exceeded the
  overdraft limit from the account's default starting state**, so the chapter's own stated
  purpose (showing `withdraw()`'s guard actually BLOCK something) silently never happened.
  `BankAccount.flsh`'s guard (`balance - amount < 0 - overdraftLimit`) is boundary-inclusive: from
  the default $100 balance and $100 `overdraftLimit`, withdrawing $200 lands exactly AT the -$100
  floor (`-100 < -100` is false — allowed, not blocked); it takes $250+ to genuinely trip the guard.
  Confirmed live before the fix: pressing the button showed `"Withdraw $200: succeeded"`, balance
  `$-100`, not the documented "blocked" case. Fixed by changing the amount (and every related
  name/label) from 200 to 250; re-verified live: `Withdraw $250: blocked (overdraft limit)`, balance
  unchanged at $100.
- **Real bug #4, same class as `findings/focus-runtime-bugs.md`'s overflow-skewed-LRUD-scoring
  entry, independently reproduced in a different app: `GlobalSingletonsDemo.thr`'s `taskButton`**
  was completely unreachable via `Down` from `themeButton` — its own label ("Start a background
  task (taskManager.run, from a class method)") overflowed its 690px box badly enough to skew
  `FlashTheaterFocusManager`'s `BoundingRect()`-based candidate scoring, letting `navButton`
  (overflowing less, despite sitting farther away) win instead. Fixed by shortening all three
  button labels on this chapter to fit their own boxes (the "from a class method"/mechanism-name
  framing already lives in the chapter's own title, so nothing was lost); re-verified live: `Down`
  from `themeButton` now correctly reaches `taskButton`.
- All three interactive chapters otherwise confirmed exactly as designed: chapter 1's deposit/
  withdraw cascade and private-field-only-via-`summary()` access; chapter 2's override divergence
  (base `10`, bonus `30`, from the identical `add(10)` call on both instances); chapter 3's
  `theme.colors.accent` read (`0x66CCFFFF`), background task start (`Task started: ft_task_1`), and
  `router.navigate(...)` from inside a class method (genuinely lands on chapter 1, focus intact).

Root `npm test`/`npm run lint`/`npm run build:roku` re-confirmed green after all four fixes.
