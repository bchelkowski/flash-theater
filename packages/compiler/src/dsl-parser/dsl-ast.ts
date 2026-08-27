/**
 * AST types for the DSL layer, per the grammar (packages/compiler/GRAMMAR.md).
 * These are adapted from flash-parser's own typed AST by
 * dsl-parser/dsl-parser.ts — see findings/compiler-parser-architecture.md for why
 * this shape stays a thin, separate adapter layer instead of having every
 * downstream module (dependency-graph.ts, template-bindings.ts,
 * xml-emitter.ts, brs-emitter.ts) depend on flash-parser types directly.
 * `derived` expressions are still raw source text here (parsed on demand by
 * analysis/expression-region.ts); function bodies carry both the raw text
 * (`body`, for display/debugging) and the structured statement list
 * (`block`, which codegen/brs-emitter.ts prints from directly).
 */
import type { Block as FlashBlock, ClassVisibility, ConstructorBody as FlashConstructorBody } from 'flash-parser';

export type { ClassVisibility };

/**
 * `array`/`assocarray` are valid only for a `field`/`state` declaration (`ScriptParser`) — never
 * produced for a `ThemeLeafDecl` (which also types itself with `FieldType`, for convenience), since
 * `ThemeParser` still validates against flash-parser's narrower, unwidened `FIELD_TYPES` set. See
 * GRAMMAR.md's "field" section.
 */
export type FieldType = 'string' | 'integer' | 'float' | 'boolean' | 'node' | 'array' | 'assocarray';

export interface SourceSpan {
  /** Line number (0-based) in the original .thr file, counted from <script>. */
  line: number;
}

export interface FieldDecl {
  kind: 'field';
  name: string;
  type: FieldType;
  /** Raw text of the default value literal, e.g. `"0"`, `"false"`, `"invalid"`. */
  defaultLiteral: string;
  /** `true` for `scale field ...` — the default value is scaled at runtime by the app's configured design-resolution factor. See GRAMMAR.md's "scale" section. */
  scale: boolean;
  span: SourceSpan;
}

export interface DerivedDecl {
  kind: 'derived';
  name: string;
  /** Native BrightScript type as text — unrestricted, unlike `FieldDecl.type` (`derived` never becomes an XML `<field>`). */
  type: string;
  /** Raw text of the expression on the right-hand side of `=`. */
  expression: string;
  /** `true` for `scale derived ...` — every recompute is scaled at runtime. */
  scale: boolean;
  span: SourceSpan;
}

/**
 * Component-local reactive state — same declaration shape as `field`
 * (`state <name>: <Type> = <literal>`), but never becomes an XML `<field>`:
 * it's a private `m.x` member, not a SceneGraph interface field, so its
 * type is an unrestricted string (like a function param/return type)
 * rather than `FieldType`'s closed set. Written only via a `StateAssignment`
 * statement (`state <name> = <expr>`) inside a function body — see
 * findings/reactivity-state.md.
 */
export interface StateDecl {
  kind: 'state';
  name: string;
  /** Native BrightScript type as text — unrestricted, unlike `FieldDecl.type`. */
  type: string;
  /** Raw text of the default value literal. */
  defaultLiteral: string;
  /** `true` for `scale state ...` — the default value is scaled at runtime. */
  scale: boolean;
  span: SourceSpan;
}

/**
 * `read <name> = store(<path>)` — a one-time, non-reactive snapshot of a
 * store value, assigned once in `init()` and never recomputed. `path`'s
 * first segment is the store's top-level key; the rest is unchecked
 * dynamic dot-access (the store is schemaless from the compiler's point of
 * view — it's a built-in runtime primitive, never declared in the DSL, see
 * GRAMMAR.md's "Global store" section). No type annotation: there's nothing
 * to check one against.
 */
export interface ReadDecl {
  kind: 'read';
  name: string;
  path: string[];
  /** `true` for `scale read ...` — the snapshot is scaled once, at init. */
  scale: boolean;
  span: SourceSpan;
}

/**
 * `watch <name> = store(<path>)` — same shape as `ReadDecl`, but reactive:
 * recomputed whenever the store's top-level key (`path[0]`) changes,
 * exactly like a `field`/`state`-driven `derived`.
 */
export interface WatchDecl {
  kind: 'watch';
  name: string;
  path: string[];
  /** `true` for `scale watch ...` — every recompute is scaled at runtime. */
  scale: boolean;
  span: SourceSpan;
}

