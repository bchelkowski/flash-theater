/**
 * Typed AST layer over the raw CST — mirrors kopytko-brightscript-parser's
 * `wrapNode`/`AstNode` pattern. Each class is a thin, lazily-evaluated view
 * over a `SyntaxNode`; nothing here is stored redundantly, it's all
 * computed from `node.children` on access.
 */
import { XmlDocument } from './xml/xml-ast.js';
import { SyntaxKind } from './syntaxKind.js';
import { isNode, SyntaxNode } from './syntaxNode.js';
import { TokenKind } from './tokenKind.js';
import { TemplateNode } from './templateModel.js';
import { classifyComponentElement, ComponentOnKeyBinding } from './template-classify.js';
import { parseEmbeddedCallArgs, splitEmbeddedCallArgs } from './embedded.js';
import { rawBlockCodeText, stripLeadingRawEndMarker } from './raw-block.js';

export abstract class AstNode {
  constructor(public readonly node: SyntaxNode) {}

  /** 0-based line number this node starts on, in the outer `.thr` source. */
  get line(): number {
    return this.node.line;
  }

  getText(): string {
    return this.node.getText();
  }
}

class GenericAstNode extends AstNode {}

/** Every byte between a Block's `{`/`}` tokens, raw (not trimmed) — matches what the compiler's `FunctionDecl.body` has always stored. */
function blockInnerText(block: SyntaxNode): string {
  let out = '';
  for (const child of block.children.slice(1, -1)) {
    out += isNode(child) ? child.getText() : childTokenText(child);
  }
  return out;
}

function childTokenText(token: { text: string; leadingTrivia: readonly { text: string }[] }): string {
  let out = '';
  for (const t of token.leadingTrivia) out += t.text;
  out += token.text;
  return out;
}

/** What kind of `.thr` file this is, discriminated by its root tag — see parser.ts's root-tag dispatch. */
export type ThrFileKind = 'component' | 'theme-template' | 'theme-variant';

export class ThrFile extends AstNode {
  /** Discriminated by which root-tag section is actually present — throws if the parse failed before any section was produced (check diagnostics first). */
  get kind(): ThrFileKind {
    if (this.node.findChild(SyntaxKind.ScriptSection)) return 'component';
    if (this.node.findChild(SyntaxKind.ThemeTemplateSection)) return 'theme-template';
    if (this.node.findChild(SyntaxKind.ThemeVariantSection)) return 'theme-variant';
    throw new Error('internal: ThrFile has no recognized section — check diagnostics before accessing .kind');
  }

  get script(): ScriptSection {
    return new ScriptSection(this.node.findChild(SyntaxKind.ScriptSection)!);
  }

  get themeTemplate(): ThemeTemplateSection {
    return new ThemeTemplateSection(this.node.findChild(SyntaxKind.ThemeTemplateSection)!);
  }

  get themeVariant(): ThemeVariantSection {
    return new ThemeVariantSection(this.node.findChild(SyntaxKind.ThemeVariantSection)!);
  }

  get template(): TemplateSection | null {
    const section = this.node.findChild(SyntaxKind.TemplateSection);
    return section ? new TemplateSection(section) : null;
  }
}

/** `import <ClassName> from "<path>"` — valid in a `.thr` `<script>` section and in a `.flsh` file. `<path>` resolves relative to the importing file's own directory (resolution itself happens in the compiler's `app-compiler.ts`, not here — flash-parser only exposes the raw grammar). */
export class ImportDeclaration extends AstNode {
  get className(): string {
    return this.node.childTokens[1].text;
  }

  /** The quoted string-literal token's text, unquoted. */
  get path(): string {
    const raw = this.node.childTokens[3].text;
    return raw.length >= 2 ? raw.slice(1, -1) : raw;
  }
}

/** Shared `field`/`derived`/`state`/`read`/`watch`/`import`/function declaration getters for a `<script>` component's declarations. */
export abstract class DeclarationsSection extends AstNode {
  get imports(): ImportDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ImportDeclaration).map((n) => new ImportDeclaration(n));
  }

  get fields(): FieldDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.FieldDeclaration).map((n) => new FieldDeclaration(n));
  }

  /** `scale field ...` declarations — kept separate from `.fields` (a distinct `SyntaxKind`/AST class, index-shifted for the leading `scale` token); `packages/compiler`'s dsl-parser adapter merges both into one `FieldDecl[]` with a `scale` flag. */
  get scaleFields(): ScaleFieldDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ScaleFieldDeclaration).map((n) => new ScaleFieldDeclaration(n));
  }

  get derived(): DerivedDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.DerivedDeclaration).map((n) => new DerivedDeclaration(n));
  }

  /** `scale derived ...` declarations — see `.scaleFields`' own doc comment. */
  get scaleDerived(): ScaleDerivedDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ScaleDerivedDeclaration).map((n) => new ScaleDerivedDeclaration(n));
  }

  get state(): StateDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.StateDeclaration).map((n) => new StateDeclaration(n));
  }

  /** `scale state ...` declarations — see `.scaleFields`' own doc comment. */
  get scaleState(): ScaleStateDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ScaleStateDeclaration).map((n) => new ScaleStateDeclaration(n));
  }

  get reads(): ReadDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ReadDeclaration).map((n) => new ReadDeclaration(n));
  }

  /** `scale read ...` declarations — see `.scaleFields`' own doc comment. */
  get scaleReads(): ScaleReadDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ScaleReadDeclaration).map((n) => new ScaleReadDeclaration(n));
  }

  get watches(): WatchDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.WatchDeclaration).map((n) => new WatchDeclaration(n));
  }

  /** `scale watch ...` declarations — see `.scaleFields`' own doc comment. */
  get scaleWatches(): ScaleWatchDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ScaleWatchDeclaration).map((n) => new ScaleWatchDeclaration(n));
  }

  get streams(): StreamDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.StreamDeclaration).map((n) => new StreamDeclaration(n));
  }

  /**
   * Every `request {}` this file declares, in source order — flash-parser stays permissive about
   * "how many," same discipline as "at most one `<theme-template>`" not being enforced here either.
   * `packages/compiler` is the one that turns `.length > 1` into `request/multiple-request-declarations`.
   */
  get requests(): RequestDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.RequestDeclaration).map((n) => new RequestDeclaration(n));
  }

  /** The first (and, once validated downstream, only) `request {}` declaration — `null` when this component declares none. */
  get request(): RequestDeclaration | null {
    return this.requests[0] ?? null;
  }

  /** Every `animation {}` this file declares, in source order — any number allowed, unlike `request`. */
  get animations(): AnimationDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.AnimationDeclaration).map((n) => new AnimationDeclaration(n));
  }

  get functions(): FunctionDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.FunctionDeclaration).map((n) => new FunctionDeclaration(n));
  }

  /** Top-level `' flash-theater:raw` ... `' flash-theater:end-raw` blocks, in source order — see GRAMMAR.md's "Raw BrightScript passthrough" section. The compiler appends each one's text into the generated `init()`. */
  get rawBlocks(): RawBrightScriptStatement[] {
    return this.node.findAllChildren(SyntaxKind.RawBrightScriptRegion).map((n) => new RawBrightScriptStatement(n));
  }
}

