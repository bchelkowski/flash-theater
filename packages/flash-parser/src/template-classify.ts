/**
 * Template-markup classification — walks the already-real-parsed XML tree
 * (`parseEmbeddedTemplate`/`parseXml`, unmodified, see `embedded.ts`) once,
 * classifying every attribute as static/dynamic/bind/onKey and recognizing
 * `{#if}`/`{#if:destroy}`/`{#each}` control-flow markup among an element's
 * children. Split out of `parser.ts` (which still owns the whole-file
 * `<script>`/`<theme-template>`/`<theme>` root-tag dispatch and calls into
 * `classifyTemplateElement` here for the one it finds, `<script>`'s own
 * template) so the two concerns — "which kind of `.thr` file is this" and
 * "how does this template's markup classify" — live in separate files.
 */
import { XmlAttribute, XmlElement } from './xml/xml-ast.js';
import { XmlSyntaxKind, XmlSyntaxNode as XmlCstNode, isXmlNode } from './xml/xml-syntax.js';
import type { XmlToken } from './xml/xml-syntax.js';
import { ParseDiagnostic } from './diagnostics.js';
import { parseEmbeddedExpression, translateBrightScriptDiagnostics } from './embedded.js';
import { TemplateAttribute, TemplateNode } from './templateModel.js';

const DYNAMIC_BINDING_PATTERN = /^\{(.*)\}$/s;

/**
 * `{#if <expr>}...{/if}` / `{#if:destroy <expr>}...{/if}` conditional
 * blocks and `{#each <collection> as <item> (<key>)}...{/each}` keyed-list
 * blocks — DSL-owned control-flow markup, structurally parsed by this file
 * (see `classifyTemplateChildren` below), never handed to `parseXml` as
 * literal text. Recognized as plain content-position text runs the real XML
 * lexer already tokenizes and positions correctly (see
 * findings/template-blocks.md) — there is no bespoke XML-adjacent
 * scanning here, only a marker search over already-real-positioned `Text`
 * tokens. The two marker families can nest arbitrarily against each other
 * (an `{#each}` inside an `{#if}`, an `{#if}` inside an `{#each}`, either
 * nested inside itself), so they're scanned and stacked together — see
 * `BlockFrame`/`scanBlockMarkers` below.
 *
 * `IF_OPEN_PREFIX`/`IF_DESTROY_OPEN_PREFIX`/`EACH_OPEN_PREFIX` are exported —
 * `parser.ts`'s own `parseComponentFile` needs them too, for its own
 * "the template's single root can't itself be a block" check, which runs
 * before the markup is even handed to the real XML parser.
 */
export const IF_OPEN_PREFIX = '{#if ';
export const IF_DESTROY_OPEN_PREFIX = '{#if:destroy ';
const IF_CLOSE_MARKER = '{/if}';
export const EACH_OPEN_PREFIX = '{#each ';
const EACH_CLOSE_MARKER = '{/each}';

/**
 * Walks the parsed XML tree once, eagerly classifying every attribute as
 * static/dynamic (today's `template-parser.ts` logic, moved here), eagerly
 * wrap-and-parsing every dynamic attribute's expression via embedded.ts
 * (populating its memoization cache for later reuse by the compiler's
 * identifier-rewrite pass), and recognizing `{#if}`/`{#if:destroy}`
 * conditional blocks among an element's children (see
 * `classifyTemplateChildren`). Pushes `template/missing-id` /
 * `expression/parse-error` / `template/unterminated-if-block` diagnostics as
 * it goes; the resulting tree itself is rebuilt on demand by the AST layer's
 * `TemplateSection` class, not stored on the CST node — only its
 * diagnostics matter here.
 *
 * `baseOffset` is the real file offset the (trimmed) template markup starts
 * at — needed to translate an embedded-expression diagnostic's position
 * (relative to the markup text alone) into the outer `.thr` source's real
 * coordinates. Defaults to 0 for the AST layer's own lazy re-classification
 * (`ast.ts`'s `TemplateSection.root`), which discards diagnostics entirely
 * and only cares about the rebuilt tree shape.
 */
