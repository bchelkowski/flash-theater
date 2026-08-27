# Raw BrightScript passthrough (`' flash-theater:raw` / `' flash-theater:end-raw`)

See `packages/compiler/GRAMMAR.md`'s "Raw BrightScript passthrough" section for the full grammar
and constraints. This file is the *why* and the real bugs building it surfaced.

## Comment-CONTENT-driven boundary detection is a deliberate, one-off exception to this repo's grammar rule

`findings/compiler-architecture.md`'s "Never do this" section is explicit: never sniff comment
*content*, always recognize real tokens via depth-counting. This feature is the one exception —
there is no `TokenKind` for "raw block start," only a `Trivia` entry whose comment text happens to
match an exact string (`raw-block.ts`'s `matchesRawStartMarker`/`matchesRawEndMarker`). This was a
deliberate design call, not an oversight: the feature's whole point is "paste real BrightScript
verbatim," and every alternative (a new keyword+brace-block statement, e.g. `raw { ... }`) would
force the author to think about brace-balance inside their own pasted snippet, exactly the kind of
friction the escape hatch exists to avoid. The one existing precedent for a text-based (not
token-based) boundary is the top-level `<script>`/`</script>` split, which also necessarily happens
outside the normal token/grammar model — this feature reuses that same category of exception rather
than inventing a new kind of "text-scanning" rule; see `token-stream-parser.ts`'s
`tryParseRawBlock`'s own doc comment for the implementation-level version of this rationale.

## Comments are always LEADING trivia, never trailing — this is what makes end-of-scan detection safe at any boundary

`packages/flash-parser/src/trivia.ts`: ALL trivia (whitespace, line breaks, comments) attaches as
the **leading** trivia of the *next* token, never as trailing trivia of the previous one. This means
`tryParseRawBlock`'s termination check — "does `peek()` (not yet consumed) carry the end marker in
its leading trivia?" — works correctly even when `peek()` is the token right before the enclosing
block's own closing `}`, or real `TokenKind.EndOfFile`: there is always a real token to peek at and
inspect, so a raw block that runs all the way to the end of its enclosing body needs no special
casing. Bounded by `endExclusive` (the same index the caller's own `parseBlockContent`/
`parseConstructorBlockContent` uses) so an unterminated raw block reports
`statement/unterminated-raw-block` at the point the ENCLOSING block ends, rather than scanning past
it into unrelated later code before finally hitting real EndOfFile.

## A raw block's start marker must be checked BEFORE keyword dispatch, and must also stop an in-flight opaque scan mid-loop

Same class of bug `findings/statement-grammar-features.md` already documents for `for`/`while`/
`try` nested inside an ordinary opaque `StatementRegion`: real BrightScript inside a raw block
(`if ... then ... end if`, a bare `for`) would otherwise be misdispatched as this DSL's own
JS-shaped grammar if the raw-block check ran anywhere other than first. Two separate fixes were
needed, not one:

1. `tryParseRawBlock()` is called at the very TOP of `parseBlockContent`/`parseConstructorBlockContent`'s
   loop bodies, before the keyword-dispatch chain — this handles a raw block starting where a
   *new* statement is expected.
2. The opaque-scan accumulation loop inside both of those same functions (the fallback that builds
   an ordinary `StatementRegion` out of whatever doesn't match a DSL keyword) needed its own
   mid-scan stop condition — `startsRawBlock` in `token-stream-parser.ts`, mirrored in
   `class-parser.ts`'s constructor-body scan — checked at every token position past the region's own
   start. Without this, a raw block's start marker landing partway through an ordinary statement
   region (e.g. right after a plain assignment on the previous line) would be silently swallowed as
   inert comment text inside that `StatementRegion`, never reaching `tryParseRawBlock` at all.

## The end marker leaks into the FOLLOWING statement's own `.text` unless explicitly stripped — found via a real golden-fixture double-print bug

Confirmed live while building the `raw-block-basic` golden fixture: a raw block immediately followed
by an ordinary statement printed the end marker **twice** —
```
' flash-theater:raw
result = "limit is " + someUndeclaredHelperName().ToStr()
' flash-theater:end-raw
' flash-theater:end-raw     <-- duplicate, from the following StatementRegion's own leaked text
return result
```
**Root cause**: this is NOT a bug in the raw-block-capture logic itself — `RawBrightScriptStatement`'s
own token span correctly excludes the marker-carrying token. The marker's comment is legitimately
attached as LEADING TRIVIA of the *next* real token (`return`, in the example above), and
`StatementRegion.text` (`ast.ts`) has always derived its printed text from `node.getText().trim()`,
which — by design, since this is what lets a DSL author's own ordinary hand-written comment survive
into generated `.brs` as part of the following statement — includes ALL of that first token's
leading trivia. The raw block's own explicit closing-marker print (`statement-printer.ts`'s
`printRawBrightScriptText`, needed because a raw block at the very end of a function has nothing
following it to carry the marker forward) then collides with this pre-existing, otherwise-correct
"ordinary comment passthrough" behavior.

**Fix**: `raw-block.ts`'s `stripLeadingRawEndMarker(node)` — generalizes the same slice-past-the-
marker logic `rawBlockCodeText` already used for the START marker, keyed on the END marker instead —
called from `StatementRegion.text` before its existing `.trim()`/trailing-`;` stripping. Only
`StatementRegion` needed this: every OTHER node kind that could immediately follow a raw block
(`IfStatement`, `FieldDeclaration`, ...) is reprinted **structurally** from its own named child
tokens/nodes, never by calling `.getText()`/`.text` on its own outermost node — so a stray marker
sitting in one of THEIR leading-trivia positions is inert, never reaches printed output. `StatementRegion`
(the generic opaque-leaf catch-all, used both for `.thr` function bodies and `.flsh` constructor
bodies) is the one exception, since it IS its own outermost blob-printed text. Safe to call
unconditionally — a `StatementRegion` that doesn't follow a raw block simply has no matching trivia
entry, so the strip is a no-op.

**Lesson for the next marker-adjacent feature**: any new construct whose OWN full `getText()` gets
spliced directly into generated output needs the same defensive strip if it can immediately follow
a raw block. A construct that's always reprinted structurally (walking named children, never its own
outer blob) never needs it.

