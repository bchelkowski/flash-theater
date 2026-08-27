import { TokenKind } from './tokenKind.js';
import { Token } from './token.js';
import { SyntaxKind } from './syntaxKind.js';
import { SyntaxChild, SyntaxNode, isToken, lastToken } from './syntaxNode.js';
import { TokenStreamParser, FIELD_TYPES } from './token-stream-parser.js';

/**
 * `field`-only superset of the shared `FIELD_TYPES` — `array`/`assocarray` are valid `field` types,
 * but deliberately NOT added to the shared constant itself, so `ThemeParser`'s leaf-type check
 * (which imports `FIELD_TYPES` directly) keeps rejecting them; class fields/theme leaves are out of
 * scope for array/assocarray support (see GRAMMAR.md's "field" section).
 */
const SCRIPT_FIELD_TYPES = new Set([...FIELD_TYPES, 'array', 'assocarray']);

/** 0-based line of the last token actually consumed for a literal — a plain token for a scalar literal, or the closing bracket's line for a captured array/AA `ExpressionRegion` (see `expectFieldOrStateLiteral`). */
function literalEndLine(literal: SyntaxChild): number {
  return isToken(literal) ? literal.line : (lastToken(literal)?.line ?? literal.line);
}

/** Token-stream-driven recursive-descent parser for one `<script>`/`<store>` region's declarations. */
export class ScriptParser extends TokenStreamParser {
  /** Parses a `<script>` component's declarations into a `ScriptSection`. */
  parseScriptSection(): SyntaxNode {
    const children: SyntaxChild[] = [];

    while (!this.check(TokenKind.EndOfFile)) {
      if (this.diagnostics.length > 0) break; // Policy: first error wins, see GRAMMAR.md

      const rawBlock = this.tryParseRawBlock(this.tokens.length);
      if (rawBlock) {
        children.push(rawBlock);
        continue;
      }

      if (this.check(TokenKind.Import)) {
        children.push(this.parseImportDeclaration());
        continue;
      }
      if (this.check(TokenKind.Field)) {
        children.push(this.parseFieldDeclaration());
        continue;
      }
      if (this.check(TokenKind.Derived)) {
        children.push(this.parseDerivedDeclaration());
        continue;
      }
      if (this.check(TokenKind.State)) {
        children.push(this.parseStateDeclaration());
        continue;
      }
      if (this.check(TokenKind.Read)) {
        children.push(this.parseReadOrWatchDeclaration(SyntaxKind.ReadDeclaration, 'read'));
        continue;
      }
      if (this.check(TokenKind.Watch)) {
        children.push(this.parseReadOrWatchDeclaration(SyntaxKind.WatchDeclaration, 'watch'));
        continue;
      }
      if (this.check(TokenKind.Scale)) {
        children.push(this.parseScaleDeclaration());
        continue;
      }
      if (this.check(TokenKind.Stream)) {
        children.push(this.parseStreamDeclaration());
        continue;
      }
      if (this.check(TokenKind.Request)) {
        children.push(this.parseRequestDeclaration());
        continue;
      }
      if (this.check(TokenKind.Animation)) {
        children.push(this.parseAnimationDeclaration());
        continue;
      }
      if (this.check(TokenKind.Private) || this.check(TokenKind.Public)) {
        children.push(this.parseFunctionDeclaration());
        continue;
      }

      const token = this.peek();
      this.error(
        'dsl/unexpected-token',
        `Unexpected content in <script> — expected import/field/derived/state/read/watch/scale/stream/request/animation/private function/public function: "${token.text}"`,
        token,
      );
      children.push(new SyntaxNode(SyntaxKind.ErrorNode, [this.advance()]));
      break;
    }

    return new SyntaxNode(SyntaxKind.ScriptSection, children);
  }

  // ---- scale ------------------------------------------------------------