export function classifyTemplateElement(element: XmlElement, baseLine: number, diagnostics: ParseDiagnostic[], baseOffset = 0): TemplateNode {
  const attributes = element.attributes.filter((a) => a.name.toLowerCase() !== 'id').map((a) => classifyAttribute(a, baseLine, diagnostics, baseOffset));
  const idAttribute = element.getAttribute('id');
  const hasDynamic = attributes.some(
    (a) => a.kind === 'dynamic' || a.kind === 'bind' || a.kind === 'onKey' || a.kind === 'transition' || a.kind === 'animate' || a.kind === 'routerTransition',
  );

  if (hasDynamic && !idAttribute) {
    diagnostics.push({
      code: 'template/missing-id',
      message: `Element <${element.tagName}> has a dynamic binding but no id attribute (needed to generate findNode).`,
      pos: 0,
      end: 0,
      line: baseLine + element.line,
    });
  }

  return {
    kind: 'element',
    tagName: element.tagName,
    id: idAttribute ? idAttribute.value : null,
    attributes,
    children: classifyTemplateChildren(element, baseLine, diagnostics, baseOffset),
  };
}

/** One `on:key[...]` binding declared directly on `<component>` itself — see `classifyComponentElement`. */
export interface ComponentOnKeyBinding {
  readonly keys: string[];
  readonly expression: string;
}

/** The classified shape of the mandatory `<component extends="..." on:key[...]="...">` root tag — see `templateModel.ts`'s doc comment and GRAMMAR.md's "`.thr` file structure". */
export interface ClassifiedComponentRoot {
  /** From the optional `extends="..."` attribute — `null` when absent (codegen defaults to `'Group'`). */
  readonly extends: string | null;
  /** Every `on:key[...]` attribute declared directly on `<component>` — unconditional, not gated by any descendant's `IsInFocusChain()`, since `<component>` IS the compiled component itself (`m.top`), not a describable child. */
  readonly onKeyAttributes: readonly ComponentOnKeyBinding[];
  readonly children: TemplateNode[];
}

/**
 * `<component>` is deliberately **not** run through `classifyTemplateElement` above — it isn't a
 * real SceneGraph node the way an ordinary template element is (no `id`, no `findNode` caching, no
 * `IsInFocusChain()`), it's a meta-wrapper carrying the compiled component's own root-level
 * attributes (`extends`, `on:key[...]`) plus the real visual content as its children. Reusing the
 * generic element classifier would wrongly demand an `id` the moment an `on:key[...]` attribute
 * makes `hasDynamic` true (`classifyTemplateElement`'s `template/missing-id` check, which doesn't
 * apply here at all). `extends`/`on:key[...]` are the only attributes `<component>` accepts.
 */
export function classifyComponentElement(element: XmlElement, baseLine: number, diagnostics: ParseDiagnostic[], baseOffset = 0): ClassifiedComponentRoot {
  let extendsValue: string | null = null;
  const onKeyAttributes: ComponentOnKeyBinding[] = [];

  for (const attr of element.attributes) {
    const name = attr.name.toLowerCase();
    if (name === 'id') {
      diagnostics.push({
        code: 'template/component-cannot-have-id',
        message: '<component> is the compiled component itself (m.top) — it never needs, or accepts, an id attribute.',
        pos: 0,
        end: 0,
        line: baseLine + attr.valueLine,
      });
      continue;
    }
    if (name === 'extends') {
      const classified = classifyAttribute(attr, baseLine, diagnostics, baseOffset);
      if (classified.kind !== 'static') {
        diagnostics.push({
          code: 'template/component-extends-must-be-static',
          message: '<component extends="..."> must be a plain literal value, not a dynamic {expression} — the SceneGraph base class is fixed at compile time.',
          pos: 0,
          end: 0,
          line: baseLine + attr.valueLine,
        });
      } else {
        extendsValue = classified.value;
      }
      continue;
    }
    const classified = classifyAttribute(attr, baseLine, diagnostics, baseOffset);
    if (classified.kind === 'onKey') {
      onKeyAttributes.push({ keys: classified.keys, expression: classified.expression });
    } else {
      diagnostics.push({
        code: 'template/component-invalid-attribute',
        message: `<component> only accepts "extends" and "on:key[...]" attributes — "${attr.name}" is not valid here.`,
        pos: 0,
        end: 0,
        line: baseLine + attr.valueLine,
      });
    }
  }

  return { extends: extendsValue, onKeyAttributes, children: classifyTemplateChildren(element, baseLine, diagnostics, baseOffset) };
}

const BIND_ATTRIBUTE_PREFIX = 'bind:';

