import { FieldDecl, SYNTHETIC_MULTI_CHILD_TAG, TemplateNode, ThrScriptAst, ThrTemplateAst } from '../dsl-parser/dsl-ast.js';
import { fieldChangeHandlerName, DEFAULT_FOCUS_ATTRIBUTE_NAME } from './naming.js';
import { ConditionalBlockAnalysis } from '../analysis/conditional-blocks.js';
import { EachBlockAnalysis, EMPTY_EACH_BLOCKS } from './each-block-emitter.js';

const EMPTY_CONDITIONAL_BLOCKS: ConditionalBlockAnalysis = {
  blocks: [],
  blockIdByNode: new Map(),
  syntheticParentIds: new Map(),
  nearestDestroyAncestorById: new Map(),
  nearestEachAncestorById: new Map(),
};

export interface EmitXmlOptions {
  /** Defaults to `'Group'`, today's exact behavior. A headless `<store>`/theme node uses `'Node'`; a `.thr` author can declare any other SceneGraph base class via `<component extends="...">` (`dsl-parser.ts`'s `ThrTemplateAst.extends`) — an unrestricted string, same trust level as a template element's `tagName`: an unknown value surfaces as a real Roku error, not a DSL-level one. */
  extends?: string;
  /** Defaults to `false`. `true` skips `<children>` entirely — a `<store>`/theme component has no template. */
  headless?: boolean;
  /** `<function name="..." />` entries beyond what `script.fields` already produces — a store's public functions, needed for `CallFunc` to find them. Defaults to none. */
  interfaceFunctions?: readonly string[];
  /**
   * Additional `<script>` URIs beyond the component's own self-referencing
   * one — one per transitively-imported `.flsh` class (see `import`,
   * GRAMMAR.md), already resolved to a path relative to this component's
   * own directory and deduped by the caller (`app-compiler.ts`). SceneGraph
   * XML already supports multiple `<script>` tags sharing one BrightScript
   * global scope, so this is all multi-file class wiring needs — no
   * bundling/inlining. Defaults to none.
   */
  extraScriptUris?: readonly string[];
  /** Every `{#if}`/`{#if:destroy}` block in the template (see `analysis/conditional-blocks.ts`) — computed once by the caller and threaded through so a toggle-mode block's synthetic `Group` wrapper (and any synthesized parent id a destroy-mode block forced onto a real element) get the exact same ids `codegen/brs-emitter.ts` generates code against. Defaults to "no blocks" for callers (store/theme) whose template never has any. */
  conditionalBlocks?: ConditionalBlockAnalysis;
  /** Every `{#each}` block in the template (see `codegen/each-block-emitter.ts`) — same "computed once, threaded through" convention as `conditionalBlocks`, so its wrapper `Group` gets the exact id `codegen/brs-emitter.ts` generates code against. Defaults to "no blocks". */
  eachBlocks?: EachBlockAnalysis;
  /** `<field>` entries beyond what `script.fields` produces — used for a `request {}` declaration's `resolvedOptions`/`rawResponse`/`result`/`error` (`assocarray`, outside the closed `FieldType` union `script.fields` is bound to) and `ft_isRequestComponent` (a `boolean` marker field, defaulted `value="true"`). See `codegen/request-emitter.ts`'s `requestInterfaceFields`. `value` is omitted (no `value=` attribute at all) unless the field explicitly needs a non-empty XML default — `resolvedOptions`/`rawResponse`/`result`/`error` all rely on their ordinary SG-type default (`invalid` for an unset `assocarray`) instead. Defaults to none. */
  extraInterfaceFields?: readonly { id: string; type: string; value?: string }[];
  /**
   * Pre-rendered, pre-indented XML lines for non-visual sibling nodes — currently, every declared
   * `animation {}`'s own `<Animation>`/`<SequentialAnimation>`/`<ParallelAnimation>` + interpolator
   * subtree (see `codegen/animation-emitter.ts`'s `emitAnimationXml`, called once per declaration by
   * `compile.ts`). Spliced directly after
   * the template root, still inside `<children>` — unlike `Store`/`Router`/etc. (separate copied
   * singleton components, referenced via `m.global`), Roku requires an `Animation` node to be a
   * real per-component child so `fieldToInterp="id.field"` resolves via `findNode` scoped to this
   * component. Silently dropped when `headless` is true (a headless component has no template, so
   * no element ids an animation could ever validly target — nothing to splice). Defaults to none.
   */
  extraChildrenXml?: readonly string[];
}