/**
 * `stream <name>: <Type>` — a per-component-instance, BehaviorSubject-like
 * pub-sub value used for imperative, reactive communication between
 * different objects (especially `.flsh` class instances) living inside the
 * SAME component — never for node-to-node communication (that stays
 * field/binding). No expression/defaultLiteral, unlike every other
 * `ScriptDecl` — its runtime value is always a fresh `ft_createStream()` AA
 * (codegen/brs-emitter.ts), never DSL-authored. Deliberately NOT folded into
 * `reactiveSourceNames`/the `derived`/`watch` dependency graph
 * (analysis/scope-resolution.ts registers it under its own disjoint
 * `streamNames` set) — reading a stream's `.value` is a plain snapshot,
 * never a tracked binding.
 */
export interface StreamDecl {
  kind: 'stream';
  name: string;
  /** Unrestricted identifier, like `derived`'s — a stream never becomes an XML `<field>`. */
  type: string;
  span: SourceSpan;
}

/**
 * `request <Kind> { ... }` — declares this component as a single HTTP/Channel Store
 * request/endpoint, generating `data`/`result`/`error` interface fields plus the transport-specific
 * wiring `codegen/request-emitter.ts` needs. At most one per file — `analysis/request-config.ts`/
 * `compile.ts` reject a second one (`request/multiple-request-declarations`), not this layer (this
 * package's own `ThrScriptAst.request` is a single optional slot, not an array, for exactly that
 * reason — flash-parser itself stays permissive, see `RequestDeclaration.requests` there).
 */
export interface RequestDecl {
  kind: 'request';
  /** The request `Kind` discriminator — a raw, unvalidated identifier at this layer; `analysis/request-config.ts` validates it against the closed `Kind` list. */
  requestKind: string;
  /** Raw config-literal text, INCLUDING its own `{`/`}` delimiters (unlike `DerivedDecl.expression`, which is a bare expression) — `analysis/request-config.ts` parses this whole span as one AA-literal expression. */
  configText: string;
  span: SourceSpan;
}

/**
 * `animation <name> { ... }` — declares a named, reusable Roku Animation/composition, referenced
 * later via `.start()`/`.stop()`/`.pause()`/`.resume()`/`.finish()` trigger sugar and template
 * `transition:`/`in:`/`out:` attribute values. Unlike `RequestDecl` (at most one per file), any
 * number of `animation` declarations are allowed — `ThrScriptAst.animations` is an array, not a
 * single optional slot.
 */
export interface AnimationDecl {
  kind: 'animation';
  name: string;
  /** Raw config-literal text, INCLUDING its own `{`/`}` delimiters — same convention as `RequestDecl.configText`; `analysis/animation-config.ts` parses this whole span. */
  configText: string;
  span: SourceSpan;
}

export interface FunctionParam {
  name: string;
  /** Native BrightScript type as text (e.g. `boolean`, `object`, `string`). */
  type: string;
}

export type FunctionVisibility = 'private' | 'public';

export interface FunctionDecl {
  kind: 'function';
  visibility: FunctionVisibility;
  name: string;
  params: FunctionParam[];
  /** `null` when the function omits its return-type clause — compiles to a BrightScript `sub`, not `function ... as <Type>` (see codegen/brs-emitter.ts). There is no `void` type in this DSL; "no return value" is expressed by omitting the clause entirely. */
  returnType: string | null;
  /** Raw body text between `{` and `}` (braces excluded) — display/debugging only, codegen uses `block`. */
  body: string;
  /** Structured statement list (flash-parser's `Block`) — what codegen/brs-emitter.ts actually prints from. */
  block: FlashBlock;
  span: SourceSpan;
}

/**
 * A top-level `' flash-theater:raw` ... `' flash-theater:end-raw` block in `<script>`, a sibling of
 * `field`/`derived`/`function` — unlike those, it declares nothing and has no name; its `text` is
 * appended, unrewritten, into the generated `init()` (see `codegen/brs-emitter.ts`'s
 * `emitInitFunction`), in source order, after every other reactive/binding/focus setup `init()`
 * already does. `.flsh` class bodies have no equivalent top-level form — see GRAMMAR.md's "Raw
 * BrightScript passthrough" section for why (no guaranteed lifecycle sub to land one in).
 */
export interface RawBlockDecl {
  kind: 'raw-block';
  /** Exactly as authored, with only the leading marker comment line stripped — see flash-parser's `RawBrightScriptStatement.text`. Never identifier-rewritten. */
  text: string;
  span: SourceSpan;
}

export type ScriptDecl = FieldDecl | DerivedDecl | StateDecl | ReadDecl | WatchDecl | StreamDecl | AnimationDecl | FunctionDecl | RawBlockDecl;

/** `import <ClassName> from "<path>"` — valid in a `.thr` `<script>` section and in a `.flsh` file. `path` is exactly as written (unresolved) — resolving it to a real file is app-compiler.ts's job (inherently cross-file), never this package's `compile.ts`. */
export interface ImportDecl {
  className: string;
  path: string;
  span: SourceSpan;
}

