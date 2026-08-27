# `.flsh` class codegen pipeline (`class`, `extends`/`override`/`super`)

Design rationale and real bugs for how a `.flsh` class compiles to BrightScript — a separate
codegen pipeline from `.thr` components (`codegen/class-emitter.ts`,
`analysis/class-analysis.ts`/`class-shape.ts`/`class-identifier-rewrite.ts`), not a variant of
`compile.ts`'s `.thr` pipeline. See `packages/compiler/GRAMMAR.md`'s "Classes" section for the
precise, worked grammar (fields/methods/`extends`/`override`/`super`, the prototype-object shape a
class compiles to); this file is the *why* and the real bugs found building it. For how a class
body reaches app-wide global singletons (`store`/`theme`/`router`/`taskManager`) through
`GetGlobalAA()` rather than `m.global`, and why a class method's `m` is the instance itself, never
a SceneGraph node, see
[class-pipeline-global-singleton-access.md](class-pipeline-global-singleton-access.md). For the
core pipeline this sits on top of (flash-parser's CST/AST, the identifier-rewrite/scope-resolution
machinery, naming conventions), see `findings/compiler-architecture.md`. For the incremental
statement/expression grammar features (declarations, loops, ternary, comparison, anonymous
functions, ...) that a class method body can use exactly like a `.thr` function body, see
`findings/statement-grammar-features.md`, `findings/operators-ternary.md`,
`findings/operators-comparison.md`, and `findings/anonymous-functions.md`.

## `.flsh` classes are a separate codegen pipeline from `.thr` components, not a variant of `compile.ts`

A class has no template, no XML `<interface>`, nothing SceneGraph-shaped about it at all, so
`codegen/class-emitter.ts` does not reuse `compile.ts`'s `emitXml`/`emitBrs` pipeline — threading
class-specific cases through code that otherwise has nothing to do with classes would make both
harder to read (same reasoning `theme-emitter.ts` already uses for itself). A class compiles to
one function returning a plain associative array (a "prototype object"): fields become AA members,
methods become AA-member closures (so `m` inside a method is automatically bound to the instance —
standard BrightScript semantics), see GRAMMAR.md's "Classes" section for the full worked example.
The per-statement printing itself (`for`/`while`/`try`/`if`/`else if`/`else`/ternary/anonymous
functions) is NOT reimplemented here, though — it's shared with `.thr`'s own pipeline via
`codegen/statement-printer.ts`, see `findings/compiler-codegen-conventions.md`'s own entry on it.

**The one deliberate asymmetry, and the easiest thing to get backwards:** an ordinary method is
invoked as `instance.method()`, so BrightScript auto-binds `m`. The generated
`private_constructor` helper is invoked as a **plain function call**
(`private_constructor(prototype, a, b)`), so `m` does **not** auto-bind inside it — every member
reference in a constructor body must go through its own explicit `self` parameter instead. Every
print function in `class-emitter.ts` is threaded with a `selfExpr` (`'self'` for the constructor,
`'m'` for everything else) for exactly this reason; get it backwards and a constructor-initialized
field silently writes to the wrong (global) `m` instead of the instance being built.

`protected` parses as a genuine third visibility (`ClassVisibility = 'public' | 'private' |
'protected'`) but **compiles identically to `public`** — BrightScript has no real access boundary
to enforce either way, everything is just an AA-key read. Lint-enforced visibility (rejecting an
out-of-scope access at compile time) is tracked as its own, separate, still-deferred item
(docs/features.md) — don't conflate "the keyword parses" with "the boundary is enforced."

**Two independent places check `override` correctness, deliberately not merged:** a constructor's
override-ness (`override-without-extends`, `missing-override-constructor`, `missing-super-call`,
`super-call-not-first`) is validated structurally by flash-parser at *parse* time, since it only
needs to know "does this class have `extends` at all" — no cross-file base-class knowledge
required. A *method's* `override` correctness (`class/override-no-matching-member`,
`class/missing-override`) needs the resolved base class's own member shape, so it's checked at
*compile* time instead, in `analysis/class-analysis.ts`'s `checkOverrideCoherence`, after
`app-compiler.ts` has already resolved and topologically compiled the base.

