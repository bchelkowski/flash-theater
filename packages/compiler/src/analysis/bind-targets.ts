/**
 * `bind:<field>={<state>}` — one-directional (child field change → write into
 * a declared `state`) target collection + validation. See
 * packages/compiler/GRAMMAR.md's "Two-way binding" section for the full
 * grammar and findings/reactivity-bind.md for why this is
 * one-directional only (despite the "two-way binding" name in docs/features.md).
 */
import { CompileError, TemplateElement } from '../dsl-parser/dsl-ast.js';
import { ScriptBindings } from './scope-resolution.js';
import { EachBlockAnalysis } from '../codegen/each-block-emitter.js';
import { walkTemplate } from './template-walk.js';

/** A `bind:` attribute as found in the template, before its expression is confirmed to be a bare declared-state name. */
export interface RawBindTarget {
  readonly elementId: string;
  readonly fieldName: string;
  readonly expression: string;
}

/** A validated bind target — `expression` confirmed to be exactly one bare identifier naming a declared `state`. */
export interface BindTarget {
  readonly elementId: string;
  readonly fieldName: string;
  readonly stateName: string;
}

const BARE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Every `bind:` attribute anywhere in the template, in document order —
 * recurses into `{#if}`/`{#if:destroy}` subtrees (a bind target can live
 * inside either, see GRAMMAR.md) *and* into `{#each}` bodies, unlike most
 * other template walks in this codebase (e.g. `template-bindings.ts`'s
 * `collectBindings`) — here that's deliberate, not an oversight: a bind
 * target has to actually reach `checkBindTargets` for its
 * `nearestEachAncestorById` check to ever fire `template/bind-inside-each`.
 * Skipping each bodies here (as most other walks do) would silently drop a
 * misplaced bind: attribute instead of rejecting it.
 */
export function collectBindTargets(root: TemplateElement): RawBindTarget[] {
  const out: RawBindTarget[] = [];
  walkTemplate(root, {
    recurseIntoEach: true,
    onElement: (element) => {
      for (const attr of element.attributes) {
        if (attr.kind === 'bind') out.push({ elementId: element.id!, fieldName: attr.name, expression: attr.expression });
      }
    },
  });
  return out;
}

/**
 * Validates every raw bind target and returns the confirmed `BindTarget[]`
 * (expression → stateName). Throws `CompileError` on the first violation,
 * matching this codebase's "first diagnostic wins" policy:
 * `template/invalid-bind-target` (the expression isn't a single bare
 * identifier), `template/bind-target-not-state` (the identifier isn't a
 * declared `state`), `template/bind-inside-each` (the element lives inside
 * an `{#each}` body — rejected, not just unimplemented, since N item nodes
 * writing into the same single `state` has no defined "which item wins"
 * semantics).
 */
export function checkBindTargets(raw: readonly RawBindTarget[], scriptBindings: ScriptBindings, eachBlocks: EachBlockAnalysis): BindTarget[] {
  return raw.map((target) => {
    const trimmed = target.expression.trim();
    if (!BARE_IDENTIFIER_PATTERN.test(trimmed)) {
      throw new CompileError({
        code: 'template/invalid-bind-target',
        message: `bind:${target.fieldName} on element "${target.elementId}" must be a single bare state name — "${target.expression}" is not a plain identifier.`,
      });
    }

    if (eachBlocks.nearestEachAncestorById.has(target.elementId)) {
      throw new CompileError({
        code: 'template/bind-inside-each',
        message: `bind:${target.fieldName} on element "${target.elementId}" lives inside an {#each} block — a bind target can't live inside a loop, since every item would write into the same single state with no defined "which item wins" order.`,
      });
    }

    if (!scriptBindings.stateNames.has(trimmed)) {
      const reason = scriptBindings.fieldNames.has(trimmed)
        ? `"${trimmed}" is a field, not a state — a bind target can only be a declared state.`
        : scriptBindings.derivedNames.has(trimmed)
          ? `"${trimmed}" is a derived, not a state — a bind target can only be a declared state.`
          : scriptBindings.readNames.has(trimmed) || scriptBindings.watchNames.has(trimmed)
            ? `"${trimmed}" is a read/watch, not a state — a bind target can only be a declared state.`
            : `"${trimmed}" is not a declared state.`;
      throw new CompileError({
        code: 'template/bind-target-not-state',
        message: `bind:${target.fieldName} on element "${target.elementId}": ${reason}`,
      });
    }

    return { elementId: target.elementId, fieldName: target.fieldName, stateName: trimmed };
  });
}