  /**
   * `scale field|state|derived|watch|read ...` — a leading modifier consumed here, then
   * dispatched into the same per-keyword parse method the unscaled form uses, with the
   * already-consumed `scale` token passed through so the resulting node is index-shifted by 1
   * and gets its own distinct `Scale*` `SyntaxKind` — same pattern as `class-parser.ts`'s
   * `parseClassStreamFieldDeclaration` shifting for a leading `visibility` token. No bare
   * `scale <name> = ...` shorthand at script level — `scale` must always be followed by one of
   * the five kind keywords.
   */
  private parseScaleDeclaration(): SyntaxNode {
    const scaleToken = this.advance();

    if (this.check(TokenKind.Field)) return this.parseFieldDeclaration(scaleToken);
    if (this.check(TokenKind.State)) return this.parseStateDeclaration(scaleToken);
    if (this.check(TokenKind.Derived)) return this.parseDerivedDeclaration(scaleToken);
    if (this.check(TokenKind.Watch)) return this.parseReadOrWatchDeclaration(SyntaxKind.WatchDeclaration, 'watch', scaleToken);
    if (this.check(TokenKind.Read)) return this.parseReadOrWatchDeclaration(SyntaxKind.ReadDeclaration, 'read', scaleToken);

    this.error(
      'dsl/invalid-scale-declaration',
      `Invalid scale declaration. "scale" must be followed by field/state/derived/watch/read — got "${this.peek().text}".`,
      this.peek(),
    );
    return this.errorNode([scaleToken]);
  }

  // ---- field ----------------------------------------------------------

  /** Only `integer`/`float`/`array`/`assocarray` fields may be `scale`d — `string`/`boolean`/`node` never represent a scalable numeric size/position. `array`/`assocarray` scale element-wise/per-key, one level deep (see `ft_scale` in `FlashTheaterScale.brs`). */
  private static readonly SCALABLE_FIELD_TYPES = new Set(['integer', 'float', 'array', 'assocarray']);

  private parseFieldDeclaration(scaleToken?: Token): SyntaxNode {
    const MSG = 'Invalid field declaration. Expected: field <name>: <Type> = <literal>';
    const prefix: SyntaxChild[] = scaleToken ? [scaleToken] : [];
    const fieldToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-field', MSG);
    if (!nameToken) return this.errorNode([...prefix, fieldToken]);

    const colonToken = this.expect(TokenKind.Colon, 'dsl/invalid-field', MSG);
    if (!colonToken) return this.errorNode([...prefix, fieldToken, nameToken]);

    const typeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-field', MSG);
    if (!typeToken) return this.errorNode([...prefix, fieldToken, nameToken, colonToken]);

    if (!SCRIPT_FIELD_TYPES.has(typeToken.text)) {
      this.error(
        'dsl/invalid-field-type',
        `Unknown field type "${typeToken.text}" for field "${nameToken.text}". Allowed: ${[...SCRIPT_FIELD_TYPES].join(', ')}.`,
        typeToken,
      );
      return this.errorNode([...prefix, fieldToken, nameToken, colonToken, typeToken]);
    }

    if (scaleToken && !ScriptParser.SCALABLE_FIELD_TYPES.has(typeToken.text)) {
      this.error(
        'dsl/scale-invalid-field-type',
        `"scale field ${nameToken.text}" has type "${typeToken.text}" — only integer/float/array/assocarray fields can be scaled.`,
        typeToken,
      );
      return this.errorNode([...prefix, fieldToken, nameToken, colonToken, typeToken]);
    }

    const equalsToken = this.expect(TokenKind.Equals, 'dsl/invalid-field', MSG);
    if (!equalsToken) return this.errorNode([...prefix, fieldToken, nameToken, colonToken, typeToken]);

    const literalToken = this.expectFieldOrStateLiteral(MSG, 'dsl/invalid-field');
    if (!literalToken) return this.errorNode([...prefix, fieldToken, nameToken, colonToken, typeToken, equalsToken]);

    if (scaleToken && isToken(literalToken) && literalToken.kind !== TokenKind.NumberLiteral) {
      this.error(
        'dsl/scale-non-numeric-literal',
        `"scale field ${nameToken.text}" default value "${literalToken.text}" is not numeric.`,
        literalToken,
      );
      return this.errorNode([...prefix, fieldToken, nameToken, colonToken, typeToken, equalsToken, literalToken]);
    }

    const next = this.peek();
    if (next.kind !== TokenKind.EndOfFile && next.line === literalEndLine(literalToken)) {
      this.error('dsl/invalid-field', MSG, next);
      return this.errorNode([...prefix, fieldToken, nameToken, colonToken, typeToken, equalsToken, literalToken]);
    }

    return new SyntaxNode(scaleToken ? SyntaxKind.ScaleFieldDeclaration : SyntaxKind.FieldDeclaration, [
      ...prefix,
      fieldToken,
      nameToken,
      colonToken,
      typeToken,
      equalsToken,
      literalToken,
    ]);
  }

