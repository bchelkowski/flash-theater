/**
 * Hand-written recursive-descent parser for the whole `.thr` file — the
 * root-tag dispatch (`<script>` component / `<store>` / `<theme-template>` /
 * `<theme name="...">`), the DSL declaration grammar
 * (`field`/`derived`/`private|public function`, the JS-shaped `if`), the
 * theme group/leaf grammar, and the template markup, all in one `parse()`
 * call producing one lossless CST. See GRAMMAR.md for the grammar and
 * findings/compiler-parser-architecture.md for the embedded-BrightScript/XML
 * region boundary this parser respects.
 *
 * This file itself owns only the whole-file root-tag dispatch — which kind
 * of `.thr` file is this, and where do its four regions' boundaries fall
 * (`<script>`'s body, its template, a `<theme-template>`/`<theme>`'s body).
 * The declaration/statement grammar shared by all three regions lives in
 * `token-stream-parser.ts` (`TokenStreamParser`, the common base),
 * `script-parser.ts` (`ScriptParser`), `theme-parser.ts` (`ThemeParser`),
 * and `class-parser.ts` (`ClassParser`, also this file's own
 * `parseFlshFile` entry point for a `.flsh` file's bare import/class
 * declarations). The template markup's own classification (attribute
 * static/dynamic/bind/onKey, `{#if}`/`{#if:destroy}`/`{#each}` block
 * recognition) lives in `template-classify.ts`.
 *
 * Delimiter matching (an `if` condition's `)`, a function body's `}`, a
 * theme group's `}`) is done by depth-counting over the already-tokenized
 * stream, not by rescanning raw text — see lexer.ts's docstring for why
 * that's both simpler and correct even with nested BrightScript syntax (AA
 * literals, nested calls) inside a passthrough statement region.
 *
 * A parse error only guarantees a lossless tree up to the point of failure
 * ("first error wins" policy) — the compiler throws on the first
 * diagnostic and never touches the CST beyond the diagnostics list, so a
 * partial tree past that point is fine. See individual parse methods for how
 * that failure boundary is represented (an `ErrorNode` wrapping whatever was
 * consumed so far).
 */
import { XmlDocument } from './xml/xml-ast.js';
import { TokenKind } from './tokenKind.js';
import { Token } from './token.js';
import { tokenize } from './lexer.js';
import { SyntaxKind } from './syntaxKind.js';
import { SyntaxNode } from './syntaxNode.js';
import { ParseDiagnostic } from './diagnostics.js';
import { TriviaKind, Trivia } from './trivia.js';
import { findLiteralOutsideStringsAndComments, lineAt } from './text-scan.js';
import { parseEmbeddedTemplate } from './embedded.js';
import { preprocessOnKeyAttributes } from './onKeyPreprocess.js';
import { classifyComponentElement } from './template-classify.js';
import { ScriptParser } from './script-parser.js';
import { ThemeParser } from './theme-parser.js';
import { ClassParser } from './class-parser.js';

export interface ParseResult {
  /** The root `ThrFile` CST node. */
  readonly root: SyntaxNode;
  readonly diagnostics: readonly ParseDiagnostic[];
}

const SCRIPT_OPEN_TAG = '<script>';
const SCRIPT_CLOSE_TAG = '</script>';
/** No longer a parseable root tag — `<store>` files are rejected with a dedicated upgrade-path diagnostic, see `parseThrFile`. Store is a built-in runtime primitive now (`read`/`watch`/`store(...)` in a `<script>` component), never user-authored. */
const STORE_OPEN_TAG = '<store>';
const THEME_TEMPLATE_OPEN_PREFIX = '<theme-template';
const THEME_TEMPLATE_CLOSE_TAG = '</theme-template>';
const THEME_VARIANT_OPEN_PREFIX = '<theme ';
const THEME_VARIANT_CLOSE_TAG = '</theme>';
/** The mandatory root tag wrapping every `.thr` file's template markup — see `parseComponentFile`'s own root-tag requirement check. Matched as a prefix (not `<component>`'s exact literal), since the tag legitimately carries `extends="..."`/`on:key[...]="..."` attributes — real XML parsing (not a raw-text regex) does the actual attribute extraction, via `template-classify.ts`'s `classifyComponentElement`. */
const COMPONENT_OPEN_PREFIX = '<component';