/**
 * `transition:<name>`/`in:<name>`/`out:<name>` — enter/exit animation attribute-name conventions,
 * same "attribute-NAME carries the payload" shape `bind:<field>` already established. Checked in
 * this fixed order so `transition:` (which itself starts with neither `in:` nor `out:`, so order
 * wouldn't actually matter here — kept explicit anyway since a future prefix addition might not be
 * so lucky). `in:`/`out:` are short and generic-looking but deliberately reserved globally the same
 * way `bind:`/`on:key` already are — see GRAMMAR.md's "animation" section.
 */
const TRANSITION_ATTRIBUTE_PREFIXES: ReadonlyArray<{ prefix: string; direction: 'both' | 'in' | 'out' }> = [
  { prefix: 'transition:', direction: 'both' },
  { prefix: 'in:', direction: 'in' },
  { prefix: 'out:', direction: 'out' },
];

/**
 * `navigate-out:<name>`/`navigate-in:<name>`/`back-out:<name>`/`back-in:<name>` — the router-outlet
 * counterpart of `TRANSITION_ATTRIBUTE_PREFIXES` above, named after the two router actions
 * (`router.navigate(...)`/`router.back()`) rather than internal push/pop stack terminology, so the
 * attribute name reads directly off the DSL action that plays it. Same value grammar as
 * `transition:`/`in:`/`out:` (`classifyDoubleBraceOrEmptyValue`), only valid on a
 * `<FlashTheaterRouterOutlet>` element — enforced in `packages/compiler`, not here.
 */
const ROUTER_TRANSITION_ATTRIBUTE_PREFIXES: ReadonlyArray<{ prefix: string; navDirection: 'navigate' | 'back'; phase: 'in' | 'out' }> = [
  { prefix: 'navigate-out:', navDirection: 'navigate', phase: 'out' },
  { prefix: 'navigate-in:', navDirection: 'navigate', phase: 'in' },
  { prefix: 'back-out:', navDirection: 'back', phase: 'out' },
  { prefix: 'back-in:', navDirection: 'back', phase: 'in' },
];

/**
 * Prefix of an `on:key[...]` attribute's name *after* `onKeyPreprocess.ts`'s
 * transliteration has already run — the raw `[` right after `on:key` always
 * becomes `_` (see that file's doc comment), so the transliterated name
 * always starts with exactly this. Everything from here to the end of the
 * name is the (transliterated) key list, still `_`-delimited, with a
 * guaranteed trailing `_` contributed by the closing `]`.
 */
const ON_KEY_ATTRIBUTE_PREFIX = 'on:key_';
/** The reserved wildcard marker in a *parsed* `on:key` key list — the DSL-facing `*`. `onKeyPreprocess.ts` transliterates a literal `*` to `-` (the one XML-legal character not otherwise used by this scheme), reversed back to `*` here. */
const ON_KEY_WILDCARD = '*';

/** Splits an `on:key[...]`'s already-transliterated attribute name back into its raw (still possibly-empty) segments, dropping the single always-present trailing empty segment contributed by the closing `]` -> `_`. Whitespace-padding markers (`.`, see `onKeyPreprocess.ts`'s doc comment for why they're distinct from the `_` separator) are stripped first, so `on:key[OK, play]`'s comma-space produces the same single separator as a bare comma — only a truly empty gap between two `_`s (nothing, or only whitespace, between two commas) survives as an empty segment. An empty segment anywhere in the *returned* array means a malformed list (`on:key[]`, or a doubled separator like `on:key[OK,,play]`). */
function splitOnKeyAttributeName(name: string): string[] {
  const suffix = name.slice(ON_KEY_ATTRIBUTE_PREFIX.length).replace(/\./g, '');
  const segments = suffix.split('_');
  segments.pop();
  return segments;
}

const ANIMATE_ATTRIBUTE_PREFIX = 'animate:';

/**
 * `<prefix><rest>=""` / `<prefix><rest>="{{}}"` (no override) or `<prefix><rest>="{{duration:
 * 250}}"` (override) — the shared empty-or-`{{...}}` value convention `transition:`/`in:`/`out:`
 * and `animate:` all use. Unlike `bind:`/`on:key`, an empty value is legitimate here. Returns
 * `null` (having already pushed `errorCode`'s diagnostic) for anything else — a single-brace value
 * (`animate:opacity="{300}"`) is rejected the same "malformed" way, not silently misinterpreted as
 * a bare (non-AA-literal) override.
 */