  // ---- state --------------------------------------------------------

  /**
   * `state <name>: <Type> = <literal>` — same shape as `field`, except the
   * type is an unrestricted identifier (like a function param/return type)
   * rather than the closed `FIELD_TYPES` set: `state` never becomes an XML
   * `<field>` (see findings/reactivity-state.md — it's a private `m.x`
   * member, not a SceneGraph interface field), so it isn't bound by
   * SceneGraph's small set of field types.
   */
  private parseStateDeclaration(scaleToken?: Token): SyntaxNode {
    const MSG = 'Invalid state declaration. Expected: state <name>: <Type> = <literal>';
    const prefix: SyntaxChild[] = scaleToken ? [scaleToken] : [];
    const stateToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-state', MSG);
    if (!nameToken) return this.errorNode([...prefix, stateToken]);

    const colonToken = this.expect(TokenKind.Colon, 'dsl/invalid-state', MSG);
    if (!colonToken) return this.errorNode([...prefix, stateToken, nameToken]);

    const typeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-state', MSG);
    if (!typeToken) return this.errorNode([...prefix, stateToken, nameToken, colonToken]);
    if (!this.rejectVoidType(typeToken)) return this.errorNode([...prefix, stateToken, nameToken, colonToken, typeToken]);

    const equalsToken = this.expect(TokenKind.Equals, 'dsl/invalid-state', MSG);
    if (!equalsToken) return this.errorNode([...prefix, stateToken, nameToken, colonToken, typeToken]);

    const literalToken = this.expectFieldOrStateLiteral(MSG, 'dsl/invalid-state');
    if (!literalToken) return this.errorNode([...prefix, stateToken, nameToken, colonToken, typeToken, equalsToken]);

    if (scaleToken && isToken(literalToken) && literalToken.kind !== TokenKind.NumberLiteral) {
      this.error(
        'dsl/scale-non-numeric-literal',
        `"scale state ${nameToken.text}" default value "${literalToken.text}" is not numeric.`,
        literalToken,
      );
      return this.errorNode([...prefix, stateToken, nameToken, colonToken, typeToken, equalsToken, literalToken]);
    }

    const next = this.peek();
    if (next.kind !== TokenKind.EndOfFile && next.line === literalEndLine(literalToken)) {
      this.error('dsl/invalid-state', MSG, next);
      return this.errorNode([...prefix, stateToken, nameToken, colonToken, typeToken, equalsToken, literalToken]);
    }

    return new SyntaxNode(scaleToken ? SyntaxKind.ScaleStateDeclaration : SyntaxKind.StateDeclaration, [
      ...prefix,
      stateToken,
      nameToken,
      colonToken,
      typeToken,
      equalsToken,
      literalToken,
    ]);
  }

  // ---- derived ----------------------------------------------------------