/** Parses a complete `.thr` source string into a lossless CST. Always returns a tree; errors are collected as diagnostics rather than thrown — see `dsl-parser/dsl-parser.ts` in packages/compiler for the policy layered on top (throw on the first diagnostic). */
export function parse(source: string): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  const root = parseThrFile(source, diagnostics);
  return { root, diagnostics };
}

/**
 * Parses a complete `.flsh` source string into a lossless CST. Unlike a
 * `.thr` file, a `.flsh` file has no `<script>` wrapper and no template — it
 * is bare `import`/`class` declarations tokenized directly from position 0,
 * so (unlike `parseThrFile`'s root-tag dispatch) there's no outer-tag text to
 * split off first. See GRAMMAR.md's "`.flsh` files" section.
 */
export function parseFlshFile(source: string): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  const tokens = tokenize(source, { posOffset: 0, lineOffset: 0 });
  const root = new ClassParser(tokens, diagnostics).parseFlshFileBody();
  return { root, diagnostics };
}

/**
 * Formalized, explicitly-named entry point for `.thr` source — an alias for
 * `parse` (unchanged; kept under its original name too since it's already
 * widely used throughout this package and `packages/compiler`). Per
 * `findings/compiler-parser-architecture.md`'s standing rule, `parseThr`/`parseFlsh`
 * are this package's complete, held-to-full-grammar-coverage entry points
 * for each file kind.
 */
export function parseThr(source: string): ParseResult {
  return parse(source);
}

/** Formalized, explicitly-named entry point for `.flsh` source — an alias for `parseFlshFile`. See `parseThr`'s own doc comment. */
export function parseFlsh(source: string): ParseResult {
  return parseFlshFile(source);
}

function parseThrFile(source: string, diagnostics: ParseDiagnostic[]): SyntaxNode {
  const leadingWsMatch = /^\s*/.exec(source);
  const leadingWsLen = leadingWsMatch ? leadingWsMatch[0].length : 0;
  const leadingTrivia = leadingWsLen > 0 ? [wsTrivia(source, 0, leadingWsLen)] : [];

  if (source.startsWith(SCRIPT_OPEN_TAG, leadingWsLen)) {
    return parseComponentFile(source, leadingWsLen, leadingTrivia, diagnostics);
  }
  if (source.startsWith(STORE_OPEN_TAG, leadingWsLen)) {
    diagnostics.push({
      code: 'thr/store-tag-removed',
      message:
        '<store> is no longer a user-authored file — Store is a built-in runtime primitive now. Declare "read <name> = store(<path>)" / "watch <name> = store(<path>)" in a <script> component instead, and write with "store(<key>) = <expr>".',
      pos: leadingWsLen,
      end: source.length,
      line: lineAt(source, leadingWsLen),
    });
    return new SyntaxNode(SyntaxKind.ErrorNode, []);
  }
  if (source.startsWith(THEME_TEMPLATE_OPEN_PREFIX, leadingWsLen)) {
    return parseThemeTemplateFile(source, leadingWsLen, leadingTrivia, diagnostics);
  }
  if (source.startsWith(THEME_VARIANT_OPEN_PREFIX, leadingWsLen)) {
    return parseThemeVariantFile(source, leadingWsLen, leadingTrivia, diagnostics);
  }

  diagnostics.push({
    code: 'thr/unrecognized-root',
    message: 'A .thr file must start with <script>, <theme-template>, or <theme name="..."> (after optional leading whitespace).',
    pos: 0,
    end: source.length,
    line: 0,
  });
  return new SyntaxNode(SyntaxKind.ErrorNode, []);
}

// ---- <script> — component file (unchanged from before store/theme existed) ----

