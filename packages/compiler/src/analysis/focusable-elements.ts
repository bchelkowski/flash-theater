/**
 * `focusable="true"` / `focusable="{expr}"` — reuses Roku SceneGraph's own
 * native `focusable` field name (`ifSGNodeFocus`), not a new DSL-invented
 * attribute; needs no flash-parser grammar of its own, it's an ordinary
 * static/dynamic attribute whose name happens to be `focusable`. See
 * GRAMMAR.md's "Focus system" section.
 *
 * `default-focus="true"` — a second, static-only attribute alongside
 * `focusable="true"` on the same element, declaring it as its owning
 * component's explicit default focus target (see
 * `FlashTheaterFocusManager.brs`'s `firstRegistrantOfOwner`, which prefers
 * this entry over plain registration order). At most one per component —
 * `checkAtMostOneDefaultFocus` below.
 */
import { CompileError, TemplateElement, TemplateNode } from '../dsl-parser/dsl-ast.js';
import { walkTemplate } from './template-walk.js';
import { DEFAULT_FOCUS_ATTRIBUTE_NAME } from '../codegen/naming.js';

const FOCUSABLE_ATTRIBUTE_NAME = 'focusable';

/** One `focusable`-bearing element as found in the template. */
export interface FocusableElement {
  readonly elementId: string;
  /** True only for a literal `focusable="true"` static attribute — a dynamic `focusable="{expr}"` is never statically known to be true, so it can't participate in the compile-time nested-focusable check (`checkNestedFocusableConflicts` below). */
  readonly isStaticTrue: boolean;
  /** True for a literal `default-focus="true"` static attribute on this same element — see `checkAtMostOneDefaultFocus` below for the at-most-one validation and `default-focus-requires-static-focusable`/`default-focus-must-be-static` for why this is static-only, always paired with a static `focusable="true"`. */
  readonly isDefault: boolean;
}

function isFocusableAttribute(attr: TemplateElement['attributes'][number]): boolean {
  return (attr.kind === 'static' || attr.kind === 'dynamic') && attr.name === FOCUSABLE_ATTRIBUTE_NAME;
}

function isStaticallyFocusableTrue(el: TemplateElement): boolean {
  return el.attributes.some((a) => a.kind === 'static' && a.name === FOCUSABLE_ATTRIBUTE_NAME && a.value === 'true');
}

function findDefaultFocusAttribute(el: TemplateElement): TemplateElement['attributes'][number] | undefined {
  return el.attributes.find((a) => (a.kind === 'static' || a.kind === 'dynamic') && a.name === DEFAULT_FOCUS_ATTRIBUTE_NAME);
}

/**
 * True for a literal `default-focus="true"` static attribute on `el` — exported so every
 * static-registration codegen site (`brs-emitter.ts`'s own top-level loop via `FocusableElement`,
 * plus `conditional-block-emitter.ts`/`each-block-emitter.ts`, which construct a node from its raw
 * `TemplateElement` attributes directly rather than consuming `FocusableElement[]`) shares one
 * detection, instead of three independently re-implementing "is this the default-focus element."
 * Validation (static-only, requires a static `focusable="true")` sibling, at-most-one-per-component)
 * already happened in `collectFocusableElements`/`checkAtMostOneDefaultFocus` by the time codegen
 * ever calls this — this is a pure, unchecked read.
 */
export function isStaticallyDefaultFocusTrue(el: TemplateElement): boolean {
  const attr = findDefaultFocusAttribute(el);
  return attr !== undefined && attr.kind === 'static' && attr.value === 'true';
}

/**
 * Every `focusable`-bearing element anywhere in the template, in document
 * order — recurses into everything, including `{#if}`/`{#if:destroy}`/
 * `{#each}` bodies. Requires an `id` regardless of static/dynamic
 * (`template/focusable-missing-id` otherwise) — needed either way for
 * registration codegen (`codegen/naming.ts`'s `mFieldAccess`).
 *
 * A `default-focus` attribute is validated here too, on whichever element it
 * appears on: it must be a literal `default-focus="true"` (never `{expr}` —
 * `template/default-focus-must-be-static`, the compiler has no reactive default-focus
 * target, mirroring `focusable`'s own static/dynamic split but starting
 * narrower), and that same element must also be statically
 * `focusable="true"` (`template/default-focus-requires-static-focusable`) —
 * a dynamic `focusable="{expr}"` can't pair with it, since default-focus
 * target has to be provably real at compile time, exactly like the
 * nested-focusable-conflict check already requires for its own reasons.
 */
