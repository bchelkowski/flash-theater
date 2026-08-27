/**
 * Cross-declaration name-collision checks that `ScriptBindings`/element-id
 * caching don't otherwise catch on their own — see
 * findings/reactivity-codegen-conventions.md's "template `id` vs
 * field/derived/state name collision" write-up for the generated-code
 * root cause each of these guards against.
 */
import { CompileError, ThrScriptAst } from '../dsl-parser/dsl-ast.js';
import { ScriptBindings } from './scope-resolution.js';
import { RESERVED_IDENTIFIER_PREFIX } from '../codegen/naming.js';
import { EachBlockAnalysis } from '../codegen/each-block-emitter.js';

/**
 * `resolveDsl` (scope-resolution.ts) resolves a bare name against
 * `field`/`state`/`derived`/`read`/`watch` in that fixed priority order —
 * so a name declared as more than one of the five doesn't clobber anything
 * at the generated-code level (field lives at `m.top.<name>`, the rest at
 * `m.<name>`), but it does silently make every bare-name reference to that
 * name resolve to only the highest-priority kind. The other declaration is
 * real, computed code that no reference can ever reach — a correctness bug
 * for whichever binding the author actually meant.
 */
export function checkDuplicateBindingNames(bindings: ScriptBindings): void {
  const kinds: Array<{ kind: 'field' | 'derived' | 'state' | 'read' | 'watch' | 'stream' | 'animation'; names: ReadonlySet<string> }> = [
    { kind: 'field', names: bindings.fieldNames },
    { kind: 'derived', names: bindings.derivedNames },
    { kind: 'state', names: bindings.stateNames },
    { kind: 'read', names: bindings.readNames },
    { kind: 'watch', names: bindings.watchNames },
    { kind: 'stream', names: bindings.streamNames },
    { kind: 'animation', names: bindings.animationNames },
  ];

  for (let i = 0; i < kinds.length; i++) {
    for (const name of kinds[i].names) {
      for (let j = i + 1; j < kinds.length; j++) {
        if (kinds[j].names.has(name)) {
          throw new CompileError({
            code: 'dsl/duplicate-binding-name',
            message: `"${name}" is declared as both a ${kinds[i].kind} and a ${kinds[j].kind} — each name must be unique across field/derived/state/read/watch/stream/animation declarations.`,
          });
        }
      }
    }
  }
}

/**
 * Element-id node-ref caching (`m.<id> = m.top.findNode("<id>")`, emitted
 * first in generated `init()`) and `derived`/`state`/`read`/`watch`
 * storage (`m.<name>`) share the exact same bare `m.` slot — whichever
 * assignment runs second silently clobbers the other. `field` is
 * deliberately excluded: a field always lives at `m.top.<name>`, a
 * genuinely separate slot, so an id sharing a field's name is safe and a
 * perfectly natural naming choice (e.g. a field describing the very
 * element it labels).
 */
export function checkElementIdCollisions(elementIds: readonly string[], bindings: ScriptBindings): void {
  for (const id of elementIds) {
    if (bindings.derivedNames.has(id)) {
      throw new CompileError({
        code: 'template/id-collides-with-binding',
        message: `Element id "${id}" collides with a declared derived of the same name — both would compile to the same generated m.${id} slot.`,
      });
    }
    if (bindings.stateNames.has(id)) {
      throw new CompileError({
        code: 'template/id-collides-with-binding',
        message: `Element id "${id}" collides with a declared state of the same name — both would compile to the same generated m.${id} slot.`,
      });
    }
    if (bindings.readNames.has(id)) {
      throw new CompileError({
        code: 'template/id-collides-with-binding',
        message: `Element id "${id}" collides with a declared read of the same name — both would compile to the same generated m.${id} slot.`,
      });
    }
    if (bindings.watchNames.has(id)) {
      throw new CompileError({
        code: 'template/id-collides-with-binding',
        message: `Element id "${id}" collides with a declared watch of the same name — both would compile to the same generated m.${id} slot.`,
      });
    }
    if (bindings.streamNames.has(id)) {
      throw new CompileError({
        code: 'template/id-collides-with-binding',
        message: `Element id "${id}" collides with a declared stream of the same name — both would compile to the same generated m.${id} slot.`,
      });
    }
  }
}