function parseComponentFile(source: string, leadingWsLen: number, leadingTrivia: Trivia[], diagnostics: ParseDiagnostic[]): SyntaxNode {
  const scriptOpenStart = leadingWsLen;
  const scriptOpenEnd = scriptOpenStart + SCRIPT_OPEN_TAG.length;
  const scriptOpenToken = makeTagToken(source, SCRIPT_OPEN_TAG, scriptOpenStart, scriptOpenEnd, leadingTrivia);

  const scriptBodyStart = scriptOpenEnd;
  const closeTagIndex = findLiteralOutsideStringsAndComments(source, scriptBodyStart, SCRIPT_CLOSE_TAG);

  if (closeTagIndex === -1) {
    diagnostics.push({
      code: 'thr/unterminated-script',
      message: 'No closing </script> found.',
      pos: scriptBodyStart,
      end: source.length,
      line: lineAt(source, scriptBodyStart),
    });
    return new SyntaxNode(SyntaxKind.ThrFile, [scriptOpenToken]);
  }

  const scriptBody = source.slice(scriptBodyStart, closeTagIndex);
  const scriptTokens = tokenize(scriptBody, { posOffset: scriptBodyStart, lineOffset: lineAt(source, scriptBodyStart) });
  const scriptSection = new ScriptParser(scriptTokens, diagnostics).parseScriptSection();

  const eofToken = scriptTokens[scriptTokens.length - 1];
  const scriptCloseStart = closeTagIndex;
  const scriptCloseEnd = scriptCloseStart + SCRIPT_CLOSE_TAG.length;
  const scriptCloseToken = makeTagToken(source, SCRIPT_CLOSE_TAG, scriptCloseStart, scriptCloseEnd, eofToken.leadingTrivia);

  const templateStart = scriptCloseEnd;
  const afterCloseTag = source.slice(templateStart);
  const templateContentOffset = afterCloseTag.length - afterCloseTag.trimStart().length;
  const templateContent = afterCloseTag.slice(templateContentOffset);

  if (templateContent.trim().length === 0) {
    diagnostics.push({
      code: 'thr/missing-template',
      message: 'The .thr file has no template markup after </script>.',
      pos: templateStart,
      end: source.length,
      line: lineAt(source, templateStart),
    });
    return new SyntaxNode(SyntaxKind.ThrFile, [scriptOpenToken, scriptSection, scriptCloseToken]);
  }

  const templateContentStart = templateStart + templateContentOffset;
  const templateLeadingTrivia = templateContentOffset > 0 ? [wsTrivia(source, templateStart, templateContentStart)] : [];
  const templateToken: Token = {
    kind: TokenKind.EmbeddedText,
    text: templateContent,
    pos: templateContentStart,
    end: source.length,
    line: lineAt(source, templateContentStart),
    column: 0,
    leadingTrivia: templateLeadingTrivia,
    trailingTrivia: [],
  };

  const templateSection = new SyntaxNode(SyntaxKind.TemplateSection, [templateToken]);
  const trimmedMarkup = templateContent.trim();
  const baseLine = lineAt(source, templateContentStart);

  // Everything after </script> must be wrapped in <component>...</component> — checked as a
  // plain prefix (mirroring this function's own <script>/<theme-template>/<theme> root-tag
  // dispatch) before ever attempting to parse the markup as XML, so a stray {#if}/{#each} marker
  // or a bare element left over from before this tag existed gets one clear, specific diagnostic
  // instead of a generic XML parse failure.
  if (!(trimmedMarkup.startsWith(COMPONENT_OPEN_PREFIX) && /[\s>]/.test(trimmedMarkup.charAt(COMPONENT_OPEN_PREFIX.length)))) {
    diagnostics.push({
      code: 'thr/expected-component-tag',
      message:
        'The .thr file\'s template markup must be wrapped in <component>...</component> (optionally with extends="..." and/or on:key[...]="..." attributes on the opening tag) — found something else right after </script>.',
      pos: templateContentStart,
      end: source.length,
      line: baseLine,
    });
    return new SyntaxNode(SyntaxKind.ThrFile, [scriptOpenToken, scriptSection, scriptCloseToken, templateSection]);
  }

  const onKeyPreprocessed = preprocessOnKeyAttributes(trimmedMarkup);
  if (onKeyPreprocessed.diagnostics.length > 0) {
    // A malformed on:key[... span is left untransliterated (still illegal XML) — stop here rather
    // than also handing it to the real XML parser, which would just report its own generic,
    // redundant template/invalid-xml for the same span.
    for (const d of onKeyPreprocessed.diagnostics) {
      diagnostics.push({ code: d.code, message: d.message, pos: templateContentStart + d.pos, end: templateContentStart + d.end, line: baseLine + d.line });
    }
    return new SyntaxNode(SyntaxKind.ThrFile, [scriptOpenToken, scriptSection, scriptCloseToken, templateSection]);
  }

  const embeddedXml = parseEmbeddedTemplate(onKeyPreprocessed.text);

  if (embeddedXml.result.diagnostics.length > 0) {
    const first = embeddedXml.result.diagnostics[0];
    diagnostics.push({
      code: 'template/invalid-xml',
      message: `Template is not valid XML: ${first.message}`,
      pos: templateContentStart,
      end: source.length,
      line: baseLine + first.line,
    });
    templateSection.embedded = { kind: 'xml', result: embeddedXml.result, offset: templateContentStart };
    return new SyntaxNode(SyntaxKind.ThrFile, [scriptOpenToken, scriptSection, scriptCloseToken, templateSection]);
  }

  const xmlRoot = new XmlDocument(embeddedXml.result.root).root;
  if (!xmlRoot) {
    diagnostics.push({
      code: 'template/empty',
      message: 'Template has no root element.',
      pos: templateContentStart,
      end: source.length,
      line: baseLine,
    });
  } else if (xmlRoot.tagName !== 'component') {
    // Belt-and-suspenders — the prefix check above already guarantees this in practice, but a
    // defensive check here keeps this branch honest if that check's own logic ever drifts.
    diagnostics.push({
      code: 'thr/expected-component-tag',
      message: `Expected <component>, found <${xmlRoot.tagName}>.`,
      pos: templateContentStart,
      end: source.length,
      line: baseLine,
    });
  } else {
    const classified = classifyComponentElement(xmlRoot, baseLine, diagnostics, templateContentStart);
    // A component can never have zero real content at every point in time — {#if:destroy} has no
    // always-present static XML shape at all (unlike {#if}'s toggle mode or {#each}, both of which
    // compile to an always-present wrapper Group), so a *sole* {#if:destroy} child would leave
    // <children> genuinely empty until it constructs itself. Only relevant when it's the ONLY
    // top-level child — mixed among 2+ siblings, {#if}/{#each} already work fine as an ordinary
    // child, no different than nested anywhere else in the tree.
    if (classified.children.length === 1 && classified.children[0].kind === 'if') {
      diagnostics.push({
        code: 'template/if-cannot-be-root',
        message:
          "<component>'s sole child cannot itself be a {#if}/{#if:destroy} block — the SceneGraph component root must always exist. Wrap the conditional block inside a real element instead, or give <component> a second, always-present sibling child.",
        pos: templateContentStart,
        end: source.length,
        line: baseLine,
      });
    } else if (classified.children.length === 1 && classified.children[0].kind === 'each') {
      diagnostics.push({
        code: 'template/each-cannot-be-root',
        message:
          "<component>'s sole child cannot itself be a {#each} block — the SceneGraph component root must always exist (a list has 0..N items at runtime). Wrap the {#each} block inside a real element instead, or give <component> a second, always-present sibling child.",
        pos: templateContentStart,
        end: source.length,
        line: baseLine,
      });
    }
  }

  templateSection.embedded = { kind: 'xml', result: embeddedXml.result, offset: templateContentStart };
  return new SyntaxNode(SyntaxKind.ThrFile, [scriptOpenToken, scriptSection, scriptCloseToken, templateSection]);
}