/**
 * Emits the static `<component>`/`<interface>`/`<children>` tree from the DSL
 * AST. Dynamic attributes (`{expr}`) do NOT go into the XML — their value is
 * set at runtime by brs-emitter.ts (init() + on_<field>Change). Zero
 * vdom/diffing — see GRAMMAR.md.
 */
export function emitXml(
  script: ThrScriptAst,
  template: ThrTemplateAst | null,
  fieldsNeedingOnChange: ReadonlySet<string>,
  componentName: string,
  options: EmitXmlOptions = {},
): string {
  const {
    extends: extendsValue = 'Group',
    headless = false,
    interfaceFunctions = [],
    extraScriptUris = [],
    conditionalBlocks = EMPTY_CONDITIONAL_BLOCKS,
    eachBlocks = EMPTY_EACH_BLOCKS,
    extraInterfaceFields = [],
    extraChildrenXml = [],
  } = options;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8" ?>');
  lines.push(`<component name="${componentName}" extends="${extendsValue}">`);
  lines.push('  <interface>');
  for (const field of script.fields) {
    lines.push(`    ${emitFieldInterfaceLine(field, fieldsNeedingOnChange)}`);
  }
  for (const extraField of extraInterfaceFields) {
    const valueAttr = extraField.value !== undefined ? ` value="${extraField.value}"` : '';
    lines.push(`    <field id="${extraField.id}" type="${extraField.type}"${valueAttr} />`);
  }
  for (const fnName of interfaceFunctions) {
    lines.push(`    <function name="${fnName}" />`);
  }
  lines.push('  </interface>');
  if (!headless) {
    lines.push('  <children>');
    // <component> with 2+ top-level children collapses to a synthetic, never-emitted marker
    // (dsl-parser.ts's adaptTemplateSection) whose own children are those real siblings — this is
    // the ONLY place that needs to know about it: unwrap it here (print each real child directly
    // into <children>, no wrapper tag of its own) rather than rippling "N independent roots"
    // through every analysis module. The 1-child case (the common one) is untouched — `root` IS
    // that real element already, emitted exactly as before.
    if (template!.root.tagName === SYNTHETIC_MULTI_CHILD_TAG) {
      for (const child of template!.root.children) {
        lines.push(...emitElement(child, 2, conditionalBlocks, eachBlocks));
      }
    } else {
      lines.push(...emitElement(template!.root, 2, conditionalBlocks, eachBlocks));
    }
    lines.push(...extraChildrenXml);
    lines.push('  </children>');
  }
  lines.push(`  <script type="text/brightscript" uri="${componentName}.brs" />`);
  for (const uri of Array.from(new Set(extraScriptUris))) {
    lines.push(`  <script type="text/brightscript" uri="${uri}" />`);
  }
  lines.push('</component>');
  lines.push('');

  return lines.join('\n');
}

/** Types with no representable XML literal default — SceneGraph gives `node` no literal syntax at all, and `array`/`assocarray` have no reliable one either (see `request-emitter.ts`'s own `assocarray` extra fields, which never carry a `value=` for the same reason). All three get their default assigned in `init()` instead — see `brs-emitter.ts`'s `emitInitFunction`. */
const FIELD_TYPES_WITH_NO_XML_DEFAULT = new Set(['node', 'array', 'assocarray']);