**`ClassShape.allMembers` (`analysis/class-shape.ts`) is the member table both `override` checking
and `m.<name>` rewriting key off** — `ownMembers` (this class's own fields/methods) layered on top
of the base class's own already-computed `allMembers`, so an own member always wins over an
inherited one of the same name (exactly what `override` means), and a multi-level extends chain
never re-walks more than one level per class. A field declared entirely inside the constructor
(`private a: string = a`, no top-level `ClassFieldDeclaration` at all — the common
"constructor-parameter-assigned field" shorthand) is captured here too, from the constructor's
`ConstructorFieldInit` statements, not just from top-level field declarations. The constructor
itself is deliberately **not** a member here — it's never accessed via `m.<name>` in generated
code, so it plays no part in the resolution this shape exists for.

**Import/extends resolution is cross-file, so it lives in `app-compiler.ts`, not `compile.ts`**
(same "no `fs` inside `compile.ts`" reasoning as theme validation below) — `class Name` never
carries its own file location, so `extends`'s base and any instantiated class must be found via an
explicit `import <Name> from "<path>"`, resolved (see `resolveImportTargetPath`) and matched by
resolved absolute path against every discovered `.flsh` input. `compileFlshClasses` topologically
sorts the whole import graph first (DFS with an `onStack` set — a node revisited while still on
the current DFS stack is `class/import-cycle`), so a base class's `ClassShape` (for `extends`) and
transitive `.brs` script-URI list (for wiring a `.thr` component's multiple `<script>` tags) are
always already known before anything that depends on them compiles. A `.flsh` file's own base name
must match its declared class name (`class/name-file-mismatch`) — the only naming rule enforced
this way, since (unlike a `.thr` component) there is no other place a class's identity could come
from.

**An import path resolves one of three ways, decided purely by its own shape** (added after
relative-only imports turned out annoying for a component several directories deep importing a
shared class near the app's root): filesystem-absolute as-is; `./`/`../`-prefixed relative to the
*importing* file's own directory (the original, only form); anything else relative to `srcRoot`
instead. `compileApp(files, srcRoot = '.', outRoot = '.')` takes both as explicit arguments threaded
straight through to `compileFlshClasses`/`resolveFlshImport`/`toScriptUri` — **not** read from
`process.cwd()` internally, so `compileApp` stays exactly as pure/testable as it was before (a
pure-unit test that uses neither feature can keep calling `compileApp(files)` unchanged; one that
does must pass real roots matching its fixture's own absolute paths, e.g. `compileApp(files, '/app',
'/app')` against fixtures rooted at `/app/...`). **Since the src/out project-layout split**
(`project-layout.ts`, see `findings/build-layout.md`), `srcRoot` and `outRoot` are two genuinely
different directories, not the same value twice: `srcRoot` is what a bare (non-`./`) import
resolves against — it's a reference between two *source* files, resolved before either is compiled
— while `outRoot` is what every `<script uri="pkg:/...">` is computed relative to (`toScriptUri`),
since that's the directory that physically becomes the Roku package once zipped. This split forced
a real fix: a `.flsh` class's own compiled-`.brs` absolute path (used to build the `<script uri>` an
importing component gets) can no longer be derived as "next to the `.flsh` source" — the compiled
file actually lands under `outRoot`, mirrored at the same relative directory the source has under
`srcRoot` — see `compileFlshClasses`'s `ownBrsPath`. Either import form for the same class still
produces an identical, correct `<script uri="...">` in the output — the generated URI is always
`outRoot`-relative, completely independent of which form the DSL source used to name the import
target.

## A `derived` reading a `.thr` component's own class instance can crash on first mount — chain safety doesn't cover a function's own return-type cast

**Live-verified**, `apps/classes-demo`. The common `m.<name> = SomeClass(...)` idiom (a bare `m`
member, constructed in `setup()` — see `reactivity-state.md`'s own note on this pattern, no
`field`/`state` declaration needed) has a real timing trap: a `derived` whose default expression
calls a function reading that instance gets its FIRST value computed in `init()`, strictly before
`setup()` ever runs — so `m.<name>` is still `invalid` at that first evaluation. Every member access
in the generated call chain is safely `?.`-rewritten (never crashes on the chain itself), but if the
reading function has its own DECLARED return type (`: string`, `: integer`, ...), BrightScript still
enforces a cast on whatever the safely-short-circuited chain returns — casting `Invalid` to a typed
return crashes (`Type Mismatch. Unable to cast "Invalid" to "String"` for a `string` return; string
concatenation with the resulting `Invalid` throws too, same effect, different message). Confirmed
live crashing TWO chapters of `apps/classes-demo` on their very first mount before a fix (see
`findings/classes-demo-app.md`'s device-pass writeup) — this is a real, easy-to-hit gap, not a
one-off: any `derived` reading a class instance built in `setup()` is exposed to it. **Fix**: guard
the read explicitly — `if (m.<name> = invalid) { return <placeholder> }` before touching the
instance — in every function a `derived` calls this way, not just the outermost chain.