// ---- <theme-template> / <theme name="..."> — nested group/leaf grammar, headless ----

function parseThemeTemplateFile(source: string, leadingWsLen: number, leadingTrivia: Trivia[], diagnostics: ParseDiagnostic[]): SyntaxNode {
  const openStart = leadingWsLen;
  const tagEnd = source.indexOf('>', openStart);
  if (tagEnd === -1) {
    diagnostics.push({
      code: 'thr/unrecognized-root',
      message: 'Unterminated <theme-template> opening tag — no ">" found.',
      pos: openStart,
      end: source.length,
      line: lineAt(source, openStart),
    });
    return new SyntaxNode(SyntaxKind.ErrorNode, []);
  }

  const openEnd = tagEnd + 1;
  const openToken = makeTagToken(source, source.slice(openStart, openEnd), openStart, openEnd, leadingTrivia);

  const bodyStart = openEnd;
  const closeTagIndex = findLiteralOutsideStringsAndComments(source, bodyStart, THEME_TEMPLATE_CLOSE_TAG);
  if (closeTagIndex === -1) {
    diagnostics.push({
      code: 'thr/unterminated-theme-template',
      message: 'No closing </theme-template> found.',
      pos: bodyStart,
      end: source.length,
      line: lineAt(source, bodyStart),
    });
    return new SyntaxNode(SyntaxKind.ThrFile, [openToken]);
  }

  const body = source.slice(bodyStart, closeTagIndex);
  const tokens = tokenize(body, { posOffset: bodyStart, lineOffset: lineAt(source, bodyStart) });
  const templateSection = new ThemeParser(tokens, diagnostics).parseThemeSection(SyntaxKind.ThemeTemplateSection);

  const eofToken = tokens[tokens.length - 1];
  const closeTagEnd = closeTagIndex + THEME_TEMPLATE_CLOSE_TAG.length;
  // Absorb any trailing content (in practice, trailing whitespace — anything
  // else already gets the thr/theme-must-be-headless diagnostic below, and a
  // diagnosed parse only needs a lossless tree up to the failure point, see
  // this file's own doc comment) into the close token's own text, all the
  // way to source.length — mirroring templateToken's identical pattern in
  // parseComponentFile above. Without this, flash-parser's leading-trivia-only
  // Token model (see trivia.ts) has nowhere to attach a real file's own
  // trailing newline, since closeToken is the tree's last node and there's no
  // following token for that trivia to be the *leading* trivia of — confirmed
  // live: every real Theme.thr/Dark.thr/Light.thr in apps/sample-app lost
  // their final "\n" on round-trip before this fix.
  const closeToken = makeTagToken(source, source.slice(closeTagIndex), closeTagIndex, source.length, eofToken.leadingTrivia);

  requireHeadless(source, closeTagEnd, 'thr/theme-must-be-headless', 'A <theme-template> file must contain nothing after </theme-template>.', diagnostics);

  return new SyntaxNode(SyntaxKind.ThrFile, [openToken, templateSection, closeToken]);
}