export class ScriptSection extends DeclarationsSection {}

export type ThemeMember = ThemeGroupDeclaration | ThemeLeafDeclaration;

function wrapThemeMember(node: SyntaxNode): ThemeMember {
  return node.kind === SyntaxKind.ThemeGroupDeclaration ? new ThemeGroupDeclaration(node) : new ThemeLeafDeclaration(node);
}

function themeMembersOf(node: SyntaxNode): ThemeMember[] {
  return node.childNodes.filter((n) => n.kind === SyntaxKind.ThemeGroupDeclaration || n.kind === SyntaxKind.ThemeLeafDeclaration).map(wrapThemeMember);
}

/** A `<theme-template>` file's body — the canonical theme shape and defaults every variant is validated against. */
export class ThemeTemplateSection extends AstNode {
  get members(): ThemeMember[] {
    return themeMembersOf(this.node);
  }

  /** Parsed from the optional `default="name"` attribute on the opening `<theme-template>` tag — the compile-time tier of the initial-active-theme fallback chain. `null` when absent. */
  get defaultVariantName(): string | null {
    const openTokenText = this.node.parent?.childTokens[0]?.text ?? '';
    const match = /\bdefault\s*=\s*"([^"]*)"/.exec(openTokenText);
    return match ? match[1] : null;
  }
}

/** A `<theme name="...">` file's body — a partial override of the template; members it omits fall back to the template's default at that exact path. */
export class ThemeVariantSection extends AstNode {
  get members(): ThemeMember[] {
    return themeMembersOf(this.node);
  }

  /** Parsed from the required `name="..."` attribute on the opening `<theme ...>` tag. */
  get variantName(): string {
    const openTokenText = this.node.parent?.childTokens[0]?.text ?? '';
    const match = /\bname\s*=\s*"([^"]*)"/.exec(openTokenText);
    return match ? match[1] : '';
  }
}

/** `<name>: { <member>* }` inside a theme template/variant — unbounded nesting via `.members`. */
export class ThemeGroupDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[0].text;
  }

  get members(): ThemeMember[] {
    return themeMembersOf(this.node);
  }
}

/** `<name>: <Type> = <literal>` inside a theme template/variant — same token shape as `FieldDeclaration` minus the `field` keyword. */
export class ThemeLeafDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[0].text;
  }

  get type(): string {
    return this.node.childTokens[2].text;
  }

  get defaultLiteral(): string {
    return this.node.childTokens[4].text;
  }
}

/**
 * Reads a `field`/`state` declaration's default literal — a single scalar token at the fixed
 * `tokenIndex` (the pre-existing shape), OR, when the literal is an array/AA literal
 * (`expectFieldOrStateLiteral` in `token-stream-parser.ts` captured a balanced `[...]`/`{...}` span
 * as a nested `ExpressionRegion` child instead of a plain token), that region's own lossless
 * `.text` — mirrors `DerivedDeclaration.expressionRegion`'s `findChild(SyntaxKind.ExpressionRegion)`
 * lookup exactly, so this stays correct regardless of where the region sits among a scale-prefixed
 * declaration's shifted child indices. Purely additive: the fixed-index fallback is untouched, so
 * every existing scalar-literal declaration (and `ThemeLeafDeclaration`/`ClassFieldDeclaration`,
 * which never produce this region at all) keeps reading exactly as before.
 */
function readFieldOrStateDefaultLiteral(node: SyntaxNode, tokenIndex: number): string {
  const region = node.findChild(SyntaxKind.ExpressionRegion);
  if (region) return new ExpressionRegion(region).text;
  return node.childTokens[tokenIndex].text;
}

export class FieldDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[1].text;
  }

  get type(): string {
    return this.node.childTokens[3].text;
  }

  get defaultLiteral(): string {
    return readFieldOrStateDefaultLiteral(this.node, 5);
  }
}

/** `state <name>: <Type> = <literal>` — same token shape as `FieldDeclaration`, kept as its own AST class (rather than reusing `FieldDeclaration`) since `state` and `field` mean different things to every downstream consumer (no XML interface entry, no SceneGraph onChange). */
export class StateDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[1].text;
  }

  get type(): string {
    return this.node.childTokens[3].text;
  }

  get defaultLiteral(): string {
    return readFieldOrStateDefaultLiteral(this.node, 5);
  }
}

export class DerivedDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[1].text;
  }

  /** Unrestricted identifier, like `state`'s and a function's param/return types — `derived` never becomes an XML `<field>`, so it isn't bound by SceneGraph's small set of field types. */
  get type(): string {
    return this.node.childTokens[3].text;
  }

  get expressionRegion(): ExpressionRegion {
    return new ExpressionRegion(this.node.findChild(SyntaxKind.ExpressionRegion)!);
  }

  get expression(): string {
    return this.expressionRegion.text;
  }
}

/** `stream <name>: <Type>` — no expression/defaultLiteral, unlike every other declaration here: a stream's runtime value is always a fresh `ft_createStream()` AA (codegen/brs-emitter.ts), never DSL-authored. */
export class StreamDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[1].text;
  }

  /** Unrestricted identifier, like `derived`'s — a stream never becomes an XML `<field>`. */
  get type(): string {
    return this.node.childTokens[3].text;
  }
}

/**
 * `request <Kind> { ... }` — declares this component as a single HTTP/Channel Store
 * request/endpoint. Unlike `DerivedDeclaration`'s `.expression` (a bare BrightScript expression),
 * `.config`'s text still includes its own `{`/`}` delimiters, since it's meant to be interpreted
 * whole as one AA-literal expression by `packages/compiler`'s `analysis/request-config.ts`, not
 * spliced into a larger printed statement the way a `derived`/`state` RHS is.
 */
export class RequestDeclaration extends AstNode {
  /** The request `Kind` discriminator — a plain identifier token, unvalidated at this layer (validated downstream in `packages/compiler`). */
  get kind(): string {
    return this.node.childTokens[1].text;
  }

  get configRegion(): ExpressionRegion {
    return new ExpressionRegion(this.node.findChild(SyntaxKind.ExpressionRegion)!);
  }

  get config(): string {
    return this.configRegion.text;
  }
}

/**
 * `animation <name> { ... }` — declares a named, reusable Roku Animation/composition. Same
 * `.config`-includes-its-own-braces shape as `RequestDeclaration`, since it's meant to be
 * interpreted whole as one AA-literal expression by `packages/compiler`'s
 * `analysis/animation-config.ts`. Unlike `RequestDeclaration.kind`, `.name` is a real identifier
 * referenced elsewhere in the file (trigger sugar, `transition:`/`in:`/`out:` attributes), not an
 * enum-like discriminator.
 */
export class AnimationDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[1].text;
  }

  get configRegion(): ExpressionRegion {
    return new ExpressionRegion(this.node.findChild(SyntaxKind.ExpressionRegion)!);
  }

  get config(): string {
    return this.configRegion.text;
  }
}

export interface ParameterInfo {
  readonly name: string;
  readonly type: string;
}

export type FunctionVisibility = 'private' | 'public';