  /**
   * `derived <name>: <Type> = <expression>` — the type is a required,
   * unrestricted identifier (like `state`'s and a function's param/return
   * types), not the closed `FIELD_TYPES` set: `derived` never becomes an
   * XML `<field>`, so it isn't bound by SceneGraph's small set of field
   * types.
   */
  private parseDerivedDeclaration(scaleToken?: Token): SyntaxNode {
    const MSG = 'Invalid derived declaration. Expected: derived <name>: <Type> = <expression>';
    const prefix: SyntaxChild[] = scaleToken ? [scaleToken] : [];
    const derivedToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-derived', MSG);
    if (!nameToken) return this.errorNode([...prefix, derivedToken]);

    const colonToken = this.expect(TokenKind.Colon, 'dsl/invalid-derived', MSG);
    if (!colonToken) return this.errorNode([...prefix, derivedToken, nameToken]);

    const typeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-derived', MSG);
    if (!typeToken) return this.errorNode([...prefix, derivedToken, nameToken, colonToken]);
    if (!this.rejectVoidType(typeToken)) return this.errorNode([...prefix, derivedToken, nameToken, colonToken, typeToken]);

    const equalsToken = this.expect(TokenKind.Equals, 'dsl/invalid-derived', MSG);
    if (!equalsToken) return this.errorNode([...prefix, derivedToken, nameToken, colonToken, typeToken]);

    if (this.peek().kind === TokenKind.EndOfFile || this.peek().line !== equalsToken.line) {
      this.error('dsl/invalid-derived', MSG, equalsToken);
      return this.errorNode([...prefix, derivedToken, nameToken, colonToken, typeToken, equalsToken]);
    }

    const exprTokens: Token[] = [];
    while (this.peek().kind !== TokenKind.EndOfFile && this.peek().line === equalsToken.line) {
      exprTokens.push(this.advance());
    }

    const region = this.makeExpressionRegion(exprTokens);
    return new SyntaxNode(scaleToken ? SyntaxKind.ScaleDerivedDeclaration : SyntaxKind.DerivedDeclaration, [
      ...prefix,
      derivedToken,
      nameToken,
      colonToken,
      typeToken,
      equalsToken,
      region,
    ]);
  }

  // ---- stream -------------------------------------------------------

  /**
   * `stream <name>: <Type>` — no `=`/initializer, unlike `derived`/`state`:
   * a stream's runtime value is always a fresh `ft_createStream()` AA
   * (codegen/brs-emitter.ts), never a DSL-authored literal or expression.
   * `<Type>` is a required, unrestricted identifier, same rationale as
   * `derived`'s: a stream never becomes an XML `<field>`.
   */
  private parseStreamDeclaration(): SyntaxNode {
    const MSG = 'Invalid stream declaration. Expected: stream <name>: <Type>';
    const streamToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-stream', MSG);
    if (!nameToken) return this.errorNode([streamToken]);

    const colonToken = this.expect(TokenKind.Colon, 'dsl/invalid-stream', MSG);
    if (!colonToken) return this.errorNode([streamToken, nameToken]);

    const typeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-stream', MSG);
    if (!typeToken) return this.errorNode([streamToken, nameToken, colonToken]);
    if (!this.rejectVoidType(typeToken)) return this.errorNode([streamToken, nameToken, colonToken, typeToken]);

    const next = this.peek();
    if (next.kind !== TokenKind.EndOfFile && next.line === typeToken.line) {
      this.error('dsl/invalid-stream', MSG, next);
      return this.errorNode([streamToken, nameToken, colonToken, typeToken]);
    }

    return new SyntaxNode(SyntaxKind.StreamDeclaration, [streamToken, nameToken, colonToken, typeToken]);
  }

  // ---- request --------------------------------------------------------

  /**
   * `request <Kind> { ... }` — `<Kind>` is a plain, unvalidated identifier
   * (validated downstream in packages/compiler, same discipline as
   * `extends="..."` staying unvalidated here). The
   * `{ ... }` config literal is captured as an ordinary `ExpressionRegion`
   * spanning from `{` to its matching `}` (braces included, so it parses
   * standalone as a BrightScript AA literal) — reuses the exact same
   * brace-matching + `makeExpressionRegion` machinery a call argument like
   * `taskManager.setAlertThresholds({...})` already relies on, not
   * `ThemeParser`'s member-by-member grammar (this config is opaque to
   * flash-parser, structurally validated later, not parsed field-by-field
   * here).
   */
  private parseRequestDeclaration(): SyntaxNode {
    const MSG = 'Invalid request declaration. Expected: request <Kind> { ... }';
    const requestToken = this.advance();

    const kindToken = this.expect(TokenKind.Identifier, 'dsl/invalid-request', MSG);
    if (!kindToken) return this.errorNode([requestToken]);

    if (!this.check(TokenKind.LBrace)) {
      this.error('dsl/invalid-request', MSG, this.peek());
      return this.errorNode([requestToken, kindToken]);
    }

    const lbraceIndex = this.pos;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('dsl/invalid-request', `No closing "}" found for request declaration.`, this.tokens[lbraceIndex]);
      return this.errorNode([requestToken, kindToken, this.advance()]);
    }