export interface ThrScriptAst {
  imports: ImportDecl[];
  fields: FieldDecl[];
  derived: DerivedDecl[];
  state: StateDecl[];
  reads: ReadDecl[];
  watches: WatchDecl[];
  streams: StreamDecl[];
  /** `null` when this component declares no `request {}` — see `RequestDecl`'s own doc comment for why this is a single slot, not an array. */
  request: RequestDecl | null;
  animations: AnimationDecl[];
  functions: FunctionDecl[];
  /** Top-level `' flash-theater:raw` ... `' flash-theater:end-raw` blocks, in source order — see `RawBlockDecl`'s own doc comment. */
  rawBlocks: RawBlockDecl[];
}

// ---- class declarations (.flsh files) ---------------------------------

/** `[public|private|protected] <name>: <Type> = <literal>` at class-body top level — a class-owned default assigned once, before the constructor runs. `<Type>` is unrestricted, like `state`/`derived` (a class field is a private/public AA member, never a SceneGraph `<field>`). */
export interface ClassFieldDecl {
  kind: 'class-field';
  visibility: ClassVisibility;
  name: string;
  type: string;
  defaultLiteral: string;
  span: SourceSpan;
}

/**
 * `[public|private|protected] stream <name>: <Type>` at class-body top
 * level — same "no initializer" shape as the script-level `StreamDecl`; a
 * class-declared stream is reachable from whoever holds the instance
 * (`someInstance.streamFieldName.subscribe(...)`/`.emit(...)`), not just
 * from the class's own methods, exactly like any other public field. Kept
 * as a separate array (`ThrClassAst.streamFields`), parallel to
 * `ClassFieldDecl`/`.fields`, not merged into it — a stream field has no
 * `defaultLiteral`, so every existing consumer that assumes a field has one
 * stays untouched.
 */
export interface ClassStreamFieldDecl {
  kind: 'class-stream-field';
  visibility: ClassVisibility;
  name: string;
  type: string;
  span: SourceSpan;
}

/** `[override] public|private|protected function <name>(<param>: <Type>, ...) [: <Type>] { <Block> }` — identical shape to `FunctionDecl` plus `isOverride` and a third `protected` visibility; `block` is flash-parser's own `Block`, reused unchanged (same convention as `FunctionDecl.block`). */
export interface ClassMethodDecl {
  kind: 'class-method';
  isOverride: boolean;
  visibility: ClassVisibility;
  name: string;
  params: FunctionParam[];
  returnType: string | null;
  block: FlashBlock;
  span: SourceSpan;
}

/**
 * `[override] constructor(<param>: <Type>, ...) { ... }`. `body` is
 * flash-parser's own `ConstructorBody` — kept as a raw, unadapted AST node
 * (same convention as `FunctionDecl.block`) since `codegen/class-emitter.ts`
 * prints directly from its `.statements` (`SuperCallStatement`/
 * `ConstructorFieldInit`/`IfStatement`/`StatementRegion`), the same way
 * `codegen/brs-emitter.ts` prints a `FunctionDecl.block` directly.
 */
export interface ConstructorDecl {
  isOverride: boolean;
  params: FunctionParam[];
  body: FlashConstructorBody;
  span: SourceSpan;
}

/** A `.flsh` file's single class — `class Name [extends Base] { <member>* }`. */
export interface ThrClassAst {
  name: string;
  /** `null` when this class doesn't `extends` a base. */
  baseName: string | null;
  imports: ImportDecl[];
  fields: ClassFieldDecl[];
  streamFields: ClassStreamFieldDecl[];
  /** `null` when the class declares no constructor — only valid when `baseName` is also `null` (an extending class must have an explicit `override constructor`, enforced by flash-parser at parse time). */
  constructorDecl: ConstructorDecl | null;
  methods: ClassMethodDecl[];
}

export type TemplateAttribute =
  | { kind: 'static'; name: string; value: string }
  | { kind: 'dynamic'; name: string; expression: string }
  | { kind: 'bind'; name: string; expression: string }
  | { kind: 'onKey'; keys: string[]; expression: string }
  /** `transition:<name>`/`in:<name>`/`out:<name>` — see flash-parser's `templateModel.ts` for the full doc comment (hand-mirrored here, not re-exported — see this file's own top-level comment). */
  | { kind: 'transition'; direction: 'both' | 'in' | 'out'; animationRef: string; overrideConfigText: string | null }
  /** `navigate-out:`/`navigate-in:`/`back-out:`/`back-in:<name>` — see flash-parser's `templateModel.ts` for the full doc comment (hand-mirrored here, not re-exported — see this file's own top-level comment). */
  | { kind: 'routerTransition'; navDirection: 'navigate' | 'back'; phase: 'in' | 'out'; animationRef: string; overrideConfigText: string | null }
  /** `animate:<field>` — see flash-parser's `templateModel.ts` for the full doc comment (hand-mirrored here, not re-exported — see this file's own top-level comment). */
  | { kind: 'animate'; fieldName: string; overrideConfigText: string | null };