## Compile-time validation reuses the exact same eager-parse mechanism every other embedded region already has — no new machinery

`RawBrightScriptStatement`'s node construction (`token-stream-parser.ts`'s private
`makeRawBrightScriptRegion`) calls `this.attachBrightScriptParse(node, parseEmbeddedStatements,
'statement/invalid-raw-brightscript')` — the IDENTICAL call `makeStatementRegion` already makes for
an ordinary `StatementRegion` (just `'statement/parse-error'` there). This was already discovered,
not designed: ordinary function-body statement text was ALREADY being eagerly parsed via
flash-parser's own vendored BrightScript grammar (`parseEmbeddedStatements` → `parseBrightScript`,
wrap-in-synthetic-`sub` trick) and already surfaced real syntax errors at `.thr`/`.flsh` compile
time — this is NOT delegated to `kopytko-brightscript-parser` (that package's only remaining role is
post-codegen validation of the compiler's own *generated* output, see
`findings/compiler-pipeline-and-build.md`). A raw block just gets its own diagnostic code so the error
message is correctly attributed to the author ("your raw BrightScript is invalid") rather than
inheriting `validate-generated-brs.ts`'s `GeneratedBrsValidationError` wording, which explicitly
(and, for this one construct, wrongly) says "this is a compiler codegen bug, not a problem with your
.thr/.flsh source" — that framing is right for every other construct (which the compiler DOES
rewrite/regenerate) but backwards for a raw block, whose content is the author's own unmodified
text. This eager check runs on every real compile, unlike `validateGeneratedBrs`, which stays
opt-in (tests/CI only) for cost reasons.

