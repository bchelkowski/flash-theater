/**
 * The classified shape of `.thr` template markup — a tree of elements,
 * `{#if}`/`{#if:destroy}` conditional blocks, and `{#each}` keyed-list
 * blocks, with every attribute already sorted into static (literal, copied
 * 1:1 to XML), dynamic (`attr="{expr}"`, pushed into the node), bind
 * (`bind:attr="{stateName}"`, pulled from the node — see GRAMMAR.md's
 * "Two-way binding" section; despite the name it's one-directional,
 * child-to-state only), or onKey (`on:key[Key1,Key2]="{expr}"`, a key-event
 * handler — see GRAMMAR.md's "on:key event binding" section; `keys` is one
 * or more raw, case-sensitive Roku key strings, or the literal wildcard `*`
 * matching any key not otherwise matched on the same element). Structurally
 * identical to what `packages/compiler/src/dsl-parser/dsl-ast.ts` defines
 * locally — that file mirrors this one by hand rather than importing it (see
 * that file's own comment), so a change here must be made there too.
 */
export type TemplateAttribute =
  | { kind: 'static'; name: string; value: string }
  | { kind: 'dynamic'; name: string; expression: string }
  | { kind: 'bind'; name: string; expression: string }
  | { kind: 'onKey'; keys: string[]; expression: string }
  /**
   * `transition:<name>="{{...}}"` (both directions, bidirectional), `in:<name>="{{...}}"` (enter
   * only), or `out:<name>="{{...}}"` (exit only) — `<name>` is either a built-in preset (`fade`/
   * `fly`/`slide`/`scale`) or a script-declared `animation` name, resolved later by
   * `packages/compiler`'s `analysis/animation-presets.ts`/`animation-config.ts` — flash-parser
   * itself doesn't know which. `overrideConfigText` is the inner `{...}` AA literal's own text
   * (braces included, same "opaque, compiler-interpreted span" convention `RequestDeclaration.config`
   * uses), or `null` for a bare `transition:fade=""`/`transition:fade="{{}}"` with no override —
   * only valid as a direct child of `{#if}`/`{#if:destroy}` (validated in `packages/compiler`, not
   * here — flash-parser's template classifier has no block-context awareness at the attribute level).
   * See GRAMMAR.md's "animation" section.
   */
  | { kind: 'transition'; direction: 'both' | 'in' | 'out'; animationRef: string; overrideConfigText: string | null }
  /**
   * `navigate-out:<name>`/`navigate-in:<name>` (played on a `router.navigate(...)` transition) or
   * `back-out:<name>`/`back-in:<name>` (played on a `router.back()` transition) — same
   * empty-or-`{{...}}` value convention as `transition:`/`in:`/`out:` above, `<name>` resolved the
   * same way (built-in preset or script-declared `animation` name). Only valid on a
   * `<FlashTheaterRouterOutlet>` element (validated in `packages/compiler`, not here — flash-parser's
   * template classifier has no element-identity awareness). See GRAMMAR.md's "Router" section.
   */
  | { kind: 'routerTransition'; navDirection: 'navigate' | 'back'; phase: 'in' | 'out'; animationRef: string; overrideConfigText: string | null }
  /**
   * `animate:<field>="{{...}}"` — auto-animates the reactive cascade's write to the matching
   * DYNAMIC `<field>="{expr}"` attribute on the SAME element, instead of an instant snap. `<field>`
   * must be one of the known animatable field shorthands (`opacity`/`rotation`/`translation`/
   * `scale`/`color` — see `analysis/animation-config.ts`'s `ANIMATION_FIELD_NAMES`) and must have a
   * matching dynamic attribute on the same element — both validated in `packages/compiler`, not
   * here. `overrideConfigText` is the inner `{...}` AA literal's own text (braces included), or
   * `null` for a bare `animate:opacity=""`/`animate:opacity="{{}}"` with no override — same
   * empty-or-`{{...}}` convention `transition:`/`in:`/`out:` already use. See GRAMMAR.md's
   * "animation" section.
   */
  | { kind: 'animate'; fieldName: string; overrideConfigText: string | null };

export type TemplateNode =
  | { kind: 'element'; tagName: string; id: string | null; attributes: TemplateAttribute[]; children: TemplateNode[] }
  | { kind: 'if'; mode: 'toggle' | 'destroy'; expression: string; children: TemplateNode[] }
  | { kind: 'each'; collectionExpression: string; itemAlias: string; keyExpression: string; children: TemplateNode[] };

export type TemplateElementNode = Extract<TemplateNode, { kind: 'element' }>;
export type TemplateIfNode = Extract<TemplateNode, { kind: 'if' }>;
export type TemplateEachNode = Extract<TemplateNode, { kind: 'each' }>;