function classifyDoubleBraceOrEmptyValue(attr: XmlAttribute, baseLine: number, diagnostics: ParseDiagnostic[], baseOffset: number, errorCode: string): string | null | undefined {
  if (attr.value.length === 0) return null;

  const outerMatch = DYNAMIC_BINDING_PATTERN.exec(attr.value);
  const inner = outerMatch?.[1] ?? null;
  if (inner === null || !/^\{[\s\S]*\}$/.test(inner)) {
    diagnostics.push({
      code: errorCode,
      message: `"${attr.name}" must be empty (no override) or a quoted {{...}} object literal — e.g. ${attr.name}={{duration: 250}}.`,
      pos: 0,
      end: 0,
      line: baseLine + attr.valueLine,
    });
    return undefined;
  }

  const parsed = parseEmbeddedExpression(inner);
  for (const d of translateBrightScriptDiagnostics(parsed, baseOffset + attr.valuePos)) {
    diagnostics.push({ code: 'expression/parse-error', message: d.message, pos: d.pos, end: d.end, line: d.line });
  }
  return inner;
}

function classifyTransitionAttribute(
  attr: XmlAttribute,
  direction: 'both' | 'in' | 'out',
  animationRef: string,
  baseLine: number,
  diagnostics: ParseDiagnostic[],
  baseOffset: number,
): TemplateAttribute {
  const overrideConfigText = classifyDoubleBraceOrEmptyValue(attr, baseLine, diagnostics, baseOffset, 'template/invalid-transition-syntax');
  if (overrideConfigText === undefined) return { kind: 'static', name: attr.name, value: attr.value };
  return { kind: 'transition', direction, animationRef, overrideConfigText };
}

function classifyAnimateAttribute(attr: XmlAttribute, fieldName: string, baseLine: number, diagnostics: ParseDiagnostic[], baseOffset: number): TemplateAttribute {
  const overrideConfigText = classifyDoubleBraceOrEmptyValue(attr, baseLine, diagnostics, baseOffset, 'template/invalid-animate-syntax');
  if (overrideConfigText === undefined) return { kind: 'static', name: attr.name, value: attr.value };
  return { kind: 'animate', fieldName, overrideConfigText };
}

function classifyRouterTransitionAttribute(
  attr: XmlAttribute,
  navDirection: 'navigate' | 'back',
  phase: 'in' | 'out',
  animationRef: string,
  baseLine: number,
  diagnostics: ParseDiagnostic[],
  baseOffset: number,
): TemplateAttribute {
  const overrideConfigText = classifyDoubleBraceOrEmptyValue(attr, baseLine, diagnostics, baseOffset, 'template/invalid-transition-syntax');
  if (overrideConfigText === undefined) return { kind: 'static', name: attr.name, value: attr.value };
  return { kind: 'routerTransition', navDirection, phase, animationRef, overrideConfigText };
}

function classifyAttribute(attr: XmlAttribute, baseLine: number, diagnostics: ParseDiagnostic[], baseOffset: number): TemplateAttribute {
  const transitionPrefix = TRANSITION_ATTRIBUTE_PREFIXES.find((p) => attr.name.startsWith(p.prefix));
  if (transitionPrefix) {
    const animationRef = attr.name.slice(transitionPrefix.prefix.length);
    return classifyTransitionAttribute(attr, transitionPrefix.direction, animationRef, baseLine, diagnostics, baseOffset);
  }
  const routerTransitionPrefix = ROUTER_TRANSITION_ATTRIBUTE_PREFIXES.find((p) => attr.name.startsWith(p.prefix));
  if (routerTransitionPrefix) {
    const animationRef = attr.name.slice(routerTransitionPrefix.prefix.length);
    return classifyRouterTransitionAttribute(attr, routerTransitionPrefix.navDirection, routerTransitionPrefix.phase, animationRef, baseLine, diagnostics, baseOffset);
  }
  if (attr.name.startsWith(ANIMATE_ATTRIBUTE_PREFIX)) {
    return classifyAnimateAttribute(attr, attr.name.slice(ANIMATE_ATTRIBUTE_PREFIX.length), baseLine, diagnostics, baseOffset);
  }

  const isBind = attr.name.startsWith(BIND_ATTRIBUTE_PREFIX);
  const isOnKey = attr.name.startsWith(ON_KEY_ATTRIBUTE_PREFIX);
  const match = DYNAMIC_BINDING_PATTERN.exec(attr.value);

  if (!match) {
    if (isBind) {
      diagnostics.push({
        code: 'template/invalid-bind-target',
        message: `"${attr.name}" must be a quoted {expression} — a bind: attribute always reads a bare state name, e.g. bind:${attr.name.slice(BIND_ATTRIBUTE_PREFIX.length)}={someState}.`,
        pos: 0,
        end: 0,
        line: baseLine + attr.valueLine,
      });
    }
    if (isOnKey) {
      diagnostics.push({
        code: 'template/on-key-invalid-syntax',
        message: 'An on:key[...] attribute must be a quoted {expression} — e.g. on:key[OK]={selectItem(item)}.',
        pos: 0,
        end: 0,
        line: baseLine + attr.valueLine,
      });
    }
    return { kind: 'static', name: attr.name, value: attr.value };
  }

  const expression = match[1];
  const parsed = parseEmbeddedExpression(expression);
  for (const d of translateBrightScriptDiagnostics(parsed, baseOffset + attr.valuePos)) {
    diagnostics.push({ code: 'expression/parse-error', message: d.message, pos: d.pos, end: d.end, line: d.line });
  }

  if (isOnKey) {
    const rawSegments = splitOnKeyAttributeName(attr.name);
    if (rawSegments.length === 0 || rawSegments.some((s) => s.length === 0)) {
      diagnostics.push({
        code: 'template/on-key-empty-key-name',
        message: 'on:key[...] has an empty key segment — check for a doubled "," or a trailing "," in the key list.',
        pos: 0,
        end: 0,
        line: baseLine + attr.valueLine,
      });
    }
    const keys = rawSegments.filter((s) => s.length > 0).map((s) => (s === '-' ? ON_KEY_WILDCARD : s));
    return { kind: 'onKey', keys, expression };
  }

  return isBind ? { kind: 'bind', name: attr.name.slice(BIND_ATTRIBUTE_PREFIX.length), expression } : { kind: 'dynamic', name: attr.name, expression };
}