export class FunctionDeclaration extends AstNode {
  get visibility(): FunctionVisibility {
    return this.node.childTokens[0].text as FunctionVisibility;
  }

  get name(): string {
    return this.node.childTokens[2].text;
  }

  /** `null` when the function omits its return-type clause entirely (compiles to a BrightScript `sub`, not `function ... as <Type>` — see codegen/brs-emitter.ts). Found by scanning this node's own direct child tokens for `Colon` rather than a fixed index, since the clause is optional; `childTokens` only ever holds this declaration's own tokens (visibility/function/name/[colon/returnType]), never a nested `Parameter`'s colon — those live under the `ParameterList` child node, not as direct tokens here. */
  get returnType(): string | null {
    const colon = this.node.findToken(TokenKind.Colon);
    if (!colon) return null;
    const idx = this.node.childTokens.indexOf(colon);
    return this.node.childTokens[idx + 1].text;
  }

  get parameters(): ParameterInfo[] {
    const list = this.node.findChild(SyntaxKind.ParameterList)!;
    return list.findAllChildren(SyntaxKind.Parameter).map((p) => ({ name: p.childTokens[0].text, type: p.childTokens[2].text }));
  }

  get block(): Block {
    return new Block(this.node.findChild(SyntaxKind.Block)!);
  }

  /** Raw body text between `{`/`}`, exactly as authored (JS-shaped `if`, not yet rewritten to BrightScript) — matches the compiler's legacy `FunctionDecl.body` field. */
  get bodyText(): string {
    return blockInnerText(this.node.findChild(SyntaxKind.Block)!);
  }
}

export class Block extends AstNode {
  /** Direct statement children, in source order — each a structurally-parsed `if`/`for`/`for each`/`while`/`try`, a structurally-parsed `state`/`store`/`focus`/ternary-bearing-assignment/anonymous-function-assignment statement, or an opaque BrightScript passthrough chunk. */
  get statements(): (
    | IfStatement
    | ForStatement
    | ForEachStatement
    | WhileStatement
    | TryStatement
    | StateAssignment
    | StoreWriteStatement
    | FocusStatement
    | JumpFocusStatement
    | TernaryAssignmentStatement
    | AnonymousFunctionAssignmentStatement
    | ScaleLocalAssignmentStatement
    | ScaleStateAssignmentStatement
    | RawBrightScriptStatement
    | StatementRegion
  )[] {
    return this.node.children
      .slice(1, -1)
      .filter(isNode)
      .map((n) => {
        if (n.kind === SyntaxKind.IfStatement) return new IfStatement(n);
        if (n.kind === SyntaxKind.ForStatement) return new ForStatement(n);
        if (n.kind === SyntaxKind.ForEachStatement) return new ForEachStatement(n);
        if (n.kind === SyntaxKind.WhileStatement) return new WhileStatement(n);
        if (n.kind === SyntaxKind.TryStatement) return new TryStatement(n);
        if (n.kind === SyntaxKind.StateAssignment) return new StateAssignment(n);
        if (n.kind === SyntaxKind.StoreWriteStatement) return new StoreWriteStatement(n);
        if (n.kind === SyntaxKind.FocusStatement) return new FocusStatement(n);
        if (n.kind === SyntaxKind.JumpFocusStatement) return new JumpFocusStatement(n);
        if (n.kind === SyntaxKind.TernaryAssignmentStatement) return new TernaryAssignmentStatement(n);
        if (n.kind === SyntaxKind.AnonymousFunctionAssignmentStatement) return new AnonymousFunctionAssignmentStatement(n);
        if (n.kind === SyntaxKind.ScaleLocalAssignmentStatement) return new ScaleLocalAssignmentStatement(n);
        if (n.kind === SyntaxKind.ScaleStateAssignmentStatement) return new ScaleStateAssignmentStatement(n);
        if (n.kind === SyntaxKind.RawBrightScriptRegion) return new RawBrightScriptStatement(n);
        return new StatementRegion(n);
      });
  }
}

export class IfStatement extends AstNode {
  get condition(): ExpressionRegion {
    return new ExpressionRegion(this.node.findChild(SyntaxKind.ExpressionRegion)!);
  }

  get thenBlock(): Block | null {
    const block = this.node.findChild(SyntaxKind.Block);
    return block ? new Block(block) : null;
  }

  /** The inline form's single statement (`if (x) stmt`) — null when this if uses a `{ }` block instead. */
  get thenStatement(): StatementRegion | null {
    if (this.thenBlock) return null;
    const region = this.node.findChild(SyntaxKind.StatementRegion);
    return region ? new StatementRegion(region) : null;
  }

  /** This if's `else` continuation (`else { }`, `else if (...)`, or inline `else stmt`) — null if there's no else at all. */
  get elseClause(): ElseClause | null {
    const clause = this.node.findChild(SyntaxKind.ElseClause);
    return clause ? new ElseClause(clause) : null;
  }
}

/**
 * An `if`'s `else` continuation. Exactly one of `block`/`elseIf`/`statement`
 * is non-null, mirroring `IfStatement.thenBlock`/`thenStatement`: `block` for
 * `else { }`, `elseIf` for a chained `else if (...)` (itself a nested
 * `IfStatement`, which may have its own further `elseClause`), `statement`
 * for the inline form `else <stmt>`.
 */
export class ElseClause extends AstNode {
  get block(): Block | null {
    const block = this.node.findChild(SyntaxKind.Block);
    return block ? new Block(block) : null;
  }

  get elseIf(): IfStatement | null {
    const nested = this.node.findChild(SyntaxKind.IfStatement);
    return nested ? new IfStatement(nested) : null;
  }

  /** The inline form's single statement (`else stmt`) — null when this else uses a `{ }` block or is an `else if` instead. */
  get statement(): StatementRegion | null {
    if (this.block || this.elseIf) return null;
    const region = this.node.findChild(SyntaxKind.StatementRegion);
    return region ? new StatementRegion(region) : null;
  }
}

/** `for (<var> = <start> to <end> [step <step>]) { }` — the loop variable is a raw identifier token (a declaration site, never rewritten); `startExpr`/`endExpr`/`stepExpr` are each an independent `ExpressionRegion` (found by position among this node's own `ExpressionRegion` children, not a fixed token index) so identifier-rewriting can reparse each one as a genuine standalone BrightScript expression — the whole `<var> = <start> to <end>` header is not itself a valid standalone expression. */
export class ForStatement extends AstNode {
  get loopVariable(): string {
    return this.node.childTokens[2].text;
  }

  get startExpr(): ExpressionRegion {
    return new ExpressionRegion(this.node.findAllChildren(SyntaxKind.ExpressionRegion)[0]);
  }

  get endExpr(): ExpressionRegion {
    return new ExpressionRegion(this.node.findAllChildren(SyntaxKind.ExpressionRegion)[1]);
  }

  /** `null` when this `for` has no `step` clause. */
  get stepExpr(): ExpressionRegion | null {
    const regions = this.node.findAllChildren(SyntaxKind.ExpressionRegion);
    return regions.length > 2 ? new ExpressionRegion(regions[2]) : null;
  }

