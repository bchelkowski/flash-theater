# Grammar reference

This document describes exactly what the compiler supports **right now** — not
the full target language spec. The compiler's current goal: compile one real component
(`ScheduleDateMenuItem`, see `../../apps/sample-app/src/components/ScheduleDateMenuItem/ScheduleDateMenuItem.thr`)
and validate the whole pipeline end to end. Extending the grammar beyond this
scope is knowingly separate work, not a "missing piece" of this document.

## Project layout

Every app is split into two directories, TypeScript-`src`/`outDir`-style:

- **`src/`** — 100% hand-written: `manifest`, `images/`, `source/Main.brs`, `components/**/*.thr`,
  `components/**/*.flsh`, and any hand-written `.xml`/`.brs` component with no `.thr` source of its
  own (e.g. a hand-composed `Scene` root). Nothing the compiler generates is ever written here.
- **`out/`** — 100% generated/copied, mirroring `src/`'s exact structure — wiped and rebuilt from
  scratch on every `flash-theater compile`, safe to delete or gitignore wholesale. This is the
  directory that physically becomes the Roku package once zipped.

`flash-theater compile [--check] [--src-dir <dir>] [--out-dir <dir>] [--env <name>]` takes no
pattern argument — it always compiles the whole project, discovering everything under `src/`
(defaulting to a `src`/`out` sibling pair of the current working directory). `--check` validates
without writing. `--env <name>` (or a `FLASH_THEATER_ENV` environment variable) activates a named
build profile — see "Environments" below.

`flash-theater.config.json` (app root, sibling to `src/`/`out/` — **not** inside `src/`, since it's
tooling config, not app content) may override the defaults and exclude paths from consideration entirely:

```json
{
  "designResolution": "hd",
  "srcDir": "src",
  "outDir": "out",
  "exclude": ["components/Experimental/**"]
}
```

- `srcDir`/`outDir` — relative to the app root; default `"src"`/`"out"`.
- `exclude` — glob patterns (`**`, `*`, `?`) relative to `srcDir`; a matching file or directory is
  skipped entirely, neither compiled nor copied.

All three keys are optional, but the file as a whole is still all-or-nothing once present: if it
exists, `designResolution` must still be valid even for an app that only wants to customize its
layout (see "Design-resolution config" below).

### Packaging (`flash-theater zip`)

`flash-theater zip [--out-dir <dir>] [--env <name>] [--app-name <name>]` zips an already-compiled
`out/` (or `out-<env>/`) into a `dist/` artifact ready to sideload onto a Roku device — run it after
`flash-theater compile`, not instead of it:

- No active environment: `dist/<appName>.zip`.
- An active environment (`--env <name>`, or a `FLASH_THEATER_ENV` environment variable — same
  fallback `compile` honors): `dist/<appName>-<name>-<major>.<minor>.<build>.zip`, with the version
  read from the built `out-<name>/manifest`'s `major_version`/`minor_version`/`build_version` keys.
- `<appName>` defaults to the app's own `package.json`'s `"name"` field (falling back to the app
  root directory's own basename if there's no `package.json`), overridable with `--app-name`.

`--out-dir` and `--env` mean the same thing here as they do for `compile` — pass the same values you
compiled with so `zip` finds the right `out`/`out-<env>` directory. There's no `--src-dir`: zipping
never reads `src/`. Errors with a clear message (and exit code 1) if the target `out`/`out-<env>`
directory doesn't exist yet — run `flash-theater compile` first.

## The DSL is case-sensitive

BrightScript itself is case-insensitive; `.thr`/`.flsh` deliberately are
**not** — two identifiers differing only in case are different identifiers in
DSL source, even though the compiled `.brs` output still folds case like any
BrightScript program at runtime. This is a design decision, not a limitation:
simpler to reason about, and avoids a whole class of case-folding ambiguity
in the compiler's own identifier resolution. No special mechanism enforces
this — plain string comparisons are case-sensitive by default — but don't
"helpfully" add `.toLowerCase()` anywhere in identifier matching; that would
silently reintroduce BrightScript's case-folding into the DSL layer.

## Identifier resolution

Every bare identifier anywhere a `field`/`derived`/`state`/`read`/`watch`/
`stream`/function reference can appear — a `derived` expression, a template
`{expr}` binding, a function body (an `if` condition, a `return`, an
assignment, a call argument) — must resolve to exactly one of:

1. A real BrightScript local in that function (a parameter, a plain
   assignment target, a `for`/`for each` variable, a `catch` variable) —
   always wins over anything below (ordinary lexical scoping).
2. A declared `field`, `derived`, `state`, `read`, `watch`, `stream`, or
   `private`/`public function` name — rewritten to its generated form
   (`m.top.x`, `m.x`, `private_x`).