/** A `{#if}`/`{#if:destroy}`/`{/if}` marker occurrence. */
interface IfMarkerEvent {
  readonly family: 'if';
  readonly kind: 'open' | 'close';
  readonly mode?: 'toggle' | 'destroy';
  readonly expression?: string;
  /** Real file offset of the marker's own opening `{`. */
  readonly pos: number;
  readonly line: number;
}

/** A `{#each}`/`{/each}` marker occurrence. */
interface EachMarkerEvent {
  readonly family: 'each';
  readonly kind: 'open' | 'close';
  readonly collectionExpression?: string;
  readonly itemAlias?: string;
  readonly keyExpression?: string;
  /** Real file offset of the marker's own opening `{`. */
  readonly pos: number;
  readonly line: number;
}

/** Either marker family — the two are scanned together (`scanBlockMarkers`) since they can nest against each other. */
type BlockMarkerEvent = IfMarkerEvent | EachMarkerEvent;

/**
 * An element's real, interleaved `Element`/`Text` children (not the
 * elements-only `XmlElement.children` getter `classifyTemplateElement`
 * itself uses for its own tag/attributes) — a `{#if}`/`{#if:destroy}`
 * marker lives inside a `Text` node's own already-real-positioned text, so
 * recognizing it needs the raw interleaved sequence, not just the element
 * children.
 */
function rawContentChildren(element: XmlElement): XmlCstNode[] {
  return element.syntax.children.filter(
    (c): c is XmlCstNode => isXmlNode(c) && (c.kind === XmlSyntaxKind.Element || c.kind === XmlSyntaxKind.Text),
  );
}

/** An open `{#if}`/`{#if:destroy}` frame on `classifyTemplateChildren`'s block stack. */
interface IfBlockFrame {
  readonly family: 'if';
  readonly mode: 'toggle' | 'destroy';
  readonly expression: string;
  readonly children: TemplateNode[];
  readonly openPos: number;
  readonly openLine: number;
}

/** An open `{#each}` frame on `classifyTemplateChildren`'s block stack. */
interface EachBlockFrame {
  readonly family: 'each';
  readonly collectionExpression: string;
  readonly itemAlias: string;
  readonly keyExpression: string;
  readonly children: TemplateNode[];
  readonly openPos: number;
  readonly openLine: number;
}

/** Either open-block kind — a tagged union so `{#if}`/`{#each}` can nest against each other on one shared stack, with a closing marker validated against the *specific* opener kind it's popping (see `template/each-close-mismatch` below), not just "some block or other". */
type BlockFrame = IfBlockFrame | EachBlockFrame;

function frameToTemplateNode(frame: BlockFrame): TemplateNode {
  if (frame.family === 'if') return { kind: 'if', mode: frame.mode, expression: frame.expression, children: frame.children };
  return { kind: 'each', collectionExpression: frame.collectionExpression, itemAlias: frame.itemAlias, keyExpression: frame.keyExpression, children: frame.children };
}