export function collectFocusableElements(root: TemplateElement): FocusableElement[] {
  const out: FocusableElement[] = [];
  walkTemplate(root, {
    recurseIntoEach: true,
    onElement: (element) => {
      const defaultFocusAttr = findDefaultFocusAttribute(element);
      if (defaultFocusAttr) {
        if (defaultFocusAttr.kind !== 'static' || defaultFocusAttr.value !== 'true') {
          throw new CompileError({
            code: 'template/default-focus-must-be-static',
            message: `Element <${element.tagName}>'s default-focus attribute must be a literal default-focus="true" — a dynamic default-focus="{expr}" is not supported.`,
          });
        }
        if (!isStaticallyFocusableTrue(element)) {
          throw new CompileError({
            code: 'template/default-focus-requires-static-focusable',
            message: `Element <${element.tagName}> has default-focus="true" but is not statically focusable="true" — default-focus can only mark an element that is itself statically focusable.`,
          });
        }
      }

      for (const attr of element.attributes) {
        if (!isFocusableAttribute(attr)) continue;
        if (!element.id) {
          throw new CompileError({
            code: 'template/focusable-missing-id',
            message: `Element <${element.tagName}> has a focusable attribute but no id (needed to register it with the focus system).`,
          });
        }
        out.push({ elementId: element.id, isStaticTrue: attr.kind === 'static' && attr.value === 'true', isDefault: defaultFocusAttr !== undefined });
      }
    },
  });
  return out;
}

/**
 * At most one `default-focus="true"` element per component — a provable,
 * compile-time ambiguity otherwise (which one is "the" default?), same
 * treatment `checkNestedFocusableConflicts` already gives a different kind
 * of focus ambiguity.
 */
export function checkAtMostOneDefaultFocus(elements: readonly FocusableElement[]): void {
  const defaults = elements.filter((e) => e.isDefault);
  if (defaults.length > 1) {
    throw new CompileError({
      code: 'template/multiple-default-focus',
      message: `Found ${defaults.length} elements with default-focus="true" (${defaults.map((e) => e.elementId).join(', ')}) — a component may declare at most one default focus target.`,
    });
  }
}

/**
 * Rejects two elements — anywhere in the template, at any nesting depth,
 * including across a nested custom-component tag written as a plain child
 * element (its own `focusable="true"` counts the same as any built-in
 * element's) — where BOTH are *statically* `focusable="true"` literal and
 * one is an ancestor of the other. This is a genuine, permanent ambiguity
 * for the focus registry: both would report `IsInFocusChain() = true`
 * simultaneously with no way to tell which is "the" actual target.
 *
 * A *dynamic* `focusable="{expr}"` on either side is allowed and treated as
 * a documented runtime contract instead — this is exactly what a
 * parent→child focus-handoff (drill-down) pattern relies on: flip the
 * parent's reactive `focusable` off in the same handler that hands focus to
 * the child, so the two are never simultaneously `true` at runtime, even
 * though both attributes exist in the markup. Only a literal `"true"` on
 * *both* sides is provably, permanently ambiguous — anything with a
 * reactive expression on either side can't be proven wrong at compile time,
 * so it isn't rejected (`template/nested-focusable-conflict`).
 */
export function checkNestedFocusableConflicts(root: TemplateElement): void {
  walk(root, []);
}

function walk(node: TemplateNode, staticFocusableAncestorIds: readonly string[]): void {
  if (node.kind === 'element') {
    const isStaticFocusable = isStaticallyFocusableTrue(node);
    if (isStaticFocusable && staticFocusableAncestorIds.length > 0) {
      const ancestorId = staticFocusableAncestorIds[staticFocusableAncestorIds.length - 1];
      throw new CompileError({
        code: 'template/nested-focusable-conflict',
        message: `Element "${node.id}" and its ancestor "${ancestorId}" are both statically focusable="true" — a focusable element can't contain another statically-focusable element (ambiguous which one is the real focus target). Use a reactive focusable="{expr}" on at least one side for a parent→child focus-handoff pattern instead.`,
      });
    }
    const nextAncestorIds = isStaticFocusable ? [...staticFocusableAncestorIds, node.id!] : staticFocusableAncestorIds;
    for (const child of node.children) walk(child, nextAncestorIds);
    return;
  }
  for (const child of node.children) walk(child, staticFocusableAncestorIds);
}
