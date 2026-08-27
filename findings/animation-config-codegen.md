# Animation — config parsing & codegen design notes

Compile-time design rationale for `animation {}`'s config surface (`analysis/animation-config.ts`)
and the codegen decisions in `codegen/animation-emitter.ts`/`analysis/identifier-rewrite.ts`. See
`packages/compiler/GRAMMAR.md`'s "animation" section for the grammar/API itself — this file is the
*why*. For the live-device narrative, the demo-app coverage audit, and the three real device-found
bugs, see [animation.md](animation.md). For the scale-integration (`scaled: true`) and
`{#if:destroy}` targeting design, see
[animation-scale-and-destroy-targeting.md](animation-scale-and-destroy-targeting.md).

## No shared runtime helper file — deliberate, not an oversight

Unlike `stream`/`scale`/`request Http {}`, no `runtime-assets/Animation/` exists. Every piece of
behavior is either static XML Roku's own `Animation`/`SequentialAnimation`/`ParallelAnimation`/
`*FieldInterpolator` node types already fully implement, or a handful of inline `.control =`/
`ObserveFieldScoped` lines per call site — nothing here is repeated, non-trivial logic worth
hoisting into a shared `.brs` library the way `ft_httpFetch`/`ft_scale`/`ft_createStream` are.

## `target:` is a bare identifier, not a literal — the one config-literal deviation

`analysis/animation-config.ts` cannot reuse `literal-value.ts`'s `walkLiteralValue` over the whole
config AA the way `request-config.ts` does, because `target: card` is a bare identifier referencing
a template element id, not a string/number/boolean/array/object literal. `walkLiteralValue` throws
on a bare identifier by design (it's meant to reject exactly this shape everywhere else). The
extraction is hand-rolled: assert the AA field's value is a `BsIdentifierExpression`, read its
`.name`, validate it against the template's own `elementIds` set (already computed by `compile.ts`'s
`collectElementIds`, threaded in as a parameter). Every OTHER config key (`duration`/`easeFunction`/
`delay`/`repeat`/`key`/`keyValue`/`sequential`/`parallel`/`steps`/the `field`/`as` escape hatch)
stays ordinary `walkLiteralValue`.

## Negative-number support was added to the SHARED `literal-value.ts`, not animation-only

`translation: [-300, 0]` (an off-screen starting offset) needs a negative-number literal, but
`-20` isn't a single literal TOKEN in BrightScript — it's a unary-minus expression wrapping the
literal `20`. `walkLiteralValue` didn't handle `BsUnaryExpression` before this feature; it now
unwraps exactly one level of `-` on a numeric operand. This is a genuine, deliberate behavior
change to a module `request-config.ts`/`field-state-literals.ts` also depend on — a pre-existing
`request-config.test.ts` test explicitly asserted that `cache: { ttlSeconds: -5 }` was rejected at
the generic "not a literal" layer (`request/config-must-be-literal`) specifically BECAUSE negative
numbers weren't literals at all; it now reaches `-5` as an ordinary negative number and is instead
rejected by the more specific "must be positive" check (`request/invalid-cache-config`) — same
practical outcome, different (more correct) diagnostic code. Updated in the same commit, not a
silent regression.

## `scale` uniquely broadcasts a bare number to `[v, v]`; `translation` never does

`scale: [1, 1.15, 1]` (a `Vector2DFieldInterpolator` field) auto-broadcasts each scalar keyValue
entry to a uniform `[v, v]` pair — "uniform scale" is the overwhelmingly common case, so forcing
`[[1,1], [1.15,1.15], [1,1]]` for the common case would fight the whole "least code" goal.
`translation` gets NO such broadcast: x/y almost always differ there, so a bare number would
silently guess a meaning the author probably didn't intend. A mix of uniform and explicit
`[x, y]` keyframes in the same `scale` array is allowed (`[1, [1.2, 0.8], 1]`) — the broadcast only
touches plain-number entries, non-number entries pass through untouched.

## Target-inheritance for composed (`sequential`/`parallel`) animations is recursive, not shallow

A composed animation's `target:` can be declared ONCE at the very top and inherited by every
nested step/interpolator, arbitrarily deep — `validateEffectiveTargets`
(`analysis/animation-config.ts`) walks the whole step tree threading `inheritedTargetId` down
before `parseAnimationConfig` returns, and `codegen/animation-emitter.ts`'s `emitStepXml` does the
identical walk again at emission time (both must agree, since one validates and the other emits —
they are two separate walks over the same tree, not one, since analysis and codegen are the
same "walk twice, once to check, once to emit" shape most of this compiler already uses elsewhere).