function describeOpener(frame: BlockFrame): string {
  if (frame.family === 'if') return `{#if${frame.mode === 'destroy' ? ':destroy' : ''} ${frame.expression}}`;
  return `{#each ${frame.collectionExpression} as ${frame.itemAlias} (${frame.keyExpression})}`;
}

/**
 * Splits an element's children into a `TemplateNode[]`, recognizing
 * `{#if <expr>}...{/if}` / `{#if:destroy <expr>}...{/if}` and
 * `{#each <collection> as <item> (<key>)}...{/each}` blocks among ordinary
 * child elements — the two families nest arbitrarily against each other, so
 * they share one stack (`BlockFrame`). Depth-counts marker occurrences
 * across the raw `Element`/`Text` sibling sequence (same philosophy as
 * `findMatchingBrace`'s depth-counting over a token stream, applied here to
 * XML content instead) — the template's raw markup is parsed by the real,
 * unmodified `parseXml` exactly as any other template (see `embedded.ts`'s
 * `parseEmbeddedTemplate`); no text is ever rewritten before or after that
 * parse, so no diagnostic offset-remapping layer beyond the ordinary
 * `baseOffset` translation below is ever needed. See
 * findings/template-blocks.md for why this "real-parse-first" approach
 * was chosen over splicing markers into a synthetic XML tag before parsing.
 */
function classifyTemplateChildren(element: XmlElement, baseLine: number, diagnostics: ParseDiagnostic[], baseOffset: number): TemplateNode[] {
  const topLevel: TemplateNode[] = [];
  const stack: BlockFrame[] = [];
  const currentChildren = (): TemplateNode[] => (stack.length > 0 ? stack[stack.length - 1].children : topLevel);

  outer: for (const child of rawContentChildren(element)) {
    if (diagnostics.length > 0) break;

    if (child.kind === XmlSyntaxKind.Element) {
      currentChildren().push(classifyTemplateElement(new XmlElement(child), baseLine, diagnostics, baseOffset));
      continue;
    }

    const token = child.childTokens[0];
    if (!token) continue;

    for (const marker of scanBlockMarkers(token, baseLine, baseOffset, diagnostics)) {
      if (diagnostics.length > 0) break outer;

      if (marker.kind === 'open') {
        if (marker.family === 'if') {
          stack.push({ family: 'if', mode: marker.mode!, expression: marker.expression!, children: [], openPos: marker.pos, openLine: marker.line });
        } else {
          stack.push({
            family: 'each',
            collectionExpression: marker.collectionExpression!,
            itemAlias: marker.itemAlias!,
            keyExpression: marker.keyExpression!,
            children: [],
            openPos: marker.pos,
            openLine: marker.line,
          });
        }
        continue;
      }

      const closeMarkerText = marker.family === 'if' ? IF_CLOSE_MARKER : EACH_CLOSE_MARKER;
      const unterminatedCode = marker.family === 'if' ? 'template/unterminated-if-block' : 'template/unterminated-each-block';

      const frame = stack.pop();
      if (!frame) {
        diagnostics.push({
          code: unterminatedCode,
          message: `"${closeMarkerText}" with no matching "${marker.family === 'if' ? '{#if}/{#if:destroy}' : '{#each}'}".`,
          pos: marker.pos,
          end: marker.pos + closeMarkerText.length,
          line: marker.line,
        });
        break outer;
      }

      if (frame.family !== marker.family) {
        diagnostics.push({
          code: 'template/each-close-mismatch',
          message: `"${closeMarkerText}" closes "${describeOpener(frame)}" — a closing marker must match its opener's own kind ("{/if}" for "{#if}"/"{#if:destroy}", "{/each}" for "{#each}").`,
          pos: marker.pos,
          end: marker.pos + closeMarkerText.length,
          line: marker.line,
        });
        break outer;
      }

      currentChildren().push(frameToTemplateNode(frame));
    }
  }

  for (const frame of stack) {
    diagnostics.push({
      code: frame.family === 'if' ? 'template/unterminated-if-block' : 'template/unterminated-each-block',
      message: `"${describeOpener(frame)}" has no matching "${frame.family === 'if' ? '{/if}' : '{/each}'}".`,
      pos: frame.openPos,
      end: frame.openPos,
      line: frame.openLine,
    });
  }

  return topLevel;
}