    const configTokens = this.tokens.slice(lbraceIndex, rbraceIndex + 1);
    const region = this.makeExpressionRegion(configTokens);
    this.pos = rbraceIndex + 1;

    return new SyntaxNode(SyntaxKind.RequestDeclaration, [requestToken, kindToken, region]);
  }

  // ---- animation --------------------------------------------------------

  /**
   * `animation <name> { ... }` — `<name>` is a real DSL identifier (unlike `request`'s `<Kind>`
   * enum-like discriminator), referenced later via `.start()`/`.stop()`/... trigger sugar and
   * template `transition:`/`in:`/`out:` attribute values. The `{ ... }` config literal is captured
   * as an opaque `ExpressionRegion` the exact same way `request`'s is — unvalidated at this layer,
   * structurally validated downstream in `packages/compiler/src/analysis/animation-config.ts`.
   * Unlike `request`, any number of `animation` declarations are allowed per file.
   */
  private parseAnimationDeclaration(): SyntaxNode {
    const MSG = 'Invalid animation declaration. Expected: animation <name> { ... }';
    const animationToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-animation', MSG);
    if (!nameToken) return this.errorNode([animationToken]);

    if (!this.check(TokenKind.LBrace)) {
      this.error('dsl/invalid-animation', MSG, this.peek());
      return this.errorNode([animationToken, nameToken]);
    }

    const lbraceIndex = this.pos;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('dsl/invalid-animation', `No closing "}" found for animation declaration.`, this.tokens[lbraceIndex]);
      return this.errorNode([animationToken, nameToken, this.advance()]);
    }

    const configTokens = this.tokens.slice(lbraceIndex, rbraceIndex + 1);
    const region = this.makeExpressionRegion(configTokens);
    this.pos = rbraceIndex + 1;

    return new SyntaxNode(SyntaxKind.AnimationDeclaration, [animationToken, nameToken, region]);
  }

  // ---- read / watch (store bindings) ----------------------------------

  /**
   * `read <name> = store(<path>)` (one-time, non-reactive snapshot) or
   * `watch <name> = store(<path>)` (reactive — recomputed whenever the
   * store's top-level key changes). Identical shape, parameterized by
   * keyword/result kind. `<path>` is a dotted identifier chain — segment 1
   * is the store's top-level key, the rest unchecked dynamic dot-access
   * (the store is schemaless from the compiler's point of view, see
   * GRAMMAR.md's "Global store" section). No type annotation: there is
   * nothing to check one against.
   */
  private parseReadOrWatchDeclaration(resultKind: SyntaxKind, keywordText: 'read' | 'watch', scaleToken?: Token): SyntaxNode {
    const code = keywordText === 'read' ? 'dsl/invalid-read' : 'dsl/invalid-watch';
    const MSG = `Invalid ${keywordText} declaration. Expected: ${keywordText} <name> = store(<path>)`;
    const prefix: SyntaxChild[] = scaleToken ? [scaleToken] : [];
    const keywordToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, code, MSG);
    if (!nameToken) return this.errorNode([...prefix, keywordToken]);

    const equalsToken = this.expect(TokenKind.Equals, code, MSG);
    if (!equalsToken) return this.errorNode([...prefix, keywordToken, nameToken]);

    const storeToken = this.expect(TokenKind.Store, code, MSG);
    if (!storeToken) return this.errorNode([...prefix, keywordToken, nameToken, equalsToken]);

    const lparenToken = this.expect(TokenKind.LParen, code, MSG);
    if (!lparenToken) return this.errorNode([...prefix, keywordToken, nameToken, equalsToken, storeToken]);

    const pathTokens: Token[] = [];
    const firstSegment = this.expect(TokenKind.Identifier, code, MSG);
    if (!firstSegment) return this.errorNode([...prefix, keywordToken, nameToken, equalsToken, storeToken, lparenToken]);
    pathTokens.push(firstSegment);

    while (this.check(TokenKind.Dot)) {
      pathTokens.push(this.advance());
      const segment = this.expect(TokenKind.Identifier, code, MSG);
      if (!segment) return this.errorNode([...prefix, keywordToken, nameToken, equalsToken, storeToken, lparenToken, ...pathTokens]);
      pathTokens.push(segment);
    }

    const pathNode = new SyntaxNode(SyntaxKind.StorePathExpression, pathTokens);

    const rparenToken = this.expect(TokenKind.RParen, code, MSG);
    if (!rparenToken) return this.errorNode([...prefix, keywordToken, nameToken, equalsToken, storeToken, lparenToken, pathNode]);

    const next = this.peek();
    if (next.kind !== TokenKind.EndOfFile && next.line === rparenToken.line) {
      this.error(code, MSG, next);
      return this.errorNode([...prefix, keywordToken, nameToken, equalsToken, storeToken, lparenToken, pathNode, rparenToken]);
    }

    const finalKind = scaleToken
      ? resultKind === SyntaxKind.WatchDeclaration
        ? SyntaxKind.ScaleWatchDeclaration
        : SyntaxKind.ScaleReadDeclaration
      : resultKind;
    return new SyntaxNode(finalKind, [...prefix, keywordToken, nameToken, equalsToken, storeToken, lparenToken, pathNode, rparenToken]);
  }

  // ---- function -----------------------------------------------------

  /**
   * The `: <Type>` return-type clause is optional — a function with nothing
   * to return simply omits it entirely (there is no `void` type, see
   * `rejectVoidType`), and `codegen/brs-emitter.ts` compiles it to a
   * BrightScript `sub` rather than a `function ... as <Type>`. The optional
   * colon/type pair is pushed onto `headerTail` only when present, so
   * `FunctionDeclaration.returnType` (ast.ts) can find it by scanning for a
   * `Colon` token rather than a fixed index.
   */
  private parseFunctionDeclaration(): SyntaxNode {
    const HEADER_MSG = 'Invalid function header. Expected: private|public function <name>(<param>: <Type>, ...) { or ...): <Type> {';
    const visibilityToken = this.advance(); // Private | Public

    const functionToken = this.expect(TokenKind.Function, 'dsl/invalid-function-header', HEADER_MSG);
    if (!functionToken) return this.errorNode([visibilityToken]);

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-function-header', HEADER_MSG);
    if (!nameToken) return this.errorNode([visibilityToken, functionToken]);

    const msgFor = (functionName: string) => `Invalid function header for "${functionName}". Expected: private|public function <name>(<param>: <Type>, ...) { or ...): <Type> {`;

    const lparenToken = this.expect(TokenKind.LParen, 'dsl/invalid-function-header', msgFor(nameToken.text));
    if (!lparenToken) return this.errorNode([visibilityToken, functionToken, nameToken]);

    const paramList = this.parseParameterList(nameToken.text);
    if (!paramList) return this.errorNode([visibilityToken, functionToken, nameToken, lparenToken]);

    const headerTail: SyntaxChild[] = [];
    if (this.check(TokenKind.Colon)) {
      const colonToken = this.advance();
      const returnTypeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-function-header', msgFor(nameToken.text));
      if (!returnTypeToken) return this.errorNode([visibilityToken, functionToken, nameToken, paramList.node, colonToken]);
      if (!this.rejectVoidType(returnTypeToken)) return this.errorNode([visibilityToken, functionToken, nameToken, paramList.node, colonToken, returnTypeToken]);
      headerTail.push(colonToken, returnTypeToken);
    }

    const lbraceToken = this.expect(TokenKind.LBrace, 'dsl/invalid-function-header', msgFor(nameToken.text));
    if (!lbraceToken) return this.errorNode([visibilityToken, functionToken, nameToken, paramList.node, ...headerTail]);

    const lbraceIndex = this.pos - 1;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('dsl/unterminated-function', `No closing "}" found for function "${nameToken.text}".`, nameToken);
      return this.errorNode([visibilityToken, functionToken, nameToken, paramList.node, ...headerTail, lbraceToken]);
    }

    const blockChildren = this.parseBlockContent(rbraceIndex);
    const rbraceToken = this.tokens[rbraceIndex];
    this.pos = rbraceIndex + 1;
    const block = new SyntaxNode(SyntaxKind.Block, [lbraceToken, ...blockChildren, rbraceToken]);

    return new SyntaxNode(SyntaxKind.FunctionDeclaration, [visibilityToken, functionToken, nameToken, paramList.node, ...headerTail, block]);
  }
}