/**
 * Hand-mirrored copy of flash-parser's `TemplateNode` — kept as a duplicate
 * (not a re-export) for the same reason the rest of this file is a thin,
 * separate adapter layer, see the file-level comment above. A change to
 * flash-parser's `templateModel.ts` must be made here too.
 */
export type TemplateNode =
  | { kind: 'element'; tagName: string; id: string | null; attributes: TemplateAttribute[]; children: TemplateNode[] }
  | { kind: 'if'; mode: 'toggle' | 'destroy'; expression: string; children: TemplateNode[] }
  | { kind: 'each'; collectionExpression: string; itemAlias: string; keyExpression: string; children: TemplateNode[] };

export type TemplateElement = Extract<TemplateNode, { kind: 'element' }>;
export type TemplateIfBlock = Extract<TemplateNode, { kind: 'if' }>;
export type TemplateEachBlock = Extract<TemplateNode, { kind: 'each' }>;

/** One `on:key[...]` binding declared directly on `<component>` itself — hand-mirrored copy of flash-parser's `ComponentOnKeyBinding`, see `TemplateNode`'s doc comment above for why these stay duplicated rather than re-exported. */
export interface ComponentOnKeyBinding {
  keys: string[];
  expression: string;
}

/**
 * `root` is either the sole real top-level element `<component>` wraps, or — when `<component>`
 * has 2+ top-level children — a synthetic, never-emitted marker element (`tagName ===
 * SYNTHETIC_MULTI_CHILD_TAG`, `id: null`) whose own `.children` are those real siblings.
 * `codegen/xml-emitter.ts`'s top-level `emitXml` call is the ONLY place that needs to recognize
 * and unwrap the marker (loop its children into `<children>` directly, printing no wrapper tag of
 * its own) — every other analysis module already walks `.children` generically and treats a
 * marker with no `id` exactly like any other id-less element, no special-casing needed. See
 * `findings/reactivity-theme-parsing.md`'s "synthetic multi-child wrapper" entry.
 */
export interface ThrTemplateAst {
  root: TemplateElement;
  /** From `<component extends="...">` — `null` when absent (codegen defaults to `'Group'`). */
  extends: string | null;
  /** Every `on:key[...]` attribute declared directly on `<component>` — unconditional dispatch, not gated by any descendant's `IsInFocusChain()`. */
  onKeyAttributes: ComponentOnKeyBinding[];
}

/** `ThrTemplateAst.root`'s reserved synthetic tag name when `<component>` has 2+ top-level children — never a real SceneGraph tag, never emitted, see `ThrTemplateAst`'s own doc comment. */
export const SYNTHETIC_MULTI_CHILD_TAG = '$$ft_multi_root';

export interface ThrFileAst {
  script: ThrScriptAst;
  template: ThrTemplateAst;
}

/** `<name>: <Type> = <literal>` inside a theme template/variant — same token shape as `FieldDecl`. */
export interface ThemeLeafDecl {
  kind: 'theme-leaf';
  name: string;
  type: FieldType;
  defaultLiteral: string;
  span: SourceSpan;
}

/** `<name>: { <member>* }` inside a theme template/variant — unbounded nesting via `members`. */
export interface ThemeGroupDecl {
  kind: 'theme-group';
  name: string;
  members: ThemeMemberDecl[];
  span: SourceSpan;
}

export type ThemeMemberDecl = ThemeLeafDecl | ThemeGroupDecl;

/** A `<theme-template>` file's body — the canonical theme shape and defaults every variant is validated against. */
export interface ThemeTemplateAst {
  members: ThemeMemberDecl[];
  /** From the optional `default="name"` attribute — the compile-time tier of the initial-active-theme fallback chain. */
  defaultVariantName: string | null;
}

/** A `<theme name="...">` file's body — a partial override of the template. */
export interface ThemeVariantAst {
  variantName: string;
  members: ThemeMemberDecl[];
}

export interface CompileDiagnostic {
  code: string;
  message: string;
  span?: SourceSpan;
}

export class CompileError extends Error {
  constructor(public readonly diagnostic: CompileDiagnostic) {
    super(diagnostic.message);
    this.name = 'CompileError';
  }
}