3. `m` (BrightScript/SceneGraph's component-scope variable) or a recognized
   BrightScript builtin (`UCase`, `Left`, `Val`, ...), matched
   case-insensitively (BrightScript itself is case-insensitive there, unlike
   this DSL's own names) — left untouched.

**Anything else is a compile error**, not a silent pass-through — there's no
such thing as "probably a local BrightScript uses elsewhere" in this DSL; if
it isn't one of the three things above, it's treated as a typo. See
`findings/compiler-identifier-resolution.md` for how this is implemented (a real
BrightScript scope analysis per function, flash-parser's own
`brightscript-scope.ts` — vendored and adapted from
`kopytko-brightscript-parser`'s scope analysis, not a hand-rolled
local-variable tracker).

## `.thr` file structure

```
<script>
  ...declarations...
</script>

<component>
  ...children (valid XML, 1 or more top-level siblings)...
</component>
```

The `<script>`...`</script>` region must appear **once**, at the start of the file, before
`<component>`. `packages/flash-parser`'s own parser does the split as part of its single `parse()`
call (a simple text scan for the tags themselves, not a full parser) that recognizes
`<script>`/`</script>` outside string literals/comments — see `findings/compiler-parser-architecture.md`.

`<component>`...`</component>` is **mandatory** and must immediately follow `</script>` — a bare
element with no `<component>` wrapper (the pre-this-feature shape) is a compile error
(`thr/expected-component-tag`), the same clean-break-with-an-upgrade-path treatment `<store>`'s own
removal got (see `findings/reactivity-theme-parsing.md`). `<script>` itself never carries attributes —
it's pure script declarations, nothing about it "extends" anything; that's a property of the
component/node, and lives on `<component>` instead (below). `<component>` is parsed as ordinary
XML (unlike `<script>`/`<theme-template>`/`<theme name="...">`'s own raw-text literal-prefix
dispatch) — its own attributes are classified the same way any element's attributes are, and its
children the same way any element's children are; the only rule specific to it is that its tag
name must literally be `component`.

### `<component>` — the mandatory root tag

```
<component extends="Scene" on:key[OK,up,down]="{handleKey()}">
  <ChildA .../>
  <ChildB .../>
</component>
```

`<component>` owns everything about the compiled component's own root, as opposed to a specific
child node:

- **`extends="..."`** (optional, defaults to `Group`) — the SceneGraph base class this component
  compiles to. Passed through verbatim to the generated `<component extends="...">` — unrestricted,
  the same trust level as a template element's own `tagName` (never validated against a closed
  set), so an unrecognized value surfaces as a real Roku compile/runtime error, not a DSL-level
  one. Documented, tested values: `Group` (default), `Scene` (a top-level app entry point — see
  `apps/sample-app/src/components/MainScene.thr` for a real example), `Task`, `Node`. `m.top` inside
  the component's own generated `.brs` always refers to this component's own instance regardless
  of `extends` — a `Scene`-extending component's `init()`/a hand-called `public function` can
  freely do `m.top.backgroundColor = ...`/`m.top.setFocus(true)` exactly like a `Group` one does
  `m.top.<interfaceField>`. A `Scene`-rooted component has no parent to expose interface fields to,
  but `<interface>` (even empty) is harmless there — Roku permits and simply ignores it, so no
  special-casing is needed in codegen for that case.
- **`on:key[Key1,Key2,...]="{<call>}"`** (optional, any number of these) — see "`on:key` at the
  component level" below.
- **No `id`** — `<component>` never accepts one (`template/component-cannot-have-id`); it isn't a
  describable child, it *is* the compiled component (`m.top`). No other attribute is accepted
  (`template/component-invalid-attribute`).

**1 or more top-level children, no forced wrapper.** Real SceneGraph XML's `<children>` already
holds multiple top-level nodes natively — this DSL doesn't invent an "exactly one root" rule on top
of that. `<component>` with exactly one child compiles exactly as before (that child becomes
`<children>`'s sole entry); with 2+, every one becomes a direct sibling inside `<children>`,
compiler-internal bookkeeping only (`dsl-parser.ts`'s `adaptTemplateSection`/`ThrTemplateAst.root`,
see `findings/reactivity-theme-parsing.md`'s "synthetic multi-child wrapper" entry) — never an extra
node in the real generated XML. A `{#if}`/`{#if:destroy}`/`{#each}` block may be one of several
top-level children exactly like it already can be a non-root sibling anywhere else in the tree; it
still can't be `<component>`'s *sole* child (`template/if-cannot-be-root`/`template/each-cannot-be-root`)
— a component can never have zero real content at every point in time, and `{#if:destroy}` in
particular has no always-present static XML shape at all.

## Declarations in the `<script>` region

A `field`/`derived`/`state` name must be unique across all three kinds — declaring the same name
as more than one of them is a compile error (`dsl/duplicate-binding-name`), since identifier
resolution (above) always picks one kind over the others (`field` over `state` over `derived`),
silently making any other same-named declaration unreachable by any bare-name reference.

### `field`

```
field <name>: <Type> = <literal>
```

- `<Type>` ∈ `string | integer | float | boolean | node | array | assocarray`
- `<literal>` must be a literal, and its own shape must match `<Type>` (a
  compile-time check — `dsl/field-default-type-mismatch` otherwise): a
  quoted string for `string`, a number for `integer`/`float`, `true`/`false`
  for `boolean`, exactly the keyword `invalid` for `node`, a bracketed array
  literal (`[1, 2, 3]`) for `array`, and a bracketed assocarray literal
  (`{ a: 1, b: "two" }`) for `assocarray` — arbitrarily nested (an array
  inside an assocarray, and vice versa), but every leaf must itself be a
  literal, never an identifier or a call (`derived` exists for a computed
  value).
- For `string | integer | float | boolean`, the literal maps 1:1 to the
  `value=` attribute on the generated `<field>` in XML. `node`, `array`, and
  `assocarray` have no representable XML literal at all — SceneGraph gives
  `node` no literal syntax, and neither `array` nor `assocarray` have a
  reliable one either — so those three get **no** `value=` attribute; the
  default is instead assigned once in the generated `init()`, unconditionally
  (not just when `scale`d — see "scale" below).
- `field` is always public (per the target spec) — no visibility keyword.

### `derived`

```
derived <name>: <Type> = <expression>
```

- `<Type>` is a **required, unrestricted** identifier (like `state`'s and a
  function's param/return types), not `field`'s closed
  `string | integer | float | boolean | node` set — `derived` never becomes
  an XML `<field>`, so it isn't bound by SceneGraph's small set of field
  types.
- **The declared type IS checked against the expression** — `analysis/
  derived-type-check.ts` infers a best-effort static type for `<expression>`
  and rejects (`derived/type-mismatch`) a confirmed mismatch. This is "full"
  inference over everything the DSL itself models — literals; `field`/
  `state`/other-`derived` references (against their own declared type, not
  re-inferred); arithmetic (`+` is string concatenation when either operand
  is a `string`, otherwise numeric); `==`/`!=`/`<`/`>`/`<=`/`>=` (always
  `boolean` — this DSL's own crash-safe sugar never has any other meaning);
  `!` (always `boolean`, same reason); a call to a
  `private|public function` declared in this same script (checked against
  its own return-type clause); a call shaped `ClassName(...).methodName(...)`
  — a `.flsh` class constructed inline with a method called directly off the
  result (checked against that class's own declared method return type,
  resolved app-wide via `app-compiler.ts`'s `classShapesByName`) — but it has a
  deliberate, permanent boundary: a BrightScript builtin call, any other
  member/dot access (`theme.*`/`router.*`, a class instance field, a
  schemaless `read`/`watch`/assocarray value), an array/AA literal's own
  element types, or a class instance held in a local variable rather than
  constructed inline all infer as **unknown** and are never flagged —
  `unknown` is always compatible with any declared type. **`AND`/`OR`/`Not`
  are a deliberate exception to "always boolean"** — unlike this DSL's own
  crash-safe sugar, they're real, unguarded BrightScript keywords with a
  genuine dual meaning (a boolean logical op, but also a bitwise op on
  `integer` operands, e.g. `derived parityBit: integer = count AND 1`, a
  real, common idiom) — so the checker only infers `boolean` when every
  operand is CONFIRMED boolean, else `unknown` (never guesses the bitwise
  result's exact numeric subtype). `object`/`dynamic`
  as the declared type also always accepts anything (BrightScript's own
  "don't check me" escape hatches — the common case for an array/tuple
  `derived`, since `derived` was never given `field`'s closed `array`/
  `assocarray` set). Numeric subtypes (`integer`/`float`/`double`/
  `longinteger`) are mutually compatible regardless of exact match, mirroring
  `==`/`!=`'s own numeric leniency (`3`/`3.0` isn't a type mismatch here
  either). Calling a function/method with no return-type clause (compiles to
  a BrightScript `sub`, which has no value) as the WHOLE expression is a
  separate error, `derived/no-value-call` — this does NOT propagate through
  a larger expression's own nested operands (e.g. inside a larger arithmetic
  expression), only the expression's own root call.
- `<expression>` is any BrightScript expression — parsed by flash-parser's
  own vendored BrightScript grammar (`brightscript-parser.ts`, adapted from
  `kopytko-brightscript-parser`), not a hand-rolled expression parser.
- Dependencies (`field`/`state`/other `derived` used in the expression) are
  inferred statically from the top-level identifiers in the expression —
  never declared by hand.
- `derived` is never assigned by hand in code, in a function body or
  anywhere else — it's always computed from its own expression. Mutable,
  hand-assignable component data is `state` (below), a different
  declaration with different rules.

### `state`

```
state <name>: <Type> = <literal>
```

- Same declaration shape as `field`, but **`<Type>` is an unrestricted
  identifier**, not the closed `field` type set — `state` never becomes an
  XML `<field>` (see `findings/reactivity-state.md`), so it isn't bound
  by SceneGraph's small set of field types. `<literal>` also accepts a
  bracketed array/assocarray literal here — but unlike `field`, its shape is
  **not** cross-checked against `<Type>` (which stays purely decorative, as
  above); only its *contents* are validated, the same "every leaf must be a
  literal" rule `field` uses (`dsl/state-default-not-literal` otherwise).
- **Reads** are a bare `<name>`, exactly like `field`/`derived` — anywhere
  one of those can be read (a `derived` expression, a template `{expr}`, a
  function body), so does `state`.
- **Writes** are their own statement, valid only inside a function body:
  ```
  state <name> = <expression>
  ```
  (Same single-line shape as `derived`'s own declaration — no braces, no
  block form.) Assigning to a name that isn't a declared `state` (including
  a declared `field`/`derived` of that name) is a compile error
  (`statement/unknown-state`).
- **Reactive, but genuinely private** — unlike `field` (a real SceneGraph
  interface field, always externally reachable via `node.setField()`
  regardless of documented intent), `state` is a private `m.x` member,
  unreachable from outside the component. A `state` write triggers the same
  cascade a `field` change does (recompute dependent `derived`s, update
  affected template bindings) — but inlined at the assignment site itself,
  since there's no SceneGraph field observer to trigger it from. See
  `findings/reactivity-state.md` for why this is a real design fork
  (not just "a hidden field") and how the cascade is shared with `field`'s
  generated `on_<field>Change`.

### `read` / `watch` (store bindings)

```
read <name> = store(<path>)
watch <name> = store(<path>)
```

- `store` is a **reserved keyword** in this DSL — see "Global store" below for
  what it is and why there's no `<store>` declaration file anymore. `<path>`
  is a dotted identifier chain (`favoriteCount`, `some.nested.value`);
  segment 1 is the store's top-level key, the rest is unchecked dynamic
  dot-access (the store is schemaless from the compiler's point of view — see
  "Global store").
- No type annotation on either — there's no declared shape to check one
  against.
- **`read`** is a **one-time, non-reactive snapshot**: assigned once in the
  generated `init()` (same timing as a `state` default) and never
  recomputed, even if the store's value changes later.
- **`watch`** is **reactive**: recomputed whenever the store's top-level key
  (`<path>`'s first segment) changes, exactly like a `field`/`state`-driven
  `derived` — a `watch` is treated identically to a `derived` for every
  downstream consumer (another `derived`'s expression, a template `{expr}`,
  a function body can all read a `watch` name as a bare identifier). The
  only difference from `derived` is where the recompute's right-hand side
  comes from: a fixed `store(<path>)` read instead of an arbitrary
  BrightScript expression.
- A `read`/`watch` name participates in the same uniqueness check as
  `field`/`derived`/`state` (`dsl/duplicate-binding-name`).

### `stream`

```
stream <name>: <Type>
```

A per-instance, **BehaviorSubject-like pub-sub value** — send a value into it with `.emit(<value>)`,
react to every future (and, immediately, the most recent past) value with `.subscribe(<callback>)`.
Meant for **imperative, reactive communication between different objects living inside the SAME
component** — most commonly between `.flsh` class instances, or between a component's own script
and a class instance it holds. **Never for node-to-node communication** — that stays field/binding,
unchanged; a stream carries no XML `<interface>`/`<field>` at all, so nothing outside the owning
component/class instance can reach it through SceneGraph.

```
stream dataLoaded: string

private function loadData() {
  ...
  dataLoaded.emit(result)
}

public function setup() {
  dataLoaded.subscribe(function (value: string) {
    print "dataLoaded: " + value
  })
}
```

A `.flsh` class method subscribing to another instance's stream and writing the result into its
own state passes a **bound method reference** — `<target>.<methodName>`, no call parens — instead
of an inline callback (see the "bound method reference sugar" bullet below for why):

```
class Subscriber {
  constructor() {
    private received: string = "none yet"
  }

  public function subscribeTo(publisher: object) {
    publisher.onChanged.subscribe(m.onPublisherChanged)
  }

  public function onPublisherChanged(value: string) {
    m.received = value
  }
}
```

`<target>` isn't limited to `m`/`self` — any expression works, most commonly a local variable
holding a *different* instance:

```
public function wire(notifier: object, subscriber: object) {
  notifier.onChanged.subscribe(subscriber.onNotifierChanged)
}
```

- **No `=` initializer, unlike every other declaration in this section.** A stream's runtime value
  is always a fresh, empty pub-sub object — never a DSL-authored literal or expression. `<Type>` is
  an unrestricted identifier (like `derived`'s), documentation-only — a stream never becomes an XML
  `<field>`, so it isn't bound by SceneGraph's small set of field types, and the compiler does no
  runtime type-checking against it.
- **`.emit(<value>)`/`.subscribe(<callback>)` are ordinary method calls**, not special DSL grammar —
  a declared `stream` name resolves to `m.<name>` exactly like a `derived`/`read`/`watch` name does,
  and `.emit(...)`/`.subscribe(...)` pass straight through as plain BrightScript method calls on
  that object. A `.subscribe(function (value: <Type>) { ... })` callback is an ordinary anonymous
  function expression (see "Anonymous function expressions" above) — no new expression grammar
  needed for it either.
- **BehaviorSubject semantics**: `.subscribe(callback)` immediately replays the stream's most
  recently emitted value to `callback` (if `.emit` has ever been called), *before* `.subscribe`
  itself returns, then the callback also runs on every future `.emit`. A stream that has never been
  emitted into skips the replay — a new subscriber's callback simply isn't invoked yet.
- **Bound method reference sugar: `.subscribe(<target>.<methodName>)`, no call parens.** Whenever
  `.subscribe(...)`'s sole argument is a bare member access (not a call, not an anonymous function),
  the compiler lowers it to `.subscribe({ target: <target>, action: "<methodName>" })` —
  `analysis/identifier-rewrite.ts`/`analysis/class-identifier-rewrite.ts`'s
  `rewriteStreamSubscribeBoundReferences`/`rewriteClassStreamSubscribeBoundReferences`, a pure
  syntactic transform (the compiler has no cross-object type information to confirm the receiver is
  actually a stream — same "trust the shape" precedent this DSL's `.emit`/`.subscribe` already set
  by never type-checking their targets at all). `<target>` can be `m`, `self`, a local variable
  holding a *different* instance, a nested field access — anything; only the call's own shape
  matters. **This is the required pattern for subscribing from a `.flsh` class method that writes
  back into its own (or another instance's) state — never write the inline-anonymous-function form
  there** (`function (value) { m.x = value }`). Confirmed live (real Roku device): a Function
  value's own `m` binding does not reliably survive being stored in the stream's own subscriber list
  and invoked later once detached from a real SceneGraph node — this works perfectly for a `.thr`
  component's own inline-anonymous-function subscriber (its `m` is a real, persistent node), but for
  a `.flsh` class instance (a plain associative array with no SceneGraph identity), a callback
  created inside one of its own methods silently loses its `m` by the time `.emit(...)` invokes it —
  the write lands on the wrong object instead of crashing (AA field assignment never fails), so the
  bug is invisible without live-device testing; a HAND-WRITTEN bound reference (before this sugar
  existed) failed identically, and capturing `m` into a local variable first failed even harder (a
  genuine runtime crash — BrightScript anonymous functions do not close over enclosing locals at
  all). The lowered `{ target, action }` form sidesteps the problem entirely: it carries only
  ordinary DATA (an object reference and a method-name string), which persists across the
  store/invoke boundary with nothing to lose, dispatched back to a real `target.action(value)` call
  at invocation time — the same reliable `instance.method()` shape every other class method call in
  this codebase already depends on. Inside a `.flsh` class body, `<methodName>` is looked up against
  the class's own member table exactly like any other `m.<name>` access (private-prefixed if the
  method is private) — see `findings/streams.md` for the full investigation and
  `runtime-assets/Stream/FlashTheaterStream.brs`'s own doc comment for the dispatch mechanism
  (`ft_invokeStreamSubscriber`, branching on `Type(subscriber)`).
- **No unsubscribe.** A stream's subscriber list lives on `m.<name>`/the owning instance's own
  member, so it's garbage-collected together with whatever owns it — bounded by that instance's own
  lifetime, the same "no unsubscribe" shape `taskManager.onAlertChanged(...)` already has (see "Task
  manager" below) for the same reason: nothing meaningfully outlives its own owner within one
  component/class instance's lifetime.
- **Deliberately NOT part of the `derived`/`watch` dependency graph.** Reading `someStream.value`
  inside a `derived` expression or a template `{expr}` binding is a plain, non-reactive snapshot —
  structurally identical to reading any other object's member field — never a tracked dependency
  edge. Streams exist alongside the reactive cascade system, not inside it.
- **`.subscribe(...)`/`.emit(...)` may only be called from a function body** — never from a
  `derived` expression or a template `{expr}` binding
  (`expression/stream-call-in-reactive-expression`), for the exact same reason
  `taskManager.onAlertChanged(...)` has the same restriction: both recompute repeatedly, so calling
  either from one would re-subscribe/re-emit on every single recompute.
- **Reaching template reactivity**: a stream itself carries no template-binding support. The
  idiomatic bridge is to `.subscribe(...)` once (typically in `setup()`) and, inside the callback,
  write the received value into an already-declared `state` (`state <name> = <expr>`) — that write
  then rides the full, pre-existing template-cascade machinery unchanged. Streams intentionally
  don't duplicate that machinery themselves.
- A `stream` name participates in the same uniqueness check as `field`/`derived`/`state`/`read`/
  `watch` (`dsl/duplicate-binding-name`), the same reserved-`ft_`-prefix check
  (`dsl/reserved-identifier-prefix`), the same template-`id` collision check
  (`template/id-collides-with-binding`), and the same `{#each}` item-alias collision check
  (`template/each-alias-collision`).
- **Also declarable directly on a `.flsh` class** — `[public|private|protected] stream <name>:
  <Type>`, same "no initializer" shape, valid only at class-body top level (never inside a
  constructor). See "Classes" below for the full class-field grammar; a class-declared stream field
  is reachable from whoever holds the instance (`someInstance.streamFieldName.subscribe(...)`), not
  just from the class's own methods — see that section's own note.
- **Runtime helper**: compiles to `ft_createStream()`, a single shared BrightScript function
  (`packages/compiler/runtime-assets/Stream/FlashTheaterStream.brs`) returning a plain associative
  array with `.value`/`.hasValue`/`.subscribers`/`.emit`/`.subscribe` — the exact same "prototype
  object" idiom "Classes" below documents for a `.flsh` instance (AA fields plus `m`-bound
  function-valued members), just hand-written once instead of compiler-generated per use. Copied
  once into `components/FlashTheater/Stream/` and wired onto every component/class that needs it via
  a `<script uri="...">`, the same dedup mechanism `ft_equals` (see "Comparison" above) already uses
  — never a per-component copy.

### `scale`

```
scale field <name>: <Type> = <literal>
scale state <name>: <Type> = <literal>
scale derived <name>: <Type> = <expression>
scale watch <name> = store(<path>)
scale read <name> = store(<path>)
```

A leading modifier on `field`/`state`/`derived`/`watch`/`read` — the resulting value is scaled at
runtime by the app's configured design-resolution factor. Every `.thr` app authors its sizes/
positions for ONE fixed pixel space (declared once, app-wide — see "Design-resolution config"
below); `scale` marks the individual values that should stretch/shrink proportionally when the app
actually runs at a different resolution, so authoring for FHD and running at 1080p is a no-op,
while the same FHD-authored value shrinks proportionally at 720p (and vice versa for an HD-authored
app running at 1080p).

```
scale field cardWidth: integer = 200
scale field position: array = [100, 50]
scale state offset: integer = 0
scale derived doubledWidth: integer = cardWidth * 2
scale watch remoteWidth = store(remoteWidth)
scale read initialWidth = store(initialWidth)
```

- **Always precedes an explicit kind keyword** — `scale field`/`scale state`/`scale derived`/
  `scale watch`/`scale read` only. There is no bare `scale <name> = <literal>` shorthand at script
  level (`dsl/invalid-scale-declaration` otherwise).
- **Only `integer`/`float`/`array`/`assocarray` fields may be scaled** (`scale field`) —
  `string`/`boolean`/`node` rejected at parse time (`dsl/scale-invalid-field-type`; `node` staying
  excluded is deliberate — there's nothing numeric to scale in a node reference).
  `scale state`'s literal must be numeric, an array literal, or an assocarray literal
  (`dsl/scale-non-numeric-literal` otherwise — `state`'s `<Type>` itself is never checked, only the
  literal's own shape, same as `state`'s unscaled form above). `derived`/`watch`/
  `read` have no closed/validated type (same as their unscaled forms), so a `scale`d one that
  doesn't actually produce a number silently passes through unscaled at runtime rather than
  erroring at compile time — see "Runtime dispatch" below.
- **When the value is scaled**: a `scale field`'s XML `value=` stays the raw, unscaled literal
  (XML can't call a function) — the generated `init()` overwrites `m.top.<name>` with the scaled
  value once, before anything else reads it. (An `array`/`assocarray` `field` has no `value=`
  attribute at all, scaled or not — see "field" above — so for those two types this `init()`
  override happens unconditionally; `scale` only changes whether it's wrapped in `ft_scale(...)`.)
  A `scale state`/`scale read` default is scaled the
  same way, once, in `init()`. A `scale derived`/`scale watch` is scaled on every recompute —
  both the initial `init()`-time computation and every later reactive recompute, since both go
  through the same generated assignment.
- **Scaling only ever fires where `scale` is explicitly written** — it is never inherited from the
  original declaration. A `scale state offset: integer = 0` declares a scaled *default*; a later
  plain `state offset = 20` write elsewhere is NOT scaled — only a `scale state offset = 20` write
  (see the statement form below) is.

#### Runtime factor and the `scale` statement form

```
scale <name> = <expression>
scale state <name> = <expression>
```

Inside a function body, `scale` also prefixes a plain local-variable assignment or a `state` write
— both scaled the same way as their declaration-level counterparts:

```
private function onResize() {
  scale cardWidth = 200
  scale state offset = someExpr
}
```

- `scale <name> = <expr>` declares/assigns a genuine local (same "bare assignment is always a real
  local" rule as a plain `x = expr` line).
- `scale state <name> = <expr>` is the statement-level counterpart of `scale state`'s own default —
  the reactive cascade fires off the already-scaled value.
- Malformed forms of either report `statement/invalid-scale-assignment`.

#### Design-resolution config

`scale`'s runtime factor is `(actual device display width) / (configured design-resolution
width)` — computed exactly once, at app boot, and cached in one global field every `scale`d value
reads. The app declares which resolution its sizes were authored for in
`flash-theater.config.json` (see "Project layout" above for its full location/schema):

```json
{ "designResolution": "fhd" }
```

- `designResolution` is exactly `"hd"` (1280×720) or `"fhd"` (1920×1080) — the same two-tier
  vocabulary Roku's own `ui_resolutions` manifest key uses. Missing/malformed values are rejected
  (`config/invalid-design-resolution`/`config/malformed-json`).
- **Using `scale` anywhere without a valid config present is a compile error**
  (`dsl/scale-requires-config`) — there is no implicit default resolution, since guessing one would
  silently mis-scale every value.
- **The app's `manifest` MUST declare every `ui_resolutions` tier you want `scale` to ever have an
  effect for — a single-tier manifest makes `scale` a permanent, silent no-op.** Declaring only
  `ui_resolutions=fhd` makes Roku itself render the whole app at a virtual 1920×1080 canvas and
  auto-upscale/downscale the composited output to fit the real screen — under that mode
  `roDeviceInfo().GetDisplaySize()` always reports the virtual FHD size, never the physical
  device's real resolution, so `ft_scaleFactor` computes `1.0` on every device, always (confirmed
  live — see `findings/scale-device-verification.md`). Declare every tier you actually care about instead
  (`ui_resolutions=fhd,hd`) so Roku renders natively per-device and `GetDisplaySize()` reports the
  real resolution `scale` needs to compute a meaningful factor. The compiler does not cross-check
  `designResolution` against `ui_resolutions` (that would require parsing the manifest, which
  nothing else here does) — getting this manifest line right is entirely on the app author.

#### Runtime dispatch

`scale` compiles to a single shared runtime helper call, `ft_scale(<value>, <factor>)`
(`packages/compiler/runtime-assets/Scale/FlashTheaterScale.brs`, wired in via a `<script uri="...">`
exactly like `ft_equals`/`ft_createStream`), never a compiler-generated computation:

- A real number scales by multiplying; an `integer`/`roLongInteger`-typed value **truncates toward
  zero** afterward (`Int(value * factor)`) rather than rounding.
- An `roArray` scales **element-wise, one level deep** (never recursively into a nested array) —
  numeric elements are scaled, non-numeric elements in the same array pass through unchanged.
- An `roAssociativeArray` scales the same way, **per-key, one level deep** — numeric values are
  scaled, non-numeric values (and any nested array/AA value) pass through unchanged.
- Anything else (a string, a boolean, an `roSGNode`, `invalid`, ...) passes through completely
  unscaled — consistent with this DSL's general "trust the shape, do nothing surprising" runtime
  looseness (see `ft_equals`'s own doc comment).
- The factor itself is never read from `m`/`m.global` inside the helper — every call site passes
  it in explicitly (needed for `.flsh` class methods, where `m` is a plain AA, not a node).

#### Known limitations

- **`scale watch`/`scale read` double-scaling risk**: the store is schemaless, so nothing stops a
  store value from already being scaled by whichever component wrote it, while another component
  `scale`-reads the same key — the compiler has no way to detect this. Keep a store key's own
  scaling convention consistent by hand across every component that touches it.

### `private function` / `public function`

```
private function <name>(<param>: <Type>, ...) {
  ...body...
}
private function <name>(<param>: <Type>, ...): <Type> {
  ...body...
}
public function <name>(<param>: <Type>, ...): <Type> {
  ...body...
}
```

- Body in `{}` (not `end function`/`end sub`), per the target spec.
- **Type annotations always use `:`, never BrightScript's `as`** — this
  applies to parameters and the return type (matching `field`'s existing
  colon syntax). The generated `.brs` still uses BrightScript's own `as Type`
  syntax — this is purely a DSL surface-syntax choice, codegen handles the
  translation.
- `<Type>` is a native BrightScript type (`integer`, not `int`).
- **The return-type clause (`: <Type>`) is optional — there is no `void`
  type.** A function with nothing to return simply omits `: <Type>` entirely;
  writing `: void` is a compile error (`dsl/void-not-a-type`), in every type
  position this DSL has (return type, parameter type, `state`/`derived`
  type). Rationale: BrightScript already distinguishes `sub` (no return
  value) from `function` (returns one) — inventing a `void` pseudo-type
  would just be a worse way to say the same thing.
- **A function with no return-type clause compiles to a BrightScript `sub`**
  (`sub <name>(<params>) ... end sub`); a function with a return-type clause
  compiles to `function <name>(<params>) as <Type> ... end function`, as
  before. The compiler does not validate that a no-return-type function's
  body never does `return <expr>` (invalid inside a real `sub`) — same as
  every other statement in a function body, it's passed through unvalidated.
- Function bodies go through the same identifier-rewrite as `derived`/template
  expressions: a `field`/`derived`/`state`/function-name reference anywhere
  in the body (an `if` condition, a `return`, an assignment, a call argument)
  is rewritten to `m.top.x`/`m.x`/`private_x` — see
  `findings/compiler-parser-architecture.md`. A function's own **parameters and
  local variables shadow** those bindings (ordinary lexical scoping): a
  parameter, or a plain local (`total = score`), a `for`/`for each` variable,
  or a `catch` variable sharing a name with a `field`/`derived`/`state`
  refers to the local, never rewritten — see "Identifier resolution" below.
- `private` → the function's name gets a **`private_`** prefix in the
  generated `.brs`. `public` → the name is unchanged. Two rejected
  alternatives, both verified against a real compiler rather than assumed:
  the original planning doc's `$$`-prefix doesn't work because BrightScript's
  lexer rejects `$` as an identifier's first character (only valid as a type
  suffix at the *end*, e.g. `name$`); a bare `_`-prefix doesn't work either
  because it's an established ~3-year-old Roku/BrightScript ecosystem
  convention for *intentionally unused variables* (mirroring this repo's own
  `argsIgnorePattern: '^_'` in `eslint.config.cjs`) — reusing it for
  "private" would collide with that meaning. There's no cross-component name
  collision risk either way: every SceneGraph component has its own
  isolated BrightScript context.
- **A `public function` also gets a `<function name="<name>" />` entry in the
  generated XML's `<interface>` block** (after the `<field>` entries), exactly
  like `field`/`derived`/`state` get a `<field>` entry — `private function`
  gets no entry at all, matching its `describePrivate`/`private_`-prefixed
  treatment. This is required for `roSGNode.CallFunc()` to find the function
  from outside the component (a parent/sibling calling
  `someNode.callFunc("load")`) — confirmed on a real device that `callFunc`
  does **not** fall back to resolving an arbitrary non-underscore top-level
  `sub`/`function` in the target's `.brs` when no `<interface><function>`
  entry exists for it; it silently no-ops instead. The compiler's own
  hand-authored runtime singletons (`Store.set` in
  `packages/compiler/runtime-assets/Store/Store.xml`, `switchTheme` in the
  generated theme component) already followed this pattern; ordinary `.thr`
  components didn't until this was fixed.
- **A function parameter never read anywhere in its own body is
  automatically `_`-prefixed in the generated signature** — DSL source is
  never touched, only the emitted `.brs`. An already-`_`-prefixed name is
  left alone (no double `__x`); if the prefixed name would collide with
  another real parameter in the same function, that's a compile error
  (`dsl/param-prefix-collision`).
- **A local variable (a plain `x = expr` assignment, never read afterward)
  is dropped from the generated `.brs` entirely** — "if it's never read, it
  isn't needed." This only elides a plain assignment whose right-hand side
  contains no function/method call anywhere in it — a call might have a
  side effect worth keeping even though its result is discarded, so a
  dead-store call (`x = SomeCall()`) is left in place unelided. A compound
  assignment (`x += 1`), or an indexed/dotted assignment target, is never
  elided either way.

## Statements in function bodies

Function bodies are BrightScript-flavored text (assignments, `return`, `print`,
`stop`, `dim`, `goto`, calls — all passed through as-is, unvalidated), with
DSL-level statement forms for a `state` write (see `state` above), a `store`
write (below), and JS-shaped `if`/`for`/`for each`/`while`/`try`-`catch`.
**`if` is JavaScript-shaped, never BrightScript-shaped:**

```
if (condition) {
  ...statements...
}
```
or, inline, without braces:
```
if (condition) statement
```

Always parens around the whole condition, always `{ }` for a block — no
`then`, no `end if` in DSL source (the compiler emits those in the generated
`.brs`). No flexibility in the shape: it's this or nothing, not "parens
optional" / "braces optional depending on taste."

- The inline form's statement runs to the end of the line. A trailing `;` is
  accepted and stripped (optional, not required — the rest of the body has
  no semicolons, matching BrightScript's own statement style).
- `packages/flash-parser` structurally parses the JS-shaped `if` into a typed
  `IfStatement`/`Block` AST; `codegen/brs-emitter.ts` prints BrightScript's
  `then`/`end if` by walking that AST (not a text-splice transform) — see
  `findings/compiler-codegen-conventions.md`.

### `else` / `else if`

```
if (condition) {
  ...
} else if (condition2) {
  ...
} else {
  ...
}
```

- `else`/`else if` may follow either form of `if` — block or inline — and
  either form may itself be an `else if`/plain `else` in turn, so a chain of
  any length is allowed: `if (c1) s1 else if (c2) s2 else if (c3) s3 else s4`
  is valid as one fully-inline chain, exactly like the block form above.
- An inline `else` (or `else if`) runs to the end of the line the `else`
  keyword itself is on — it does **not** have to share a line with the `if`
  it follows; `if (c) s1` on one line and `else s2` on the next is the normal
  style. It can also all sit on one line: `if (c) s1 else s2`.
- The generated `.brs` always uses BrightScript's flat `if`/`else
  if`/`else`/`end if` form (one `end if` closes the whole chain), regardless
  of whether the DSL source used the block or inline shape per branch — see
  `findings/compiler-codegen-conventions.md`.

### `store(...)` write

```
store(<topLevelKey>) = <expression>
```

- Writes the store — see "Global store" below for what it is. `<topLevelKey>`
  must be a **single, dot-free segment** — `store(some.value) = 2` is a
  compile error (`statement/store-nested-write`). Only a whole top-level key
  can ever be replaced at once; there is no way to write through a nested
  path. This isn't an arbitrary restriction: a real SceneGraph field
  observer only fires when the field itself is reassigned, never when
  something mutates a nested value already stored in it in place, so a
  nested write would silently fail to notify any `watch` watching that key.
  See `findings/reactivity-state.md` for the full rationale.
- Compiles to a call on the store's own `set(key, value)` function:
  `m.global.ft_store.callFunc("set", "<topLevelKey>", <rewritten expression>)`.
  The right-hand side goes through the normal identifier-rewrite, so it can
  freely reference `field`/`derived`/`state`/`read`/`watch` names, `theme.*`,
  locals, and builtins.
- Valid only inside a function body, same as a `state` write.

### `scale` (statement form)

`scale <name> = <expression>` / `scale state <name> = <expression>` — see the "scale" section
above (under "Declarations in the `<script>` region") for the full writeup, including the
declaration-level forms this mirrors.

### Raw BrightScript passthrough

```
' flash-theater:raw
<any BrightScript, any number of lines>
' flash-theater:end-raw
```

An escape hatch for BrightScript this DSL has no sugar for (and may never get) — everything
between the two marker comments is copied into the generated `.brs` **completely unchanged**: no
identifier-rewrite (`field`/`derived`/`state`/`private function` names are **not** auto-resolved —
write the real generated form by hand, e.g. `m.top.<field>`, `m.<derived>`, `private_<fn>()`), no
elision, no reformatting beyond re-indenting to the surrounding depth (see below). Both marker
comments are reprinted around the emitted block, so the generated `.brs` shows exactly which span
passed through untouched.

- **Valid as a statement** inside a `.thr` function body or a `.flsh` method/constructor body,
  freely interleaved with ordinary statements — and **as a top-level declaration** in a `.thr`
  `<script>` section, a sibling of `field`/`derived`/`function`. A top-level raw block's content is
  appended, in source order, to the very end of the generated `init()` — after every other
  reactive/binding/focus setup `init()` already does, so it always runs once the rest of the
  component is already initialized.
- **Not supported as a top-level `.flsh` class-body declaration** — unlike a `.thr` component, a
  class isn't guaranteed to have any lifecycle sub to land one in (a class may declare zero
  constructors). A raw block inside an *existing* method or constructor body works exactly like the
  `.thr` statement-level form.
- **Not valid** as the single-statement body of an inline `if (cond) stmt` / `else stmt` (those
  require exactly one statement on the same line) — only inside a `{ }` block body. Also not valid
  inside template markup or a `{expr}`/`bind:`/`on:key[...]` binding expression — none of those have
  a statement list to host it in.
- **No nesting** — only the end marker terminates a raw block; a `' flash-theater:raw` line
  appearing before the matching end marker is inert text, not itself a new marker.
- The marker text is matched exactly (case-sensitive, trimmed) — `' flash-theater:raw` /
  `' flash-theater:end-raw`, nothing more, nothing less, one per line.
- **Re-indentation only** — the block's own content is dedented to its minimum common leading
  whitespace, then reprinted at the surrounding depth; *relative* indentation between the block's
  own lines survives untouched. This is the one shape change applied — the DSL author's own
  formatting choices inside the block are otherwise preserved exactly, and neither a formatter nor
  a linter runs over raw-block content (this compiler has neither yet for any DSL construct).
- **Compile-time validated as real BrightScript** — the captured text is parsed eagerly with this
  DSL's own vendored BrightScript grammar the moment it's captured, exactly like every other
  embedded statement/expression region (see `findings/compiler-parser-architecture.md`). A genuine syntax
  error inside a raw block is `statement/invalid-raw-brightscript`, attributed to the author (not a
  compiler bug) — unlike this repo's separate, opt-in-only post-codegen `validateGeneratedBrs`
  check, this one always runs. An unterminated block (`' flash-theater:raw` with no matching end
  marker before the enclosing block/file ends) is `statement/unterminated-raw-block`.
- A real BrightScript local variable assigned inside a raw block (`result = ...`) is still visible
  to later ordinary DSL code in the same function, exactly as if it had been assigned in an ordinary
  statement — raw-block content still participates in local-variable scope tracking, only
  identifier-*rewrite* is skipped.
- See `findings/raw-brightscript-passthrough.md` for why this feature's comment-*content*-driven
  boundary detection is a deliberate, one-off exception to this repo's usual token-based grammar
  rule (`findings/compiler-architecture.md`'s "Never do this" section).

### Ternary (`? :`)

```
<target> = <condition> ? <whenTrue> : <whenFalse>
state <name> = <condition> ? <whenTrue> : <whenFalse>
```

BrightScript has no ternary operator, so this is DSL-only sugar the compiler expands into a
hoisted temp variable plus an ordinary `if`/`else`:

```
value = cond ? a : b
```
compiles to:
```
value = Invalid
if (cond) then
  value = a
else
  value = b
end if
```

- **Only these two host shapes are allowed**: the entire right-hand side of a plain bare
  assignment (`<target> = ...`), or of a `state <name> = ...` write — both inside a function body.
  A ternary is **not** allowed in a `derived`/`state` *declaration*'s default, a template `{expr}`
  binding, an `{#each}` collection/key expression, a `store(...)`/`focus(...)` write, an `if`
  condition, or a `return` — `?` is never valid BrightScript expression syntax on its own, so
  writing one in any of those positions surfaces as an ordinary `expression/parse-error`/
  `statement/parse-error`, the same diagnostic a typo there would already produce.
- **Nesting is fully general** — a ternary may appear:
  - chained in the false branch, unparenthesized: `c1 ? a : c2 ? b : c` (right-associative, any
    chain length)
  - nested in the true branch, unparenthesized: `c1 ? c2 ? a : b : c`
  - nested inside a parenthesized/bracketed sub-expression anywhere in the right-hand side:
    `x = 1 + (cond ? a : b)`, `x = foo(cond ? a : b)`, `x = [cond ? a : b, c]`
  - as more than one independent ternary in the same right-hand side: `x = (a?b:c) + (d?e:f)`
- **Multiple/nested ternaries lower innermost-first**, each into its own `ft_ternary_N = Invalid` +
  `if`/`else` block, hoisted immediately before the statement that needs the value, with the
  temp-var name substituted back into wherever the ternary was used (including inside a larger
  surrounding expression). See the worked example:
  ```
  value = cond1 ? (cond2 ? a : b) : c
  ```
  compiles to:
  ```
  ft_ternary_1 = Invalid
  if (cond2) then
    ft_ternary_1 = a
  else
    ft_ternary_1 = b
  end if
  ft_ternary_2 = Invalid
  if (cond1) then
    ft_ternary_2 = ft_ternary_1
  else
    ft_ternary_2 = c
  end if
  value = ft_ternary_2
  ```
- **Branch evaluation is eager, not short-circuited**: every branch's own nested ternary lowering
  runs unconditionally, before the `if`/`else` that would normally decide which branch "wins" —
  so a nested ternary sitting in the branch that turns out not to be taken is still computed. This
  is a deliberate trade-off (implementing true lazy evaluation would require every hoisted block to
  itself be conditionally guarded, a substantially larger transform), not an oversight — no
  different in spirit from this DSL's existing stance that an ordinary function call anywhere is
  never assumed side-effect-free.
- Each branch/condition goes through the normal identifier-rewrite, exactly like any other
  expression — freely referencing `field`/`derived`/`state`/`read`/`watch` names, `theme.*`,
  locals, and builtins.
- **Known limitation**: a ternary-bearing assignment does not participate in unused-local elision
  (see "A local variable... is dropped from the generated `.brs` entirely" above) — it is always
  emitted, even if its target is never read afterward.

### Comparison and relational operators (`==`/`!=`/`<`/`>`/`<=`/`>=`)

```
<left> == <right>
<left> != <right>
<left> < <right>
<left> > <right>
<left> <= <right>
<left> >= <right>
```

DSL-only crash-safe equality/inequality/ordering — distinct from real BrightScript `=`/`<>`, which
stay available unchanged and still compile verbatim (writing `=`/`<>` in a `.thr`/`.flsh` file is
never an error; every operator in this section is purely additive sugar, not a replacement). A bare
BrightScript `=`/`<>`/`<`/`>`/`<=`/`>=` crashes at runtime when its two operands are different,
incompatible types (e.g. comparing an integer field to `Invalid`, or a string to a
`roAssociativeArray`) — this whole section's sugar exists specifically to avoid that failure mode.
`==`/`!=` and `<`/`>`/`<=`/`>=` differ in what "crash-safe" means for them, though (see below):
equality has an obviously-safe fallback *value* (`false`) for a genuine type mismatch; an *ordering*
comparison between incompatible types does not, so it throws instead.

- `<left> == <right>` compiles to `ft_equals(<left>, <right>)`; `<left> != <right>` compiles to
  `Not ft_equals(<left>, <right>)`. `ft_equals` is a single shared runtime helper
  (`packages/compiler/runtime-assets/SafeCompare/FlashTheaterSafeCompare.brs`), copied once into
  `components/FlashTheater/SafeCompare/` and wired onto every component/class that needs it via a
  `<script uri="...">`, the same dedup mechanism a `.flsh` class's own transitive imports already
  use — never a per-component copy.
- `ft_equals(left, right)` compares each operand's `Type(Box(...))` first — a genuine type mismatch
  (e.g. `roInt` vs `roInvalid`) returns `false` immediately, without ever reaching a real comparison
  that would otherwise crash. Three cases get their own comparison strategy instead of a mismatch
  check, matching JavaScript's own `==` more closely than a strict same-type check would:
  - **Numeric operands compare by value across subtypes.** `Integer`/`Float`/`Double`/`LongInteger`
    each box to a *distinct* component (`roInt`/`roFloat`/`roDouble`/`roLongInteger`) — `3 ==
    3.0` is `true`, never forced `false` just because BrightScript happened to box the two
    operands differently. Once both operands are confirmed numeric (of any of the four subtypes,
    not necessarily matching each other), `ft_equals` falls through to a real `left = right`,
    which BrightScript itself promotes correctly across numeric subtypes without crashing.
  - **`roArray`/`roAssociativeArray` operands compare by reference identity**
    (`CreateObject("roUtils").isSameObject(left, right)`, Roku OS 15.0+), never by deep content
    equality — two separately-built arrays/AAs with identical contents are NOT `==`, exactly like
    JavaScript's own `==`/`===` on arrays/objects. Only fires when both operands are the same kind
    (both arrays, or both associative arrays) — an array compared to an associative array is a type
    mismatch, `false`.
  - **`roSGNode` operands compare via `isSameNode`** (`ifSGNodeDict`, identity comparison — the
    node-specific counterpart to `isSameObject`, since a generic identity check is not guaranteed
    safe for SceneGraph nodes) after first confirming both operands' `subtype()` strings match.
  - Every other type (`String`, `Boolean`, `Invalid`, `Function`, ...) keeps the original
    same-type-then-`left = right` behavior.
- **`<left> < <right>`/`<left> > <right>`/`<left> <= <right>`/`<left> >= <right>` compile to
  `ft_relationalGuard(<left>, <right>, "<op>")`** — a single shared runtime helper
  (`packages/compiler/runtime-assets/SafeRelational/FlashTheaterSafeRelational.brs`), wired in the
  same way `ft_equals` is (own dedicated `<script uri="...">`, own directory — a component using only
  `<`/`>`/`<=`/`>=` never has to ship the equality helper too, and vice versa). `ft_relationalGuard`
  checks both operands are **orderable** — both numeric (any subtype) or both `String` — before doing
  the real comparison; anything else (`Invalid`, `Boolean`, `roArray`, `roAssociativeArray`,
  `roSGNode`, or mismatched families) **throws** a structured error instead of guessing a fallback
  value:
  ```brs
  { code: "relational/type-mismatch", message: "flash-theater: cannot compare <leftType> and <rightType> with '<op>' — relational operators require two numbers or two strings." }
  ```
  Unlike equality, there's no identity-based fallback for an array/AA/node here — *ordering* one has
  no meaning at all, so any non-numeric/non-string pairing throws rather than silently returning a
  meaningless `true`/`false`. The thrown value is a plain BrightScript associative array with a
  stable `code` field (for a `catch e` block to branch on programmatically) alongside `message` (for
  a human to read) — catchable via this DSL's own `try`/`catch` (see the "Statements" reference for
  `try`), since a bare `throw` doesn't stop the app on its own if it's caught.
- Existing `.thr`/`.flsh` source using `<`/`>`/`<=`/`>=` needs no changes — every relational
  comparison in real source now simply compiles to a function call instead of a raw operator (the
  generated `.brs` differs; the DSL source doesn't). This mirrors the existing `==`/`!=` precedent:
  crash-safety over raw per-comparison performance.
- Valid in every position an ordinary expression is: a `derived`/`state`/`read`/`watch` default, a
  template `{expr}` binding, an `{#if}`/`{#each}` condition/collection/key expression, an `if`
  condition, a `store(...)`/`focus(...)` write, a function body's own expressions/statements, and a
  `.flsh` class body (field initializer, `super(...)` argument, method body, constructor). Each
  operand goes through the normal identifier-rewrite exactly like anywhere else, so it can freely
  reference `field`/`derived`/`state`/`read`/`watch` names, `theme.*`, locals, and (inside a class
  body) `m.<name>`/`self.<name>` member access.
- **Fully nestable** — `(a == b) == c`, `(a < b) == c`, a comparison as a call argument, a
  comparison as a ternary's own condition/branch, etc. all work; each operand is independently,
  recursively resolved before the surrounding `ft_equals(...)`/`ft_relationalGuard(...)` call is
  assembled.
- Parsed by `flash-parser`'s `BsComparisonExpression` node — all six operators (`==`/`!=`/`<`/`>`/
  `<=`/`>=`) recognized at the same precedence tier as real BrightScript's still-unguarded `=`/`<>`,
  but kept structurally distinct so the compiler's lowering can find them specifically (branching on
  the node's own `.operator` to decide `ft_equals(...)` vs `ft_relationalGuard(...)`) — never by
  reinterpreting an ordinary BrightScript binary expression after the fact.

### Safe NOT (`!`)

```
!<operand>
```

DSL-only crash-safe unary NOT — distinct from real BrightScript `Not`, which stays available
unchanged and still compiles verbatim (writing `Not` in a `.thr`/`.flsh` file is never an error; `!`
is purely additive sugar, not a replacement). A bare BrightScript `Not` crashes at runtime when its
operand isn't a Boolean (e.g. `Invalid`, or a numeric field never explicitly guarded) — `!` exists
specifically to avoid that failure mode, the same way `==`/`!=` exist for `=`/`<>`.

- `!<operand>` compiles to `ft_not(<operand>)`. `ft_not` is a single shared runtime helper
  (`packages/compiler/runtime-assets/SafeNot/FlashTheaterSafeNot.brs`), copied once into
  `components/FlashTheater/SafeNot/` and wired onto every component/class that needs it via a
  `<script uri="...">` — the same dedup mechanism `ft_equals` (see "Comparison" above) already uses,
  as its own dedicated asset (never folded into SafeCompare's own file, so a component using only
  `!` never pulls in the equality helper).
- `ft_not(value)` checks `Type(Box(value))` first — only a genuine `roBoolean` is actually negated
  (`Not value`); any other type returns `false` immediately, without ever reaching a real `Not` that
  would otherwise crash. Unlike `ft_equals`, there is no cross-subtype special case — Boolean has
  exactly one boxed type.
- Valid in every position an ordinary expression is: a `derived`/`state`/`read`/`watch` default, a
  template `{expr}` binding, an `{#if}`/`{#each}` condition/collection/key expression, an `if`
  condition, a `store(...)`/`focus(...)` write, a function body's own expressions/statements, and a
  `.flsh` class body (field initializer, `super(...)` argument, method body, constructor). The
  operand goes through the normal identifier-rewrite exactly like anywhere else, so it can freely
  reference `field`/`derived`/`state`/`read`/`watch` names, `theme.*`, locals, and (inside a class
  body) `m.<name>`/`self.<name>` member access.
- **Fully nestable** — `!!x` (double negation), `!(a == b)` (negating a comparison), `!` as a call
  argument, `!` as a ternary's own condition/branch, etc. all work; the operand is independently,
  recursively resolved before the surrounding `ft_not(...)` call is assembled.
- Parsed by `flash-parser`'s `BsSafeNotExpression` node (`!` recognized at the same precedence tier
  as BrightScript's own `Not` — right-recursive, so `!a and b` parses the same shape as `Not a and
  b` — but kept structurally distinct from `BsUnaryExpression` so the compiler's lowering can find it
  specifically) — never by reinterpreting an ordinary BrightScript unary expression after the fact.

### Chain safety (`?.`/`?[`/`?(`/`?@`)

Every member access (`.foo`), array/index access (`[3]`), and function call (`(...)`) in
**generated `.brs` output** — regardless of where the text originated from in `.thr`/`.flsh`
source — is automatically rewritten to use BrightScript's own native optional-chaining operators
(`?.`, `?[`, `?(`, `?@`; Roku OS 11.0+), so generated code never crashes just because an
intermediate value in an access chain turns out to be `invalid`:

```
x = array[3].foo.bar("my argument")
```

compiles to

```brs
x = array?[3]?.foo?.bar?("my argument")
```

- **Compiler-generated codegen only — never DSL source syntax.** A `.thr`/`.flsh` author never
  writes `?.`/`?[`/`?(`/`?@` themselves; the compiler inserts them automatically, everywhere,
  in every position that's syntactically legal. **Writing one by hand in source is a compile
  error** (`expression/optional-chaining-not-allowed-in-source`) — it would be redundant at best,
  since the compiler already inserts it, and it's never necessary to express anything an author
  couldn't already write with plain `.`/`[`/`(`.
- **No runtime helper, unlike `==`/`!=`/`!` above** — this is a pure syntactic transform using
  BrightScript's own built-in operators, not a lowering to an `ft_`-prefixed function call. No
  `<script uri="...">` wiring, no `runtime-assets/` directory, no per-component opt-in: it applies
  uniformly to every component and class.
- **Uniform scope — every member/index access, even a lone non-chained one.** `x.foo` alone
  compiles to `x?.foo`, not just multi-hop chains. This includes chains the compiler itself
  assembles during earlier lowering passes (a `theme.*`/`store.*` global-path read, a `.flsh`
  class's `m.<name>`/`self.<name>` member access) — not just literal characters an author typed.
- **Three positions are deliberately excluded, left as plain BrightScript, entirely untouched** —
  Roku's own optional-chaining operators cannot legally appear there at all:
  - **An assignment's target (left-hand side).** `array[12] = x` stays exactly as written — Roku
    rejects `array?[12] = x` as a syntax error. This is the *whole* target chain, not just its
    final segment: `obj.a.b = c` leaves `obj.a.b` completely untouched (only the RHS, `c`, is a
    read context and gets chained if it's itself an access).
  - **A bare, void-context call statement** — a full statement whose entire content is just a call
    chain with its result discarded, e.g. `obj.foo.bar()` on its own line. Roku also rejects
    `obj?.foo?.bar()` used this way as a syntax error. The *call's own arguments* are still an
    independent read context, though: `obj.foo.bar(x.y.z())` compiles to
    `obj.foo.bar(x?.y?.z?())` — the outer statement's own spine stays plain, but the argument
    `x.y.z()` still gets fully chained.
  - **A call whose callee is a bare identifier — a plain global function or built-in, never a
    chain.** `someFunction(a, b)` stays `someFunction(a, b)`, never `someFunction?(a, b)`, in
    *every* context (including a read context, e.g. the right-hand side of an assignment) — Roku's
    compiler rejects `?(` on a built-in or global function name outright ("Install Failure:
    Compilation Failed" at install time, live-verified on-device — this is *not* the same
    restriction as the previous two, which are ordinary syntax errors). `?(` is only ever emitted
    when the callee is itself a chain: `obj.method()` → `obj?.method?()`, but
    `standaloneFunction(x.y)` → `standaloneFunction(x?.y)` (the bare callee stays plain; its own
    argument, a genuine chain, still gets protected). This applies identically to every runtime
    helper the compiler itself emits (`ft_equals(...)`, `ft_relationalGuard(...)`, `ft_not(...)`,
    `ft_scale(...)`, `CreateObject(...)`) and to every DSL-declared `public`/`private function` —
    none of these ever gain a `?` on their own call parens, only on their arguments.

  In the first two cases, a *partial* rewrite (chaining every hop but the last) wouldn't add real
  safety anyway — if an earlier optional hop already short-circuited to `invalid`, the final plain
  write/call on it would still crash — so the whole chain is left alone rather than half-done.
- **Fully recursive** — a chain nested anywhere inside another expression (a call argument, an
  index subscript, one branch of a comparison or ternary) gets the identical treatment,
  independently of its surrounding context.
- Applies to every component and every `.flsh` class uniformly; there is no DSL-level toggle to
  opt out (mirroring `==`/`!=`/`!`'s own "no way to opt out of crash-safety" design).

### `for` / `for each`

```
for (<var> = <start> to <end>) {
  ...statements...
}
for (<var> = <start> to <end> step <step>) {
  ...statements...
}
for each (<item> in <collection>) {
  ...statements...
}
```

JS-bracket sugar over BrightScript's own `for`/`for each`/`end for` — the DSL
source never spells `end for`. `step` is optional; when omitted BrightScript's
own default step (`1`) applies. **Always parens around the whole header,
always `{ }` for the body — no inline (braceless) form**, unlike `if`: a
loop body without a visible block is a much likelier source of confusion than
a one-line `if`, so this DSL doesn't offer one.

- `<var>`/`<item>` is a plain identifier — a real BrightScript local scoped to
  the loop, never rewritten, and (per the usual shadowing rule) it shadows any
  same-named `field`/`derived`/`state`/function for the rest of the loop body.
- `<start>`/`<end>`/`<step>`/`<collection>` each go through the normal
  identifier-rewrite independently, exactly like any other expression — they
  can freely reference `field`/`derived`/`state`/`read`/`watch` names,
  `theme.*`, locals, and builtins.
- The loop body is an ordinary `{ }` block — any statement valid in a function
  body (including a nested `if`/`for`/`for each`/`while`/`try`, another DSL
  `state`/`store(...)`/`focus(...)` write, ...) is valid inside one.
- **Breaking change**: because `for` is now a DSL keyword requiring this
  bracketed header, real BrightScript's own `for i = 0 to 10 ... end for`
  shape is **not** usable in `.thr`/`.flsh` source anymore — the same way a
  real BrightScript `if x then ... end if` was already unusable once the DSL's
  own JS-shaped `if` claimed that keyword. Existing raw `for` loops must be
  rewritten to the bracketed form.
- `exit for`/`continue for` pass through unchanged, exactly like `stop`/
  `print`/`return` — this DSL only claims the `for`/`for each` *statement*
  keyword itself, not every token that can follow it inside a loop body.

### `while`

```
while (<condition>) {
  ...statements...
}
```

JS-bracket sugar over BrightScript's own `while`/`end while` — same
condition-capture shape as `if`'s own condition, same "always parens, always
`{ }`, no inline form" rule as `for`/`for each` above.

### `try` / `catch`

```
try {
  ...statements...
} catch (<name>) {
  ...statements...
}
```

JS-bracket sugar over BrightScript's own `try`/`catch`/`end try`.

- `try` takes **no** parenthesized header at all — it's followed directly by
  `{ }` (`try (x) { }` is a parse error; `try` has no condition to parenthesize).
- A `catch` clause is **mandatory** — this DSL has no catch-less `try` and no
  `finally`, matching real BrightScript's own `try`/`catch` (which likewise has
  no `finally`).
- **The caught variable's parens are mandatory** (`catch (e) { }`), narrowing
  real BrightScript's own optional-paren `catch e`/`catch (e)` form — kept
  consistent with `if`/`while`/`for`'s own always-parenthesized convention.
  `<name>` is a plain identifier, a real BrightScript local scoped to the
  `catch` block, never rewritten.

### Anonymous function expressions

```
<target> = function (<param>: <Type>, ...) {
  ...statements...
}
<target> = function (<param>: <Type>, ...): <Type> {
  ...statements...
}
state <name> = function (<param>: <Type>, ...) {
  ...statements...
}
filterList(items, function (<param>: <Type>, ...) {
  ...statements...
})
```

An anonymous `function`/closure literal used as a value — same `: Type`
param/return-type convention as a named `private function`/`public function`
(never BrightScript's `as Type`), and the same "no return type → compiles to
a `sub`" rule. The author always spells `function`, never `sub` — which one
comes out in the generated `.brs` is a codegen decision, not something
written by hand.

`filterList` above is a plain, hand-written `private function`/`public
function`, not a built-in — real BrightScript's own array interface
(`ifArray`) has no `Filter`/`Map`/`ForEach`; only `Push`/`Pop`/`Peek`/
`Shift`/`Unshift`/`Delete`/`Count`/`Clear`/`Append`. What makes an anonymous
function a genuinely useful call argument is that BrightScript's own
`Function` type is a real, first-class value — it can be stored in a
variable and invoked directly (`predicate(x)`), which is exactly what a
hand-written helper like `filterList(list, predicate)` does internally with
a `for` loop. See `apps/sample-app`'s `ScheduleList.thr` (`filterDays`/
`removeToday`) for a real, compiled, working example of this shape.

- **Fully nestable, inside a function body** — usable anywhere an ordinary
  expression is legal there: a call argument (`filterList(items, function
  (x) { ... })`), an `if`/`for`/`while` header expression, a
  `store(...)`/`focus(...)` write's own argument, a ternary branch, or (as
  before) the whole right-hand side of a plain bare assignment (`<target> =
  function (...) { }`) or a `state <name> = ...` write. **The one
  exclusion**: a template
  attribute binding (a dynamic `attr="{expr}"`, `bind:`, `on:key[...]`, or a
  `{#if}`/`{#each}` block's own condition/collection/key expression) — none
  of those have a statement list to hoist a temp-var line into, so an
  anonymous function there is not yet supported; write a named
  `private function`/`public function` and call that instead.
- **The body supports the full DSL statement grammar** — a nested
  `if`/`for`/`for each`/`while`/`try`, a `state`/`store(...)` write, a
  nested anonymous function, ... — identically to a plain-assignment/`state`
  RHS host. Codegen hoists a nested occurrence to its own `ft_anon_N = ...`
  temporary, emitted immediately before the statement that uses it, with only
  the bare temp name spliced into the surrounding expression (the same
  "hoist, don't inline" shape ternary already uses, and for the same
  reason — see `findings/anonymous-functions.md` for the two DSL-parser
  internals this required: a keyword-remap step so `state`/`store`/`focus`/
  ... parse as themselves inside a nested anonymous function's own body, and
  bracket-depth tracking in the block-statement scanner so a nested `if`/
  `state`/... doesn't get mistaken for a fresh top-level statement).
- **No closure over the enclosing function's own local variables** — a real
  BrightScript anonymous `function`/`sub` literal does not close over its
  enclosing function's locals (only `m` is implicitly shared, since `m`
  binding in BrightScript follows the *call* syntax, not lexical closure).
  Referencing a name that's only a local/parameter of the *enclosing*
  function (not a `field`/`derived`/`state`/`read`/`watch`/function name)
  from inside an anonymous function's body is `expression/unresolved-
  identifier`, a compile error — this is intentional, matching real
  BrightScript runtime behavior exactly (getting this wrong would compile
  cleanly but read `Invalid` at runtime instead).
- **`field`/`derived`/`state`/`read`/`watch`/function references still work
  normally inside the body** — those aren't local-variable closures, they're
  rewritten to `m.top.x`/`m.x`/`private_x` exactly like anywhere else, and
  `m` itself is available inside an anonymous function's body the same way
  it's available in the enclosing one (an anonymous function literal called
  as a plain, non-dot local call inherits whichever `m` was already active at
  its call site — this is how every top-level function/sub in a `.thr`
  component's generated `.brs` already shares one `m` bound to the component
  instance).
- The body is an ordinary `{ }` block — any statement valid in a function
  body (including a nested `if`/`for`/`for each`/`while`/`try`, another
  anonymous function, ...) is valid inside one.
- Parsed by `flash-parser`'s `AnonymousFunctionExpression` node, reusing the
  same parameter-list/return-type-clause grammar a named function's own
  header uses — reachable both from the DSL's own statement grammar
  (`token-stream-parser.ts`, the whole-RHS host positions) and, for a nested
  occurrence, from `brightscript-parser.ts`'s general expression grammar
  (the same tier `==`/`!=` comparison sugar already occupies).

## Template

The template is **almost always valid XML** — no special markup syntax beyond the
attribute convention, and exactly two narrow, deliberate deviations (a bare attribute value, and
`on:key[...]`'s own bracket-list attribute name — both called out explicitly below where they occur):

- `attr="literal"` — a static attribute, copied 1:1 into the generated XML.
- `attr="{expression}"` — a dynamic attribute. The expression is **always**
  quoted (never `attr={expr}` without quotes) — that keeps the template
  parseable by flash-parser's own `parseXml`/`XmlDocument` (vendored and
  adapted from kopytko-brightscript-parser's XML parser) with zero
  special-casing in the tokenizer.
- A bare `attr`, with no `="..."` at all, is legal too — it means exactly the same thing as
  `attr=""`. This is the one deliberate relaxation from real XML this template grammar makes (`on:key`
  below is the other) — everywhere an empty value is already meaningful on its own (most usefully,
  `transition:`/`in:`/`out:`/`animate:` and router-outlet transition attributes' own "empty = use the
  defaults" convention — see "animation" below), the `=""` is pure ceremony, so it's optional:
  `in:bounce` and `in:bounce=""` compile to identical output. Nothing else about XML strictness
  changes — a real value still needs real quotes (`attr=val` unquoted is still an error), this only
  ever applies to omitting the value entirely.
- An element with at least one dynamic attribute **must** have an `id` — a
  compile error if missing (needed for `findNode` in the generated `init()`).
- A single root element, arbitrary nesting of children.
- Every element `id` must be unique within the template (`template/duplicate-id` if not — two
  elements sharing an `id` would cache the same node ref twice, the second silently overwriting
  the first) and must not match a declared `derived`/`state` name (`template/id-collides-with-binding`
  — both compile to the same generated `m.<name>` slot, so whichever assignment runs second in
  `init()` would otherwise silently clobber the other). An `id` matching a `field` name is fine:
  a `field` always lives at the separate `m.top.<name>` slot, so there's no clobber risk.
- `transition:<name>` / `in:<name>` / `out:<name>` (only on a direct child of an `{#if}`/
  `{#if:destroy}` block — see "Conditional rendering" below) and `animate:<field>` (auto-animates
  a matching dynamic attribute's own reactive write) are two more attribute-name conventions
  layered on top of the same "still valid XML" rule — see "animation"'s own "Layer 2"/"Layer 3"
  sections for the full grammar.
- Write a literal `<`/`>`/`&` directly in a static attribute value's text (`text="a < b"`) — the
  compiler's own XML emitter escapes it correctly (`&lt;`/`&gt;`/`&amp;`) when generating the final
  `.xml`, and Roku's own XML parser un-escapes it back to the literal character at load time.
  **Never pre-escape it by hand** (`text="a &lt; b"`) — the compiler escapes THAT text too, so the
  entity code itself ends up rendered on screen instead of the intended character, with no compile
  error to catch it (confirmed live, `findings/template-attribute-value-escaping.md`).

## Conditional rendering

```
{#if <expr>}
  ...any template content (elements, nested {#if}/{#if:destroy} blocks)...
{/if}

{#if:destroy <expr>}
  ...same...
{/if}
```

- `<expr>` is any BrightScript expression — reads reactive sources (`field`/`state`/`derived`/
  `watch`/`theme.*`/`store.*`) exactly like an ordinary dynamic attribute binding, and is
  recomputed on the same reactive cascade.
- No `{:else}` branch — a false condition means "nothing is shown/present," not "render an
  alternate branch."
- A block can appear anywhere ordinary element children can, and nests arbitrarily (an
  `{#if:destroy}` inside an `{#if}`, etc.) — but can **never be the template's sole top-level
  content** (`template/if-cannot-be-root`): the SceneGraph component root must always be a
  concretely-typed, always-present node.
- Recognized structurally by `packages/flash-parser`, not by any bespoke markup parser — the raw
  markup is still parsed by the same real XML parser every template already goes through
  (`{#if cond}<Rectangle/>{/if}` already tokenizes today as ordinary content-position text between
  tags); flash-parser scans the already-real-positioned `Text` content for the `{#if `/
  `{#if:destroy `/`{/if}` markers, depth-counting them the same way `if`-statement `{`/`}` nesting
  is depth-counted. See `findings/compiler-parser-architecture.md` for why this "real-parse-first" design
  was chosen over rewriting the markers into synthetic XML tags first.

**Compiled shape**: every block compiles to exactly one synthetic `Group` wrapper node
(`ft_if_N`, an internal, reserved name — see "Reserved `ft_` prefix" below) around the block's
real children:

- **`{#if}` (toggle)** — the `Group` is always present in the compiled `<children>` XML; `<expr>`
  drives its `visible` field, reactively, via the exact same binding/cascade machinery an ordinary
  `attr="{expr}"` binding already uses. SceneGraph's own visibility inheritance (a hidden `Group`
  hides every descendant) is what makes wrapping multiple children in one node sufficient.
  `visible=false` is rendering-only — it does not remove descendants from the focus registry (a
  toggle-mode block containing focusable content stays registered while hidden). A block that opts
  into `transition:`/`out:` (see "animation"'s "Layer 2" section) additionally gets its focusable
  content actively unregistered the moment the exit animation starts, not left dangling — see
  `findings/focus-system.md`. For a block with no transition, `FlashTheaterFocusManager.navigate()`
  itself now skips any candidate that isn't genuinely visible (its own `visible`, or any ancestor's,
  including this block's own wrapper `Group`) before scoring it — so hidden content can no longer
  win a directional search or silently consume a key press, even though it remains in the registry.
- **`{#if:destroy}` (create/destroy)** — the `Group` (and everything under it) never appears in the
  static XML at all. The first time `<expr>` becomes true, generated BrightScript hand-constructs
  the whole subtree (`CreateObject("roSGNode", ...)` + attribute assignment + `appendChild`,
  recursively) and inserts it into its parent at the correct position (a **runtime-computed**
  sibling index — a preceding sibling can itself be a destroy-mode block whose own mount state is a
  runtime fact, not a compile-time constant); when `<expr>` becomes false, the subtree is fully
  removed (`removeChild`) and every cached node ref inside it is nulled out. This is genuine
  destroy-and-recreate, not detach-and-reattach — a block's internal state never survives a
  destroy/recreate cycle, which is the whole reason `:destroy` exists as something different from
  a plain visibility toggle. A block that opts into `transition:`/`in:`/`out:` (see "animation"'s
  "Layer 2" section) defers the actual `appendChild`/`removeChild` to run alongside the enter/exit
  animation instead of instantly.

## Keyed list rendering

```
{#each <collectionExpr> as <itemAlias> (<keyExpr>)}
  ...any template content, with <itemAlias> in scope...
{/each}
```

- `<collectionExpr>` is any BrightScript expression, evaluated at runtime as either an array-like
  value (`.Count()`/`[i]`-indexable) or a SceneGraph node — a node is iterated over its own children
  (`getChildren(-1, 0)`), the branch decided at runtime via `type(...)`, no separate syntax needed.
  Item values may be anything: an associative array, a node, a plain scalar — building child UI from
  whatever shape each item has is entirely up to the template body; the compiler's only enforced
  constraint is `<keyExpr>` below. Reads reactive sources exactly like an ordinary dynamic attribute
  binding, and triggers this block's reconcile on the same reactive cascade. There is no array
  `field` type in this DSL (see "Declarations in the `<script>` region" above) — a collection comes
  from a `derived`/`state`/`watch`/function return value instead, untyped/unchecked by the compiler
  like any of those already are.
- `<itemAlias>` is a plain identifier, scoped only to this block's body — it shadows any
  same-named DSL binding inside the body (matching how a real BrightScript local already shadows a
  DSL binding), but colliding with an existing `field`/`derived`/`state`/`read`/`watch`/function/
  element-id name anywhere in the component is a compile error (`template/each-alias-collision`),
  not silent shadowing — unlike a function parameter's small, visible scope, an each-block's body
  can be large template markup where a shadowed component-wide binding would be an easy, confusing
  mistake.
- The `(<keyExpr>)` clause is **mandatory** (no index-fallback identity) — evaluated per item,
  with `<itemAlias>` in scope, and must produce a value that uniquely and stably identifies that
  item across reconciles. `<keyExpr>` is **any** BrightScript expression, not a required `.id`
  field — `(n.id)` if the item is an AA with one, but equally `(n)` for a bare scalar item,
  `(n.getField("id"))` for a node, or a composite expression, entirely up to the item's actual
  shape. **Two items sharing a key at runtime is not a compile error** (the collection's contents
  are a runtime value, not statically known) — they silently collapse onto one rendered node, a
  documented runtime contract, not a checked one.
- A block can appear anywhere ordinary element children can, and nesting is fully supported in
  **both** directions, arbitrarily deep, in any combination: an `{#each}` inside `{#if}`/
  `{#if:destroy}`; an `{#if}`/`{#if:destroy}` inside an `{#each}`'s own body; and an `{#each}`
  inside another `{#each}` (loop-in-loop). Like `{#if}`, an `{#each}` can never be the template's
  sole top-level content (`template/each-cannot-be-root`).
- Recognized structurally by `packages/flash-parser`, the same "real-parse-first" way `{#if}` is —
  see "Conditional rendering" above and `findings/compiler-parser-architecture.md`.

**Compiled shape**: every block compiles to exactly one synthetic, always-present `Group` wrapper
node (`ft_each_N`) — always present in the compiled `<children>` XML (self-closing; the item body
is never statically rendered, only constructed at runtime), *unless* the block itself is nested
inside a `{#if:destroy}` subtree (not inside another `{#each}`), in which case it comes and goes
with that ancestor exactly like an ordinary nested element would. An `{#each}` nested *inside
another* `{#each}`'s body has no XML presence or `findNode`-cacheable wrapper at all — it's
constructed fresh as part of each outer item's own subtree instead (see below).

Rendering is a **real keyed diff**, not a destroy-and-rebuild-everything pass, run by a generated
`sub` (or, for a block nested inside another `{#each}`, inlined directly into the enclosing each's
own per-item construction/update code) every time a reactive source the block depends on changes
(the collection expression itself, or any component-wide source referenced by a binding — including
a nested block's own condition/collection expression — anywhere inside the item body: any of these
always triggers a full reconcile of the block, there is no narrower "just update this one binding"
path):

1. Evaluate the collection once, computing the new ordered key list.
2. Remove every currently-rendered item whose key is no longer present.
3. Walk the new key order: reuse (and re-run every binding on, including anything nested inside it)
   a surviving item's existing node, or construct a new one; then position it at its target index.
   Node identity is preserved for a surviving key — reordering an item never destroys and recreates
   its node, only repositions it, so any of the node's own runtime state that isn't itself
   DSL-managed survives a reorder (this is also what lets anything nested *inside* a surviving
   item — a nested `{#if:destroy}` block's current mount state, a nested `{#each}`'s own rendered
   list — persist across a reorder rather than resetting).

**A block nested inside an `{#each}`'s body has no static XML presence and no flat `m.<id>` slot at
all** — since the enclosing each may render any number of copies of it, its state must be scoped to
one specific item instance. Two earlier designs were tried and rejected here, both confirmed wrong
only by real-device testing (compile-time success proved neither wrong):
- Stashing state as a **compound (AA) value nested inside a single field** on the item
  (`roSGNode.AddFields({ ft_state: {} })`, then `ft_item.ft_state.ft_if_2 = ...`) —
  confirmed wrong on a real device: a compound value written into a *different* node's field, then
  mutated via nested dot-chain writes across separate statements, doesn't reliably survive being
  read back later.
- Re-locating a nested block's own node on every access via `<itemRoot>.findNode(id)` — also
  confirmed wrong on a real device: `findNode` does not reliably scope its search to the calling
  node's own subtree when the same id string is reused across dynamically-created sibling items
  (siblings shared one literal id at the time, since each item was built from the same template with
  no per-instance uniqueness); it could resolve to a different item's node entirely. See
  `findings/template-each-nesting.md` for the full incident and the debug evidence that pinned this
  down — including the caveat that this test predates any unique-id guarantee (see below).

A third design (a real reference cached as its own flat field, added via `roSGNode.AddFields({
ft_ref_<id>: <nodeVar> })` at construction and read back via plain dot-notation) replaced `findNode`
for a while and worked, but has since been retired in favor of a fourth: **every dynamically-created
node gets a genuinely unique `id`** — the compile-time-known literal suffixed with the item's own
reconcile key (e.g. `"row_" + ft_key`) — **and is re-resolved via `findNode` at the point of use**,
with nothing cached in any field. The reasoning: design 2's on-device failure was observed with every
sibling sharing one literal id, which is equally explained by id collision as by a genuine
subtree-scoping bug in `findNode` — unique ids remove that precondition, which is the one thing that
was never actually tried before design 3 replaced `findNode` outright. This also incidentally
satisfies a separate requirement — every generated node, static or dynamic, having a truly unique id,
useful for on-device/automation testing where a shared id across rendered siblings is unusable. As
with design 2, this needs real-device confirmation before it's a settled fact, not an assumption —
see `findings/template-each-nesting.md` for the standing verification requirement.
- A nested destroy-mode `{#if:destroy}`'s wrapper gets the same unique, key-suffixed `.id` (exactly
  like a toggle-mode `{#if}`'s wrapper already has one) — its mount state is
  `<itemRoot>.findNode(<uniqueId>) <> invalid`, resolved fresh every access, never cached. There is
  no `AddFields`/`hasField()` guard to reason about here at all (a distinct quirk that only mattered
  for design 3's caching, documented below for the historical record) — its update behavior is
  otherwise the **same idempotent create-on-false→true/destroy-on-true→false check the top-level
  form already uses** — not an unconditional tear-down-and-maybe-rebuild on every pass.
- A nested `{#each}`'s wrapper gets the same unique-id/`findNode` treatment, but its `_keys`/`_nodes`
  diff bookkeeping (a genuine key→node map, not just an existence flag) still lives in the
  **enclosing component's own `m` scope** — exactly like a top-level each's `_keys`/`_nodes` already
  do — addressed by the chain of enclosing items' own reconcile keys
  (`m["$$<id>_keys"][<outerKey>]`, one more `[...]` level per further nesting; see "Reserved `ft_`
  prefix" below for the `$$`-bracket convention). Removing an outer item explicitly deletes every
  transitively-nested each's entry for that key from these dicts (this is not "for free" via node
  garbage collection, since the bookkeeping lives on `m`, not on the removed node).

**Design 3's now-historical `AddFields`-with-`invalid`-value quirk**, kept here in case a future
design ever caches a node field again: `roSGNode.AddFields()` silently fails to register a field
whose *initial* value is `invalid` (no warning, the field simply never exists — a distinct quirk
from the already-known "`AddFields()` only adds, never updates" one documented below, which fires on
a *second* write instead). Design 4 sidesteps this entirely by never calling `AddFields` for
per-item state at all.

**Known limitations**:
- The reposition step relies on `roSGNode.InsertChild`'s documented behavior that inserting an
  already-present child removes and re-inserts it at the new index, rather than erroring or
  duplicating it — confirmed on a physical Roku device (see
  `findings/template-each-reconcile.md`'s `{#each}`'s keyed diff section).
- There is no built-in "loop index" binding — only `<itemAlias>` is in scope. A list that needs a
  distinct on-screen position per item (most lists) must compute and carry that position as part of
  the item's own data (see `apps/sample-app/src/components/ScheduleList/ScheduleList.thr` for a worked
  example), since a rendered item's wrapper node has no `translation` of its own by default and a
  `{#each}`'s items are not direct children of any enclosing `LayoutGroup` for automatic layout
  purposes (they're children of the each's own wrapper `Group` instead).

## Two-way binding (`bind:`)

```
<TextEditBox id="..." bind:<childField>={<stateName>} />
```

Despite the name (kept for continuity with the original roadmap entry), `bind:` is
**one-directional only: a child node's field change flows into a `state`, never the other way
around.** `bind:` never pushes anything into the child — if a value also needs to be pushed *into*
that same child field, that's an ordinary, fully separate `attr="{expr}"` dynamic-attribute
binding on a different XML attribute name (see "Template" above), the author's own choice, not
something `bind:` manages.

- `<childField>` is generic — any field on the child node, whether a built-in SceneGraph field
  (`TextEditBox.text`) or a user `.thr` component's own declared `field`
  (`<MyCounter bind:count={n} />`). A `field` is a `field` from BrightScript's point of view
  regardless of where it's declared.
- `<stateName>` must be a single bare identifier naming a declared `state` — the DSL's only
  internally-writable reactive slot (see "`state`" above; `field`/`derived`/`read`/`watch` have no
  internal-write mechanism and can't be a bind target). `template/invalid-bind-target` if the
  expression isn't a single bare identifier; `template/bind-target-not-state` if it doesn't name a
  declared `state`.
- The raw child value (whatever type the field is — scalar, associative array, node) lands
  untransformed in the bound `state`. Any extraction or computation on it is an ordinary
  downstream `derived` reading that state — already fully general, no new syntax needed:
  ```
  state selectedUserRaw: node = invalid
  derived selectedEmail: string = extractEmail(selectedUserRaw)
  ```
- An element with a `bind:` attribute needs an `id`, exactly like an ordinary dynamic attribute
  (`template/missing-id` otherwise) — `bind:` participates in the same `hasDynamic` check.
- **`{#if:destroy}` is supported** — the reverse `ObserveFieldScoped` registration happens inline
  the moment the element is actually constructed (in the block's generated create sub), and
  `UnobserveField` is called in the generated destroy sub before the subtree is torn down.
- **`{#each}` is rejected** (`template/bind-inside-each`) — not just unimplemented: an each block
  renders N item nodes, and if every copy's `bind:` wrote into the same single `state`, whichever
  item's field fires last would win arbitrarily, with no defined "which item" semantics.

## `on:key` event binding

```
<SomeElement on:key[Key1,Key2,...]="{<call expression>}" />
```

A key-event handler binding — fires the given call expression whenever any of the listed keys is
pressed (or released) while this element is anywhere on the currently-focused node's ancestor
chain, not only when this exact element itself holds real focus (see "Focus system" below for why
that's the correct, intentional bubbling model).

- The bracket list is a **custom, non-XML attribute-name shape**, deliberately: `[`, `]`, and `,`
  are not legal XML `Name` characters, so this can't be handled as an ordinary XML attribute the
  way every other template attribute is. `packages/flash-parser` recognizes it via a dedicated,
  position-preserving pre-scan pass that runs before the real XML tokenizer ever sees the
  template — the one deliberate exception to this codebase's usual "never touch the template text
  before the real XML parse" rule. See `findings/compiler-parser-architecture.md` for the full rationale
  and mechanism.
- Each entry in the bracket list is one of Roku's own **raw, case-sensitive `onKeyEvent` key
  strings**, verbatim — `"OK"`, `"up"`, `"down"`, `"left"`, `"right"`, `"rewind"`,
  `"fastforward"`, `"options"`, `"back"`, `"play"`, etc. No translation table, no new vocabulary —
  exactly what a hand-written `onKeyEvent` chain already uses. There is no closed, checked
  vocabulary — Roku's key strings aren't statically enumerable (custom remotes, deep-link/CEC
  keys), so an unrecognized key name is not a compile error.
- A bare `*` entry is the **wildcard** — matches any key not otherwise matched by a more specific
  `on:key[...]` entry on the *same* element. An element may have both a specific-key
  `on:key[...]` and a separate `on:key[*]` (ordinary multi-attribute XML), and the specific match
  always wins; the wildcard only fires when none of that element's own specific keys matched.
- The value must be a **single call expression** at its root — `selectItem(item)`, not a bare
  identifier or `selectItem(item) + 1` (`template/on-key-expression-not-call` otherwise). The
  compiler auto-prepends `key` (string) and `press` (boolean) as the call's first two arguments,
  before any author-written ones:
  ```
  on:key[OK,play,replay]={startVideo(item)}
  ```
  compiles the injected call as `startVideo(key, press, item)`, matching a handler declared
  ```
  private function startVideo(key: string, press: boolean, item: object) {}
  ```
  (no return type → a `sub`, per this DSL's existing rule). `press = false` (a key-up event) is
  still routed through to the handler — the author's own function body decides whether to act on
  it, the generated code never filters by `press` itself.
- An element with an `on:key[...]` attribute needs an `id`, exactly like an ordinary dynamic
  attribute (`template/missing-id` otherwise) — the generated `onKeyEvent` needs a real node
  reference to check.
- **`on:key[...]` does *not* require `focusable` on the same element** — unlike `focusable`, it
  fires purely from being on the currently-focused node's ancestor chain, matching Roku's real key
  delivery/bubbling model. A container-level `on:key[back]={goBack()}` on a screen's root element
  fires without every focusable descendant needing its own handler.
- **Fully supported inside a *top-level* `{#each}` item body** — per-row handlers
  (`on:key[OK]={selectItem(item)}`) are a primary use case, unlike `bind:`'s own `{#each}`
  rejection. `item` (the each's own item alias) is in scope exactly like any other expression
  inside that block's body. **Not supported inside an `{#each}` nested inside another `{#each}`**
  (`template/on-key-inside-nested-each`) — a documented narrowing, not silently dropped.
- Never emitted into the generated XML at all — entirely `.brs`-side, resolved live at call time
  via `IsInFocusChain()` (and, for an each-scoped element, `findNode` against the same
  key-suffixed unique id `{#each}`'s own construction already establishes).

### `on:key` at the component level

```
<component on:key[OK,up,down,left,right]="{handleKey()}">
  ...
</component>
```

`on:key[...]` on `<component>` itself (see "`<component>` — the mandatory root tag" above) — same
bracket-list syntax, same `key`/`press` auto-injection, same specific-then-wildcard semantics as an
ordinary element's `on:key[...]`, but **unconditional**: no `IsInFocusChain()` guard at all, since
this binding isn't tied to any one descendant's focus state — it *is* the component (`m.top`).
Generated as the very last branch in `onKeyEvent`, after every per-element/`{#each}`-scoped
`on:key[...]` branch and after the automatic LRUD `focusable` fallthrough, immediately before the
final `return false` — matching real Roku bubbling, where a component's own `onKeyEvent` only ever
runs once nothing deeper already consumed the event. This is what lets a root component (a `Scene`,
most commonly) declare a single always-active key handler declaratively, instead of hand-writing a
raw `public function onKeyEvent(...)` that bypasses `on:key` entirely — see
`apps/sample-app/src/components/MainScene.thr` for a real example (its whole remote-control dispatch is
one `on:key[...]` binding on `<component>`, calling a single `private function handleKey(key:
string, press: boolean)` that branches on `key` itself, exactly the shape any other `on:key`
handler already uses).

## Focus system

```
<SomeElement focusable="true" />
<SomeElement focusable="{<expr>}" />
```

`focusable` reuses Roku SceneGraph's own **native** `ifSGNodeFocus` field name — not a new
DSL-invented attribute, and needs no new grammar of its own: it's an ordinary static or dynamic
attribute whose name happens to be `focusable`, ordinary `template/missing-id` rules aside.
Marking an element `focusable` registers it (and the compiled component instance that owns it) with
a fixed, built-in runtime primitive (`FlashTheaterFocusManager`, mirroring the `store`/`theme`
pattern — see "Global store") that maintains one flat, **cross-component, whole-app** registry,
giving:

- **Automatic directional grid navigation** — any component with at least one focusable element
  gets a generated `onKeyEvent` fallthrough for `up`/`down`/`left`/`right` that asks the focus
  manager to move real focus to the geometrically nearest registered neighbor in that direction.
  Standard spatial-navigation rule (the same one CSS Spatial Navigation and most game-UI focus
  engines use), not a raw distance/angle heuristic: a candidate counts as being "in" a direction
  **only** when its bounding box genuinely *overlaps* the focused box on the perpendicular axis
  (e.g. for "down", the two elements' horizontal spans overlap, however slightly, and the
  candidate sits below) — among overlapping candidates, nearest by primary-axis distance wins. A
  same-sign-but-non-overlapping candidate (genuinely diagonal, nothing really lines up) is **never**
  a match, not even as a fallback of last resort — if nothing genuinely overlaps in a direction,
  navigation simply does nothing in that direction, which is the correct outcome for a real
  boundary, not a gap to paper over. An earlier design first tried "primary-axis offset must
  exceed the perpendicular one" (a 45° cone), then briefly tried a same-sign fallback tier when
  overlap found nothing — both confirmed live as wrong: the cone test broke perfectly ordinary,
  not-pixel-aligned layouts (excluding a candidate a real user would obviously consider "the one
  below"), and the fallback tier reintroduced exactly the bug the overlap rule exists to prevent.
  See `findings/focus-system.md` for the full trace. No configuration needed for the common case —
  a screen full of `focusable="true"` elements just navigates.
  Distance is computed from each candidate's **absolute** on-screen position (summed `translation`
  up to the Scene root), not `BoundingRect()` (which is relative to a node's immediate parent
  only) — required for candidates from *different* components to compare correctly at all; see
  `findings/focus-system.md` for the real-device bug this fixes.
  **Two-pass, not one flat search across the whole registry**: the currently-focused element's own
  *component instance* is searched first — every other focusable element belonging to that same
  instance, however far away it is on screen. Only once that finds nothing (a genuine boundary —
  no more of this component's own content in that direction) does the search widen to every other
  component's focusable content, app-wide, exactly as before. This is what makes a component with
  a large or irregular focusable area (a scrollable grid, say) exhaust its own content in a
  direction before navigation ever leaves it for a geometrically-closer neighbor belonging to a
  different component — reported live as focus otherwise feeling like it "mixes everything
  together"; see `findings/focus-system.md`.
  **Which specific element receives focus when the search crosses into a different component is
  that component's own concern, not a fresh geometric pick** — the focus manager remembers each
  component's own most-recently-focused element and restores it on re-entry (the same principle
  `recoverFocusFor()` already uses for tree-mutation recovery), falling back to the geometrically
  nearest element only the first time that component is ever entered. Without this, navigating out
  of a component and back could land on a different element than the one you left, purely because a
  fresh geometric search happened to prefer something else at that moment.
  **A cross-component candidate that lives inside a scrolled ancestor (declares
  `scrollOffsetX`/`Y`, see "Scroll-into-view" below) is scored using only its currently-visible
  portion, clipped to that ancestor's viewport window — not its full, possibly mostly off-screen
  extent.** `clippingRect` (see below) stops off-screen content from *rendering*, but says nothing
  to `navigate()`'s own geometry on its own; without this, an oversized element only partially
  scrolled into view could still win a cross-component match purely because its full (mostly
  invisible) bounding box happened to be geometrically closer than a fully-visible candidate
  belonging to a different component — confirmed live. A same-component candidate is exempt: a
  not-yet-visible neighbor is the ordinary, expected case while navigating within one scrollable
  component (that's the whole point scroll-into-view exists for).
- **Hold-to-repeat** — a held directional press keeps navigating instead of moving only once:
  Roku's `onKeyEvent` does not itself auto-repeat while a button stays physically held (it fires
  exactly once on press and once on release), so the focus manager arms its own repeat on a
  successful `navigate()` and cancels it on release. Delay-then-accelerate, not a fixed rate: a
  pause after the immediate first move, then repeats that start at a comfortable pace and speed up
  the longer the button stays held, stopping on its own once there's no further candidate in that
  direction. No configuration option exists yet — the timing is fixed in
  `FlashTheaterFocusManager.brs`'s `repeatTuning()`.
- **Focus highlight** — the newly-focused node's own `color` field (present on any colorable node
  type — `Rectangle`, `Poster`, `Label`, ...) is swapped to a fixed highlight color, restoring the
  previous value on the next focus move. Not a new `field`/attribute convention — reuses whatever
  `color` field the node already has, since a per-`{#each}`-item node (a grid tile, say) is a plain
  dynamically-created SceneGraph node, not a compiled `.thr` component of its own, so there's no
  natural place to declare a custom field on it. A no-op on a node with no `color` field.
- **Automatic focus recovery on removal** — destroying the currently-focused element (a
  `{#if:destroy}` block tearing down, or an `{#each}` item being removed) no longer leaves focus
  routing dead app-wide (a confirmed, real Roku behavior otherwise — see
  `findings/focus-system.md`). The generated teardown code unregisters the removed
  element before detaching it, and calls the focus manager's `recoverFocusFor(m.top)` **once, at
  the very end** of that whole removal pass (never inline, mid-pass) — confirmed live that
  reassigning focus any earlier gets silently clobbered by `{#each}`'s own later, unconditional
  item repositioning.

  Recovery is **scoped to the component whose own teardown actually lost focus**, not global:
  `recoverFocusFor` does nothing at all unless the node that just went away was the one holding
  focus *and* was somewhere inside the subtree this component's own `{#if:destroy}`/`{#each}`
  teardown just removed — including a NESTED CUSTOM COMPONENT's own focusable content, registered
  under that component's own `m.top`, not this one (`unregisterSubtree` walks the registry by live
  ownership at teardown time and reassigns the recorded loss to this component before the node is
  detached, so recovery still fires correctly even though the destroyed content's own registration
  never mentioned this component by name — see
  `issues/focus-destroy-nested-component-orphaned-registration.md`). Every other call is a cheap
  no-op. This precision matters more than it looks
  — an earlier, deliberately blunt version ("if *nothing* in the app holds focus, grab the first
  registrant") was correct in isolation but wrong as soon as components nested: during a fresh
  screen's construction there is legitimately no focus anywhere yet, so a *nested child*
  component's own reconcile would fire, see the vacuum, and grab an arbitrary element belonging to
  a completely different component — which then outranked the screen's own
  `default-focus="true"`. Confirmed live; see `findings/focus-system.md`.

  When this component *is* the one that lost focus, recovery picks, in order: its own
  `default-focus="true"` element (or first registrant), then wherever focus most recently was in
  some other still-registered component (which is what makes "close an overlay, land back where
  you were" work with no per-app bookkeeping), then the Scene itself (wired in via one hand-written
  `Main.brs` line, the same convention `store`/`theme` already use) as a last resort.
- **`default-focus="true"` — declaring a component's own explicit default focus target.** Static
  only (never `focusable="{expr}"`-style reactive), and only alongside a static
  `focusable="true"` on the *same* element (`template/default-focus-must-be-static`/
  `template/default-focus-requires-static-focusable` otherwise). At most one per component
  (`template/multiple-default-focus`) — a provable, compile-time ambiguity otherwise, the same
  treatment the nested-focusable conflict check above gets for a different kind of ambiguity.
  `default-focus="true"` means exactly one thing, no matter how focus arrives: **when focus enters
  this component and the component has no remembered last-focused element of its own, land here.**
  All four entry paths honour it — a cross-component arrow-key `navigate()`, `focus(<id>)`, a
  router-mounted screen's own first mount (see the "Router" section below), and automatic recovery
  after this component's focused element was destroyed. With none declared, the first registered
  focusable element (registration/document order) receives focus instead, except on arrow-key
  entry, where the geometrically nearest element quite reasonably wins — a spatial entry has a
  spatial answer, and only an explicitly declared default overrides it.

  It does **not** mean "grab focus when I appear": a component mounting while the user is focused
  somewhere else never steals focus (see the vacuum rule under "Router" below). The declared
  default simply waits until focus genuinely enters. Most useful for a freshly `CreateObject`'d
  component, which can never have any "remembered last focus" to fall back on instead (that memory
  is keyed by node reference, and a fresh instance's reference didn't exist a moment ago):
  ```
  <Rectangle id="prompt" focusable="true" default-focus="true" on:key[OK]="{...}">
    <Label id="promptLabel" text="Press OK to continue" />
  </Rectangle>
  ```
- **Reactive registration for a dynamic `focusable="{expr}"`** — the element registers/unregisters
  itself automatically as the expression's own value changes, through the same reactive cascade
  any other dynamic attribute already uses. This is what makes a **parent → child focus handoff**
  (drill-down navigation) work: flip the parent's `focusable` expression to `false` in the same
  handler that hands real focus to a child, so the two are never simultaneously registered. The
  parent can never carry `default-focus="true"` itself (that requires *static* `focusable="true"`,
  which its own dynamic toggle rules out) — not a problem in practice, since whenever the parent
  isn't handed off it's the only registered focusable node around, so it's already the plain
  geometric winner on cross-owner arrow-key entry. If the child also exits back to the parent on
  **back**, put that `on:key[back]` on the child element(s), never on `<component>` — a
  component-level `on:key[...]` is unconditional (no `IsInFocusChain()` guard at all, see "`on:key`
  at the component level" below), so it would swallow **back** even while the parent itself holds
  focus (before any handoff happened), breaking ordinary back-navigation out of the component
  entirely. A per-child handler only fires while that child is genuinely focused, which only
  happens after the handoff. See `apps/sample-app/src/components/RichCard/RichCard.thr` for a full
  worked example (OK enters, arrow keys navigate only the child content, back exits), verified live
  end to end.
- **Explicit, non-directional focus transfer into one of THIS component's own descendants —
  `focus(<id>)`.** A reserved keyword, usable as an ordinary statement anywhere in a function body
  (most commonly an `on:key` handler), that sends real focus into a specific descendant — a direct
  child, or a nested custom component's own root — identified by its declared `id`:
  ```
  private function jumpToTop(key: string, press: boolean) {
    if (press) {
      focus("row0")
    }
  }
  ```
  `<id>` is any BrightScript expression evaluating to a **string** (a literal, or a `field`/`state`
  holding one) — never a node reference. Compiles to
  `m.global.ft_focus.callFunc("focusComponent", m.top.findNode(<rewritten id>))` — `<id>` is always
  wrapped in `m.top.findNode(...)`, scoped to **this component's own subtree only**. This is a
  deliberate, structural restriction, not an oversight: `focus(<id>)` can **never** reach a sibling
  or any other unrelated branch of the app, on purpose — see "Cross-component focus transfer between
  siblings" right below for why, and for the actual pattern to use when the target isn't your own
  descendant.

  `<id>` may name either a focusable leaf directly (e.g. `"row0"` above — an ordinary
  `focusable="true"` element, focused immediately) or a nested custom component's own root: entering
  a *component* this way lands on its own remembered last-focused element if it has one (the exact
  same per-owner memory the cross-component `navigate()` case below already uses), otherwise its
  first registered focusable element — which of the two `<id>` named is detected automatically at
  runtime, no different DSL syntax needed. A no-op if `<id>` doesn't resolve to a real descendant.
  Useful for author-triggered jumps `navigate()`'s geometric search wouldn't produce on its own —
  e.g. a dedicated "jump to top" key on a component with several own focusable
  children. See `apps/focus-demo`'s `FocusGroup.thr` (`on:key[OK]` calling `focus("row0")`, one of
  its own three rows) for a worked example. `focus` is a **reserved keyword** — a `field`/`derived`/
  `state`/`read`/`watch`/function literally named `focus` is a parse error, the same way
  `state`/`store`/etc. already are. Unlike `store(...)` (restricted to exactly three grammar
  positions — `read`/`watch`'s RHS or a write statement's target), `focus(...)` is a plain statement
  usable anywhere in a function body.

  **Cross-component focus transfer between siblings.** `focus(<id>)` cannot reach a sibling — by
  design, not as a missing feature (an earlier version resolved `<id>` against the whole scene,
  reachable from anywhere in the app; rejected as a real architectural mistake, see
  `findings/focus-system.md`). Reaching a sibling has to go through a common parent, the same
  child→parent→child relay every other piece of cross-branch data in this framework already uses:
  the child sets its own outbound `field` (an ordinary declared field, written from a `private
  function` via `m.top.<field> = <value>` — see the note on bare-identifier field writes below), the
  parent observes it (`bind:` if the parent is itself a compiled `.thr` component; a hand-wired
  `ObserveFieldScoped` if the parent is hand-composed BrightScript, like `apps/focus-demo`'s
  `CrossSiblingRelayDemo.brs`, a router-mounted chapter with no template of its own — kept
  hand-written on purpose, see that file's own top-of-file comment) and reacts by calling
  `focus(<siblingId>)` **itself** — valid there because the sibling IS the parent's own child. See
  `apps/focus-demo`'s `SimpleFocusItem.thr` (sets `focusRequest`) plus
  `CrossSiblingRelayDemo.brs`'s own `onFocusRequestChange` (observes it, relays into
  `FocusGroup`/`ScrollFocusDemo`'s own nested `ScrollableTileGrid`) for a worked example of the
  whole relay.

  **A field write must currently use the explicit `m.top.<field> = <value>` form, not a bare
  `<field> = <value>` statement.** A bare form is planned but not yet safe: the same real
  BrightScript scope analysis that powers unused-local elision has no way to tell a field-name
  assignment target apart from a genuine local, so it can (depending on the rest of the function)
  either wrongly treat the write as dead code or silently declare a shadowing local instead of
  writing the real field — `m.top.<field> = <value>` sidesteps both, since `m` is always left
  untouched by identifier resolution (see "Identifier resolution" above) and the codegen never
  rewrites anything past it.
- **RowList-style multi-item jump — `jumpFocus(<direction>, <count>, <press>)`.** A reserved
  keyword, usable as an ordinary statement anywhere in a function body, that moves real focus
  several registered candidates at once in one geometric direction — the reserved-keyword
  counterpart to the automatic single-step LRUD `navigate()` fallthrough. `<direction>` reuses the
  exact same `"up"`/`"down"`/`"left"`/`"right"` vocabulary `navigate()` already understands (any
  other value is simply never a match, same as an unrecognized `on:key[...]` string), `<count>` is
  how many candidates to hop (a literal, or any expression evaluating to an integer), and `<press>`
  must be the caller's own `on:key`-injected `press` value, forwarded through **unconditionally**
  — never guarded by the caller's own `if (press)`:
  ```
  <Rectangle id="row" focusable="true" on:key[fastforward]="{jumpDown()}" on:key[rewind]="{jumpUp()}">

  private function jumpDown(key: string, press: boolean) {
    jumpFocus("down", 5, press)
  }
  private function jumpUp(key: string, press: boolean) {
    jumpFocus("up", 5, press)
  }
  ```
  Compiles to a small `if`/`else` (not a single-line `callFunc`, unlike `focus(<id>)` — real
  multi-line codegen for one DSL statement already has a direct precedent in ternary's own hoisted
  temp-var + `if`/`else`):
  ```
  if press then
    if m.global.ft_focus.callFunc("navigateBy", "down", 5) then
      m.global.ft_focus.callFunc("startRepeat", "down", 5)
    end if
  else
    m.global.ft_focus.callFunc("stopRepeat")
  end if
  ```
  A press jumps focus (`navigateBy`, repeating the same geometric single-hop search `navigate()`
  itself uses but restricted to the SAME owner the jump started in — unlike a plain arrow-key
  press, a jump never crosses into a different component's own registered content, even when it
  runs out of candidates in the current one — up to `<count>` times, stopping early — landing on
  the last reachable same-owner candidate — the moment a hop finds nothing, so a jump near the end
  of a short list lands exactly on the last item instead of doing nothing, overshooting, or
  escaping to whatever sits just outside the list) and arms the **same** hold-to-repeat `Timer`
  machinery arrow-key repeat already uses (`startRepeat`/`onRepeatTimerFire`, generalized to accept
  an optional jump count — same `repeatTuning()` timings either way, not a separately-tuned
  mechanism); a release stops it (`stopRepeat`). This is exactly why `<press>` must be forwarded
  unconditionally: the release branch is what stops an in-flight repeat — a `jumpFocus(...)` call
  wrapped in the caller's own `if (press) { ... }` guard (the pattern every OTHER `on:key` handler
  in this codebase uses, e.g. `focus(<id>)`'s own examples above) would silently leave a held
  repeat running forever once the key is released.

  **`jumpFocus` is deliberately never automatic, unlike the LRUD fallthrough.** Every
  `apps/*-demo` chapter app already reserves `on:key[fastforward]`/`on:key[rewind]` at the
  `<component>` level, unconditionally, for chapter-to-chapter navigation — a real, established
  convention that exists specifically *because* `navigate()` never touches those two keys. An
  automatically-generated FF/RW fallthrough (mirroring the automatic up/down/left/right one) would
  consume the keypress on any component with focusable content and never let it bubble up to that
  component-level handler — a real regression. `jumpFocus` is opt-in instead: an author wires it via
  an ordinary `on:key[...]` binding — on a specific focusable element, or once on a plain wrapping
  container (`on:key` doesn't require `focusable` on the same element; it bubbles from wherever
  focus currently sits, up through the ancestor chain, so one container-level binding covers every
  descendant) — so a component that never mentions it behaves exactly as before. See
  `apps/focus-demo`'s `JumpFocusDemo.thr` chapter (and its own nested `JumpRowList.thr`, one
  component per list) for a worked example, including the layout pattern that resolves the
  FF/RW-meaning clash with pure composition (a plain focusable header carrying no
  `on:key[fastforward]`/`[rewind]` of its own, so those keys fall through to chapter-switching while
  it holds focus; each list's own template root binds them to `jumpFocus` instead).

  **A `jumpFocus` hop never crosses into a different component instance mid-jump** — every hop stays
  restricted to the SAME registry owner the jump started in, even once it runs out of further
  candidates there (landing on the nearest reachable one instead) — unlike `navigate()`'s own
  single-press LRUD fallthrough, which deliberately DOES cross into a different component ("press up
  from a list's top row reaches the header above it" is exactly that). This is why each jump-capable
  list needs to be its OWN component instance, not merely a plain wrapping `<Group>` inside a larger
  one — a `<Group>` gives `on:key` a real boundary to bubble through, but gives `navigateBy()`
  nothing, since its own search is scoped by component-instance identity, never template nesting —
  confirmed live as a real bug (see `findings/focus-demo-app.md`) before this restriction existed.

  No compile-time validation of `<direction>`/`<count>` — deliberately matches `focus(<id>)`'s own
  precedent above (an unresolvable target there is a documented runtime no-op, not a compile
  error). **Known limitation**: `jumpFocus` has no separate, DSL-exposed timing configuration of
  its own — it always reuses the fixed `repeatTuning()` constants `FlashTheaterFocusManager.brs`
  already defines for arrow-key hold-to-repeat.

### `isFocused` / `isInFocusChain` — reacting to focus, reactively

Two **reserved, read-only field names** any component can simply *read*. You never declare them;
the compiler synthesizes them as ordinary `field`s for any component whose `.thr` mentions either
name, and for no other component at all — a component that never reads them gets no field, no
subscription, and not one extra line of generated code.

| Name | True when |
|---|---|
| `isFocused` | Focus is **directly** in this component — this component owns the focused element itself. |
| `isInFocusChain` | The focused element is **anywhere inside** this component's subtree, including inside a nested child component. |

Because they are ordinary fields, they compose with everything that already works on fields — no
new syntax, no observers to wire by hand:

```
derived focusStateLabel: string = describeFocus(isFocused, isInFocusChain)

private function describeFocus(focused: boolean, inChain: boolean): string {
  if (focused) {
    return "focus: MENU"
  }
  if (inChain) {
    return "focus: CONTENT"
  }
  return "focus: elsewhere"
}
```
```
<Label id="readout" text="{focusStateLabel}" />
{#if isFocused}
  <Label id="hint" text="press RIGHT to enter content" />
{/if}
```

The distinction is what a wrapper component needs: persistent chrome wrapping a router outlet reads
`isInFocusChain = true` while the mounted screen holds focus, but `isFocused = false` — so
"this section is active" and "this exact control is selected" stay separately expressible. See
`apps/sample-app/src/components/Shell/Shell.thr` for exactly that, live.

**Two components can never both report `isFocused = true`.** That is a structural guarantee, not a
convention: the focus manager holds a single "what has focus right now" value, is the only writer
of it, and recomputes both fields for every subscribing component in one pass on every real focus
move. There are no independent per-component observers that could drift apart. Both fields are
deliberately derived from that value rather than from Roku's native `hasFocus()`/`IsInFocusChain()`,
which are confirmed to be able to report focus on a node that real key events never reach (see
`findings/focus-system.md`).

Both names are **reserved**: declaring a `field`/`derived`/`state`/`read`/`watch`/function called
`isFocused` or `isInFocusChain` is a compile error (`dsl/reserved-focus-state-name`), the same way
`store`/`focus` already are. If a component needs a *different* notion of "focused" — e.g. a
`MarkupGrid`/`RowList` item component, where SceneGraph itself writes `focusPercent` — name it
something else; `apps/sample-app`'s `ScheduleDateMenuItem.thr` uses `isGridFocused` for precisely
that reason.

**Inspecting focus at any moment.** The focus manager also exposes its own authoritative view for
debugging: `getFocusPathString()` returns the whole Scene-to-leaf chain as one readable line (e.g.
`Scene > Shell > Group#childOutlet > HomeScreen > Rectangle#prompt`), `getFocusPath()` the same as
an array, and `focusedNode()` the focused node itself. All three read the framework's own record,
so they stay truthful even where the native fields don't.

**Nested focusable elements** — a compile error (`template/nested-focusable-conflict`) only when
**both** an ancestor and a descendant are *statically* `focusable="true"` literal, at any nesting
depth (including across a nested custom-component tag). This is a genuine, permanent ambiguity:
both would report `IsInFocusChain() = true` simultaneously with no way to tell which is "the" real
target. If **either** side uses a reactive `focusable="{expr}"` instead, it's allowed — the
compiler can't prove they're never simultaneously `true`, so it's a documented runtime contract
instead (same treatment `{#each}`'s own duplicate-key collision already gets), and is exactly the
mechanism the parent→child handoff pattern above relies on.

**Known limitations**:
- **A `SetFocus()` reached through two or more nested `callFunc` hops from whatever native handler
  is currently executing does not establish real key-event routing** — a confirmed Roku platform
  behavior, not a framework bug, and the single most important thing to know when writing focus
  code by hand. `IsInFocusChain()` and `queryAppUi` both report success; real key presses simply
  never arrive. The framework already handles every path it owns (see the router's deferred focus
  application below), but hand-written BrightScript that hands focus off from deep inside a
  `callFunc` chain will hit it. Keep such a call at most one hop from the executing handler. See
  `findings/focus-system.md` for the full trace.
- A `default-focus="true"` element that first appears **long after** its component mounted (e.g.
  after an async data load, seconds later, while the user is already focused elsewhere) does not
  automatically take focus — by design: that would be stealing focus mid-interaction. A default
  that appears during the ordinary `init()`/`setup()`/reconcile cascade — the common case, including
  behind an `{#if:destroy}` flipped in `setup()` — is honoured normally with no extra code.

  For the genuinely-delayed case, call `m.global.ft_focus.callFunc("claimFocusIfVacant", m.top)`
  explicitly, from a `setTimeout(...)` callback (see "Timer statements" below), once the content
  actually exists:
  ```
  state ready: boolean = false

  public function setup() {
    setTimeout(function() {
      state ready = true
      m.global.ft_focus.callFunc("claimFocusIfVacant", m.top)
    }, 1500)
  }
  ```
  `claimFocusIfVacant` claims this component's own `default-focus`/first registrant **only if
  nothing anywhere currently holds focus** — the same vacuum rule `router.navigate()` itself
  follows, so it composes correctly whether the user left the remote alone (a real vacuum, claimed)
  or already moved focus elsewhere by the time the content appears (left alone, exactly like a
  route change would leave it). See `apps/sample-app`'s `SplashScreen.thr` (a genuine vacuum — the
  app's own true first-ever route) and `LoadingDemoScreen.thr` (reachable from `Shell`'s sidebar
  menu, which already holds focus the whole time — the non-stealing case) for both directions
  verified live. Deliberately not wired automatically into every `{#if:destroy}`/`{#each}` create
  path — see `findings/focus-system.md`'s own entry on `claimFocusIfVacant` for why that would
  reintroduce a real, already-fixed ordering bug.
- Dynamic `default-focus="{expr}"` is not currently supported (static literal only), mirroring
  `focusable`'s own static/dynamic split but starting narrower.
- A `focusable` element inside an `{#each}` that's itself nested inside a `{#if:destroy}` block is
  only unregistered when the `{#each}`'s own reconcile removes that specific item — **not** when
  the enclosing `{#if:destroy}` block tears down its whole subtree at once (its own destroy sub
  only unregisters statically-known ids, deliberately excluding each-nested ones — that lifecycle
  belongs to the each block's own reconcile). A stale registry entry from this specific combination
  can outlive the subtree it belonged to. A router-mounted screen doesn't have this gap —
  `FlashTheaterRouterOutlet`'s own teardown calls `unregisterSubtree(root)` instead, which walks the
  whole registry once and removes every entry whose owner is anywhere inside the torn-down subtree,
  regardless of nesting. The same blanket approach would close this gap for `{#if:destroy}` too, at
  the cost of a full registry scan on every such teardown instead of a fixed, statically-known list
  — not yet done, since it hasn't been a reported problem in practice.
- A toggle-mode `{#if}` block's `visible=false` still does not remove its descendants from the
  focus/key-event chain (see "Conditional rendering" above) — this predates the focus system and
  is unaffected by it.

### Scroll-into-view

```
field scrollOffsetX: float = 0
field scrollOffsetY: float = 0
```

Declaring these two exact field names on a component (any `float`, any default) opts it into
**automatic scroll-into-view**: whenever real focus moves onto a descendant of that component —
via `navigate()`'s directional grid navigation or `recoverFocus()`'s removal recovery, both above —
the focus manager checks whether it (or one of the newly-focused node's other ancestors) declares
both fields and, if so, adjusts them so the newly-focused element's bounds fall back inside that
component's own **template root element's** bounds. This is detection via `HasField`, not new DSL
grammar — the two field names are just an ordinary convention, checked the same way `focusable`
reuses SceneGraph's own field name.

```
<Viewport width="1000" height="500">
  <Group id="track" translation="{[-scrollOffsetX, -scrollOffsetY]}">
    {#each items as item (item.id)}
      <SomeTile focusable="true" on:key[OK]="{select(item)}" />
    {/each}
  </Group>
</Viewport>
```

To actually move content, bind an inner element's `translation` to the negated offsets (an
ordinary, already-general dynamic-attribute binding — no new grammar needed there either); the
`field`-declaring component's own template root element must **not** itself be the thing that
translates — only content nested further inside it should move, so the root element's own
bounds stay a stable reference window throughout.

**Clipping is the `.thr` author's own responsibility, not automatic.** Roku SceneGraph does not
clip a node's children to its own bounds by default — scrolled content that extends past the
viewport's declared `width`/`height` still renders outside that window unless the author opts in
with the node's own native `clippingRect` field (`[x, y, width, height]` in the node's local
coordinate space — an ordinary static or dynamic attribute, same as `focusable`, needing no new DSL
grammar). Recommended on the same element that declares `width`/`height` as the viewport window,
matching those same dimensions. Purely a rendering concern, though — `clippingRect` does not by
itself change what `navigate()` considers a candidate; see "Focus system" above's note on
cross-component candidates being clipped to their own visible portion for LRUD scoring, a related
but separate mechanism.

**Single-level nearest-ancestor only** — the focus manager stops at the first ancestor exposing
both fields; nested scroll regions (a scrollable list inside another scrollable region) don't
compose, the same treatment the nested-`focusable` rule above gets. Requires the auto-scroll
component's own template root to be a node type with real `width`/`height` fields (`Rectangle`,
`Poster`, `LayoutGroup`, ...) — a plain `Group` root has no such fields to read the window size
from. See `apps/focus-demo/src/components/ScrollableTileGrid/ScrollableTileGrid.thr` for a worked example
(a tile grid deliberately larger than the screen) and `findings/focus-system.md` for the
real-device `BoundingRect()` behavior this design works around. This is precisely the constraint
`ScrollFocusDemo.thr` itself violated until a later session split it into a thin chrome wrapper
plus this nested `ScrollableTileGrid` component — its own template root used to be a full-screen
background `Rectangle` with the real scrollable viewport nested one level inside it, so every
scroll-into-view computed itself against the WRONG (full-screen) bounds; see
`findings/focus-demo-app.md` for the device-found writeup.

## Reserved `ft_` prefix

Every compiler-synthesized **node/element id** (a `{#if}`/`{#if:destroy}` block's own wrapper id,
an `{#each}` block's own wrapper id, a synthesized parent id) and internal **local variable** name
(loop counters, temp node refs, expression-wrapper temps) is prefixed `ft_` — never a leading
underscore of any length, by deliberate house style (nothing generated should visually read as
unused-by-convention or private-by-convention). A user-authored
`id`/`field`/`derived`/`state`/`read`/`watch`/`stream`/function/`scale`-local name starting with `ft_` is a compile error
(`dsl/reserved-identifier-prefix`) — that prefix is reserved exclusively for the compiler's own
generated names.

**A compiler-synthesized id that needs to be cached on the component's own `m` scope uses a
`$$ft_`-prefixed name, accessed with bracket syntax** — `m["$$ft_if_1"]`, not `m.ft_if_1`.
BrightScript's lexer rejects `$` as an identifier's first character, so this only works because a
bracket string key isn't parsed as an identifier at all; `naming.ts`'s `mFieldAccess(id, suffix?)`
is the single call site for this, and it leaves a DSL-author's own `m.<name>` field/state/derived
access as plain dot syntax (those names can never collide with the reserved prefix). This
convention applies only to `m`-scope caching — nothing is cached in a field on a dynamically-created
child/item node anymore (see the per-item-state design above).

**Generated `{#if:destroy}`/`{#each}` plumbing `sub`/`function` names use a separate convention**:
`<componentName>__<name>` (e.g. a `ScheduleList` component's each-reconcile sub is
`ScheduleList__reconcile_each_1`, not `ft_reconcile_ft_each_1`) — distinct from both the
`ft_` prefix above and from the unrelated `private_`/`on_<field>Change` scheme a `.thr`
component's own declared fields/functions use (see "`private function` / `public function`"
above). This exists specifically so generated code stays readable enough to debug by hand — an
earlier flat `ft_`-prefixed scheme for these sub names made a real on-device bug (see
`findings/compiler-architecture.md`) much harder to trace than it needed to be.

**Every field the compiler hangs off SceneGraph's `m.global` node is also `ft_`-prefixed** —
`ft_store`, `ft_theme`, `ft_focus`, `ft_scaleFactor` — for a different reason than the id/local-variable convention
above: an unprefixed name (`m.global.store`) risks silent collision with an app's own code writing
a same-named field onto the same shared global node. `packages/compiler/src/codegen/global-fields.ts`
(`GLOBAL_FIELD_NAMES`/`globalFieldRef`) is the single source of truth every codegen site reads
this from — any future built-in global singleton (a router, an analytics primitive, ...) goes
through it too, never a fresh string literal. This is purely an internal `m.global` field name, not
DSL-facing syntax — the keyword an author actually types (`store(...)`, `theme.a.b`, `focus(...)`)
never changes.

## Dependency graph and scheduler

The only piece of the full target-spec scheduler that's currently implemented: the
dependency graph between `derived` and the **reactive sources** it can
depend on — `field` and `state` — topological sorting, and cycle detection
**at compile time** (a build error with the list of names in the cycle). A
source's change (a SceneGraph `field.onChange` for `field`, a `state x =
expr` statement for `state`) recomputes only its own transitive `derived`
closure in one pass. Batching multiple changes within one handler doesn't
exist yet — there's no need for it at this scale.

## Global store

**The store is a built-in runtime primitive — never declared in the DSL.**
There is no `<store>` root tag anymore; a `.thr` file starting with `<store>`
is a parse-time error (`thr/store-tag-removed`) with a message pointing at
the `read`/`watch`/`store(...)` replacement grammar. Instead, every app gets
one global `store` singleton out of the box: a fixed SceneGraph component
(`FlashTheaterStore`, see `packages/compiler/runtime-assets/Store`) with a
single interface function, `set(key as string, value as dynamic)`, that
dynamically adds or updates a SceneGraph field for that key — `m.top.hasField(key)`
branches between `m.top.addFields({...})` for a brand-new key and
`m.top.setField(key, value)` for an existing one. Both branches are required:
`AddFields()` only *adds* a field that doesn't exist yet (confirmed live on a
real device — a second write to the same key silently no-op'd; this matches
Roku's own `ifSGNodeField` docs, "if the field already exists, no change
occurs"), and `SetField()` updates an existing field but cannot create a new
one. Reading a key is a plain SceneGraph field access, which is what makes
the reactivity free: a field observer fires whenever the field itself is
reassigned, exactly like any other SceneGraph field.

Because the store is schemaless from the compiler's point of view (there's
no DSL-level declaration to validate a path against), a value can be
anything — a scalar, an associative array, an array, or a node — and reading
can dot arbitrarily deep into it (`store(some.nested.value)`). Writing,
however, can only ever replace a **whole top-level key at once** — see
`store(...)` write above and its rationale (a real field observer never
fires on an in-place mutation of an already-referenced value, only on
reassignment of the field itself).

Three DSL forms touch the store, covered in detail above:
`read <name> = store(<path>)` (one-time snapshot), `watch <name> =
store(<path>)` (reactive), and `store(<topLevelKey>) = <expression>` (the
only way to write). `store(<path>)` is **not** a general expression — it only
ever appears in exactly these three positions, never inline inside an
arbitrary `derived`/template/function-body expression. To use a store value
elsewhere, declare a `read`/`watch` first and reference its plain name —
the same discipline `state` already requires for its own writes.

`store` is a **reserved keyword** — a `field`/`derived`/`state`/`read`/
`watch`/function literally named `store` is a parse error, the same way
`state`/`field`/etc. already are.

Whenever any component in the app uses the store, `flash-theater compile`
automatically copies `FlashTheaterStore`'s `.xml`/`.brs` into a
`FlashTheater/` subfolder of the app's component output (e.g.
`components/FlashTheater/FlashTheaterStore/`) and wires it into the
generated `FlashTheater/FlashTheaterGlobals.brs` bootstrap under `source/`
(see "Tooling" in docs/features.md) — zero manual steps, unlike the theme
(below), which still needs at least an empty `<theme-template>` to exist at
all. This `FlashTheater/` grouping is where every piece of compiler-owned
output lives, regardless of build — see `findings/reactivity-codegen-conventions.md`.

## Router

`router` is a built-in runtime primitive, like `store`/`theme`/`focus` — a fixed SceneGraph
singleton (`FlashTheaterRouter`), never declared in the DSL. Unlike those three, `router` is
reached through **one namespace covering both data reads and actions**, not a dedicated statement
form: `router.<member>` for a schemaless data read, `router.<method>(...)` for an action call —
both are ordinary BrightScript dot-chain/call expressions, valid anywhere an expression can appear
(a function body, an `if` condition, a `derived`/template `{expr}` — though see "Known
limitations" below for why an action call belongs in a function body, not a `derived`/template
binding). `router` is otherwise an ordinary identifier — no new reserved keyword, unlike
`store`/`focus`/`state`.

### Route configuration — nested, not flat

A route is `{path: <segment>, component: <name>, [children: [<route>, ...]]}` — a plain
BrightScript AA. `path` is a single path **segment** at that nesting level (`""` for an
index/default child, `"browse"`, `"schedule"`, ...), never a full URL; `component` is the
SceneGraph component name a `FlashTheaterRouterOutlet` (below) will `CreateObject` when this route
activates; `children` is an optional nested array of the same shape, matched by a nested outlet
mounted inside whatever component this route's own outlet creates. Register the whole tree once,
typically from a hand-called `setup()` (the same convention already used to seed the store — see
`apps/sample-app/src/components/MainScene.thr`):

```
router.setRouting([
  {
    path: "browse",
    component: "Shell",
    children: [
      { path: "", component: "HomeScreen" },
      { path: "schedule", component: "ScheduleScreen" }
    ]
  }
])
```

### `<FlashTheaterRouterOutlet>` — renders whichever route currently matches

A fixed runtime component, used in a template exactly like any other referenced component:
`<FlashTheaterRouterOutlet id="outlet"/>`. **Any number may be mounted at once, nested
arbitrarily** — a route's own `component` may itself contain another `<FlashTheaterRouterOutlet>`,
which independently matches the router's current target path against that route's own `children`.
This is what makes a parent route's component (a persistent menu, say) stay mounted across
navigation between its own children: an outlet only destroys-and-recreates (never patches in
place) when *its own* matched route entry changes — a `Shell` component whose own match ("browse")
never changes never rebuilds just because a deeper, nested outlet's own match changes underneath
it. See `apps/sample-app/src/components/Shell.thr`/`HomeScreen.thr`/`ScheduleScreen.thr` for a worked
example, and `findings/router.md` for the full matching mechanism (a flatter,
no-URL-string data model).

**A router-mounted component gets an automatic `setup()` call**, the moment it's mounted — the
same one-time, post-construction hook `MainScene`'s own hand-called `scene.callFunc("setup")`
already provides, just automatic (a router-mounted component has no other way to run one-time
setup logic, since nothing external calls it). Declaring `public function setup() { ... }` is
optional — a mounted component with none simply doesn't get called (harmless).

### Navigation and focus — the vacuum rule

Changing routes destroys one component subtree and builds another, so *something* has to decide
where focus ends up. The rule is deliberately narrow and applies to the whole framework, not just
the router:

> **An automatically chosen focus target is applied only when nothing currently holds focus.**
> The framework never takes focus away from a living focus — it only ever fills a vacuum.

Two cases, both of which a real TV app needs:

- **Focus was inside the content being replaced.** Destroying it leaves a genuine vacuum, so the
  freshly mounted screen's own `default-focus="true"` element receives focus. This is the ordinary
  "press OK, go to the next screen, start interacting with it" flow.
- **Focus was somewhere else** — a persistent side menu, a global overlay, anything outside the
  swapped subtree. It survives the navigation untouched. This is what makes the canonical TV
  layout work: moving through a menu while the content beside it reloads must *not* yank focus out
  of the menu on every move. The newly mounted screen's `default-focus` isn't wasted — it applies
  the moment focus actually enters that screen (an arrow key from the menu).

To deliberately *take* focus on mount — the opposite behavior, occasionally wanted — call
`focus(<id>)` explicitly from the mounted component's own `setup()`. An explicit request always
wins over the vacuum rule, because the author asked for it by name.

**Why the compiler emits an extra line after every route change.** Roku will not establish real
key-event routing for a `SetFocus()` reached through 2+ nested `callFunc` hops from the executing
handler, and a navigation cascade is inherently deeper than that (your handler → the router → each
mounted outlet's own field observer → the new component). So the cascade never focuses anything
itself: it only *records* where focus should go, and the compiler emits one shallow
`applyPendingFocus()` call as a sibling statement immediately after your own
`router.navigate(...)`/`router.back()`, which performs the move from a depth that actually works.
You never write it; it shows up in the generated `.brs`.

That is also why **`router.navigate(...)` and `router.back()` must each be a statement of their
own** — never nested inside a larger expression, a `derived`, or a template binding
(`expression/router-action-must-be-statement`). There would be nowhere to put the mandatory
follow-up statement, and the result would compile cleanly while leaving focus unable to receive
real key presses. The other router actions mount nothing and are unrestricted.

```
' fine — a statement of its own
private function goToSchedule(key: string, press: boolean) {
  if (press) {
    router.navigate("/browse/schedule", { day: "Mon" })
  }
}

' rejected — nothing would run the focus hand-off
private function tryBack(key: string, press: boolean) {
  if (not router.back()) {
    ' ...
  }
}
```

**A route remembers whatever element was last genuinely focused anywhere inside its own mounted
content — including inside a nested custom component, e.g. a list row — and restores it the next
time the same route mounts.** Tracked continuously as focus moves around (not just captured at the
literal instant of navigating away), so it survives the user stepping back to a persistent menu to
actually trigger the navigation — the ordinary way to navigate in this framework's own canonical
"persistent side menu" layout. Covers `router.back()`, a fresh `router.navigate(...)` to a route
visited before, and even a dynamically-created `{#each}` element, as long as its `id` still resolves
under the new mount (an `{#each}` item's own author `id` compiles to `"<id>_" + <key>`, so the same
reconcile key reproduces the same id string). This applies regardless of which direction caused the
navigation. Nothing to author for this — it's automatic, keyed by the route's own resolved
path+params, not by component instance (a routed screen is always a fresh instance on every mount,
so a plain node-reference memory couldn't survive the round trip).

**The vacuum rule above still governs whether a restoration is actually ever allowed to apply, and
this is a real, deliberate limitation, not a corner case to work around**: restoration can only ever
be *observed* when returning to a route creates a genuine focus vacancy — i.e. whatever holds focus
at that moment is *also* being destroyed by this same navigation. If the user has manually returned
to persistent chrome (a sidebar) before triggering the navigation away, that chrome keeps focus
continuously (it's never torn down), and the vacuum rule correctly refuses to steal it back later —
the route's own content memory is still captured underneath, ready to apply the next time a genuine
vacancy actually occurs for that route, but has no observable effect while something else remains
legitimately focused. A screen that needs to land on a SPECIFIC element regardless of vacuum state
can still call `focus(<id>)` explicitly from its own `setup()`, which always wins over this automatic
restoration.

### `router.navigate(<path>)` / `router.navigate(<path>, <params>)` / `router.navigate(<path>, <params>, <skipInHistory>)`

Changes the current route. `<path>` is always the **full** path (every segment from the root,
`/`-joined — e.g. `"/browse/schedule"`), never a single segment; matching that back down against
each mounted outlet's own candidate list happens automatically. `<params>` (optional, an AA,
default `{}`) is arbitrary data for the newly-activated route, read back via `router.params.*`
(below). `<skipInHistory>` (optional, a boolean, default `false`) — when `true`, the route being
left is **not** pushed onto the back-journey history, so a later `router.back()` skips past it
entirely (see `apps/sample-app/src/components/ScheduleScreen.thr`'s "peek Tuesday" example: switching
which day is displayed without adding a stop to the back stack).

### `router.back()`

Pops the most recent back-journey history entry and re-activates it — returns `true` if there was
one, `false` (and does nothing) if history is empty. This is also exactly the signal the
compiler's own automatic back-key fallthrough (below) uses to know whether to consume the physical
**back** key or let it fall through.

There is no forward-navigation concept — the back journey is a plain stack (`navigate()` pushes
the outgoing route unless `skipInHistory`, `back()` pops), not a browser-style history you can
step forward through again.

### `router.resetHistory()` / `router.resetHistory(<rootPath>)`

Clears the back-journey history, optionally reseeding it with one root entry — for establishing a
fresh "can't go back past here" boundary (e.g. after a login flow completes, `back` should never
return to the login screen).

### `router.appendBackJourneyData(<data>)` / `router.updateBackJourneyData(<data>)`

Attaches arbitrary data (an AA) to the **current** route, so it doesn't need to be re-fetched (from
a backend, say) if the user navigates back to it later — `appendBackJourneyData` merges into
whatever's already attached, `updateBackJourneyData` replaces it outright. Read back via
`router.backJourneyData` (a schemaless data read, below) once that route is active again — see
`apps/sample-app/src/components/HomeScreen.thr`'s `welcomeText`/`ScheduleScreen.thr`'s `goBack()` for a
worked round trip through a full destroy-and-recreate cycle.

### `router.path` / `router.params.<key>` / `router.backJourneyData.<key>` / `router.isBackJourney` — schemaless data reads

A bare `router.<path>` (any depth, e.g. `router.params.day`) reads directly off the currently
active route — schemaless from the compiler's own point of view (same "unchecked past the root"
treatment `store(<path>)` already gets), since there's no way to know a route's `params`/
`backJourneyData` shape at compile time. **A plain, non-reactive snapshot** — reading
`router.params.day` in a `derived`/template binding evaluates it at that binding's own normal
recompute time, but the router itself never *triggers* a recompute the way a `field`/`state`/
`watch` change does (unlike `theme`/`store`, `router` contributes no reactive dependency-graph
source). A component that needs to react to a route change without being torn down and rebuilt by
its own `FlashTheaterRouterOutlet` (the router's actual, primary reactivity mechanism) combines the
read with a `field`/`state` the app updates itself.

`router.isBackJourney` — `true` when the CURRENT mount was reached via `router.back()`, `false` for
an ordinary forward `router.navigate(...)` — reads the same way, off the same schemaless path. A
real, common authoring need this enables: the same route legitimately wanting a DIFFERENT initial
focus depending on how it was entered — e.g. a multi-step flow whose own "continue" action should
be focused on a fresh forward visit, but whose own "review/edit" action should be focused when the
user has stepped away and come back to revisit it. Combine it with an explicit
`focus(<id>)` call (always wins over both the vacuum rule and any automatic route-memory
restoration — see "Navigation and focus" above) from the mounted component's own `setup()`:

```
public function setup() {
  if (router.isBackJourney) {
    focus("reviewButton")
  } else {
    focus("continueButton")
  }
}
```

See `apps/sample-app`'s `DirectionalFocusDemo.thr`/`DirectionalFocusDemoDetail.thr` (reachable from
`HomeScreen`'s own second prompt) for a full, live-verified worked example, and
`findings/router-focus-integration.md` for the design history.

### Back key — fully automatic, no `on:key[back]` needed

The app's one `Scene`-rooted component (`<component extends="Scene">`) automatically gets a
generated fallthrough: an unhandled physical/ECP **back** key calls `router.back()`; if it returns
`true` (there was somewhere to go back to), the key is consumed; if `false` (history empty), the
key is **not** consumed, so it reaches Roku's own default unhandled-`"back"`-at-the-Scene behavior,
which exits the app. Placed last in the generated `onKeyEvent`, after every explicit `on:key`
dispatch and the focus system's own LRUD arrow-key fallthrough — an author's own `on:key[back]`
handler, anywhere in the tree, always wins and can preempt this entirely. No setup needed beyond
using the router somewhere in the app: the Scene root always gets this fallthrough generated
(compile-time unconditional, since whether *some other* component in the app uses the router isn't
known yet at the Scene's own codegen time), guarded at **runtime** on `ft_router` actually existing
on `m.global` — a harmless dead branch in an app that never uses the router at all. A component
that isn't the Scene root never gets it, regardless.

### `default-focus="true"` — declaring a component's own entry point

See "Focus system" above for the general mechanism — this is documented there since it isn't
router-specific, but it's what makes a router-mounted screen (always a brand-new instance, so
never any "remembered last focus" to fall back on) land focus somewhere deliberate on every mount,
rather than merely "the first focusable element in document order."

### Router-outlet transitions

`<FlashTheaterRouterOutlet>` swaps its mounted child instantly by default (destroy the old, create
the new, in one call stack). Four attributes, only valid on `<FlashTheaterRouterOutlet>` itself,
opt a specific outlet into animating that swap — same value grammar as "animation"'s own
`transition:`/`in:`/`out:` (a bare preset/custom-`animation`-declaration name, or
`="{{overrides}}"` for a preset — and, same as those, the `=""` is optional when there's no
override: see "Template"'s own bare-attribute note above):

```
animation slideOutLeft     { target: outlet, duration: 0.25, translation: [[0, 0], [-1280, 0]] }
animation slideInFromRight { target: outlet, duration: 0.25, translation: [[1280, 0], [0, 0]] }
animation slideOutRight    { target: outlet, duration: 0.25, translation: [[0, 0], [1280, 0]] }
animation slideInFromLeft  { target: outlet, duration: 0.25, translation: [[-1280, 0], [0, 0]] }

<FlashTheaterRouterOutlet
  id="outlet"
  width="1280" height="720"
  navigate-out:slideOutLeft navigate-in:slideInFromRight
  back-out:slideOutRight back-in:slideInFromLeft
  loadingComponent="BusySpinner"
  loadingMinDuration="0.2" loadingTimeout="5"
/>
```

- **`navigate-out:`/`navigate-in:`** play on a `router.navigate(...)`-driven mount of this outlet;
  **`back-out:`/`back-in:`** play on a `router.back()`-driven one — the direction is read straight
  off `activatedRoute.isBackJourney` (already threaded through by `navigate()`/`back()`), no
  authoring needed on the caller's side. Each of the 4 is independently optional; an unconfigured
  direction/phase keeps the exact pre-feature instant behavior for that case.
- **Every `navigate-out:`/`navigate-in:`/`back-out:`/`back-in:` animation must target the outlet
  ITSELF** (`router/transition-target-must-be-outlet` otherwise), never some other element: a
  dynamically `CreateObject`'d routed screen has no
  compile-time id for the animation system to reference in the first place, so the outlet's own
  `translation` is the only thing a transition can actually animate. The visual model this produces
  is a single shared outlet node, not two screens co-mounted and cross-fading: the outgoing screen's
  `out:` animation plays, then (once it reports Roku's `state="stopped"`) the old screen is torn
  down, the outlet's own translation is **teleported** to the `in:` animation's own first keyframe
  (e.g. off-screen on the opposite side), the new screen is created, and the `in:` animation plays
  it back into position. Only one screen is ever visible at a time.
- **`repeat: true` is rejected on `navigate-out:`/`back-out:`** (`router/repeat-not-supported-
  for-exit-transition`), anywhere in its own step tree (the outermost node, or nested arbitrarily
  deep inside a `sequential`/`parallel` composition) — same reasoning as Layer 2's own `out:`
  restriction below: the outlet only tears down the outgoing screen and mounts the next route once
  the exit animation's own `state` field reports `"stopped"`, which a repeating animation never
  does on its own. Freely allowed on `navigate-in:`/`back-in:` — nothing in this outlet's own
  runtime waits for an enter transition to finish.
- **`width`/`height`** — the outlet's own declared content-area size, in design-resolution pixels.
  `FlashTheaterRouterOutlet` extends `Group` (no native size of its own), so these exist purely for
  this outlet's own script to compute where to center `loadingComponent` — not a SceneGraph
  layout/clipping primitive. Required whenever `loadingComponent` is set.
- **`loadingComponent`** — the SceneGraph node type to instantiate as a loading indicator (Roku's
  built-in `BusySpinner`, or any custom `.thr` component) while the newly mounted screen isn't
  ready yet. The outlet creates and owns it directly (not an author-placed sibling element),
  centered at `[width/2, height/2]` — same assumption Roku's own `BusySpinner` renders under
  (center-anchored on its own `translation`; a custom component should follow the same convention).
  Independent of whether any slide animation is configured.
- **`router.markReady()`** — a routed screen's own signal that it's ready to be revealed, typically
  called once real data has arrived (e.g. from inside a `taskManager.onResult` callback). Unlike
  every other `router.*` action, it does **not** call into the router singleton — it compiles to a
  plain field assignment on the CALLING component's own top node (`m.top.ft_routeReady = true`), a
  field every compiled `.thr` component declares unconditionally. This is what lets the outlet gate
  a mount purely by observing its own child's field, with no global "which outlet is waiting"
  registry needed. Must be a statement of its own (`expression/router-mark-ready-must-be-statement`
  — it lowers to an assignment, not a valid expression term) and is **not supported from a `.flsh`
  class body** (`class/router-mark-ready-not-supported` — a class instance has no SceneGraph node of
  its own for "its own top" to mean; call it from the owning `.thr` component instead). If a routed
  screen never calls it, `loadingTimeout` (default 5 seconds) forces the reveal anyway — a screen
  doesn't have to know about this feature to remain functional under a `loadingComponent`-gated
  outlet. Calling it **synchronously from within `setup()` itself** (the common case — nothing else
  to wait on, data already available) reveals the screen immediately, with no loading indicator ever
  shown at all — the outlet checks for readiness right after `setup()` returns, before arming any
  wait. Calling it later (asynchronously, e.g. from a `taskManager.onResult` callback) genuinely gates
  the reveal on that callback firing, showing `loadingComponent` (subject to `loadingMinDuration`)
  in the meantime.
- **`loadingMinDuration`** (default 0) — a floor on how long the loading indicator stays up, even if
  the screen becomes ready almost instantly; avoids an unpleasant single-frame flash for a fast
  local mount.
- **Only one visible loading indicator at a time, even across nested outlets.** A single navigation
  can in principle cause more than one nested `FlashTheaterRouterOutlet` to gate a mount
  simultaneously (an ancestor outlet re-rendering persistent chrome around a deeper route change).
  Only the **innermost** transitioning outlet actually shows its `loadingComponent` — an ancestor
  outlet mid-transition at the same time still genuinely waits on its own child's readiness, it just
  never displays a second, competing indicator. "Innermost" falls out of construction order for
  free: a nested outlet's whole mount cascade runs as part of the ENCLOSING outlet's own
  `CreateObject` call, so the inner outlet's own claim always happens first.
- **Rapid re-navigation** (a second `router.navigate(...)`/`router.back()` arriving before a prior
  transition has settled) cancels whatever was in flight — a still-playing animation, or an
  unsettled loading gate — and restarts fresh against the newest target, rather than leaving the
  behavior undefined.

### Known limitations

- **Middlewares/guards** (route-entry checks, redirects) are not yet supported — no async-guard-chain
  concept exists anywhere in this compiler's synchronous codegen yet.
- **Router-outlet transitions have no per-route override** — `navigate-out:`/`navigate-in:`/
  `back-out:`/`back-in:`/`loadingComponent` are configured once, on the outlet itself, applying to
  every route that outlet ever mounts; there is no way to give one specific route a different
  transition or loading indicator than its siblings.
- **One `loadingComponent` per outlet** — no way to vary which loading indicator shows based on the
  route being mounted.
- **A router-mounted screen that isn't itself compiled from `.thr`** (a hand-authored SceneGraph
  component referenced directly as a route's `component:`) can still be gated by `loadingComponent`,
  but since it never declares `ft_routeReady` and can't call `router.markReady()`, it always falls
  back to `loadingTimeout` before revealing — never a real readiness signal.
- **No URL/query-string composition** — `path` and `params` stay separate values; there is no
  single parseable route string, and no dynamic path segments (an app modeling per-item detail
  routes needs a fixed path segment plus a `params` value, not a `:id`-style placeholder).
- **`router.navigate(...)`/`router.back()` must be a statement of their own** — see "Navigation and
  focus" above. The remaining actions (`setRouting`, `resetHistory`, `appendBackJourneyData`,
  `updateBackJourneyData`) mount nothing and are unrestricted, though calling any router action
  from a `derived`/template binding (recomputed reactively, as a side effect of some unrelated
  change) remains the author's own responsibility — this DSL doesn't police `derived`/template
  purity in general. Prefer calling router actions from a function body (an `on:key` handler,
  typically).
- **Route-scoped focus restoration (see "Navigation and focus" above) only re-identifies a
  remembered element by its own `id`** — a focusable node with no `id` at all can never be
  re-identified on a later mount, so it simply falls out of the chain (a surviving ancestor with an
  `id`, if any, is still tried). Re-resolution is also a depth-first search across the WHOLE app
  (not scoped to any one route's own subtree, since the remembered element may not live inside any
  routed content at all), so two *different* custom components anywhere in the app could in
  principle reuse the same static author-chosen id (the DSL's own id-uniqueness check is
  per-component, not app-wide) — a narrow, pre-existing risk class also carried by `{#each}`'s own
  item-update `findNode` pattern.

## Task manager

`taskManager` is a built-in runtime primitive, like `store`/`theme`/`focus`/`router` — a fixed
SceneGraph singleton (`FlashTheaterTaskManager`), never declared in the DSL. Like `router`, it's
one namespace covering both actions (`taskManager.run(<node>, [priority])`/
`taskManager.cancel(<taskId>)`/`taskManager.setMaxConcurrent(<n>)`/
`taskManager.setAlertThresholds(<config>)`/`taskManager.onAlertChanged(<callback>)`/
`taskManager.onResult(<task>, <onSuccess>, [<onError>])`/`taskManager.onRequestSent(<callback>)`/
`taskManager.onResponseReceived(<callback>)`) and data reads (`taskManager.runningCount`/
`taskManager.queuedCount`/`taskManager.alertLevel`) — but unlike `router`'s schemaless route data,
these reads are a small, fixed, validated set (`expression/unknown-task-manager-member` for
anything else). `taskManager` is otherwise an ordinary identifier, no new reserved keyword.

It exists to throttle how many [`Task`](https://developer.roku.com/dev/docs/task) nodes run at
once, app-wide — RokuOS documents a soft limit of 50 and a hard limit of 100 concurrently running
tasks. **`taskManager` never creates a Task itself.** The DSL author does their own ordinary
`CreateObject("roSGNode", "MyTaskComponent")` (any DSL-`extends="Task"` component, or a
hand-written one) and sets its own input fields, then hands the resulting node to
`taskManager.run(node)` instead of manually toggling `control = "RUN"`:

```
private function startWork(key: string, press: boolean) {
  if (press) {
    task = CreateObject("roSGNode", "MyDownloadTask")
    task.url = "https://example.com/data.json"
    taskId = taskManager.run(task)
  }
}
```

### `taskManager.run(<node>, [priority])` — starts (or queues) a task, returns its id

Registers `node` with the manager and returns a **task id** (a string) the author should keep —
`cancel(<taskId>)` (below) needs it. Every `roSGNode` already carries a built-in `id` field: if
`node.id` is already set, that value is reused as the task id; the common case is an unset `id`,
in which case the manager mints and assigns one itself (`"ft_task_" + <counter>`). If a limit is
already reached, `run(...)` still returns the id immediately — the task is queued and started
automatically once a slot frees up.

`run(...)` watches the node's own native `state` field (Roku's documented Task lifecycle:
`"init"` → `"run"` → `"stop"`/`"done"`) to know when it actually stops — `"run"` counts as active;
`"init"`/`"stop"`/`"done"` do not.

**`priority`** (optional) is one of `"high"`/`"normal"`/`"low"`, defaulting to `"normal"` when
omitted. It only affects **queue order**, never already-running tasks: whenever a slot frees up,
the manager always drains the entire high tier before touching normal, and the entire normal tier
before touching low — FIFO within each tier. A `"high"`-priority task submitted after several
already-queued `"normal"` ones still starts before all of them.

```
taskId = taskManager.run(task)              ' priority: "normal"
urgentId = taskManager.run(urgentTask, "high")
```

**Auto-cancelled when the calling `.thr` component is torn down.** Every `run(...)` call made from
an ordinary component (never from a `.flsh` class body — see below) registers the task under that
component's own node; when the component is removed (a router navigation away, `{#if:destroy}`, or
an `{#each}` removal), its generated teardown hook automatically cancels every task it ever started
that hasn't already finished — the same guarantee timer statements already have for
`setTimeout`/`setInterval`. Keeping the returned id and calling `cancel(<taskId>)` yourself is only
needed to stop a task *before* its owning component is torn down. A `taskManager.run(...)` call from
inside a `.flsh` class body has no such auto-cancel — a class instance has no node of its own for the
teardown hook to key off of — so a class-started task still needs a manually-tracked id and an
explicit `cancel(...)` call if early or teardown-triggered stopping matters.

### `taskManager.cancel(<taskId>)` — stops a queued or running task

Takes the **id** `run()` returned, not the node itself. If the task is still queued (never
started), it's simply removed from the queue. If it's already running, this sets its `control`
field to `"STOP"` — the actual bookkeeping (freeing its slot, starting the next queued task) then
happens the moment its `state` field confirms the task actually stopped, the same path a
naturally-finished task goes through. An unknown, already-finished, or already-cancelled id is a
no-op.

### `taskManager.setMaxConcurrent(<n>)` — the concurrency budget

Defaults to **50** (RokuOS's documented soft limit) — deliberately below the hard limit of 100, to
leave headroom for Task nodes created **outside** `.thr`/`.flsh` entirely (see "Known limitations"
below). Call `taskManager.setMaxConcurrent(<n>)` once, from anywhere (typically the root Scene's
own `setup()`), to raise or lower it. Raising the limit immediately starts as many queued tasks as
now fit; lowering it never stops an already-running task — it only throttles future `run(...)`
calls.

### `taskManager.setAlertThresholds(<config>)` — queue-depth monitoring

`taskManager` tracks a hysteresis-gated `alertLevel` (`"none"`/`"warning"`/`"critical"`), computed
from `queuedCount` against two thresholds — defaulting to `{warning: 30, critical: 50}`. Override
either or both with `taskManager.setAlertThresholds({warning: <n>, critical: <n>})`, e.g. from the
root Scene's own `setup()`.

**Hysteresis, not a raw threshold check, is the whole point.** `alertLevel` is only ever *written*
when the computed level actually **changes** — never on every queue mutation — so a subscriber
(below) is notified exactly once per real crossing (queue climbs past 30 → one `"warning"`
notification; it can then sit at 31, 35, 40 indefinitely with no further noise; climbing past 50 →
one `"critical"` notification; dropping back under 50 → one `"warning"` notification; under 30 →
one `"none"` notification). This is what keeps a dashboard/reporting integration from being spammed
by a queue depth that's merely fluctuating near a threshold.

### `taskManager.onAlertChanged(<callback>)` — subscribing to alert-level changes

Registers `callback` (a function taking one `string` parameter — the new `alertLevel`) to run
whenever the alert level actually changes. Under the hood this is sugar over an ordinary
`ObserveFieldScoped` registration on the manager's own `alertLevel` field — the compiler generates
the trampoline sub and the registration for you, once, in `init()`:

```
private function onQueueAlert(level: string) {
  if level = "critical" then
    ' forward `level`, taskManager.runningCount, taskManager.queuedCount, etc. to whatever
    ' reporting/analytics integration this app already has — flash-theater has no built-in HTTP
    ' layer yet (see docs/features.md), so sending the data anywhere is the app's own job.
  end if
}

public function setup() {
  taskManager.onAlertChanged(onQueueAlert)
}
```

An inline anonymous function expression works too: `taskManager.onAlertChanged(function (level:
string) { ... })`.

**Multiple independent subscribers in the same component are fully supported** — call
`onAlertChanged(...)` as many times as you like (with different callbacks); every one of them runs
on each real alert change. There is exactly one `ObserveFieldScoped` registration per component no
matter how many subscribers it has, so the field observer never double-fires.

**Only callable from a function body** — never from a `derived` expression or a template `{expr}`
binding (`expression/task-manager-on-alert-changed-in-reactive-expression`). Both of those recompute
repeatedly, and `onAlertChanged(...)` has a real, cumulative side effect (registering a callback) —
calling it from one would re-subscribe the same callback on every recompute, an unbounded leak. A
function body only ever runs it as many times as the author's own code actually calls it (typically
once, from `setup()`).

**Not callable from a `.flsh` class body** (`class/task-manager-on-alert-changed-not-supported`) —
the one `taskManager.*` action still excluded from the class support described above. Three open
problems, none safe to resolve without live-device verification first:
- Whether `ObserveFieldScoped`'s callback-scoping semantics even work when the *call site* is a
  class method (a plain closure with no SceneGraph node of its own).
- `ObserveFieldScoped`'s callback must be a real *top-level* `sub`/`function` name — never an AA
  member the way every other method is — so a class-side trampoline would need its own top-level
  declaration, and a fixed generic name (mirroring `.thr`'s single `on_taskManagerAlertChange`)
  would collide the moment a second class needing one is imported into the same component (every
  `.brs` a component pulls in via `<script>` shares one combined top-level scope). Every class
  method/constructor emitted today avoids this collision by construction (methods are AA members,
  never top-level declarations) — an `onAlertChanged`-style trampoline would be the first thing to
  need a class-name-qualified name instead.
- Even with those solved, `GetGlobalAA()` is one table shared by the *whole app*, so a callbacks
  array stored there needs a genuinely unique key per subscribing instance, and a class instance has
  no stable identity or destroy hook to safely back one (unlike a `.thr` component instance, whose
  own `m` scope is already correctly per-instance).

Call `taskManager.onAlertChanged(...)` from the owning `.thr` component instead, and pass the class
instance a plain method it can call back into.

### `taskManager.onResult(<task>, <onSuccess>, [<onError>])` — promise-style request consumption

An alternative to the old field-observer style (`task.observeFieldScoped("result"/"error", ...)`,
called by the DSL author directly — see `request Http {}` in "Requests") for consuming a
`request Http {}`-generated Task's own `result`/`error` fields — both styles stay available side by
side, this is sugar, not a replacement. **`<task>` is the task node itself** — the same value
already passed to `taskManager.run(...)` — not the id `run(...)` returns:

```
private function loadPosts(key: string, press: boolean) {
  if (press) {
    task = CreateObject("roSGNode", "GetPosts")
    taskManager.run(task)
    taskManager.onResult(task, onPostsLoaded, onPostsFailed)
  }
}

private function onPostsLoaded(result: dynamic) {
  ' `result` is exactly what parseResponse(...) returned — already unwrapped, unlike the
  ' old-style observeFieldScoped callback, which receives a roSGNodeEvent and must call
  ' .GetData() itself.
}

private function onPostsFailed(error: dynamic) {
  ' same shape as parseError(...)'s own return value
}
```

`onError` is optional — a failed request with no `onError` callback is a silent no-op (mirroring
`parseError` itself being optional in `request Http {}`). An inline anonymous function expression
works for either callback, exactly like `onAlertChanged`'s own callback.

**Why the task node, not the id**: confirmed live that a design registering the callback pair on
the MANAGER (keyed by the task id `run()` returns, reached via `callFunc`) cannot work at all — a
Function value placed into a `callFunc` AA argument arrives as `invalid` on the other side of a
cross-node `callFunc` call (SceneGraph field/argument marshaling doesn't carry raw Function values
across a node boundary). `onResult(...)` instead expands entirely on the CALLING component's own
script — `ObserveFieldScoped` is attached directly on `<task>`, from the same scope that already
holds a live reference to it, so the callback never has to cross any node boundary at all. See
`findings/task-manager-onresult.md` for the live-discovered failure and the fix.

**Fire-once "settle" semantics** — whichever of `result`/`error` is written first fires the
matching callback exactly once, then the registration is torn down (both fields unobserved,
the pending entry removed) — a task that somehow wrote both, or that's re-`run()` a second time,
never double-invokes a callback from a stale registration.

**Call it after `taskManager.run(<task>)`** — `<task>.id` (the lookup key this registration is
stored under) is only actually assigned once `run(...)` has processed the node, so `onResult(...)`
needs to run afterward. Unlike the earlier taskId-based design, there's no cross-thread race to
worry about here either way — everything (the `ObserveFieldScoped` call included) runs on this
component's own script, synchronously, regardless of exactly when it's called relative to `run(...)`.

**Not supported from a `.flsh` class body** (`class/task-manager-on-result-not-supported`) — same
underlying reason as `onAlertChanged`: whether `ObserveFieldScoped`'s callback-scoping semantics
even work when the call site is a class method is unverified, and this feature's two fixed
trampoline sub names would collide the moment a second class needing them is imported into the
same component. Call `taskManager.onResult(...)` from the owning `.thr` component instead.

### `taskManager.onRequestSent(<callback>)` / `taskManager.onResponseReceived(<callback>)` — global HTTP request/response interceptors

Global, app-wide, register-once reporting/telemetry hooks for every `request Http {}` component's
own HTTP traffic — see "Requests". Registers `callback` to run every time ANY `request Http {}`
component in the app sends a request (`onRequestSent`) or receives its response (`onResponseReceived`),
regardless of which component created the request or which screen registered the callback:

```
public function setup() {
  taskManager.onRequestSent(function (request: dynamic) {
    ' request = the resolved options AA: {method, url, headers, query, body, cache,
    '   buildSucceeded, buildErrorMessage} — see "Requests" → "Build safety".
    if not request.buildSucceeded then
      ' this endpoint's own buildRequest hook is buggy — the request still went out, with the
      ' static config's options (buildRequest's override was skipped), but report it anyway
    end if
  })
  taskManager.onResponseReceived(function (response: dynamic) {
    ' response = the RAW ft_httpFetch response, plus parseSucceeded/parseErrorMessage — see
    ' "Requests" → "Parsing safety". NOT the same value as result/error (those are each
    ' component's own parseResponse/parseError-transformed output).
    if not response.isSuccess then
      ' a real HTTP failure
    end if
    if not response.parseSucceeded then
      ' this endpoint's own parseResponse/parseError hook is buggy — orthogonal to isSuccess
    end if
  })
}
```

Shaped exactly like `taskManager.onAlertChanged(...)`, not `taskManager.onResult(...)`: this is a
global, register-once subscription with no per-task identity — every subscriber gets every event,
backed by an accumulating callbacks array, not a per-task lookup. Under the hood, the manager
singleton (`runtime-assets/TaskManager/FlashTheaterTaskManager.brs`) never stores or invokes a
Function value belonging to another component (the exact cross-`callFunc`-boundary bug documented
in `taskManager.onResult`'s own section above, and in `findings/task-manager-onresult.md`) —
instead it flips one of its own plain-data fields (`lastRequestSent`/`lastResponseReceived`) once per request/
response, and each subscribing component independently attaches its own `ObserveFieldScoped` to
that field, in its own `init()`, storing its own callback(s) in its own `m` scope. The original
design for these two hooks (register the callback pair on the manager via `callFunc`) was abandoned
before it was ever implemented, once `onResult`'s own postmortem proved that shape broken — see
`findings/task-manager-onresult.md`.

**Multiple independent subscribers in the same component are fully supported**, exactly like
`onAlertChanged` — call `onRequestSent(...)`/`onResponseReceived(...)` as many times as you like;
every one of them runs on each real request/response. There is exactly one `ObserveFieldScoped`
registration per component per hook no matter how many subscribers it has.

**Unlike `alertLevel`, `lastRequestSent`/`lastResponseReceived` are never hysteresis-gated** — every
single request/response is reported, even two structurally-identical ones back to back (a
reporting hook that silently dropped a repeat request would defeat the point).

**Only callable from a function body** — never from a `derived` expression or a template `{expr}`
binding (`expression/task-manager-on-request-sent-in-reactive-expression` /
`expression/task-manager-on-response-received-in-reactive-expression`), same reasoning as
`onAlertChanged`: both recompute repeatedly, which would re-subscribe the same callback on every
recompute.

**Not supported from a `.flsh` class body** (`class/task-manager-on-request-sent-not-supported` /
`class/task-manager-on-response-received-not-supported`) — same underlying reason as
`onAlertChanged`.

### `taskManager.runningCount` / `taskManager.queuedCount` / `taskManager.alertLevel` — snapshot reads

Plain, non-reactive reads of the manager's own state — the same "point-in-time snapshot" treatment
`router.path` gets, not a `watch`-reactive binding. Useful for a diagnostic display or a hand-wired
`Timer` poll; there is no live binding from an arbitrary global field into a template.
`taskManager.onAlertChanged(...)` (above) is the one exception — `alertLevel` is also the one field
on this singleton meant to be observed directly.

### Wiring

Whenever any component in the app reads or calls `taskManager.*` anywhere, `flash-theater compile`
automatically copies `FlashTheaterTaskManager`'s `.xml`/`.brs` into
`components/FlashTheater/FlashTheaterTaskManager/` and wires it into the generated
`FlashTheaterGlobals.brs` bootstrap, the same unconditional-once-used treatment `store`/`focus`/
`router` already get.

### Known limitations

- **Task nodes created outside `.thr`/`.flsh` are invisible to this manager.** `taskManager` only
  ever knows about a Task node the moment it's handed to `taskManager.run(...)` — nothing observes
  Task creation itself, so hand-written BrightScript (a `.brs` file imported via
  `<script uri="...">`, or code outside this compiler's own pipeline entirely) that creates and
  starts a Task directly is never counted or throttled unless it's also explicitly routed through
  `taskManager.run(...)`. This is exactly why the default limit (50) sits below the real hard limit
  (100) — headroom for exactly this gap — and why `setMaxConcurrent(...)` exists for an app that
  knows it has more untracked Task creation than that.
- **No timeout for a task whose `state` never leaves `"init"`.** A node that's never really a
  functioning Task (author error, or one whose own thread never starts) permanently occupies a
  concurrency slot — the manager does not verify `node` is a genuine Task, and has no fallback
  timer.
- **No automatic cleanup when a `.flsh` class-body `taskManager.run(...)` call's task outlives the
  class instance.** A class instance has no SceneGraph node of its own and no destroy hook to key an
  auto-cancel off of — an app that wants to stop a class-started task early (or on its owning
  component's own teardown) still has to keep the returned id and call `taskManager.cancel(id)`
  itself. This is narrower than it used to be: an ordinary `.thr` component's own `run(...)` calls
  ARE now auto-cancelled when that component is torn down (a router navigation away,
  `{#if:destroy}`, or an `{#each}` removal) — see `taskManager.run(...)`'s own section above and
  `findings/task-manager-core.md`'s "No automatic cleanup..." section for how.
- **An author-set `node.id` that collides with another already-tracked task's id is silently
  re-minted** — the id `run(...)` returns can therefore differ from whatever the author explicitly
  set on the node, if (and only if) that exact string was already in use by a different task.
- **`taskManager.runningCount`/`.queuedCount`/`.alertLevel` are non-reactive snapshots** when read
  as plain values — no `watch` support, same as `router.path`. `onAlertChanged(...)` is the one
  sanctioned way to react to `alertLevel` changing, since it's built on a real `ObserveFieldScoped`
  registration, not the DSL's own `watch` mechanism.
- **`run(node, priority)`'s priority only affects queue order, never preempts an already-running
  task** — a burst of `"high"`-priority `run()` calls arriving while the concurrency limit is
  already saturated with `"low"`-priority work still waits for those low-priority tasks to finish
  naturally; nothing stops or demotes already-started work.
- **Re-prioritizing an already-queued task isn't supported** — calling `run(...)` again with the
  same node's id (see idempotency above) and a different `priority` argument has no effect; the
  first call's priority sticks until the task starts or is cancelled.
- **`onAlertChanged(...)` is the one `taskManager.*` action not reachable from a `.flsh` class
  body** — see its own section above for the two open reasons why. Every other action/read works
  from a class body via `GetGlobalAA().global` (see "Classes").

## Environments

An **environment** is a named, opt-in build profile — different builds of the same app (e.g.
`staging`/`production`) that need different build-time variables (API keys, service URLs), a
patched `manifest`, or a different set of bundled files, without a separate copy of the source
tree. With no environment active, every app builds exactly as it did before this feature existed —
this is entirely additive.

### Selecting an environment

`flash-theater compile --env <name>` selects `environments/<name>.config.json` (a dedicated
folder, sibling to `src/`/`flash-theater.config.json`) as the active environment. Equivalently, a
`FLASH_THEATER_ENV=<name>` environment variable is honored as a fallback whenever `--env` isn't
passed — specifically so it flows through `npm run build:roku`'s `compile && zip` chain untouched:

```bash
FLASH_THEATER_ENV=staging npm run build:roku
```

No `--env`/`FLASH_THEATER_ENV` at all ⇒ unchanged behavior: `out/`, `dist/<app>.zip`, no manifest
patch, `env.*` is a compile error anywhere it's used. An active environment writes to `out-<env>/`
instead of `out/` (see "Project layout" above), so different environments' builds never clobber
each other or the plain build.

### `environments/<name>.config.json`

```json
{
  "variables": {
    "apiBaseUrl": { "value": "https://staging.api.example.com" },
    "apiKey": { "fromEnv": "STAGING_API_KEY" }
  },
  "manifestOverrides": {
    "title": "My App (Staging)"
  },
  "exclude": ["images/production-only/**"],
  "include": ["images/staging-only/**"]
}
```

All four keys are optional, and — unlike the base `flash-theater.config.json` — an unrecognized
top-level key is a hard error (`environment-config/unknown-key`): `designResolution`/`srcDir`/
`outDir` are **not** overridable per-environment, so an environment file that tries is almost
certainly a mistake, not a new feature being (silently) ignored.

- **`variables`** — each declared name resolves to a plain string, either a literal (`{ "value":
  "..." }`) or read from a build-time bash/CI environment variable (`{ "fromEnv": "VAR_NAME" }` —
  compiling fails with `environment-config/missing-env-var` if `VAR_NAME` is unset). Exactly one of
  `value`/`fromEnv` is required per variable. Readable from DSL code as `env.<name>` (below).
- **`manifestOverrides`** — a partial patch on top of the base `src/manifest`: each key is
  upserted into the manifest's `key=value` lines (replacing an existing line in place, or appended
  if new) when writing `out-<env>/manifest`. `src/manifest` itself is never modified.
- **`exclude`** — glob patterns (same syntax as the base config's `exclude`), added on top of it
  for this environment only.
- **`include`** — glob patterns that are exempted from `exclude` (the base config's or this
  environment's own) for this environment only. This is what lets a base config permanently
  exclude e.g. `images/staging-only/**`/`images/production-only/**` from the plain build, while
  each environment's own `include` pulls its own subtree back in.

### `env.<name>` — reading a declared variable

```
derived apiBaseUrlLabel: string = "API: " + env.apiBaseUrl
```

`env` is resolved the same structural way `theme.a.b` is — not a schemaless, free-form scan like
`store`/`router` — because an environment's whole variable set is known from its own config file at
compile time, so both of these are ordinary compile errors, not runtime bugs:

- **`env.<name>` used with no active environment at all** — `expression/env-requires-active-environment`.
- **`env.<name>` where `<name>` isn't declared in the active environment's `variables`** — `expression/unknown-env-variable`.

`env.<name>` is read-only (`expression/env-not-callable` if called like a function — a variable is
always a plain string, never a function) and flat, no nested groups
(`expression/unknown-env-member` for `env.a.b`). It's baked once, as a literal associative array,
into the same `FlashTheaterGlobals.brs` bootstrap the store/theme/router/task-manager singletons
and `scale`'s runtime factor are wired into (`m.global.ft_env.<name>`) — never a SceneGraph node,
since (unlike those) an environment's variables are fixed at compile time and never reassigned at
runtime, so there's nothing to instantiate. `env` is otherwise an ordinary identifier — no new
reserved keyword.

### `environments/<name>.local.config.json` — local overrides

An optional, git-ignored file sitting beside `environments/<name>.config.json`, same shape,
automatically picked up whenever that environment is selected — no extra flag. Lets a developer
override any of that environment's values on their own machine (point `apiBaseUrl` at `localhost`,
supply a personal sandbox `apiKey`) without touching the committed config or needing every
developer to export the same bash variable. `variables`/`manifestOverrides` are merged key-by-key
with the local file winning on any conflict (a local entry fully replaces the committed one for
that key, but doesn't disturb keys only the committed file declares); `exclude`/`include` are
concatenated, committed patterns first.

### Output naming

An active environment's zip is named `dist/<app>-<env>-<major>.<minor>.<build>.zip` (the version
numbers read from the **final, patched** manifest) rather than the plain build's `dist/<app>.zip` —
built by `flash-theater zip` (see "Packaging" above), which honors `--env`/`FLASH_THEATER_ENV` the
same way `compile` does.

### Not (yet) supported

- Non-string variable values (numbers, booleans, nested groups) — every `env.<name>` value is a
  plain string.
- Per-environment `designResolution`/`srcDir`/`outDir` — those stay base-config-only, app-wide
  settings.
- `env.*` in the browser-based `ThrPlayground` docs-site component — there's no real
  `process.env`/environment-file concept to demo against client-side.

See `findings/environments.md` for the underlying design decisions and gotchas.

## Timer statements

```
setTimeout(<callback>, <milliseconds>)
setInterval(<callback>, <milliseconds>)
clearTimeout(<handle>)
clearInterval(<handle>)
```

Bare global functions — JS-shaped, **not** namespaced like `taskManager.run(...)`. `<callback>` is
either an anonymous function expression or a named function reference:

```
public function setup() {
  t = setTimeout(function() {
    state ready = true
  }, 1500)
}

public function scheduleClearable() {
  m.pollHandle = setInterval(onPoll, 500)
}

private function onPoll() {
  print "poll"
}

private function halt() {
  clearInterval(m.pollHandle)
}
```

`setTimeout`/`setInterval` return a **handle** — the created `Timer` node itself — usable later with
`clearTimeout`/`clearInterval`. The full BrightScript `Timer` node lifecycle (creation, `.duration`,
`.repeat` for `setInterval`, a callback registry entry, `ObserveFieldScoped("fire", ...)`,
`.control = "start"`) is generated and hidden behind the call. A `setInterval` callback is invoked
with **zero arguments** — new sugar, not a re-export of the raw SceneGraph `fire` event.

**Duration is milliseconds** (`setTimeout(fn, 1000)` means 1 second) — true JS parity, converted to
Roku's native `Timer.duration` field (seconds) in generated code. A literal duration folds to a
clean literal at compile time (`1000` → `1.0`); an arbitrary expression divides at runtime
(`(<expr>) / 1000.0`). A literal duration must be positive.

**Position**: `setTimeout`/`setInterval` may appear only as a bare statement of their own, or as the
entire right-hand side of a plain `<local> = ` (or `m.<field> = `) assignment, each occupying its own
line — never nested inside a larger expression, a condition, or a loop header.
`clearTimeout`/`clearInterval` may appear only as a bare statement. None of the four may be used
inside a `derived` expression, a dynamic template `{expr}` binding, or an `{#if}`/`{#if:destroy}`/
`{#each}` condition/collection/key expression — all of those recompute repeatedly, which would create
(or try to clear) a new Timer node every time; call them once from an ordinary function body instead.
**Not supported inside a `.flsh` class body** — same three reasons `taskManager.onAlertChanged`/
`onResult` aren't (see "Task manager" above): an unverified `ObserveFieldScoped`-from-a-class-method
scoping question, a fixed non-class-qualified trampoline sub name, and a class instance's plain-AA
`m` isn't a real component scope to hang a registry off of.

**Automatic cleanup on unmount.** Every pending `setTimeout`/`setInterval` created by a component is
automatically force-stopped when that component's own node is removed — via
`FlashTheaterRouterOutlet` navigating away from a router-mounted screen, an ancestor `{#if:destroy}`
block tearing down a subtree that contains the component, or an `{#each}` block removing an item that
contains it (any nesting depth, in all three cases — confirmed live through a real two-component-deep
chain and a real list-item removal, see `findings/component-unmount-hook.md`). This is a general
component-unmount hook (`ft_unmount`), introduced by this feature but not specific to it — every
compiled `.thr` component declares one, unconditionally, whether or not it uses a timer. See
`findings/component-unmount-hook.md` for the full design and its own still-open items.

Reserved names — `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` cannot be used as a
`field`/`derived`/`state`/`read`/`watch`/`stream`/`animation`/function/function-parameter name.

## Requests

```
request Http { method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE", url: "...", headers: {...}, query: {...}, body: ... }
```

Declares a `.thr` component as a single HTTP request/endpoint — at most one `request {}` per file,
sibling to `field`/`derived`/`state`/`stream` inside `<script>`. The component's whole purpose is to
be that one endpoint.
`<Kind>` is `Http` (the only Kind implemented so far — see "Known limitations" below).

**Requires `<component extends="Task">`** (`request/declaration-requires-task-extends`) — the
generated work function runs on this Task's own background thread, exactly like any other
`extends="Task"` component (see "Task manager"'s own note that `extends="Task"` is handled
completely generically by this compiler).

### Config keys (`Http`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `method` | string literal | `"GET"` | One of `GET`/`POST`/`PUT`/`PATCH`/`DELETE` (`request/invalid-http-method` otherwise). |
| `url` | string literal | `""` | Static base URL — completed/overridden per-call via `buildRequest(requestData)` (below). Can already contain its own `?...` query string; `query` (below) is appended with `&`, not `?`, when it does. |
| `headers` | nested object literal | `{}` | Merged with `buildRequest()`'s own `headers`, call-site wins on collision (key-by-key merge). |
| `query` | nested object literal | `{}` | Flat key/value map, URI-encoded and appended to `url` as a query string. Merged with `buildRequest()`'s own `query`, call-site wins on collision (key-by-key merge, same shape as `headers`). |
| `body` | any literal | `invalid` | Request body, `FormatJson`'d and sent as-is — object/array/string/number/boolean, unlike `headers`/`query` (always key/value maps). Wholesale-replaced (not merged) by `buildRequest()`'s own `body` when present. |
| `cache` | `false` \| `{ ttlSeconds?: <positive integer> }` | *(caches automatically per the server's own `Cache-Control`)* | **GET only** — `request/cache-requires-get-method` if `method` is anything else. Caching is **ON BY DEFAULT** — omitting `cache` entirely (or writing `cache: {}`) still caches, following whatever the real response's own `Cache-Control` header says; `cache` is only ever an *override* of that default: `cache: false` **forces caching off** entirely for this endpoint, and `cache: { ttlSeconds: <n> }` **forces** that exact lifetime, bypassing `Cache-Control` entirely (including an explicit `no-store`/`no-cache`). See "HTTP response caching" below. |

Every value must be a literal (string/number/boolean/`invalid`/nested object/array) —
`request/config-must-be-literal` otherwise; an unrecognized key is `request/unknown-config-key`;
an invalid `cache` shape (`true`, a non-boolean/non-object value, a present-but-non-positive/
non-integer `ttlSeconds`, or an unknown key inside `cache {}`) is `request/invalid-cache-config`.

### HTTP response caching (on by default; `cache: false` or `cache: { ttlSeconds: <n> }` overrides)

```
request Http {
  method: "GET",
  url: "https://api.example.com/catalog"
  ' caches automatically, following the server's own Cache-Control — no "cache" key needed at all
}
```

```
request Http {
  method: "GET",
  url: "https://api.example.com/live-price",
  cache: false   ' force caching OFF for this endpoint — always a real network request
}
```

```
request Http {
  method: "GET",
  url: "https://api.example.com/legacy-endpoint-with-no-cache-headers",
  cache: { ttlSeconds: 300 }   ' force this exact lifetime, ignoring whatever Cache-Control (if any) the server sends
}
```

Roku has no built-in HTTP cache — this is a from-scratch implementation
(`runtime-assets/Http/FlashTheaterHttp.brs`'s own "HTTP response caching" section).

- **Opt-out, not opt-in.** A GET request with no `cache` key at all still consults and populates
  the cache, purely following the real response's own `Cache-Control` header — there's no need to
  declare `cache` just to respect what the server already says. `cache: {}` is accepted and is a
  no-op, explicit spelling of this same default.
- **Storage**: `cachefs:/FlashTheaterHttpCache/<sha1(url)>` — Roku's own purpose-built,
  OS-clearable per-channel cache filesystem. The cache key is the **final resolved URL**
  (`url` + `query`, after `buildRequest`'s own override merge), so two different `query` values
  for the same endpoint never collide, and the same URL/query pair always hits the same entry.
- **`cache: { ttlSeconds: <n> }` FORCES the cache lifetime** — bypasses `Cache-Control` entirely,
  including an explicit `no-store`/`no-cache` (a deliberate override: the DSL author explicitly
  asked for this exact duration). Without a forced `ttlSeconds` (the default case), the real
  `Cache-Control` response header governs entirely: `no-store`/`no-cache` means never cache,
  `max-age=<n>` uses that value, anything else (including no `Cache-Control` header at all) means
  don't cache — no locally-assumed lifetime, ever, unless explicitly forced.
- **`cache: false` FORCES caching off** — the cache is never consulted nor written for this
  endpoint, regardless of what the server sends.
- **`response.fromCache`** (a new field on every `ft_httpFetch`/`parseResponse`/`parseError`
  response, alongside `isSuccess`/`httpStatusCode`/`data`/`headers`/`rawBody`) is `true` only for
  an actual cache hit — `false` for every real network response (success or failure) and for a
  request with caching disabled. Useful for surfacing "served from cache" in an app's own UI, and
  for testing/demoing the cache itself.
- **Known limitations**: no `Expires` header parsing (only `Cache-Control: max-age`) — a real
  HTTP-date parser is a separate, meaningfully large piece of work, deferred rather than
  half-implemented. No ETag/conditional-GET revalidation — an expired entry is a plain cache miss
  (a fresh, uncached request). `cache` is not overridable via `buildRequest` — a caching policy is
  a property of the endpoint in this phase, not a per-call choice.

### Generated shape

Always: `result: assocarray`, `error: assocarray`, `resolvedOptions: assocarray`, `rawResponse:
assocarray`, and `ft_isRequestComponent: boolean` (XML-defaulted `true`) — real SceneGraph field
types, `assocarray` outside this DSL's own `field`/`state` type set on purpose (see "Reserved `ft_`
prefix"'s sibling discipline of bespoke codegen for a feature that needs something the ordinary
`field` grammar doesn't cover). `init()` also sets `m.top.functionName = "ft_runRequest"`
automatically — no need to set `task.functionName = "..."` by hand the way a plain Task component
otherwise would.

`resolvedOptions`/`rawResponse`/`ft_isRequestComponent` are internal plumbing, not meant to be read
directly by DSL author code:

- **`resolvedOptions`** — unconditionally written in `init()` to the static config's own resolved
  options AA, regardless of whether `buildRequest` is declared. This is what
  `taskManager.onRequestSent(...)` (see "Task manager") reads as its payload — it needs a reliable
  value for every `request Http {}` component, not just ones overriding it via `buildRequest`. See
  "Parameterizing a request per call" below for how a `buildRequest`-declaring component's caller
  overwrites this same field with the merged result.
- **`rawResponse`** — written once, at the end of `ft_runRequest()`, with the RAW
  `ft_httpFetch` response (`{isSuccess, httpStatusCode, data, headers, rawBody, failureReason,
  fromCache}`) plus `parseSucceeded`/`parseErrorMessage` (see "Parsing safety" below) —
  deliberately NOT the same value as `result`/`error` (which hold `parseResponse`/`parseError`'s own
  transformed output, an app-author-defined shape that varies per component). This is what
  `taskManager.onResponseReceived(...)` reads as its payload — a generic reporting hook needs a
  consistent shape across every `request Http {}` component, not whatever each one's own hooks
  happen to return.
- **`ft_isRequestComponent`** — the marker `FlashTheaterTaskManager.brs`'s `startNode()` checks
  before firing either interceptor or attaching the `rawResponse` observer — see "Task manager".

**Only when `buildRequest` is declared**, one more thing exists: a `<function
name="prepareRequest">` interface entry (a real, `callFunc`-reachable function taking `requestData
as object`) — see "Parameterizing a request per call" below for what it's for.

### Overridable hooks

`buildRequest`/`parseResponse`/`parseError` may be declared `public` or `private` — unlike a bare
string literal handed to `observeFieldScoped`/`ObserveField` (never rewritten by this compiler —
see `findings/task-manager-onresult.md`'s and `findings/requests-runtime.md`'s own notes on that gotcha), these
hooks are always called by their real compiled name, `private_<name>` included when declared
`private function` (a `public function` keeps its literal DSL name — see "Declarations in the
`<script>` region"), resolved at compile time (never a runtime `type()` probe) — so `private` is
safe, and the ordinary DSL-wide default, here too:

```
private function buildRequest(requestData: object): object {
  return { url: "...", headers: {"X-Header": "..."}, query: {"userId": "..."}, body: {...} }   ' any key omitted falls back to the static config
}
private function parseResponse(response: object): object {
  return { ... }   ' becomes m.top.result on a 2xx response
}
private function parseError(response: object): object {
  return { ... }   ' becomes m.top.error on a non-2xx response or a failed request
}
```

**Quote `headers`/`query` keys inside a hook body's return value** (`"userId"`, not bareword
`userId`) — an unquoted associative-array-literal key is case-folded by BrightScript itself at
runtime (treated like an identifier, the same case-insensitivity BrightScript variable/function
names get), silently breaking a case-sensitive header/query-param name a real API expects. This
only matters inside a hook body — `request Http {}`'s own static config literal above is immune
(the compiler always re-prints every static key as a quoted string, regardless of how it's
written in source) — see `findings/requests-runtime.md` for the live-confirmed failure mode.

Every hook is optional — omitting `buildRequest` uses the static config as-is; omitting
`parseResponse`/`parseError` writes the raw `response` (`{isSuccess, httpStatusCode, data, headers,
rawBody, failureReason}`, from `runtime-assets/Http/FlashTheaterHttp.brs`'s `ft_httpFetch`) straight
to `m.top.result`/`m.top.error`.

#### Parsing safety — a `parseResponse`/`parseError` exception never crashes the Task

Each hook's own invocation, when declared, is wrapped in a `try`/`catch` — a bug in either hook
body (a bad field access, an unexpected response shape) degrades to a synthesized fallback error
instead of crashing the whole Task:

```
m.top.error = { message: "parseResponse threw: " + <exception message>, parseFailed: true, httpStatusCode: response.httpStatusCode, raw: response }
```

(`parseError`'s own catch produces the same shape, with `"parseError threw: "` instead.) `m.top.error`
is always left with something usable — never left unset — even when the hook that would have set it
crashed. A component with neither hook declared gets no `try`/`catch` at all (nothing there can
throw). `buildRequest` gets the equivalent protection too — see "Build safety" below.

Whether the most recent parse succeeded is also surfaced on `rawResponse` (see "Generated shape"
above) as `parseSucceeded`/`parseErrorMessage` — orthogonal to `rawResponse.isSuccess`: a successful
HTTP call can still have `parseSucceeded: false` (a buggy `parseResponse`), and a failed HTTP call's
own `parseError` can itself throw, also producing `parseSucceeded: false`. A
`taskManager.onResponseReceived(...)` interceptor (see "Task manager") is the intended consumer of
this signal — a reporting/telemetry hook can specifically flag "this endpoint's own parse hook is
buggy," distinct from "the HTTP call itself failed."

### Parameterizing a request per call — `buildRequest`, resolved BEFORE the Task starts

`request Http {}`'s own config literal can only ever hold compile-time-fixed values — a query
parameter, a path segment baked into `url`, or a body that depends on a runtime value (a
caller-supplied id, a user's typed search text, a page number) all have to flow through
`buildRequest(requestData)` instead, where `requestData` is whatever the caller passes.

**Critically, this resolution happens on the render thread, before `taskManager.run(task)` ever
starts this Task's own background thread** — not inside `ft_runRequest()` (the Task-thread work
function). A component declaring `buildRequest` gets a generated, `public`, `callFunc`-reachable
`prepareRequest(requestData)` function; the caller invokes it explicitly, BEFORE `run()`:

```
task = CreateObject("roSGNode", "GetPosts")
task.observeFieldScoped("result", "onPostsLoaded")
task.observeFieldScoped("error", "onPostsFailed")
task.callFunc("prepareRequest", { userId: someRuntimeValue })   ' resolves options NOW, on the calling thread
taskManager.run(task)
```

`prepareRequest` merges the static config with `buildRequest(requestData)`'s own override (`query`/
`headers` merged key-by-key, call-site wins; `method`/`url`/`body` wholesale-replaced when present)
and stores the fully-resolved options onto `m.top.resolvedOptions`. `ft_runRequest()` then just
reads that already-resolved field — never calls `buildRequest` itself.

**Why**: a Roku Task node is an ordinary, single-threaded node right up until `control="RUN"` is
set — `CreateObject(...)` and an ordinary `callFunc`/field write both execute on whichever thread
is doing them (the render thread, in the ordinary case), with no Task thread involved yet. If
`buildRequest`'s own body ever read something living outside this node — `store`/`theme`/
`m.global.*`/another node's field — doing that from *inside* `ft_runRequest()` (which only exists
once `control="RUN"` has actually spun up the background thread) would trigger a real Roku
**rendezvous**: the background thread blocks, synchronously waiting on the render thread to
service that foreign-node access. Calling `prepareRequest` before `run()` sidesteps this by
construction — there's no background thread yet to rendezvous from. See
`findings/requests-runtime.md` for the full design-review writeup (this was flagged and fixed after phase 1 first shipped
`buildRequest` running inside `ft_runRequest()` itself).

`resolvedOptions` is now unconditionally written to the static config's own resolved options in
`init()` (regardless of whether `buildRequest` is declared — see "Generated shape" above), so a
caller that forgets to call `prepareRequest` still gets a working request — `ft_runRequest()` reads
that same static value back (silently skipping `buildRequest`'s own override) rather than crashing.
`prepareRequest`, when called, simply overwrites `resolvedOptions` with the merged result before
`taskManager.run(task)` ever reads it — the same "last write wins, both happen before `RUN`" shape
`SlowTask.thr`'s own "set input fields, then `control="RUN"`" convention already relies on for
ordinary Task input.

**When `buildRequest` isn't declared at all**, only `prepareRequest` itself doesn't exist —
`ft_runRequest()` just reads the same unconditionally-written `resolvedOptions` field, exactly as a
request with no per-call parameterization needs (and with zero rendezvous risk to begin with, since
nothing dynamic/global is ever touched to produce it).

#### Build safety — a `buildRequest` exception never crashes the calling thread

`buildRequest` is the DSL author's own hook body too, and can throw just like `parseResponse`/
`parseError` — a bad `requestData` field access, most realistically. Its call (plus the
override-merge logic that reads its return value) is wrapped in `try`/`catch` inside
`prepareRequest()` — safe to do there specifically because `prepareRequest()` always runs on the
CALLING thread (never the Task's own background thread — see "Why" above), so there's no rendezvous
concern for the `try`/`catch` itself, unlike a hook that ran inside `ft_runRequest()`.

On a caught exception, `options` is left exactly as the static base config produced it — none of
`buildRequest`'s own overrides were applied, since the call that would have applied them is what
threw — the same graceful "use the static base options" degrade a forgotten `prepareRequest()` call
already gets. **The request still proceeds** with the static options rather than being abandoned.
`resolvedOptions` gains two more keys reporting this, always present regardless of outcome:

```
resolvedOptions.buildSucceeded      ' boolean — false only when buildRequest actually threw
resolvedOptions.buildErrorMessage   ' string — the caught exception's own .message, "" otherwise
```

Since `resolvedOptions` **is** `taskManager.onRequestSent(...)`'s own payload (see "Task manager"),
a registered interceptor sees `buildSucceeded: false` automatically the instant a `buildRequest`
hook misbehaves — no new hook, no new field on the manager, reusing the exact reporting shape
`rawResponse.parseSucceeded` already gives `onResponseReceived` on the response side. This is the
"report this in production" story for `buildRequest` failures — the same global interceptor an app
already registers for telemetry.

### Consuming a request — two styles, both fully supported

**The old field-observer style** — the DSL author wires `observeFieldScoped` by hand:

```
task = CreateObject("roSGNode", "GetPosts")
task.observeFieldScoped("result", "onPostsLoaded")
task.observeFieldScoped("error", "onPostsFailed")
task.callFunc("prepareRequest", { ... })   ' only if this request declares buildRequest — see above
taskManager.run(task)
```

`result`/`error` are ordinary real SceneGraph fields — nothing about `request {}` is hidden behind
sugar at this layer; `taskManager.run(task)` is the same call documented in "Task manager", entirely
unchanged. Unlike `buildRequest`/`parseResponse`/`parseError` above, the handler names passed to
`observeFieldScoped` here ARE bare string literals, never rewritten — those handlers
(`onPostsLoaded`/`onPostsFailed` above) must stay `public function`, or their compiled
`private_`-prefixed name silently won't match the string and the observer never fires (see
`findings/requests-runtime.md`).

**The newer promise-style sugar** — `taskManager.onResult(task, onSuccess, [onError])`, see "Task
manager"'s own section on it — registers directly on the task NODE (not its id) instead of
hand-wiring `observeFieldScoped`, and its callbacks receive the already-unwrapped `result`/`error`
value directly (not a `roSGNodeEvent`), and are safe as `private function` (no bare-string-name
gotcha, unlike the old style above):

```
task = CreateObject("roSGNode", "GetPosts")
taskManager.run(task)
taskManager.onResult(task, onPostsLoaded, onPostsFailed)
```

Both styles read the exact same `result`/`error` fields — pick whichever fits the call site; a
sample-app fixture demonstrates each, side by side (`GetPosts`/`RequestDemoScreen.thr`'s three
buttons — see `findings/requests-runtime.md`).

### Wiring

Whenever any component declares `request Http {}`, `flash-theater compile` copies
`runtime-assets/Http/FlashTheaterHttp.brs` into `components/FlashTheater/Http/` and adds a
`<script uri="pkg:/...">` to that component's own XML — a `pkg:/`-rooted absolute path (same
treatment `stream`'s `FlashTheaterStream.brs` and every other shared runtime asset/`.flsh` import
gets, regardless of how deeply nested the referencing component is — see "Reserved `ft_` prefix").
A component that declares `request {}` also automatically counts as using `taskManager` (its
generated code reaches `m.global.ft_taskManager` for the manager's own Task-lifecycle bookkeeping),
even if its own script never writes `taskManager.*` directly.

### Known limitations

- **Only `request Http { ... }` is supported** — `request <Kind> { ... }` with any other `Kind` is
  a compile error (`request/unknown-kind`).
- **No retry logic, no cancellation, no request timeout** — a hung `roUrlTransfer` call blocks that
  request's own Task thread indefinitely (it does not block the render thread or any other task).

Global request/response interceptors (`taskManager.onRequestSent`/`onResponseReceived`, for
reporting/telemetry) shipped — see "Task manager" below, not a limitation of this section anymore.

## animation

Three layers, all compiling to Roku's native `Animation`/`SequentialAnimation`/`ParallelAnimation`
+ `Float`/`Vector2D`/`ColorFieldInterpolator` nodes — no shared runtime helper library backs any of
it (unlike `stream`/`scale`/`request Http {}`), since every piece of behavior is either static XML
these built-in node types already implement, or a couple of inline `.control =`/
`ObserveFieldScoped` lines per call site.

### Layer 1 — `animation` declarations

```
animation <name> {
  target: <elementId>
  duration: <seconds>
  easeFunction: "linear" | "inQuad" | ... | "outExpo" | "inOutQuad" | ... | "piecewise"
  delay: <seconds>
  repeat: true | false
  <fieldName>: [<v0>, <v1>, ...] | { key: [...], keyValue: [...], target: <elementId> }
}
```

Declares a named, reusable animation — sibling to `field`/`derived`/`stream`/`request {}` inside
`<script>`, any number allowed per file (unlike `request {}`'s "at most one"). `target` is a bare
identifier referencing a real template element id (`animation/unknown-target` if it doesn't
resolve) — not a string literal, the one place this config literal departs from `request {}`'s
"everything is a literal" convention.

**Known field shorthands** — `opacity`, `rotation` (→ `FloatFieldInterpolator`), `translation`,
`scale` (→ `Vector2DFieldInterpolator`), `color` (→ `ColorFieldInterpolator`). A plain array value
(`scale: [1, 1.15, 1]`) auto-computes evenly-spaced `key` percentages (`[0, 0.5, 1]` for 3 values,
`[0, 1]` for 2, ...) and inherits the block's own `duration`/`easeFunction`/`delay`/`repeat`. An
object-form value (`translation: { key: [...], keyValue: [...], target: overlay }`) gives full
per-field keyframe control and its own `target` override.

`scale` is the one field where a bare number broadcasts to uniform `[v, v]` (`scale: [1, 1.15, 1]`
means "scale x and y together") — `translation` never broadcasts, since x/y almost always differ
there; write `[x, y]` pairs explicitly. Negative numbers are supported (`translation: [-300, 0]`
for an off-screen start position).

**Escape hatch** for an arbitrary Roku field beyond the five known shorthands:
```
field: { name: "customFieldName", as: "float" | "vector2d" | "color", key: [...], keyValue: [...] }
```
Same object-form shape as a known shorthand's own object form, with `name`/`as` replacing the
implicit field name/interpolator kind.

**`scaled: true`** — object form only (`translation: { keyValue: [...], scaled: true }`), and only
on `translation` or the `field`/`as` escape hatch (`animation/scaled-not-supported-for-field` on
`opacity`/`rotation`/`scale`; `animation/scaled-not-supported-for-color` on `color` or `as:
"color"` — those are relative/unitless quantities that scaling would corrupt, not a design-
resolution pixel value). Runs every `keyValue` entry through the app's `ft_scale(...)` factor at
runtime (`m.top.findNode("ft_anim_<name>_scaled_<n>").keyValue = [...]`, set in `init()` once
`ft_scaleFactor` is known — the exact "XML can't call a function, override the raw default in
init()" pattern `scale field`'s own defaults already use), instead of baking the literal values
into static XML. Requires the same `flash-theater.config.json`/multi-tier `ui_resolutions` setup
`scale` itself needs (see the "scale" section) — use it whenever an absolute `translation` keyframe
must land in the same place as a `scale`d static layout, at every resolution, not just the app's
own design baseline:
```
scale derived cardTranslation: object = [760, 450]
animation introSequence {
  target: card
  translation: { keyValue: [[760, -200], [760, 450]], scaled: true }
}
<Rectangle id="card" translation="{cardTranslation}" />
```
Both the animation's own end keyframe and the card's static resting position resolve through the
identical `ft_scale([760, 450], factor)` call, so they agree at any resolution by construction.
`transition:fly`/`transition:slide`'s own `x`/`y` offset is always `scaled: true`, unconditionally
— it's a pixel offset by construction, so no author opt-in is needed there (unlike a custom
`animation {}` declaration, where the compiler can't infer a field's own semantic meaning).

**Composition** — `sequential: true` or `parallel: true` plus a `steps: [...]` array, each entry
the same shape as a simple animation body (arbitrarily nestable — a step can itself be composed).
Compiles to `<SequentialAnimation>`/`<ParallelAnimation>` wrapping `<Animation>` leaves. A step
with no explicit `target` inherits the nearest ancestor's own `target`. Mixing top-level fields
with `sequential`/`parallel` on the same block is rejected (`animation/mixed-composition-and-fields`)
— move the fields into their own `steps` entry instead. `duration`/`easeFunction` have no effect on
the composition node itself (Roku's `SequentialAnimation`/`ParallelAnimation` have no such fields)
— set them per step (`animation/composition-does-not-support-duration-or-ease-function` otherwise).

```
animation introSequence {
  target: card
  sequential: true
  steps: [
    { opacity: [0, 1], duration: 0.3 },
    { translation: { key: [0, 1], keyValue: [[0, 40], [0, 0]] }, duration: 0.4 }
  ]
}
```

### Trigger sugar — `.start()` / `.stop()` / `.pause()` / `.resume()` / `.finish()`

```
bounce.start()
```

Usable as a standalone statement anywhere one is legal (a function body, an `on:key[...]` handler)
— mirrors `stream`'s `.subscribe()`/`.emit()` sugar, and the five method names map 1:1 onto Roku's
own `AnimationBase.control` field values. Lowers to `m["$$ft_anim_<name>"].control = "<method>"`.
**Must be a statement of its own** — `expression/animation-control-call-must-be-statement` if
nested inside a larger expression, a `derived`, or a template binding (a `control` write has no
value to embed). A bare `bounce` (no trailing method call) resolves to the raw generated node
itself — an escape hatch for reading Roku's own `AnimationBase` fields directly (`bounce.state`,
an `ObserveField` on it, ...) beyond the five sugar methods.

### `.onFinish(callback)` — animation-finished hook

```
animation bounce {
  target: card
  duration: 0.4
  scale: [1, 1.15, 1]
}
private function play(key: string, press: boolean) {
  if (press) {
    bounce.start()
    bounce.onFinish(onBounceDone)
  }
}
private function onBounceDone() {}
```

Registers a callback that runs every time `bounce` reports Roku's own `state = "stopped"` —
whether it got there by running to completion, or via `.stop()`/`.finish()`. Unlike
`taskManager.onResult`'s fire-once/auto-unregister shape, `onFinish` fires **every** time the
animation stops, since a Layer 1 animation is commonly retriggered (a bounce button pressed
repeatedly) — there is no unregister API. The callback argument may be a bound function reference
or an inline anonymous function; registering `.onFinish()` again for the same name simply replaces
the previous callback (ordinary assignment semantics). Lowers to
`m["$$ft_animFinish_bounce"] = <callback>`, read back by a shared, once-per-name
`ObserveFieldScoped("state", ...)` handler registered in `init()`.

**Must be a statement of its own** — `expression/animation-onfinish-call-must-be-statement` if
nested inside a larger expression, a `derived`, or a template binding, for the same reason as the
five control methods above (this registers a callback via a field write; there's no value to
embed). **Rejected on an animation declaring `repeat: true` anywhere in its own step tree**
(`animation/repeat-not-supported-with-onfinish`) — Roku's `state` never reports `"stopped"` for a
looping animation, so the callback would provably never fire, the same reasoning Layer 2's `out:`
side already rejects `repeat: true` for. Not usable in a `.flsh` class body — Layer 1 `animation`
declarations aren't usable there at all (see Layer 1's own "Known limitations" entry above).

If the SAME declared animation name is ALSO used as a Layer 2 `out:`/`transition:` target
somewhere, the two mechanisms never actually contend for anything: `out:`/`transition:` always
synthesizes and animates its own per-block copy of the referenced config (a fresh node, never the
literal `ft_anim_<name>` node `.onFinish()` observes), so each gets its own independent handler.

### Layer 2 — `transition:` / `in:` / `out:` on `{#if}` / `{#if:destroy}`

```
{#if showPanel}
  <Rectangle id="panel" transition:fade={{duration: 0.25}} />
{/if}

{#if:destroy showCard}
  <Poster id="card" in:bounce out:fade={{duration: 0.15}} />
{/if}
```

Enter/exit animation for a conditional block's content — `transition:<name>` (both directions),
or `in:<name>`/`out:<name>` independently. `<name>` is either a built-in preset (`fade`, `fly`,
`slide`, `scale` — each expanding to the same shape a Layer 1 declaration produces) or a
script-declared `animation` name — one resolution mechanism, no separate preset type system. The
optional `{{...}}` value overrides `duration`/`delay`/`easeFunction`/`repeat` (and, for `fly`/
`slide` only, `x`/`y` — the off-screen starting offset, defaulting to `y: 40` for `fly`, `x: -100`
for `slide`) — **only for a preset**; a custom `animation` reference doesn't accept an override
(`animation/transition-override-not-supported-for-custom-animation` — adjust its own declaration
instead). Omit the value entirely, or write `{{}}`, for "use the defaults" (`transition:fade=""`).

`transition:X` is exactly `in:X out:X`, with the exit side setting every interpolator's native
Roku `reverse` field rather than a second hand-authored config — enter/exit stay symmetric by
construction.

**`repeat: true` is rejected on the `out:`/exit side** (`animation/repeat-not-supported-for-exit-
animation`), anywhere in its own step tree (the outermost node, or nested arbitrarily deep inside a
`sequential`/`parallel` composition) — the deferred `visible=false`/`removeChild` only ever runs
once the exit animation's own `state` field reports `"stopped"`, which a repeating animation never
does on its own (Roku loops it indefinitely until explicitly stopped, which nothing here ever
does); the block would stay visible forever. Freely allowed on the `in:` side — nothing waits for
an enter animation to finish, so a looping "pulse while shown" effect works as expected there.

**Only one direct child of the block may carry a transition-family attribute**
(`animation/multiple-transitioning-children`), and only on a **direct** child of the block itself
(`animation/transition-outside-conditional-block` otherwise) — the block's own deferred-visibility
mechanism (below) operates on the block as a whole.

**Toggle mode (`{#if}`):** on show, `visible = true` then the `in:` animation starts (a
still-in-flight exit is cancelled first, `control = "stop"`). On hide, the `out:` animation starts
— `visible = false` is deferred until it reports `state = "stopped"`, re-checking the block's own
condition first (a stale completion after a fast hide→show must not re-hide an already-reshown
block). A block with no `out:` animation keeps the exact instant-hide behavior it always had.

**Destroy mode (`{#if:destroy}`):** the enter animation starts as the last line of the generated
create sub, after the subtree is actually attached. On hide, the exit animation starts immediately;
`removeChild` itself is deferred to the same `state = "stopped"` check above. A block with no `in:`
animation keeps the exact original instant-construct/instant-destroy shape.

**Focus safety:** for a block with an `out:` animation and focusable content, every focusable
element in the subtree is unregistered (and focus recovered, if it held any) at the moment the
exit animation **starts** — not deferred to match the delayed hide/removal — since nothing in
`FlashTheaterFocusManager`'s candidate scoring checks `visible`, so a lingering, still-registered,
mid-fade-out node would otherwise remain a legitimate LRUD target or focus holder for the whole
animation's duration. See `findings/focus-system.md`.

### Layer 3 — `animate:<field>`

```
<Poster id="poster" opacity="{isActive}" animate:opacity="{{duration: 0.2}}" />
```

Auto-animates the reactive cascade's own write to a matching **dynamic** `<field>="{expr}"`
attribute on the same element, instead of an instant snap — `<field>` must be one of the five known
animatable shorthands (`template/animate-without-dynamic-attribute` if there's no matching dynamic
attribute on the same element; `animation/unknown-animate-field` for any field outside that set —
no `field`/`as` escape hatch here, unlike Layer 1, since animating an arbitrary field correctly
needs knowing its current BrightScript type, which this compiler has no way to check). The
optional `{{...}}` value accepts `duration`/`delay`/`easeFunction`/`repeat` — but only `duration`/
`delay` (plain numbers) are actually reachable in practice: the whole `{{...}}` sits inside the XML
attribute's own outer double quotes, and `easeFunction`'s value is itself a double-quoted string —
nesting one inside the other breaks XML parsing before the DSL ever sees it (confirmed: both a
quoted `"...easeFunction: \"x\"..."` value and an entirely unquoted `animate:opacity={{...}}` form
fail to compile). Use the field's own default `easeFunction` (`linear`) when `animate:` is
involved, or switch to a full `animation {}` declaration (Layer 1) if a custom easing curve matters
— see `apps/animation-demo`'s `AnimateAttrDemo.thr` for the verified working shape, including a
customized-vs-default pair using only `duration`/`delay`.
Also note: a dynamic attribute's own `{expr}` (here, `opacity="{isActive}"`) can never be a ternary
— see "Ternary" above — flip the underlying `state` with a plain `if`/`else` instead (as
`AnimateAttrDemo.thr` does).

This is the one place in the whole feature where an animation's `keyValue` is computed at
**runtime**, not baked into static XML/generated literals at compile time: the field's live
current value becomes the animation's start point, read fresh at every write. The element's
*initial* value at `init()` still snaps instantly — only a subsequent, cascade-triggered write
animates, matching Layer 2's own "no animation on initial mount" behavior.

### Known limitations

- **No `.flsh` class-body `animation` form** — animations are inherently tied to a template's
  element ids, which a class has none of.
- **`fly`/`slide` presets need a STATIC `translation` on the target to account for its own resting
  position** — the interpolator always writes an absolute value, so without knowing the target's
  actual resting translation the presets fall back to assuming Roku's own default `[0, 0]` (the
  original, still-default behavior for a target with no `translation` attribute at all). A target
  that declares its own static `translation="[x, y]"` is read automatically and used as the resting
  keyframe instead — `x`/`y`'s offset (default or overridden) adds against THAT value rather than
  `[0, 0]`, and in that case the whole interpolator is deliberately left unscaled (both keyframes
  stay in the exact same raw coordinate space the target's own literal already lives in — see
  `scaled: true` above for why mixing a scaled offset with an unscaled resting literal would be
  wrong). A target whose `translation` is DYNAMIC (`{expr}`/`bind:`) can't be read this way — that's
  a compile error (`animation/preset-target-has-dynamic-translation`); use a custom `animation {}`
  declaration with an explicit object-form `translation` instead, where you already control every
  absolute keyframe by hand.
- **`scale` animations are not reflected in `FlashTheaterFocusManager`'s LRUD geometry** —
  `absoluteRect()` only sums `translation` and reads `BoundingRect()`'s width/height; it never
  factors in a node's `scale` field. A card animating its own `scale` will not visually resize its
  own LRUD hit-testing footprint.
- **`scaled: true` is opt-in, per-field, and object-form-only** — a shorthand array value
  (`translation: [-300, 0]`) can never be `scaled`, since there's no room for the flag alongside a
  bare array literal; rewrite it as the object form to opt in. An author who forgets `scaled: true`
  on an absolute `translation` keyframe gets no diagnostic — it silently stays a fixed literal at
  every `ui_resolutions` tier, exactly like before this mechanism existed. No compiler check flags
  a `translation` keyframe that "looks like" it should probably be scaled (e.g. one whose value
  matches another `scale`d attribute's own unscaled source number) — that would need cross-checking
  arbitrary literal values against arbitrary `scale`d declarations elsewhere in the file, with no
  reliable way to tell an intentional coincidence from a forgotten `scaled: true`.
- **`scaled: true`'s runtime override only touches the interpolator's own `keyValue` field** — a
  `duration`/`delay` value (already resolution-independent, a time in seconds) is never scaled, nor
  could it be asked to be; there is no `scaled` key anywhere outside a field's own object form.

## Theme

```
<theme-template [default="name"]>       <theme name="...">
  ...group/leaf members...                ...group/leaf members
</theme-template>                         (a partial override)...
                                         </theme>
```

- **`<theme-template>`** — at most one per app, the canonical theme shape and
  defaults. Body is a sequence of members, each either:
  - a **leaf** — `<name>: <Type> = <literal>`, same 5-token shape as `field`
    minus the `field` keyword, same closed type set.
  - a **group** — `<name>: { <member>* }`, unbounded nesting.
  - An optional `default="name"` attribute names the initially-active variant
    (see the fallback chain below).
- **`<theme name="...">`** — zero or more per app (each a distinct name), a
  *partial* override of the template: a variant may omit any member (it falls
  back to the template's default at that exact path), but a member it does
  provide must exist in the template at that path, be the same kind (group
  vs. leaf), and declare the **same type explicitly** — never inferred.

**The `<theme-template>` file's own name and location are free choices —
they don't affect the compiled output.** `flash-theater compile` finds the
theme-template structurally (by its `<theme-template>` root tag), not by
filename, and always compiles it to a fixed `FlashTheaterTheme` component
under `components/FlashTheater/FlashTheaterTheme/` — the same fixed-name,
fixed-location treatment the built-in `store` already gets (see "Global
store" above). An app author can name their theme-template file `Theme.thr`,
`AppColors.thr`, or anything else, and put it anywhere the compile pattern
reaches; only its content (the `<theme-template>` tag) matters.

**Access — bare `theme.a.b`, no new keyword.** This is already a valid
BrightScript dot-expression, so no new embedded grammar is needed — the
DSL-level work is entirely in identifier resolution and path-shape
validation, not parsing (unlike `store`, `theme` still has a real compile-time
shape to validate against, since it must still be explicitly declared). A
`theme` reference is validated against the whole app's shape at compile time:
an unknown member, or indexing through a theme leaf, are compile errors.
Reads generate a real `ObserveFieldScoped` in the *consuming* component's own
`init()`, so a `theme` switch is reflected live everywhere it's read, not
just on next mount. Theme is read-only from components — there is no
`theme`-write syntax at all.

**Initial active theme — a three-tier fallback**, resolved at compile time:
1. `<theme-template default="name">`, if present.
2. Otherwise, the first-declared variant (by file discovery order).
3. If no variants exist at all, the template's own literal defaults.

A generated `switchTheme(name)` on the theme node changes it at runtime; an
unknown variant name is a no-op with a debug `print`, never a crash (a
runtime string can't be statically checked). See
`findings/reactivity-codegen-conventions.md` for the codegen details (the theme's
private per-variant AA-literal tables, and the `FlashTheaterGlobals.brs`
bootstrap an app author wires one line of into their own `Main.brs`).

## Classes (`.flsh` files)

A `.flsh` file is BrightScript-only reusable logic, entirely separate from a `.thr` component: no
`<script>` wrapper, no template, no XML output at all — just a class declaration compiled straight
to a `.brs` file.

### File shape

```
import <Name> from "<relative-path>.flsh"
...
class <Name> [extends <BaseName>] {
  ...members...
}
```

- Zero or more `import` statements, each naming exactly one other `.flsh` file's class, always
  come first — an import after the class, or a second class, is `flsh/trailing-content`.
- Exactly one `class` declaration, required — a file with only imports (or nothing at all) is
  `flsh/missing-class`. Leading content that's neither an import nor a class is
  `flsh/expected-import-or-class`.
- **The file's own base name must match the declared class name** — `LabeledCounter.flsh` must
  declare `class LabeledCounter { ... }`, or it's a compile error (`class/name-file-mismatch`).
  There is no other way to name/locate a class: `extends`/instantiation always goes through an
  explicit `import`, matched against every `.flsh` file discovered by the same compile pattern
  that finds `.thr` components (`import/file-not-found` if nothing resolves there,
  `import/class-name-mismatch` if the resolved file declares a different class than the import's
  own name says).
- **`<path>` supports two forms**, told apart purely by shape — no separate syntax:
  - **`./`- or `../`-prefixed** — relative to the *importing* file's own directory, e.g.
    `import Counter from "./Classes/Counter.flsh"` from a file that sits next to `Classes/`.
  - **Anything else** (no `./`/`../` prefix, and not filesystem-absolute) — relative to the
    **app root** instead, e.g. `import Counter from "components/Classes/Counter.flsh"`. This
    exists so a deeply nested component doesn't have to count `../../../` segments back out to
    reach a shared class near the top of the tree. The app root is `flash-theater compile`'s own
    invocation directory by default (a `--source-dir <dir>` override moves it to `<dir>`'s parent,
    keeping it the same directory `components/`/`source/` are already assumed to be siblings
    under).
  Either form can be used for the same class from different importers, and both compile to the
  same correct `<script uri="...">` in the output — the generated URI is always computed relative
  to the *importing* file's own directory, regardless of which form the DSL source used.

### `class` body

```
class <Name> [extends <BaseName>] {
  private <name>: <Type> = <literal>
  public <name>: <Type> = <literal>
  protected <name>: <Type> = <literal>

  [override] constructor(<param>: <Type>, ...) {
    [super(<args>)]
    private <name>: <Type> = <expr>
    ...
  }

  [override] public|private|protected function <name>(<param>: <Type>, ...)[: <Type>] {
    ...body...
  }
}
```

- **Three visibility levels** — `public`/`private`/`protected`, on both fields and methods.
  `private` gets the same `private_` prefix treatment a `.thr` component's `private function`
  does; `protected` compiles identically to `public` in generated code (BrightScript has no real
  access boundary to enforce either way — everything is just an associative-array key read).
  Lint-enforced visibility itself is deliberately out of scope for the compiler — a linter, not the
  compiler, is the intended place to enforce it, since BrightScript itself has no access-boundary
  mechanism a compile step could check against at runtime.
- **A field can be declared two ways**, and both populate the same member table: a top-level
  `<visibility> <name>: <Type> = <literal>` (evaluated once, before the constructor runs), or
  entirely inside the constructor as `<visibility> <name>: <Type> = <expr>` — the common
  "assign a constructor parameter straight to a field" shorthand. A name can't be declared as a
  field more than once, or as both a field and a method (`class/duplicate-member-name`), and (for
  an extending class) can never collide with any inherited member of any kind — a field has no
  `override` syntax, so any such collision is unconditionally an error, never something a field
  could legitimately intend.
- **A `stream` field** — `[public|private|protected] stream <name>: <Type>`, top-level only (never
  inside a constructor), no `=` initializer. Compiles to `prototype.<name> = ft_createStream()` (or
  `prototype.private_<name>` for a private one), set at the same timing as a literal-initialized
  field — before `super()`/the constructor body runs. Participates in the same
  `class/duplicate-member-name` collision checks as an ordinary field. See "`stream`" above for the
  full pub-sub semantics — a class-declared stream field works identically to a script-declared one,
  and (being a plain public/private/protected member) is reachable from whoever holds the instance,
  e.g. `notifier.onChanged.subscribe(...)` from the owning `.thr` component's own script, exactly
  like reading any other public field on a class instance already works.
- **At most one constructor.** Two is `dsl/multiple-constructors`. A constructor's body is a
  sequence of field-init statements (`<visibility> <name>: <Type> = <expr>`,
  `dsl/invalid-constructor-field-init` if malformed) plus ordinary statements (including the
  JS-shaped `if`) — no `state`/`store(...)`, since a class has neither
  (`class/state-store-not-supported`).
- **`theme`/`router`/`taskManager` ARE reachable from a class body — via `GetGlobalAA().global`,
  never `m.global`.** A class method is compiled as a plain associative-array member closure —
  BrightScript auto-binds `m` inside it to the class **instance**, never a SceneGraph node, so
  `m.global` (a `.thr` component's own access root) has no meaning there. `GetGlobalAA()` is
  confirmed live (real device) to return one `roAssociativeArray` shared app-wide that SceneGraph
  automatically populates with a `"global"` key aliasing the exact same content node `m.global`
  points at — with zero manual wiring, reachable identically from a `.thr` component and a `.flsh`
  class method. So `theme.a.b` reads, `router.navigate(...)`/`router.back()`/etc. (including the
  same mandatory sibling focus hand-off a `.thr` component gets), and
  `taskManager.run/cancel/setMaxConcurrent/setAlertThresholds(...)`/data reads all compile from a
  class body exactly like they do from a `.thr` component, just rooted at `GetGlobalAA().global`
  instead of `m.global`. `onAlertChanged`/`onResult`/`onRequestSent`/`onResponseReceived` are the
  four exceptions — see each one's own "Not supported from a `.flsh` class body" note in "Task
  manager". `store`/`state`/`focus(...)` remain entirely unreachable from a class body
  (`class/state-store-not-supported`/a parse-time rejection) — a *separate, unrelated* restriction,
  since a class has no reactive lifecycle at all (no `state`, no destroy hook), not an `m`-vs-context
  wiring gap the way `theme`/`router`/`taskManager` used to be.
- **`extends`/`override`/`super(...)` are structurally validated at parse time** (no cross-file
  knowledge needed for these): `override` on a constructor or method with no `extends` at all is
  `dsl/override-without-extends`; a bare `super(...)` call with no `extends` is
  `dsl/unexpected-super-call`; an extending class's constructor must exist, be marked `override`,
  and its **first statement** must be exactly one `super(<args>)` call
  (`dsl/missing-override-constructor`/`dsl/missing-super-call`/`dsl/super-call-not-first`). A
  zero-arg base is valid (`super()`).
- **`override` on a method is validated at compile time instead** (this needs the resolved base
  class, unlike the constructor checks above): a method marked `override` with no matching base
  member is `class/override-no-matching-member`; conversely, a method that redeclares a base
  member's name *without* `override` is `class/missing-override` — an unmarked shadow is far more
  likely a missing keyword than an intentional new member that happens to share a name.
- Method bodies use the same JS-shaped `if`/`else`/`else if`, the same `_`-prefixing for an unused
  parameter, and the same call-free dead-local elision as a `.thr` component's function body — see
  "Statements in function bodies" above. `m.<name>` inside a method resolves against the class's
  own member table (including inherited members), rewritten to `m.private_<name>` for a private
  member, exactly like a `.thr` component's `private` field/function.

### Codegen — a plain BrightScript "prototype object", not a component

A class compiles to one function returning an associative array — no XML, no `<interface>`,
nothing SceneGraph-shaped:

```brs
function Counter(start as integer) as Object
  prototype = {}
  prototype.private_count = 0

  private_constructor = function (self as Object, start as integer) as Object
    self.private_count = start
    return self
  end function

  prototype.get = function() as integer
    return m.private_count
  end function

  return private_constructor(prototype, start)
end function
```

- An ordinary method is attached as `prototype.<name> = function/sub(...)` and always invoked as
  `instance.method()`, so BrightScript auto-binds `m` to the instance — standard BrightScript
  closure-as-method semantics, no runtime helper needed.
- **The generated `private_constructor` is the one exception** — it's invoked as a **plain
  function call** (`private_constructor(prototype, start)`), not a method call, so `m` does
  **not** auto-bind inside it. Every member reference inside a constructor body is rewritten
  against an explicit `self` parameter instead of `m` — the single most important correctness
  detail in `codegen/class-emitter.ts`; get this backwards and every constructor-initialized field
  silently writes to the wrong (global) `m`.
- An extending class's `prototype` starts as `BaseName(<rewritten super args>)` instead of `{}` —
  the base class's own compiled function, called with the `super(...)` call's (rewritten) argument
  expressions — so every inherited field/method is already present on `prototype` before the
  subclass's own constructor body or method overrides run.
- `.flsh` classes participate in the same whole-app compile as `.thr` components
  (`compileApp`/`app-compiler.ts`): every discovered `.flsh` file is parsed, its import graph
  topologically sorted (cycle-detected as `class/import-cycle`) so a base class is always compiled
  before anything that `extends`/imports it, then compiled in that order. A `.thr` component's own
  `import <Name> from "<path>.flsh"` is resolved the same way and wired in as one or more
  `<script uri="...">` tags (deduped, and including every transitive import — e.g. importing a
  subclass automatically pulls in its base class's own `.brs` too) — see `FavoriteCounter.thr` in
  `apps/sample-app` for a real end-to-end example (imports `LabeledCounter`, which itself
  `extends Counter`).