## Composed steps reject their own `duration`/`easeFunction` — Roku has no such fields there

`SequentialAnimation`/`ParallelAnimation` (a composed step's own emitted node) have no `duration`/
`easeFunction` fields at all — only `Animation` (a leaf step) does. Silently dropping an
author-declared `duration`/`easeFunction` on a composed step would be a real, hard-to-notice bug
(the value just vanishes), so `animation/composition-does-not-support-duration-or-ease-function`
rejects it at analysis time instead — put the timing on each individual `steps` entry.

## Layer 2's `transition:X` = `in:X out:X`, exit side sets Roku's own `reverse` field

Deliberately NOT two independently-authored configs. `FieldInterpolator.reverse` is a native Roku
field built for exactly "play this same keyframe set backwards" — reusing it means the exit
animation is byte-identical to the entrance one except this one flag, guaranteeing symmetry by
construction instead of by the author remembering to keep two hand-written configs in sync. A
CUSTOM (non-preset) animation referenced via `in:bounce`/`out:bounce` gets the SAME treatment —
`analysis/animation-presets.ts`'s `applyReverse` recursively sets `reverse: true` on every
interpolator in the referenced animation's own step tree when used as the `out:` side.

## Custom animation references do NOT support an inline `{{...}}` override — presets do

`transition:bounce={{duration: 0.3}}` is rejected
(`animation/transition-override-not-supported-for-custom-animation`) — only built-in presets
accept an override. Merging an override config onto an arbitrarily-nested composition tree (does
it apply to every leaf step? just the outermost?) has no obviously-correct answer, so this was
deliberately left unsupported rather than guessed at. Adjust the custom animation's own declaration
instead.

## `animate:<field>` is the ONLY place `keyValue` is computed at runtime, not compile time

Every other piece of this feature (Layer 1 declarations, Layer 2 presets/custom references) has a
fully compile-time-known `keyValue` array baked into static XML. `animate:<field>`'s whole point
is auto-animating an ORDINARY reactive write, whose new value is a runtime expression — so its
synthesized interpolator's `keyValue` is set fresh, in generated `.brs`, at the write site:
```
ft_animate_from_<id>_<field> = m.<id>.<field>        ' read the CURRENT live value first
m["$$ft_anim_animate_<id>_<field>"].GetChild(0).keyValue = [ft_animate_from_<id>_<field>, <newValueExpr>]
m["$$ft_anim_animate_<id>_<field>"].control = "start"
```
`GetChild(0)` (not a named id) reaches the synthesized animation's own sole interpolator — safe
because this animation is never composed, always exactly one field, one interpolator, by
construction. `animate:` is restricted to the five known field shorthands only (no `field`/`as`
escape hatch, unlike Layer 1) — animating an arbitrary field correctly needs knowing its current
BrightScript type to interpolate it, which this compiler has no way to check for an escape-hatch
field name.

## A real bug this implementation caught and fixed: missing `findNode` caching for animation nodes

Through M5 (Layer 2's own codegen), every `animation {}`/transition-synthesized node's own id
(`ft_anim_<name>`) was referenced via `m["$$ft_anim_<name>"]` in generated `.brs`
(`.control = "start"`, etc.) but NEVER ACTUALLY ASSIGNED anywhere — `collectStaticallyPresentIds`
(the function `emitInitFunction`'s own `findNode` loop iterates) only walks the TEMPLATE's own
`TemplateNode` tree, and animation nodes are injected as XML siblings via `xml-emitter.ts`'s
`extraChildrenXml`, entirely outside that tree — so it had zero knowledge of them. Every reference
would have resolved to `invalid` at runtime, syntactically valid but functionally broken; unit
tests never caught it because they only assert specific generated-line substrings, never that a
referenced `m["$$..."]` slot was ever actually populated. Fixed by adding a dedicated `findNode`
loop in `emitInitFunction` for every `script.animations` name, every resolved transition's in/out
name, and every `animate:` binding's own synthesized name — see that function's own comment.
**Lesson for the next feature that synthesizes a node id outside the ordinary template tree: an
`m["$$..."]` reference with no visible assignment anywhere is a silent, easy-to-miss bug — grep for
the id's own assignment site, don't just trust that referencing it "looks right."**