/**
 * Scans one real, already-positioned `Text` token's text for
 * `{#if `/`{#if:destroy `/`{/if}` and `{#each `/`{/each}` marker occurrences
 * (a single `Text` node can contain more than one back-to-back, e.g. two
 * blocks closing in a row with no element between them). An `{#if}`
 * condition expression runs from right after the opener's prefix to the
 * next `}` — not nested-brace-aware, a deliberate narrowing consistent
 * with this DSL's other single-line expression forms (`derived`/`state`'s
 * own scan-to-end-of-line rule). `{#each}`'s header has the same narrowing
 * (see `parseEachHeader`).
 */
function scanBlockMarkers(token: XmlToken, baseLine: number, baseOffset: number, diagnostics: ParseDiagnostic[]): BlockMarkerEvent[] {
  const text = token.text;
  const events: BlockMarkerEvent[] = [];
  const line = baseLine + token.line;
  let i = 0;

  while (i < text.length) {
    if (text.startsWith(IF_CLOSE_MARKER, i)) {
      events.push({ family: 'if', kind: 'close', pos: baseOffset + token.pos + i, line });
      i += IF_CLOSE_MARKER.length;
      continue;
    }

    if (text.startsWith(EACH_CLOSE_MARKER, i)) {
      events.push({ family: 'each', kind: 'close', pos: baseOffset + token.pos + i, line });
      i += EACH_CLOSE_MARKER.length;
      continue;
    }

    const isDestroy = text.startsWith(IF_DESTROY_OPEN_PREFIX, i);
    const isToggle = !isDestroy && text.startsWith(IF_OPEN_PREFIX, i);
    if (isDestroy || isToggle) {
      const prefixLength = isDestroy ? IF_DESTROY_OPEN_PREFIX.length : IF_OPEN_PREFIX.length;
      const exprStart = i + prefixLength;
      const closeIndex = text.indexOf('}', exprStart);
      if (closeIndex === -1) {
        diagnostics.push({
          code: 'template/unterminated-if-block',
          message: `"${isDestroy ? '{#if:destroy' : '{#if'} ..." has no closing "}".`,
          pos: baseOffset + token.pos + i,
          end: baseOffset + token.pos + text.length,
          line,
        });
        return events;
      }

      const expression = text.slice(exprStart, closeIndex).trim();
      const exprAbsolutePos = baseOffset + token.pos + exprStart;
      const parsed = parseEmbeddedExpression(expression);
      for (const d of translateBrightScriptDiagnostics(parsed, exprAbsolutePos)) {
        diagnostics.push({ code: 'expression/parse-error', message: d.message, pos: d.pos, end: d.end, line: d.line });
      }

      events.push({ family: 'if', kind: 'open', mode: isDestroy ? 'destroy' : 'toggle', expression, pos: baseOffset + token.pos + i, line });
      i = closeIndex + 1;
      continue;
    }

    if (text.startsWith(EACH_OPEN_PREFIX, i)) {
      const parsedHeader = parseEachHeader(text, i, baseOffset, token, line, diagnostics);
      if (!parsedHeader) return events;
      events.push({ family: 'each', kind: 'open', ...parsedHeader.header, pos: baseOffset + token.pos + i, line });
      i = parsedHeader.nextIndex;
      continue;
    }

    i++;
  }

  return events;
}

interface EachHeaderParts {
  readonly collectionExpression: string;
  readonly itemAlias: string;
  readonly keyExpression: string;
}

/** First paren-depth-0 occurrence of the literal `" as "` in `header` — depth-tracked so a key clause containing `" as "` inside its own parens (unlikely, but possible in principle) can't be mistaken for the collection/alias separator. Returns -1 if not found. */
function findTopLevelAsSeparator(header: string): number {
  let depth = 0;
  for (let j = 0; j < header.length; j++) {
    const ch = header[j];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (depth === 0 && header.startsWith(' as ', j)) {
      return j;
    }
  }
  return -1;
}

/**
 * Parses one `{#each <collection> as <item> (<key>)}` header, starting at
 * `i` (the marker's own opening `{`) within `text`. Not nested-brace-aware
 * for the header's own closing `}` (same narrowing as `{#if}`'s
 * condition scan — a collection/key expression containing a literal `}`,
 * e.g. an inline BrightScript AA literal, isn't currently supported). Returns
 * `null` (after pushing a diagnostic) on any malformed header; on success,
 * returns the parsed parts plus the index just past the header's own
 * closing `}`.
 */