  get body(): Block {
    return new Block(this.node.findChild(SyntaxKind.Block)!);
  }
}

/** `for each (<item> in <collection>) { }` — `itemVariable` is a raw identifier token (a declaration site, never rewritten); `collectionExpr` is a genuine standalone BrightScript expression. */
export class ForEachStatement extends AstNode {
  get itemVariable(): string {
    return this.node.childTokens[3].text;
  }

  get collectionExpr(): ExpressionRegion {
    return new ExpressionRegion(this.node.findChild(SyntaxKind.ExpressionRegion)!);
  }

  get body(): Block {
    return new Block(this.node.findChild(SyntaxKind.Block)!);
  }
}

/** `while (<condition>) { }` — same `condition`/`body` shape as `IfStatement`'s single-condition half, no inline (braceless) form. */
export class WhileStatement extends AstNode {
  get condition(): ExpressionRegion {
    return new ExpressionRegion(this.node.findChild(SyntaxKind.ExpressionRegion)!);
  }

  get body(): Block {
    return new Block(this.node.findChild(SyntaxKind.Block)!);
  }
}

/** A `TryStatement`'s mandatory `catch (<name>) { }` — `variableName` is a raw identifier token (a declaration site, never rewritten). */
export class CatchClause extends AstNode {
  get variableName(): string {
    return this.node.childTokens[2].text;
  }

  get body(): Block {
    return new Block(this.node.findChild(SyntaxKind.Block)!);
  }
}

/** `try { } catch (<name>) { } ` — always has exactly one `catchClause`; this DSL has no catch-less `try`, no `finally`. */
export class TryStatement extends AstNode {
  get tryBlock(): Block {
    return new Block(this.node.findChild(SyntaxKind.Block)!);
  }

  get catchClause(): CatchClause {
    return new CatchClause(this.node.findChild(SyntaxKind.CatchClause)!);
  }
}

/**
 * `function (<param>: <Type>, ...) [: <Type>] { <Block> }` used as a value —
 * this DSL's own `: Type` return-type convention (same as a named `private
 * function`/`public function`, GRAMMAR.md), never BrightScript's `as Type`.
 * The author always spells `function`, never `sub` — "no return type → sub"
 * is a codegen decision here exactly like it already is for named functions.
 */
export class AnonymousFunctionExpression extends AstNode {
  get parameters(): ParameterInfo[] {
    const list = this.node.findChild(SyntaxKind.ParameterList)!;
    return list.findAllChildren(SyntaxKind.Parameter).map((p) => ({ name: p.childTokens[0].text, type: p.childTokens[2].text }));
  }

  /** `null` when this anonymous function omits its return-type clause entirely (compiles to a BrightScript `sub`) — same convention as `FunctionDeclaration.returnType`. */
  get returnType(): string | null {
    const colon = this.node.findToken(TokenKind.Colon);
    if (!colon) return null;
    const idx = this.node.childTokens.indexOf(colon);
    return this.node.childTokens[idx + 1].text;
  }

  get block(): Block {
    return new Block(this.node.findChild(SyntaxKind.Block)!);
  }
}

/** `<target> = function (...) { }` — a plain bare assignment whose whole right-hand side is an anonymous function expression (Tier 1 scope: the RHS must be exactly the function literal, not a larger expression containing one — see GRAMMAR.md). `target` is always a real local declaration, mirroring `TernaryAssignmentStatement`'s own "a bare assignment to a name is always a new local" rule. */
export class AnonymousFunctionAssignmentStatement extends AstNode {
  get target(): string {
    return this.node.childTokens[0].text;
  }

  get value(): AnonymousFunctionExpression {
    return new AnonymousFunctionExpression(this.node.findChild(SyntaxKind.AnonymousFunctionExpression)!);
  }
}

/** `state <name> = <expr>` — a function-body statement writing to a declared `state`. Same shape as `DerivedDeclaration` (name + expression), but a statement rather than a script-level declaration. */
export class StateAssignment extends AstNode {
  get name(): string {
    return this.node.childTokens[1].text;
  }

  /** The right-hand side — an opaque `ExpressionRegion`, an anonymous function expression (Tier 1: the whole RHS, never mixed with a ternary), or (when the RHS contains a ternary anywhere) a `TernaryExpression`/`TernaryOperand`. Callers must branch on its kind before deciding how to print it — see `codegen/brs-emitter.ts`'s `printStateAssignment`. */
  get rhs(): ExpressionRegion | TernaryExpression | TernaryOperand | AnonymousFunctionExpression {
    const node = this.node.childNodes[0];
    if (node.kind === SyntaxKind.AnonymousFunctionExpression) return new AnonymousFunctionExpression(node);
    return wrapTernaryChild(node);
  }

  /** Only valid when `.rhs` is a plain `ExpressionRegion` (no ternary in the RHS) — throws otherwise. A ternary-bearing state write must go through `.rhs` instead. */
  get expressionRegion(): ExpressionRegion {
    const rhs = this.rhs;
    if (!(rhs instanceof ExpressionRegion)) throw new Error('internal: StateAssignment.expressionRegion called on a ternary-bearing right-hand side — use .rhs instead');
    return rhs;
  }

  get expression(): string {
    return this.expressionRegion.text;
  }
}

/**
 * `scale <name> = <expr>` — a function-body local-variable assignment whose value is scaled at
 * runtime by the app's configured design-resolution factor. Same `.rhs` shape/logic as
 * `StateAssignment` (see its own doc comment), just retargeted at a local instead of a `state`.
 */
export class ScaleLocalAssignmentStatement extends AstNode {
  get target(): string {
    return this.node.childTokens[1].text;
  }

  get rhs(): ExpressionRegion | TernaryExpression | TernaryOperand | AnonymousFunctionExpression {
    const node = this.node.childNodes[0];
    if (node.kind === SyntaxKind.AnonymousFunctionExpression) return new AnonymousFunctionExpression(node);
    return wrapTernaryChild(node);
  }
}

/**
 * `scale state <name> = <expr>` — the function-body write form of a declared `state`, scaled at
 * runtime. Token indices shift by one vs. `StateAssignment` since `state` sits after the leading
 * `scale` token: `[scale(0), state(1), name(2), equals(3), rhs(4)]`.
 */
export class ScaleStateAssignmentStatement extends AstNode {
  get name(): string {
    return this.node.childTokens[2].text;
  }

  get rhs(): ExpressionRegion | TernaryExpression | TernaryOperand | AnonymousFunctionExpression {
    const node = this.node.childNodes[0];
    if (node.kind === SyntaxKind.AnonymousFunctionExpression) return new AnonymousFunctionExpression(node);
    return wrapTernaryChild(node);
  }
}

/**
 * `<condition> ? <whenTrue> : <whenFalse>` — DSL-only syntax (BrightScript has no ternary
 * operator), structurally parsed by `ternary.ts` and lowered by the compiler into a hoisted
 * `if`/`else` block (see GRAMMAR.md/findings/operators-ternary.md). Each of
 * `.condition`/`.whenTrue`/`.whenFalse` may itself be a nested ternary (chained in the false branch,
 * or nested in the true branch, unparenthesized either way) or an ordinary opaque expression.
 */
