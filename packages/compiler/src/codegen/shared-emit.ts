/**
 * Small BrightScript code snippets shared across sibling emitter modules
 * that can't import from each other directly (`brs-emitter.ts` already
 * imports `conditional-block-emitter.ts`, so the reverse import would be a
 * cycle) — a leaf module every emitter can depend on, distinct from
 * `naming.ts` (which is specifically "what does a generated identifier
 * become," a plain string-formatting concern, not a multi-line snippet or a
 * conditional shape).
 */
import { FOCUSABLE_ATTRIBUTE_NAME } from './naming.js';
import { globalFieldRef } from './global-fields.js';

/**
 * Generated call registering `nodeRef` with the fixed runtime `FlashTheaterFocusManager` (see
 * `runtime-assets/FocusManager`) — shared between `codegen/brs-emitter.ts`
 * (statically-present/reactive-dynamic `focusable` elements), `codegen/conditional-block-emitter.ts`
 * (an element inside a `{#if:destroy}` subtree's generated create sub), and
 * `codegen/each-block-emitter.ts` (a per-item focusable element).
 *
 * Passes `m.top` as the registrant's *owner* — always valid here, since every call site this
 * emits into lives inside that element's own owning component's generated code, where `m.top` is
 * that component instance's own root node. `navigate()` uses this to search within the
 * currently-focused node's own component first, only falling back to the whole app-wide registry
 * once that search finds nothing — see `findings/focus-system.md`.
 *
 * `isDefault` (true only for an element with a static `default-focus="true"` attribute — see
 * `analysis/focusable-elements.ts`) is passed straight through to `register`'s own third
 * parameter, which `firstRegistrantOfOwner` prefers over plain registration order — see
 * GRAMMAR.md's "Focus system" section.
 */
export function focusRegisterCall(nodeRef: string, isDefault: boolean): string {
  return `${globalFieldRef('focus')}.callFunc("register", ${nodeRef}, m.top, ${isDefault ? 'true' : 'false'})`;
}

/** Counterpart to `focusRegisterCall` — also used by a `{#if:destroy}` block's generated destroy sub, before `removeChild` (see GRAMMAR.md's "Focus system" — `unregister` must run while the node is still attached, so `IsInFocusChain()`/`BoundingRect()` are still valid). */
export function focusUnregisterCall(nodeRef: string): string {
  return `${globalFieldRef('focus')}.callFunc("unregister", ${nodeRef})`;
}

/**
 * The reactive temp-var + field-assign + conditional register/unregister
 * shape for a dynamic `focusable="{expr}"` assignment — the shape that makes
 * a reactive parent→child focus-handoff (drill-down) pattern work at
 * runtime (see `codegen/brs-emitter.ts`'s `emitBindingAssignment` for the
 * full rationale). Shared by every codegen site that assigns a dynamic
 * attribute: `brs-emitter.ts`'s `emitBindingAssignment`,
 * `conditional-block-emitter.ts`'s construction path, and
 * `each-block-emitter.ts`'s item construct/update paths. Returns unindented
 * lines — each caller applies its own indent.
 */
export function emitDynamicFocusableAssignment(nodeRef: string, tempVarName: string, rewrittenExpr: string, attributeName: string): string[] {
  return [
    `${tempVarName} = ${rewrittenExpr}`,
    `${nodeRef}.${attributeName} = ${tempVarName}`,
    `if ${tempVarName} then`,
    // A dynamic focusable="{expr}" can never pair with default-focus (currently requires a static
    // focusable="true" sibling — see analysis/focusable-elements.ts's collectFocusableElements),
    // so this call site's own `isDefault` is always false.
    `  ${focusRegisterCall(nodeRef, false)}`,
    'else',
    `  ${focusUnregisterCall(nodeRef)}`,
    'end if',
  ];
}

/**
 * `focusRegisterCall(nodeRef, isDefault)` if `attributeName`/`attributeValue` is a
 * static `focusable="true"` attribute, else `null` — the
 * register-once-unconditionally-at-construction-time shape shared by
 * `conditional-block-emitter.ts` and `each-block-emitter.ts` (`brs-emitter.ts`'s
 * own top-level static registration is a separate pass over the whole
 * component's `focusableElements` list, not a per-attribute construction
 * site, so it isn't a third caller here). `isDefault` is the caller's own
 * `isStaticallyDefaultFocusTrue(element)` result (analysis/focusable-elements.ts)
 * — this function only knows about the one `focusable` attribute it's given,
 * not the rest of that element's attributes.
 */
export function staticFocusableRegisterLine(nodeRef: string, attributeName: string, attributeValue: string, isDefault: boolean): string | null {
  return attributeName === FOCUSABLE_ATTRIBUTE_NAME && attributeValue === 'true' ? focusRegisterCall(nodeRef, isDefault) : null;
}

/**
 * Emits a single `nodeRef.name = value` line for exactly one field, or one
 * `nodeRef.setFields({...})` call for two or more — batches plain field
 * assignments to the same target into one call instead of one dot-notation
 * statement per field (better readability, and a single field-change trigger
 * instead of N). `fields` must already be in the desired output order; each
 * `value` must already be a fully rewritten BrightScript expression ready to
 * splice into an AA literal value position. Not used for `focusable` (its own
 * register/unregister shape, see `emitDynamicFocusableAssignment`), `bind:`
 * (`ObserveFieldScoped`, no value push), or `on:key` (no per-attribute
 * assignment at all) — callers filter those out before collecting `fields`.
 */
export function emitFieldAssignments(nodeRef: string, fields: readonly { name: string; value: string }[]): string[] {
  if (fields.length === 0) return [];
  if (fields.length === 1) return [`${nodeRef}.${fields[0].name} = ${fields[0].value}`];
  const body = fields.map((f) => `${f.name}: ${f.value}`).join(', ');
  return [`${nodeRef}.setFields({${body}})`];
}
