import type {
  ClassDeclaration,
  ClassFieldDeclaration,
  ClassStreamFieldDeclaration,
  ClassMethodDeclaration,
  ConstructorDeclaration,
  DerivedDeclaration,
  FlshFile,
  ImportDeclaration,
  WatchDeclaration,
  StreamDeclaration,
  RequestDeclaration,
  AnimationDeclaration,
  FieldDeclaration,
  FunctionDeclaration,
  ReadDeclaration,
  ScriptSection,
  StateDeclaration,
  TemplateSection,
  ThemeTemplateSection,
  ThemeVariantSection,
  ThemeMember,
  ScaleFieldDeclaration,
  ScaleStateDeclaration,
  ScaleDerivedDeclaration,
  ScaleWatchDeclaration,
  ScaleReadDeclaration,
  RawBrightScriptStatement,
} from 'flash-parser';
import { ThemeGroupDeclaration } from 'flash-parser';
import {
  WatchDecl,
  StreamDecl,
  RequestDecl,
  AnimationDecl,
  ClassFieldDecl,
  ClassStreamFieldDecl,
  ClassMethodDecl,
  ConstructorDecl,
  FieldType,
  DerivedDecl,
  FunctionDecl,
  FunctionParam,
  ImportDecl,
  RawBlockDecl,
  ReadDecl,
  SourceSpan,
  StateDecl,
  SYNTHETIC_MULTI_CHILD_TAG,
  TemplateElement,
  TemplateNode,
  ThemeMemberDecl,
  ThemeTemplateAst,
  ThemeVariantAst,
  ThrClassAst,
  ThrScriptAst,
  ThrTemplateAst,
} from './dsl-ast.js';

/**
 * Adapts flash-parser's typed `DeclarationsSection`/`TemplateSection` AST
 * (see packages/flash-parser) into the `ThrScriptAst`/`ThrTemplateAst`
 * shapes the rest of this pipeline already consumes
 * (`analysis/dependency-graph.ts`, `codegen/template-bindings.ts`,
 * `codegen/xml-emitter.ts`, `codegen/brs-emitter.ts`) — a thin mapping
 * layer, not a parser. The actual `<script>`/template grammar now lives
 * entirely in flash-parser; this repo never hand-parses it.
 * `compile.ts` calls flash-parser's `parse()` once and throws
 * `CompileError` on its first diagnostic before any adapter ever runs, so
 * all of them can assume their input is grammatically valid.
 */
export function adaptScriptSection(script: ScriptSection): ThrScriptAst {
  return {
    imports: script.imports.map(adaptImport),
    fields: mergeByLine(
      script.fields.map((f) => adaptField(f, false)),
      script.scaleFields.map((f) => adaptField(f, true)),
    ),
    derived: mergeByLine(
      script.derived.map((d) => adaptDerived(d, false)),
      script.scaleDerived.map((d) => adaptDerived(d, true)),
    ),
    state: mergeByLine(
      script.state.map((s) => adaptState(s, false)),
      script.scaleState.map((s) => adaptState(s, true)),
    ),
    reads: mergeByLine(
      script.reads.map((r) => adaptRead(r, false)),
      script.scaleReads.map((r) => adaptRead(r, true)),
    ),
    watches: mergeByLine(
      script.watches.map((w) => adaptWatch(w, false)),
      script.scaleWatches.map((w) => adaptWatch(w, true)),
    ),
    streams: script.streams.map(adaptStream),
    request: script.request ? adaptRequest(script.request) : null,
    animations: script.animations.map(adaptAnimation),
    functions: script.functions.map(adaptFunction),
    rawBlocks: script.rawBlocks.map(adaptRawBlock),
  };
}

function adaptRawBlock(r: RawBrightScriptStatement): RawBlockDecl {
  return { kind: 'raw-block', text: r.text, span: { line: r.line } };
}

/** Merges a plain and a `scale`d declaration list back into one, in original source order — `scale field`/`scale state`/`scale derived`/`scale watch`/`scale read` each parse into their own distinct flash-parser `SyntaxKind` (see `ast.ts`'s `Scale*Declaration` classes), so `ScriptSection` exposes them as separate arrays. */
function mergeByLine<T extends { span: SourceSpan }>(plain: T[], scaled: T[]): T[] {
  return [...plain, ...scaled].sort((a, b) => a.span.line - b.span.line);
}

function adaptImport(i: ImportDeclaration): ImportDecl {
  return { className: i.className, path: i.path, span: { line: i.line } };
}

/** Adapts a `.flsh` file's single class declaration (the class body's own member grammar) — `imports` is filled in separately by `adaptFlshFile` from the enclosing `FlshFile`'s own import list, since flash-parser's `ClassDeclaration` node doesn't carry them (they're siblings, not children, of the class in the CST). */
export function adaptClassDeclaration(cls: ClassDeclaration): ThrClassAst {
  return {
    name: cls.name,
    baseName: cls.baseName,
    imports: [],
    fields: cls.fields.map(adaptClassField),
    streamFields: cls.streamFields.map(adaptClassStreamField),
    constructorDecl: cls.constructorDecl ? adaptConstructorDeclaration(cls.constructorDecl) : null,
    methods: cls.methods.map(adaptClassMethod),
  };
}

/** Adapts a whole `.flsh` file — its own class plus the imports that precede it in the file (used to resolve `extends`'s base and any class the constructor/methods instantiate). */
export function adaptFlshFile(file: FlshFile): ThrClassAst {
  return { ...adaptClassDeclaration(file.classDecl), imports: file.imports.map(adaptImport) };
}