export class TernaryExpression extends AstNode {
  get condition(): ExpressionRegion | TernaryExpression | TernaryOperand {
    return wrapTernaryChild(this.node.childNodes[0]);
  }

  get whenTrue(): ExpressionRegion | TernaryExpression | TernaryOperand {
    return wrapTernaryChild(this.node.childNodes[1]);
  }

  get whenFalse(): ExpressionRegion | TernaryExpression | TernaryOperand {
    return wrapTernaryChild(this.node.childNodes[2]);
  }
}

/**
 * The "opaque template with embedded ternary holes" shape — a ternary nested somewhere inside a
 * larger expression (`1 + (cond ? a : b)`) rather than being the expression's own outermost form.
 * `.segments` interleaves raw text runs (including any ternary-free bracketed sub-span, kept
 * completely untouched) with nested ternary sub-expressions, in source order — reassembling them
 * (substituting each nested ternary's own lowered temp-var name in its place) and rewriting the
 * result once is codegen's job (`brs-emitter.ts`'s `lowerTernaryRhs`), not something resolved here.
 * Deliberately carries no eager `kopytko-brightscript-parser` parse of its own combined text the
 * way `ExpressionRegion` does — that text still contains `?`/`:`, not valid BrightScript on its own.
 */
export class TernaryOperand extends AstNode {
  get segments(): (string | TernaryExpression | TernaryOperand)[] {
    const result: (string | TernaryExpression | TernaryOperand)[] = [];
    let rawBuffer = '';

    for (const child of this.node.children) {
      if (isNode(child) && (child.kind === SyntaxKind.TernaryExpression || child.kind === SyntaxKind.TernaryOperand)) {
        if (rawBuffer.length > 0) {
          result.push(rawBuffer);
          rawBuffer = '';
        }
        result.push(child.kind === SyntaxKind.TernaryExpression ? new TernaryExpression(child) : new TernaryOperand(child));
      } else {
        rawBuffer += isNode(child) ? child.getText() : childTokenText(child);
      }
    }
    if (rawBuffer.length > 0) result.push(rawBuffer);

    // The first/last token's own leading trivia (e.g. the space right after the "=" this operand's
    // whole span starts from, or right after a "?"/":") is otherwise preserved verbatim — matching
    // `ExpressionRegion.text`/`StatementRegion.text`'s own boundary-trim convention (both `.trim()`
    // their whole text) is what keeps codegen's reassembled text from picking up a stray leading/
    // trailing space; only the outermost boundary is touched, never whitespace between segments.
    if (result.length > 0 && typeof result[0] === 'string') result[0] = (result[0] as string).trimStart();
    const lastIndex = result.length - 1;
    if (lastIndex >= 0 && typeof result[lastIndex] === 'string') result[lastIndex] = (result[lastIndex] as string).trimEnd();

    return result;
  }
}

/** `<target> = <expr>` in a function body where `<expr>` contains a ternary somewhere — a ternary-free plain assignment stays an ordinary opaque `StatementRegion`, never this node (see ternary.ts). */
export class TernaryAssignmentStatement extends AstNode {
  get target(): string {
    return this.node.childTokens[0].text;
  }

  get rhs(): ExpressionRegion | TernaryExpression | TernaryOperand {
    return wrapTernaryChild(this.node.childNodes[0]);
  }
}

function wrapTernaryChild(node: SyntaxNode): ExpressionRegion | TernaryExpression | TernaryOperand {
  if (node.kind === SyntaxKind.TernaryExpression) return new TernaryExpression(node);
  if (node.kind === SyntaxKind.TernaryOperand) return new TernaryOperand(node);
  return new ExpressionRegion(node);
}

/**
 * Reconstructs a ternary tree back into a single, syntactically-valid-as-BrightScript string —
 * NEVER emitted, analysis only. Every real leaf `ExpressionRegion`'s text is kept byte-for-byte
 * (including any ternary-free raw text inside a `TernaryOperand`, so a real local/field/global
 * reference sitting next to a ternary hole is never lost); every ternary hole becomes a synthetic
 * `ft_ternary_scope(<condition>, <whenTrue>, <whenFalse>)` call, recursively, so a real reference
 * nested inside the ternary itself survives too. Used by anything that needs to scan every real
 * identifier/access reference in a possibly ternary-bearing expression without understanding
 * ternary syntax itself — real BrightScript local-scope reconstruction
 * (`packages/compiler/src/analysis/scope-resolution.ts`), and best-effort text scanning for a
 * reserved name or a `theme.`/`router.`-rooted access (`analysis/focus-state.ts`, `compile.ts`).
 * Works uniformly on a plain `ExpressionRegion` too (returns its `.text` unchanged), so callers
 * never need to branch on `.rhs`'s kind before calling this.
 */
export function reconstructTernaryText(node: ExpressionRegion | TernaryExpression | TernaryOperand): string {
  if (node instanceof ExpressionRegion) return node.text;
  if (node instanceof TernaryExpression) {
    return `ft_ternary_scope(${reconstructTernaryText(node.condition)}, ${reconstructTernaryText(node.whenTrue)}, ${reconstructTernaryText(node.whenFalse)})`;
  }
  return node.segments.map((segment) => (typeof segment === 'string' ? segment : reconstructTernaryText(segment))).join('');
}

/** A dotted identifier chain inside `store(<path>)` — e.g. `some.value`. Segment 1 (`.topLevelKey`) is the store's top-level key; the rest is unchecked dynamic dot-access, since the store is schemaless from the compiler's point of view (see GRAMMAR.md's "Global store" section). */
export class StorePathExpression extends AstNode {
  get segments(): string[] {
    return this.node.findAllTokens(TokenKind.Identifier).map((t) => t.text);
  }

  get topLevelKey(): string {
    return this.segments[0];
  }

  get text(): string {
    return this.node.getText().trim();
  }
}

/** `read <name> = store(<path>)` — a one-time, non-reactive snapshot of a store value, evaluated once in `init()` and never recomputed. */
export class ReadDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[1].text;
  }

  get path(): StorePathExpression {
    return new StorePathExpression(this.node.findChild(SyntaxKind.StorePathExpression)!);
  }
}

/** `watch <name> = store(<path>)` — a reactive store binding, recomputed whenever the store's top-level key (`path.topLevelKey`) changes. Same shape as `ReadDeclaration`. */
export class WatchDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[1].text;
  }

  get path(): StorePathExpression {
    return new StorePathExpression(this.node.findChild(SyntaxKind.StorePathExpression)!);
  }
}

/** `scale field <name>: <Type> = <literal>` — same shape as `FieldDeclaration`, index-shifted by 1 for the leading `scale` token. */
export class ScaleFieldDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[2].text;
  }

  get type(): string {
    return this.node.childTokens[4].text;
  }

  get defaultLiteral(): string {
    return readFieldOrStateDefaultLiteral(this.node, 6);
  }
}