/** Two elements sharing an `id` cache the same `m.<id>` node ref twice in generated `init()` — the second silently overwrites the first, currently with no diagnostic at all. */
export function checkDuplicateElementIds(elementIds: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of elementIds) {
    if (seen.has(id)) {
      throw new CompileError({
        code: 'template/duplicate-id',
        message: `Element id "${id}" is used by more than one element — ids must be unique within a component's template.`,
      });
    }
    seen.add(id);
  }
}

/**
 * `codegen/naming.ts`'s `RESERVED_IDENTIFIER_PREFIX` (`ft_`) is used
 * throughout this package for compiler-synthesized names — a `{#if}`/
 * `{#if:destroy}` block's own wrapper id, a synthesized parent id, a
 * generated construction/teardown sub name, and (pre-existing) a handful of
 * embedded-expression wrapper temp names — all relying on never colliding
 * with anything the DSL author could write. Nothing enforced that until now:
 * the DSL lexer happily accepts a leading `_` in any identifier, so a
 * hand-authored `field ft_foo: integer = 0` (or an `id="ft_if_1"`) would
 * silently alias whatever the compiler itself generates. This closes the gap
 * for every name kind that could plausibly collide — `id`/`field`/`derived`/
 * `state`/`read`/`watch`/function names — retroactively, not just for this
 * feature's own new generated names.
 */
export function checkReservedIdentifierPrefix(script: ThrScriptAst, bindings: ScriptBindings, elementIds: readonly string[], itemAliases: readonly string[] = []): void {
  const named: Array<{ kind: string; names: Iterable<string> }> = [
    { kind: 'field', names: bindings.fieldNames },
    { kind: 'derived', names: bindings.derivedNames },
    { kind: 'state', names: bindings.stateNames },
    { kind: 'read', names: bindings.readNames },
    { kind: 'watch', names: bindings.watchNames },
    { kind: 'stream', names: bindings.streamNames },
    { kind: 'animation', names: bindings.animationNames },
    { kind: 'function', names: script.functions.map((f) => f.name) },
    { kind: 'element id', names: elementIds },
    { kind: '{#each} item alias', names: itemAliases },
  ];

  for (const { kind, names } of named) {
    for (const name of names) {
      if (name.startsWith(RESERVED_IDENTIFIER_PREFIX)) {
        throw new CompileError({
          code: 'dsl/reserved-identifier-prefix',
          message: `"${name}" (a ${kind}) starts with the reserved "${RESERVED_IDENTIFIER_PREFIX}" prefix — that prefix is used exclusively for compiler-generated names and cannot appear in DSL source.`,
        });
      }
    }
  }
}

/**
 * `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` are bare global functions (see
 * `packages/compiler/GRAMMAR.md`'s "Timer statements" section) — deliberately NOT new lexer
 * keywords, unlike `animation`/`stream`/`request` (see `packages/flash-parser/src/tokenKind.ts`),
 * so nothing in `flash-parser`'s own grammar rejects a DSL author declaring a `field`/`function`/etc.
 * with one of these names. `analysis/identifier-rewrite.ts` and `codegen/statement-printer.ts`
 * recognize a BARE call to one of these names (`analysis/../embedded.ts`'s `findGlobalFunctionCalls`,
 * matched by NAME alone, with no notion of "is this really the reserved global or a same-named local
 * shadowing it") — so this check is what actually keeps that recognition sound: without it, `field
 * setTimeout: integer` (or worse, a function PARAMETER named `setTimeout`, invisible to every other
 * name-collision check in this file since a parameter is function-local) would be silently hijacked
 * by the sugar the moment it's called bare, instead of resolving to the DSL author's own declaration.
 *
 * Stricter than the existing `theme`/`router`/`taskManager` precedent (`analysis/identifier-
 * rewrite.ts`'s `GLOBAL_ROOT_NAMES`), which has no equivalent check at all today — that mechanism
 * only ever matches a DOT-CHAIN ROOT (`theme.foo`/`router.navigate(...)`), so a bare `field theme:
 * string` never collides with anything syntactically. `setTimeout`/etc. are matched as BARE CALLS
 * instead, so a same-named local really would collide — this is a real, new risk this feature
 * introduces that `theme`/`router`/`taskManager` never had.
 */