function parseEachHeader(
  text: string,
  i: number,
  baseOffset: number,
  token: XmlToken,
  line: number,
  diagnostics: ParseDiagnostic[],
): { header: EachHeaderParts; nextIndex: number } | null {
  const exprStart = i + EACH_OPEN_PREFIX.length;
  const closeIndex = text.indexOf('}', exprStart);
  const markerStart = baseOffset + token.pos + i;

  if (closeIndex === -1) {
    diagnostics.push({
      code: 'template/unterminated-each-block',
      message: '"{#each ..." has no closing "}".',
      pos: markerStart,
      end: baseOffset + token.pos + text.length,
      line,
    });
    return null;
  }

  const headerEnd = baseOffset + token.pos + closeIndex + 1;
  const header = text.slice(exprStart, closeIndex);
  const asIndex = findTopLevelAsSeparator(header);
  if (asIndex === -1) {
    diagnostics.push({
      code: 'template/each-invalid-header',
      message: `Invalid "{#each ...}" header — expected "{#each <collection> as <item> (<key>)}", found "${header.trim()}".`,
      pos: markerStart,
      end: headerEnd,
      line,
    });
    return null;
  }

  const collectionExpression = header.slice(0, asIndex).trim();
  const afterAs = header.slice(asIndex + ' as '.length);
  const aliasMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(afterAs);
  if (!aliasMatch) {
    diagnostics.push({
      code: 'template/each-invalid-item-alias',
      message: `Invalid item alias in "{#each ...}" — expected an identifier after "as", found "${afterAs.trim()}".`,
      pos: markerStart,
      end: headerEnd,
      line,
    });
    return null;
  }

  const itemAlias = aliasMatch[0];
  const afterAlias = afterAs.slice(itemAlias.length);
  let k = 0;
  while (k < afterAlias.length && /\s/.test(afterAlias[k])) k++;

  if (afterAlias[k] !== '(') {
    diagnostics.push({
      code: 'template/each-missing-key',
      message: `"{#each}" requires a key clause — expected "(<expr>)" after the item alias, found "${afterAlias.slice(k).trim()}". <expr> can be any BrightScript expression that uniquely identifies the item (e.g. "(n.id)", "(n)", "(n.getField(\"id\"))") — it isn't required to be a field literally named "id".`,
      pos: markerStart,
      end: headerEnd,
      line,
    });
    return null;
  }

  let depth = 1;
  let m = k + 1;
  while (m < afterAlias.length && depth > 0) {
    if (afterAlias[m] === '(') depth++;
    else if (afterAlias[m] === ')') depth--;
    m++;
  }

  if (depth !== 0) {
    diagnostics.push({
      code: 'template/each-missing-key',
      message: '"{#each}" key clause "(...)" is unterminated.',
      pos: markerStart,
      end: headerEnd,
      line,
    });
    return null;
  }

  const keyExpression = afterAlias.slice(k + 1, m - 1).trim();
  const trailing = afterAlias.slice(m);

  if (keyExpression.length === 0) {
    diagnostics.push({
      code: 'template/each-missing-key',
      message: '"{#each}" key clause "()" must not be empty.',
      pos: markerStart,
      end: headerEnd,
      line,
    });
    return null;
  }

  if (trailing.trim().length > 0) {
    diagnostics.push({
      code: 'template/each-invalid-header',
      message: `Unexpected content after the "(key)" clause in "{#each ...}": "${trailing.trim()}".`,
      pos: markerStart,
      end: headerEnd,
      line,
    });
    return null;
  }

  const collectionExprAbsolutePos = baseOffset + token.pos + exprStart;
  const parsedCollection = parseEmbeddedExpression(collectionExpression);
  for (const d of translateBrightScriptDiagnostics(parsedCollection, collectionExprAbsolutePos)) {
    diagnostics.push({ code: 'expression/parse-error', message: d.message, pos: d.pos, end: d.end, line: d.line });
  }

  const keyExprAbsolutePos = baseOffset + token.pos + exprStart + asIndex + ' as '.length + itemAlias.length + k + 1;
  const parsedKey = parseEmbeddedExpression(keyExpression);
  for (const d of translateBrightScriptDiagnostics(parsedKey, keyExprAbsolutePos)) {
    diagnostics.push({ code: 'expression/parse-error', message: d.message, pos: d.pos, end: d.end, line: d.line });
  }

  return { header: { collectionExpression, itemAlias, keyExpression }, nextIndex: closeIndex + 1 };
}