/** `scale state <name>: <Type> = <literal>` — same shape as `StateDeclaration`, index-shifted by 1. */
export class ScaleStateDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[2].text;
  }

  get type(): string {
    return this.node.childTokens[4].text;
  }

  get defaultLiteral(): string {
    return readFieldOrStateDefaultLiteral(this.node, 6);
  }
}

/** `scale derived <name>: <Type> = <expression>` — same shape as `DerivedDeclaration`, index-shifted by 1. */
export class ScaleDerivedDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[2].text;
  }

  get type(): string {
    return this.node.childTokens[4].text;
  }

  get expressionRegion(): ExpressionRegion {
    return new ExpressionRegion(this.node.findChild(SyntaxKind.ExpressionRegion)!);
  }

  get expression(): string {
    return this.expressionRegion.text;
  }
}

/** `scale read <name> = store(<path>)` — same shape as `ReadDeclaration`, index-shifted by 1. */
export class ScaleReadDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[2].text;
  }

  get path(): StorePathExpression {
    return new StorePathExpression(this.node.findChild(SyntaxKind.StorePathExpression)!);
  }
}

/** `scale watch <name> = store(<path>)` — same shape as `WatchDeclaration`, index-shifted by 1. */
export class ScaleWatchDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[2].text;
  }

  get path(): StorePathExpression {
    return new StorePathExpression(this.node.findChild(SyntaxKind.StorePathExpression)!);
  }
}

/** `store(<topLevelKey>) = <expr>` — a function-body statement writing the store. `path` always has exactly one segment (a multi-segment target is a parse-time error, `statement/store-nested-write` — see parser.ts). */
export class StoreWriteStatement extends AstNode {
  get path(): StorePathExpression {
    return new StorePathExpression(this.node.findChild(SyntaxKind.StorePathExpression)!);
  }

  get topLevelKey(): string {
    return this.path.topLevelKey;
  }

  get expressionRegion(): ExpressionRegion {
    return new ExpressionRegion(this.node.findChild(SyntaxKind.ExpressionRegion)!);
  }

  get expression(): string {
    return this.expressionRegion.text;
  }
}

/** `focus(<expr>)` — a function-body statement transferring real focus into another component. Unlike `store(...)`'s write form, the argument is a single arbitrary expression (a string id, a node reference, ...), not a restricted dot-free key. */
export class FocusStatement extends AstNode {
  get expressionRegion(): ExpressionRegion {
    return new ExpressionRegion(this.node.findChild(SyntaxKind.ExpressionRegion)!);
  }

  get expression(): string {
    return this.expressionRegion.text;
  }
}

/**
 * `jumpFocus(<direction>, <count>, <press>)` — a function-body statement jumping real focus
 * several registered candidates at once in one geometric direction (RowList-style), the
 * reserved-keyword counterpart to the automatic single-step LRUD `navigate()` fallthrough. Unlike
 * `focus(<expr>)`'s single argument, this captures three independent expressions (in source
 * order, the parser's own three `ExpressionRegion` children) — `direction` reuses the same
 * `"up"/"down"/"left"/"right"` vocabulary the LRUD fallthrough already knows, `count` is how many
 * candidates to hop, and `press` must be the caller's own `on:key`-injected `press` value,
 * forwarded through unconditionally (never guarded by the caller's own `if (press)`), since the
 * compiled form uses it to decide "jump and arm hold-to-repeat" vs. "release, stop repeat" — see
 * GRAMMAR.md's "Focus system" section.
 */
export class JumpFocusStatement extends AstNode {
  private get expressionRegions(): ExpressionRegion[] {
    return this.node.children.filter(isNode).filter((n) => n.kind === SyntaxKind.ExpressionRegion).map((n) => new ExpressionRegion(n));
  }

  get directionExpressionRegion(): ExpressionRegion {
    return this.expressionRegions[0];
  }

  get countExpressionRegion(): ExpressionRegion {
    return this.expressionRegions[1];
  }

  get pressExpressionRegion(): ExpressionRegion {
    return this.expressionRegions[2];
  }

  get directionExpression(): string {
    return this.directionExpressionRegion.text;
  }

  get countExpression(): string {
    return this.countExpressionRegion.text;
  }

  get pressExpression(): string {
    return this.pressExpressionRegion.text;
  }
}

/** A raw span of embedded BrightScript expression text — a `derived` RHS or an `if` condition. */
export class ExpressionRegion extends AstNode {
  get text(): string {
    return this.node.getText().trim();
  }
}

/**
 * A raw span of embedded BrightScript statement text — function-body content that isn't a DSL `if`.
 * A single trailing `;` is stripped, matching BrightScript's own statement style (never required in
 * this DSL). A leading `' flash-theater:end-raw` marker is also stripped when this region
 * immediately follows a raw block — see `stripLeadingRawEndMarker`'s own doc comment for why.
 */
export class StatementRegion extends AstNode {
  get text(): string {
    const trimmed = stripLeadingRawEndMarker(this.node).trim();
    return trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed;
  }
}

/**
 * `' flash-theater:raw` ... `' flash-theater:end-raw` — BrightScript copied byte-for-byte into
 * generated `.brs`, never identifier-rewritten. Valid as a function/method/constructor-body
 * statement (`Block.statements`/`ConstructorBody.statements`) or as a `<script>`-level declaration
 * (`DeclarationsSection.rawBlocks`, `.thr` only — see GRAMMAR.md). `.text` strips only the leading
 * marker comment line (`raw-block.ts`'s `rawBlockCodeText`) — everything else is untouched, exactly
 * as authored; the compiler's own printer re-adds both marker comments around whatever it emits.
 */
export class RawBrightScriptStatement extends AstNode {
  get text(): string {
    return rawBlockCodeText(this.node);
  }
}

/** The classified shape of the mandatory `<component extends="..." on:key[...]="...">` tag wrapping every `.thr` file's markup — see `template-classify.ts`'s `classifyComponentElement`. */
export class TemplateSection extends AstNode {
  private classify() {
    const embedded = this.node.embedded;
    if (!embedded || embedded.kind !== 'xml') {
      throw new Error('internal: TemplateSection is missing its embedded XML parse');
    }
    const xmlRoot = new XmlDocument(embedded.result.root).root;
    if (!xmlRoot) throw new Error('internal: template has no root element');
    return classifyComponentElement(xmlRoot, 0, []);
  }

  /** From `<component extends="...">` — `null` when absent. */
  get extends(): string | null {
    return this.classify().extends;
  }

  /** Every `on:key[...]` attribute declared directly on `<component>` — see `ComponentOnKeyBinding`. */
  get onKeyAttributes(): readonly ComponentOnKeyBinding[] {
    return this.classify().onKeyAttributes;
  }

  /** `<component>`'s real content — one or more top-level siblings (elements and/or `{#if}`/`{#each}` blocks), no forced wrapper. */
  get children(): TemplateNode[] {
    return this.classify().children;
  }
}

// ---- class declarations ---------------------------------------------

export type ClassVisibility = 'public' | 'private' | 'protected';