const RESERVED_GLOBAL_FUNCTION_NAMES = new Set(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']);

export function checkReservedGlobalFunctionNames(script: ThrScriptAst, bindings: ScriptBindings): void {
  const named: Array<{ kind: string; names: Iterable<string> }> = [
    { kind: 'field', names: bindings.fieldNames },
    { kind: 'derived', names: bindings.derivedNames },
    { kind: 'state', names: bindings.stateNames },
    { kind: 'read', names: bindings.readNames },
    { kind: 'watch', names: bindings.watchNames },
    { kind: 'stream', names: bindings.streamNames },
    { kind: 'animation', names: bindings.animationNames },
    { kind: 'function', names: script.functions.map((f) => f.name) },
    { kind: 'function parameter', names: script.functions.flatMap((f) => f.params.map((p) => p.name)) },
  ];

  for (const { kind, names } of named) {
    for (const name of names) {
      if (RESERVED_GLOBAL_FUNCTION_NAMES.has(name)) {
        throw new CompileError({
          code: 'dsl/reserved-global-function-name',
          message: `"${name}" (a ${kind}) collides with the reserved global "${name}(...)" — setTimeout/setInterval/clearTimeout/clearInterval are compiler sugar and cannot be redeclared or shadowed.`,
        });
      }
    }
  }
}

/**
 * An `{#each items as item (key)}` block's item alias colliding with an
 * existing field/derived/state/read/watch/function/element-id name is a
 * hard error, not silent shadowing — unlike a real BrightScript
 * local/parameter (whose scope is one small, visible function body), an
 * each-block's body can be arbitrarily large template markup where a
 * shadowed whole-component binding silently read as the loop item would be
 * an easy, confusing authoring mistake. `resolveIdentifier`'s existing
 * priority order would otherwise happily permit the shadowing (a
 * `FunctionScope`/`TemplateScope` local always wins over a DSL binding) —
 * this check exists specifically to forbid it for this one binding kind.
 */
export function checkEachItemAliasCollisions(eachBlocks: EachBlockAnalysis, bindings: ScriptBindings, elementIds: readonly string[]): void {
  const elementIdSet = new Set(elementIds);

  for (const block of eachBlocks.blocks) {
    const alias = block.itemAlias;
    const collisionKind = bindings.fieldNames.has(alias)
      ? 'field'
      : bindings.derivedNames.has(alias)
        ? 'derived'
        : bindings.stateNames.has(alias)
          ? 'state'
          : bindings.readNames.has(alias)
            ? 'read'
            : bindings.watchNames.has(alias)
              ? 'watch'
              : bindings.streamNames.has(alias)
                ? 'stream'
                : bindings.animationNames.has(alias)
                  ? 'animation'
                  : bindings.privateFunctionNames.has(alias) || bindings.publicFunctionNames.has(alias)
                    ? 'function'
                    : elementIdSet.has(alias)
                      ? 'element id'
                      : null;

    if (collisionKind) {
      throw new CompileError({
        code: 'template/each-alias-collision',
        message: `"{#each ... as ${alias} ...}"'s item alias "${alias}" collides with an existing ${collisionKind} of the same name — an each-block's item alias must not shadow a component-wide binding.`,
      });
    }
  }
}