function emitFieldInterfaceLine(field: FieldDecl, fieldsNeedingOnChange: ReadonlySet<string>): string {
  const parts = [`id="${field.name}"`, `type="${field.type}"`];

  if (!FIELD_TYPES_WITH_NO_XML_DEFAULT.has(field.type)) {
    parts.push(`value="${escapeXmlAttr(field.defaultLiteral)}"`);
  }

  if (fieldsNeedingOnChange.has(field.name)) {
    parts.push(`onChange="${fieldChangeHandlerName(field.name)}"`);
  }

  return `<field ${parts.join(' ')} />`;
}

/**
 * Emits one template node as XML — an ordinary element, or a toggle-mode
 * `{#if}` block's synthetic `Group` wrapper (always present, `visible`
 * bound at runtime by `codegen/brs-emitter.ts` via an ordinary attribute
 * binding — see `codegen/template-bindings.ts`'s synthetic-binding push). A
 * destroy-mode `{#if:destroy}` block never appears here at all — its
 * subtree doesn't exist until `codegen/conditional-block-emitter.ts`'s
 * generated create sub builds it at runtime.
 */
function emitElement(node: TemplateNode, depth: number, conditionalBlocks: ConditionalBlockAnalysis, eachBlocks: EachBlockAnalysis): string[] {
  const indent = '  '.repeat(depth);

  if (node.kind === 'if') {
    if (node.mode === 'destroy') return [];
    const id = conditionalBlocks.blockIdByNode.get(node)!;
    return emitChildrenWrappedIn('Group', id, node.children, depth, conditionalBlocks, eachBlocks);
  }

  if (node.kind === 'each') {
    // Always statically present — unlike a {#if:destroy} block, an {#each}'s item count is a
    // runtime fact but the wrapper itself always exists, so it's a plain self-closing `Group`
    // (never any of `node.children` — the item body is never statically rendered, only
    // constructed at runtime by codegen/each-block-emitter.ts's reconcile sub).
    const id = eachBlocks.blockIdByNode.get(node)!;
    return [`${indent}<Group id="${escapeXmlAttr(id)}" />`];
  }

  const attrParts: string[] = [];
  const id = node.id ?? conditionalBlocks.syntheticParentIds.get(node) ?? null;
  if (id) attrParts.push(`id="${escapeXmlAttr(id)}"`);
  for (const attr of node.attributes) {
    // default-focus is a pure compiler-internal/DSL marker with no corresponding native
    // SceneGraph field on any node type — emitting it as a real XML attribute produces a genuine
    // Roku compile failure (confirmed live — see findings/router.md), unlike `focusable`, which
    // legitimately IS a real native field and belongs in the XML.
    if (attr.kind === 'static' && attr.name !== DEFAULT_FOCUS_ATTRIBUTE_NAME) attrParts.push(`${attr.name}="${escapeXmlAttr(attr.value)}"`);
  }

  const openTag = `<${node.tagName}${attrParts.length > 0 ? ' ' + attrParts.join(' ') : ''}`;
  const staticallyPresentChildren = node.children.filter((c) => !(c.kind === 'if' && c.mode === 'destroy'));

  if (staticallyPresentChildren.length === 0) {
    return [`${indent}${openTag} />`];
  }

  const lines = [`${indent}${openTag}>`];
  for (const child of node.children) lines.push(...emitElement(child, depth + 1, conditionalBlocks, eachBlocks));
  lines.push(`${indent}</${node.tagName}>`);
  return lines;
}

function emitChildrenWrappedIn(
  tagName: string,
  id: string,
  children: readonly TemplateNode[],
  depth: number,
  conditionalBlocks: ConditionalBlockAnalysis,
  eachBlocks: EachBlockAnalysis,
): string[] {
  const indent = '  '.repeat(depth);
  const openTag = `<${tagName} id="${escapeXmlAttr(id)}"`;
  const staticallyPresentChildren = children.filter((c) => !(c.kind === 'if' && c.mode === 'destroy'));

  if (staticallyPresentChildren.length === 0) {
    return [`${indent}${openTag} />`];
  }

  const lines = [`${indent}${openTag}>`];
  for (const child of children) lines.push(...emitElement(child, depth + 1, conditionalBlocks, eachBlocks));
  lines.push(`${indent}</${tagName}>`);
  return lines;
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