function adaptClassField(f: ClassFieldDeclaration): ClassFieldDecl {
  return { kind: 'class-field', visibility: f.visibility, name: f.name, type: f.type, defaultLiteral: f.defaultLiteral, span: { line: f.line } };
}

function adaptClassStreamField(f: ClassStreamFieldDeclaration): ClassStreamFieldDecl {
  return { kind: 'class-stream-field', visibility: f.visibility, name: f.name, type: f.type, span: { line: f.line } };
}

function adaptClassMethod(m: ClassMethodDeclaration): ClassMethodDecl {
  return {
    kind: 'class-method',
    isOverride: m.isOverride,
    visibility: m.visibility,
    name: m.name,
    params: m.parameters.map(adaptParam),
    returnType: m.returnType,
    block: m.block,
    span: { line: m.line },
  };
}

function adaptConstructorDeclaration(c: ConstructorDeclaration): ConstructorDecl {
  return { isOverride: c.isOverride, params: c.parameters.map(adaptParam), body: c.body, span: { line: c.line } };
}

/**
 * flash-parser's `TemplateElement`/`TemplateAttribute`/`TemplateNode` are structurally identical
 * to this package's — no transformation needed for the tree shape itself. What this adapts:
 * `<component>`'s own `extends`/`on:key[...]` attributes (not part of the recursive `TemplateNode`
 * tree at all — `<component>` is never itself classified as an ordinary element, see
 * `flash-parser`'s `classifyComponentElement`), and collapsing `<component>`'s 1..N real
 * top-level children into the single `root: TemplateElement` the rest of this pipeline expects —
 * either the sole child directly, or a synthetic never-emitted wrapper for 2+ (see
 * `ThrTemplateAst`'s own doc comment in `dsl-ast.ts`).
 */
export function adaptTemplateSection(template: TemplateSection): ThrTemplateAst {
  const children: TemplateNode[] = template.children;
  const root: TemplateElement =
    children.length === 1 && children[0].kind === 'element'
      ? children[0]
      : { kind: 'element', tagName: SYNTHETIC_MULTI_CHILD_TAG, id: null, attributes: [], children };
  return { root, extends: template.extends, onKeyAttributes: template.onKeyAttributes.map((b) => ({ keys: b.keys, expression: b.expression })) };
}

export function adaptThemeTemplateSection(section: ThemeTemplateSection): ThemeTemplateAst {
  return { members: section.members.map(adaptThemeMember), defaultVariantName: section.defaultVariantName };
}

export function adaptThemeVariantSection(section: ThemeVariantSection): ThemeVariantAst {
  return { variantName: section.variantName, members: section.members.map(adaptThemeMember) };
}

function adaptThemeMember(member: ThemeMember): ThemeMemberDecl {
  if (member instanceof ThemeGroupDeclaration) {
    return { kind: 'theme-group', name: member.name, members: member.members.map(adaptThemeMember), span: { line: member.line } };
  }
  return {
    kind: 'theme-leaf',
    name: member.name,
    // flash-parser already validated this against the allowed field types during parsing.
    type: member.type as FieldType,
    defaultLiteral: member.defaultLiteral,
    span: { line: member.line },
  };
}

function adaptField(f: FieldDeclaration | ScaleFieldDeclaration, scale: boolean) {
  return {
    kind: 'field' as const,
    name: f.name,
    // flash-parser already validated this against the allowed field types during parsing.
    type: f.type as FieldType,
    defaultLiteral: f.defaultLiteral,
    scale,
    span: { line: f.line },
  };
}

function adaptDerived(d: DerivedDeclaration | ScaleDerivedDeclaration, scale: boolean): DerivedDecl {
  return { kind: 'derived', name: d.name, type: d.type, expression: d.expression, scale, span: { line: d.line } };
}

function adaptState(s: StateDeclaration | ScaleStateDeclaration, scale: boolean): StateDecl {
  return { kind: 'state', name: s.name, type: s.type, defaultLiteral: s.defaultLiteral, scale, span: { line: s.line } };
}

function adaptRead(r: ReadDeclaration | ScaleReadDeclaration, scale: boolean): ReadDecl {
  return { kind: 'read', name: r.name, path: r.path.segments, scale, span: { line: r.line } };
}

function adaptWatch(d: WatchDeclaration | ScaleWatchDeclaration, scale: boolean): WatchDecl {
  return { kind: 'watch', name: d.name, path: d.path.segments, scale, span: { line: d.line } };
}

function adaptStream(s: StreamDeclaration): StreamDecl {
  return { kind: 'stream', name: s.name, type: s.type, span: { line: s.line } };
}

/** `.config` (not `.configRegion.text`) — deliberately keeps the config literal's own `{`/`}` delimiters, unlike `adaptDerived`'s bare `.expression`, since `analysis/request-config.ts` parses the whole span as one AA-literal expression. */
function adaptRequest(r: RequestDeclaration): RequestDecl {
  return { kind: 'request', requestKind: r.kind, configText: r.config, span: { line: r.line } };
}

/** Same "keep the config's own `{`/`}` delimiters" convention as `adaptRequest` — `analysis/animation-config.ts` parses the whole span as one AA-literal expression. */
function adaptAnimation(a: AnimationDeclaration): AnimationDecl {
  return { kind: 'animation', name: a.name, configText: a.config, span: { line: a.line } };
}

function adaptFunction(f: FunctionDeclaration): FunctionDecl {
  return {
    kind: 'function',
    visibility: f.visibility,
    name: f.name,
    params: f.parameters.map(adaptParam),
    returnType: f.returnType,
    body: f.bodyText,
    block: f.block,
    span: { line: f.line },
  };
}

function adaptParam(p: { name: string; type: string }): FunctionParam {
  return { name: p.name, type: p.type };
}