function parseThemeVariantFile(source: string, leadingWsLen: number, leadingTrivia: Trivia[], diagnostics: ParseDiagnostic[]): SyntaxNode {
  const openStart = leadingWsLen;
  const tagEnd = source.indexOf('>', openStart);
  if (tagEnd === -1) {
    diagnostics.push({
      code: 'thr/unrecognized-root',
      message: 'Unterminated <theme name="..."> opening tag — no ">" found.',
      pos: openStart,
      end: source.length,
      line: lineAt(source, openStart),
    });
    return new SyntaxNode(SyntaxKind.ErrorNode, []);
  }

  const openEnd = tagEnd + 1;
  const openToken = makeTagToken(source, source.slice(openStart, openEnd), openStart, openEnd, leadingTrivia);

  const bodyStart = openEnd;
  const closeTagIndex = findLiteralOutsideStringsAndComments(source, bodyStart, THEME_VARIANT_CLOSE_TAG);
  if (closeTagIndex === -1) {
    diagnostics.push({
      code: 'thr/unterminated-theme-variant',
      message: 'No closing </theme> found.',
      pos: bodyStart,
      end: source.length,
      line: lineAt(source, bodyStart),
    });
    return new SyntaxNode(SyntaxKind.ThrFile, [openToken]);
  }

  const body = source.slice(bodyStart, closeTagIndex);
  const tokens = tokenize(body, { posOffset: bodyStart, lineOffset: lineAt(source, bodyStart) });
  const variantSection = new ThemeParser(tokens, diagnostics).parseThemeSection(SyntaxKind.ThemeVariantSection);

  const eofToken = tokens[tokens.length - 1];
  const closeTagEnd = closeTagIndex + THEME_VARIANT_CLOSE_TAG.length;
  // See the identical fix (and its comment) in parseThemeTemplateFile above.
  const closeToken = makeTagToken(source, source.slice(closeTagIndex), closeTagIndex, source.length, eofToken.leadingTrivia);

  requireHeadless(source, closeTagEnd, 'thr/theme-must-be-headless', 'A <theme> file must contain nothing after </theme>.', diagnostics);

  return new SyntaxNode(SyntaxKind.ThrFile, [openToken, variantSection, closeToken]);
}

function requireHeadless(source: string, bodyEnd: number, code: string, message: string, diagnostics: ParseDiagnostic[]): void {
  const trailing = source.slice(bodyEnd);
  if (trailing.trim().length > 0) {
    diagnostics.push({ code, message, pos: bodyEnd, end: source.length, line: lineAt(source, bodyEnd) });
  }
}

function makeTagToken(source: string, text: string, start: number, end: number, leadingTrivia: readonly Trivia[]): Token {
  return {
    kind: TokenKind.EmbeddedText,
    text,
    pos: start,
    end,
    line: lineAt(source, start),
    column: 0,
    leadingTrivia,
    trailingTrivia: [],
  };
}

function wsTrivia(source: string, start: number, end: number): Trivia {
  return { kind: TriviaKind.Whitespace, text: source.slice(start, end), pos: start, end, line: lineAt(source, start), column: 0 };
}