/** `[public|private|protected] <name>: <Type> = <literal>` at class-body top level — a class-owned default assigned once, before the constructor runs (`prototype.<name>`/`prototype.private_<name>` in the generated `.brs`). Same token shape as `FieldDeclaration` minus the `field` keyword, with an unrestricted type like `state`/`derived`. */
export class ClassFieldDeclaration extends AstNode {
  get visibility(): ClassVisibility {
    return this.node.childTokens[0].text as ClassVisibility;
  }

  get name(): string {
    return this.node.childTokens[1].text;
  }

  get type(): string {
    return this.node.childTokens[3].text;
  }

  get defaultLiteral(): string {
    return this.node.childTokens[5].text;
  }
}

/** `[public|private|protected] stream <name>: <Type>` at class-body top level — no `=`/literal, unlike `ClassFieldDeclaration`: a stream field's runtime value is always a fresh `ft_createStream()` AA. Token indices shift by one vs. `ClassFieldDeclaration` since `stream` sits after the visibility token: `[visibility(0), stream(1), name(2), colon(3), type(4)]`. */
export class ClassStreamFieldDeclaration extends AstNode {
  get visibility(): ClassVisibility {
    return this.node.childTokens[0].text as ClassVisibility;
  }

  get name(): string {
    return this.node.childTokens[2].text;
  }

  get type(): string {
    return this.node.childTokens[4].text;
  }
}

/** `[public|private|protected] <name>: <Type> = <expr>` inside a constructor body — declares AND assigns an instance field (`self.<name>`/`self.private_<name>` in the generated `private_constructor`). Same token shape as `ClassFieldDeclaration` but with an expression instead of a literal RHS. */
export class ConstructorFieldInit extends AstNode {
  get visibility(): ClassVisibility {
    return this.node.childTokens[0].text as ClassVisibility;
  }

  get name(): string {
    return this.node.childTokens[1].text;
  }

  get type(): string {
    return this.node.childTokens[3].text;
  }

  get expressionRegion(): ExpressionRegion {
    return new ExpressionRegion(this.node.findChild(SyntaxKind.ExpressionRegion)!);
  }

  get expression(): string {
    return this.expressionRegion.text;
  }
}

/** `super(<args>)` — required as an override constructor's first statement when the class extends a base; compiles to `prototype = BaseName(<rewritten args>)`. */
export class SuperCallStatement extends AstNode {
  private get argsRegion(): SyntaxNode | undefined {
    return this.node.findChild(SyntaxKind.ExpressionRegion);
  }

  /** The raw, comma-separated argument-list text between the parens, trimmed — empty string for `super()`. */
  get argsText(): string {
    const region = this.argsRegion;
    return region ? region.getText().trim() : '';
  }

  /** Each argument's own raw text, split via the same synthetic-callee wrap-and-parse the parser already validated this text with at parse time (`parseEmbeddedCallArgs`/`splitEmbeddedCallArgs`, embedded.ts) — a cache hit off that helper's memoization, not a re-parse. Empty for `super()`. */
  get args(): string[] {
    const text = this.argsText;
    if (text.length === 0) return [];
    return splitEmbeddedCallArgs(parseEmbeddedCallArgs(text), text);
  }
}

/**
 * A constructor's body — deliberately its own AST shape, not a widened
 * `Block`: see `SyntaxKind.ConstructorBody`'s doc comment for why
 * `SuperCallStatement`/`ConstructorFieldInit` must stay structurally
 * impossible to produce outside this dedicated parse path.
 */
export class ConstructorBody extends AstNode {
  get statements(): (
    | SuperCallStatement
    | ConstructorFieldInit
    | IfStatement
    | ForStatement
    | ForEachStatement
    | WhileStatement
    | TryStatement
    | RawBrightScriptStatement
    | StatementRegion
  )[] {
    return this.node.children
      .slice(1, -1)
      .filter(isNode)
      .map((n) => {
        if (n.kind === SyntaxKind.SuperCallStatement) return new SuperCallStatement(n);
        if (n.kind === SyntaxKind.ConstructorFieldInit) return new ConstructorFieldInit(n);
        if (n.kind === SyntaxKind.IfStatement) return new IfStatement(n);
        if (n.kind === SyntaxKind.ForStatement) return new ForStatement(n);
        if (n.kind === SyntaxKind.ForEachStatement) return new ForEachStatement(n);
        if (n.kind === SyntaxKind.WhileStatement) return new WhileStatement(n);
        if (n.kind === SyntaxKind.TryStatement) return new TryStatement(n);
        if (n.kind === SyntaxKind.RawBrightScriptRegion) return new RawBrightScriptStatement(n);
        return new StatementRegion(n);
      });
  }
}

/** `[override] constructor(<param>: <Type>, ...) { <ConstructorBody> }`. */
export class ConstructorDeclaration extends AstNode {
  get isOverride(): boolean {
    return this.node.findToken(TokenKind.Override) !== undefined;
  }

  get parameters(): ParameterInfo[] {
    const list = this.node.findChild(SyntaxKind.ParameterList)!;
    return list.findAllChildren(SyntaxKind.Parameter).map((p) => ({ name: p.childTokens[0].text, type: p.childTokens[2].text }));
  }

  get body(): ConstructorBody {
    return new ConstructorBody(this.node.findChild(SyntaxKind.ConstructorBody)!);
  }

  /** This constructor's own `super(...)` call, if any — parser.ts's `validateClassStructure` already guarantees it's the body's first statement whenever the class extends a base, so this is a plain lookup, not a re-scan. */
  get superCall(): SuperCallStatement | null {
    const first = this.body.statements[0];
    return first instanceof SuperCallStatement ? first : null;
  }
}

/** `[override] public|private|protected function <name>(<param>: <Type>, ...) [: <Type>] { <Block> }` — identical shape to a `.thr` `FunctionDeclaration` plus the optional leading `override` and a third `protected` visibility; the body reuses `Block` completely unchanged. */
export class ClassMethodDeclaration extends AstNode {
  get isOverride(): boolean {
    return this.node.findToken(TokenKind.Override) !== undefined;
  }

  get visibility(): ClassVisibility {
    const token = this.node.findToken(TokenKind.Public) ?? this.node.findToken(TokenKind.Private) ?? this.node.findToken(TokenKind.Protected);
    return token!.text as ClassVisibility;
  }

  get name(): string {
    const functionToken = this.node.findToken(TokenKind.Function)!;
    const idx = this.node.childTokens.indexOf(functionToken);
    return this.node.childTokens[idx + 1].text;
  }

  /** `null` when the method omits its return-type clause entirely (compiles to a BrightScript `sub`) — same convention as `FunctionDeclaration.returnType`. */
  get returnType(): string | null {
    const colon = this.node.findToken(TokenKind.Colon);
    if (!colon) return null;
    const idx = this.node.childTokens.indexOf(colon);
    return this.node.childTokens[idx + 1].text;
  }

  get parameters(): ParameterInfo[] {
    const list = this.node.findChild(SyntaxKind.ParameterList)!;
    return list.findAllChildren(SyntaxKind.Parameter).map((p) => ({ name: p.childTokens[0].text, type: p.childTokens[2].text }));
  }

  get block(): Block {
    return new Block(this.node.findChild(SyntaxKind.Block)!);
  }
}