The captured span passed to `attachBrightScriptParse` includes the START marker's own comment text
as harmless leading trivia (the node's span begins AT the marker-carrying token) — this parses fine
as an ordinary comment before real code, so no special un-wrapping was needed before validating.

## A raw block's own real local-variable declarations stay visible to later ordinary code — for free, via the existing scope-reconstruction fallback

`analysis/scope-resolution.ts`'s `reconstructStatementForScope`/`reconstructConstructorStatementForScope`
(used to rebuild a real-BrightScript-shaped version of a function body purely for
`buildBrightScriptScopes`/local-variable tracking, never emitted) both already end in a generic
`return statement.text` fallback for anything not structurally special-cased. `RawBrightScriptStatement`
needed no new branch there — its `.text` IS real, unrewritten BrightScript, so it falls straight into
that same fallback, exactly like an ordinary `StatementRegion`. Practical effect: `result = ...`
assigned inside a raw block is a genuine BrightScript local, visible to a later ordinary `return
result` in the same function, without `expression/unresolved-identifier` — added explicitly to both
functions' type unions anyway (rather than relying on TypeScript's structural typing silently
accepting it) purely for readability, since every OTHER branch in those functions is an explicit,
enumerated case and an absent one would misleadingly suggest raw blocks were never considered.

## Declaration-level (`.thr` top-level) form lands in `init()`, appended last — `.flsh` gets no equivalent

`codegen/brs-emitter.ts`'s `emitInitFunction` already assembles `init()` as one long, strictly
ordered, append-only `lines` array (field/derived setup, cascade registrations, focus registration,
binding assignments, conditional-block/each-block initial construction — see that function's own
inline comments for the exact fixed sequence). `script.rawBlocks` is appended, in source order,
as the LAST step, right before the closing `end sub` push — no restructuring of anything earlier in
the function needed, since every earlier section is itself just a sequential `lines.push(...)` (or
guarded loop of the same). This gives a raw top-level block "runs once everything else is already
set up" semantics, closest to an `onMounted`-style hook.

**`.flsh` classes deliberately get NO equivalent top-level (class-body-level) form** — a class may
declare zero constructors (`GRAMMAR.md`: "at most one constructor," never "exactly one"), so unlike
a `.thr` component's `init()` (which always exists), there is no guaranteed lifecycle sub to land a
class-body-level raw block into without synthesizing one. Revisit only if a real use case demands
it — the statement-level form (inside an *existing* method/constructor body) already covers the
common case, and `printClassStatement`'s dispatch (shared with `.thr`'s `printStatement` via
`codegen/statement-printer.ts`'s engine) already prints a raw block identically on both sides, so
extending to class-body-level later would only need parser-side wiring (a `tryParseRawBlock()` call
in `class-parser.ts`'s member-dispatch loop) plus deciding which lifecycle point to append into —
codegen-side, nothing would change.

## Formatting/linting are explicitly out of scope — deferred to whenever this compiler gets either, for both DSL code and raw blocks together

The ONLY shape change applied to a raw block's content is re-indentation (dedent to the block's own
minimum common leading whitespace, then reprint at the surrounding depth — `statement-printer.ts`'s
`dedentRawBlockLines`) — chosen for consistency with how every other construct in this compiler is
printed (canonical depth-based indentation, see `findings/compiler-codegen-conventions.md`'s "prints from a
structured AST" section), not byte-for-byte preservation of the author's own original indentation.
Nothing reformats a raw block's internal style beyond that, and no lint rule runs over it — this
compiler has neither a formatter nor a linter for ANY DSL construct yet, so raw blocks are not a
special case here, just consistent with everything else. `RawBrightScriptStatement` is a real,
independently addressable AST node (its own `SyntaxKind`, a real token span) rather than a string
spliced into another node's text specifically so a future formatter/linter can find and process it
the same way it would any other node, without a second parsing pass.