/** `class Name [extends Base] { <member>* }`. */
export class ClassDeclaration extends AstNode {
  get name(): string {
    return this.node.childTokens[1].text;
  }

  /** `null` when this class doesn't `extends` a base. */
  get baseName(): string | null {
    const extendsToken = this.node.findToken(TokenKind.Extends);
    if (!extendsToken) return null;
    const idx = this.node.childTokens.indexOf(extendsToken);
    return this.node.childTokens[idx + 1].text;
  }

  get fields(): ClassFieldDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ClassFieldDeclaration).map((n) => new ClassFieldDeclaration(n));
  }

  /** Kept parallel to, NOT merged into, `.fields` — a stream field has no `defaultLiteral`, so every existing consumer that assumes a field has one stays untouched. */
  get streamFields(): ClassStreamFieldDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ClassStreamFieldDeclaration).map((n) => new ClassStreamFieldDeclaration(n));
  }

  /** `null` when the class declares no constructor at all — only valid when the class doesn't `extends` a base (an extending class must have an explicit `override constructor`, enforced at parse time). */
  get constructorDecl(): ConstructorDeclaration | null {
    const node = this.node.findChild(SyntaxKind.ConstructorDeclaration);
    return node ? new ConstructorDeclaration(node) : null;
  }

  get methods(): ClassMethodDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ClassMethodDeclaration).map((n) => new ClassMethodDeclaration(n));
  }
}

/** A `.flsh` file's root — zero or more `ImportDeclaration`s (used by `extends`'s base, or a class's own field/method bodies) followed by exactly one `ClassDeclaration`. No `<script>` wrapper, no template — see GRAMMAR.md's "`.flsh` files" section. */
export class FlshFile extends AstNode {
  get imports(): ImportDeclaration[] {
    return this.node.findAllChildren(SyntaxKind.ImportDeclaration).map((n) => new ImportDeclaration(n));
  }

  get classDecl(): ClassDeclaration {
    return new ClassDeclaration(this.node.findChild(SyntaxKind.ClassDeclaration)!);
  }
}

/** Wraps a raw `SyntaxNode` into its typed AST class, dispatching on `node.kind`. */
export function wrapNode(node: SyntaxNode): AstNode {
  switch (node.kind) {
    case SyntaxKind.ThrFile:
      return new ThrFile(node);
    case SyntaxKind.ScriptSection:
      return new ScriptSection(node);
    case SyntaxKind.ThemeTemplateSection:
      return new ThemeTemplateSection(node);
    case SyntaxKind.ThemeVariantSection:
      return new ThemeVariantSection(node);
    case SyntaxKind.ThemeGroupDeclaration:
      return new ThemeGroupDeclaration(node);
    case SyntaxKind.ThemeLeafDeclaration:
      return new ThemeLeafDeclaration(node);
    case SyntaxKind.FieldDeclaration:
      return new FieldDeclaration(node);
    case SyntaxKind.DerivedDeclaration:
      return new DerivedDeclaration(node);
    case SyntaxKind.StateDeclaration:
      return new StateDeclaration(node);
    case SyntaxKind.ScaleFieldDeclaration:
      return new ScaleFieldDeclaration(node);
    case SyntaxKind.ScaleStateDeclaration:
      return new ScaleStateDeclaration(node);
    case SyntaxKind.ScaleDerivedDeclaration:
      return new ScaleDerivedDeclaration(node);
    case SyntaxKind.ScaleReadDeclaration:
      return new ScaleReadDeclaration(node);
    case SyntaxKind.ScaleWatchDeclaration:
      return new ScaleWatchDeclaration(node);
    case SyntaxKind.ScaleLocalAssignmentStatement:
      return new ScaleLocalAssignmentStatement(node);
    case SyntaxKind.ScaleStateAssignmentStatement:
      return new ScaleStateAssignmentStatement(node);
    case SyntaxKind.FunctionDeclaration:
      return new FunctionDeclaration(node);
    case SyntaxKind.Block:
      return new Block(node);
    case SyntaxKind.IfStatement:
      return new IfStatement(node);
    case SyntaxKind.ElseClause:
      return new ElseClause(node);
    case SyntaxKind.ForStatement:
      return new ForStatement(node);
    case SyntaxKind.ForEachStatement:
      return new ForEachStatement(node);
    case SyntaxKind.WhileStatement:
      return new WhileStatement(node);
    case SyntaxKind.TryStatement:
      return new TryStatement(node);
    case SyntaxKind.CatchClause:
      return new CatchClause(node);
    case SyntaxKind.StateAssignment:
      return new StateAssignment(node);
    case SyntaxKind.ReadDeclaration:
      return new ReadDeclaration(node);
    case SyntaxKind.WatchDeclaration:
      return new WatchDeclaration(node);
    case SyntaxKind.StreamDeclaration:
      return new StreamDeclaration(node);
    case SyntaxKind.RequestDeclaration:
      return new RequestDeclaration(node);
    case SyntaxKind.AnimationDeclaration:
      return new AnimationDeclaration(node);
    case SyntaxKind.StorePathExpression:
      return new StorePathExpression(node);
    case SyntaxKind.StoreWriteStatement:
      return new StoreWriteStatement(node);
    case SyntaxKind.FocusStatement:
      return new FocusStatement(node);
    case SyntaxKind.JumpFocusStatement:
      return new JumpFocusStatement(node);
    case SyntaxKind.ExpressionRegion:
      return new ExpressionRegion(node);
    case SyntaxKind.StatementRegion:
      return new StatementRegion(node);
    case SyntaxKind.RawBrightScriptRegion:
      return new RawBrightScriptStatement(node);
    case SyntaxKind.TernaryExpression:
      return new TernaryExpression(node);
    case SyntaxKind.TernaryOperand:
      return new TernaryOperand(node);
    case SyntaxKind.TernaryAssignmentStatement:
      return new TernaryAssignmentStatement(node);
    case SyntaxKind.AnonymousFunctionExpression:
      return new AnonymousFunctionExpression(node);
    case SyntaxKind.AnonymousFunctionAssignmentStatement:
      return new AnonymousFunctionAssignmentStatement(node);
    case SyntaxKind.TemplateSection:
      return new TemplateSection(node);
    case SyntaxKind.FlshFile:
      return new FlshFile(node);
    case SyntaxKind.ImportDeclaration:
      return new ImportDeclaration(node);
    case SyntaxKind.ClassDeclaration:
      return new ClassDeclaration(node);
    case SyntaxKind.ClassFieldDeclaration:
      return new ClassFieldDeclaration(node);
    case SyntaxKind.ClassStreamFieldDeclaration:
      return new ClassStreamFieldDeclaration(node);
    case SyntaxKind.ConstructorDeclaration:
      return new ConstructorDeclaration(node);
    case SyntaxKind.ConstructorBody:
      return new ConstructorBody(node);
    case SyntaxKind.ConstructorFieldInit:
      return new ConstructorFieldInit(node);
    case SyntaxKind.SuperCallStatement:
      return new SuperCallStatement(node);
    case SyntaxKind.ClassMethodDeclaration:
      return new ClassMethodDeclaration(node);
    default:
      return new GenericAstNode(node);
  }
}
