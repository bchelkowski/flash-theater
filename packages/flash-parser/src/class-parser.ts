import { TokenKind } from './tokenKind.js';
import { Token } from './token.js';
import { SyntaxKind } from './syntaxKind.js';
import { isNode, SyntaxChild, SyntaxNode } from './syntaxNode.js';
import { parseEmbeddedCallArgs } from './embedded.js';
import { TokenStreamParser } from './token-stream-parser.js';
import { hasRawStartMarker } from './raw-block.js';

/**
 * Token-stream-driven recursive-descent parser for a `.flsh` file's top
 * level (zero or more `import`s + exactly one `class`) and for a `class`
 * declaration's own body (fields, an optional constructor, methods). See
 * GRAMMAR.md's "`.flsh` files" and "class declarations" sections.
 */
export class ClassParser extends TokenStreamParser {
  /** A `.flsh` file's root: zero or more `ImportDeclaration`s followed by exactly one `ClassDeclaration`, then nothing else. */
  parseFlshFileBody(): SyntaxNode {
    const children: SyntaxChild[] = [];
    let sawClass = false;

    while (!this.check(TokenKind.EndOfFile)) {
      if (this.diagnostics.length > 0) break; // Policy: first error wins, see GRAMMAR.md

      if (sawClass) {
        this.error('flsh/trailing-content', 'A .flsh file must contain nothing after its single class declaration.', this.peek());
        break;
      }

      if (this.check(TokenKind.Import)) {
        children.push(this.parseImportDeclaration());
        continue;
      }

      if (this.check(TokenKind.Class)) {
        sawClass = true;
        children.push(this.parseClassDeclaration());
        continue;
      }

      const token = this.peek();
      this.error(
        'flsh/expected-import-or-class',
        `Unexpected content in a .flsh file — expected "import <Name> from \"...\"" or "class <Name> ...": "${token.text}"`,
        token,
      );
      children.push(this.errorNode([this.advance()]));
      break;
    }

    if (this.diagnostics.length === 0 && !sawClass) {
      this.error('flsh/missing-class', 'A .flsh file must declare exactly one class.', this.peek());
    }

    // Attach the EndOfFile token itself — its own leadingTrivia carries
    // whatever trailing whitespace (typically just the file's final "\n")
    // follows the class declaration. Omitting this (as this function
    // previously did) silently drops that trailing content from getText(),
    // since flash-parser's Token model only ever attaches trivia as a
    // token's *leading* trivia (see trivia.ts) — with no token after the
    // class's closing "}", that trivia has nowhere to attach. Confirmed live:
    // every real .flsh file in this repo lost its own final "\n" on
    // round-trip before this fix (see the identical bug/fix in
    // parseThemeTemplateFile/parseThemeVariantFile, parser.ts).
    if (this.check(TokenKind.EndOfFile)) children.push(this.advance());

    return new SyntaxNode(SyntaxKind.FlshFile, children);
  }

  // ---- class ------------------------------------------------------------

  /** `class <Name> [extends <Base>] { <member>* }`. */
  private parseClassDeclaration(): SyntaxNode {
    const HEADER_MSG = 'Invalid class header. Expected: class <Name> [extends <Base>] {';
    const classToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-class-header', HEADER_MSG);
    if (!nameToken) return this.errorNode([classToken]);

    const headerMsgFor = (className: string) => `Invalid class header for "${className}". Expected: class <Name> [extends <Base>] {`;

    const prefix: SyntaxChild[] = [classToken, nameToken];
    let hasExtends = false;

    if (this.check(TokenKind.Extends)) {
      const extendsToken = this.advance();
      const baseNameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-class-header', headerMsgFor(nameToken.text));
      if (!baseNameToken) return this.errorNode([...prefix, extendsToken]);
      prefix.push(extendsToken, baseNameToken);
      hasExtends = true;
    }

    const lbraceToken = this.expect(TokenKind.LBrace, 'dsl/invalid-class-header', headerMsgFor(nameToken.text));
    if (!lbraceToken) return this.errorNode(prefix);

    const lbraceIndex = this.pos - 1;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('dsl/unterminated-class', `No closing "}" found for class "${nameToken.text}".`, nameToken);
      return this.errorNode([...prefix, lbraceToken]);
    }

    const memberChildren = this.parseClassMembers(rbraceIndex, nameToken.text, hasExtends);
    const rbraceToken = this.tokens[rbraceIndex];
    this.pos = rbraceIndex + 1;

    return new SyntaxNode(SyntaxKind.ClassDeclaration, [...prefix, lbraceToken, ...memberChildren, rbraceToken]);
  }

  /**
   * Dispatches each class-body member on its leading token(s): `[override]
   * constructor` → constructor, `[override] public|private|protected
   * function` → method (2-token lookahead needed to tell a method header
   * apart from a field, which also starts with a visibility keyword),
   * `public|private|protected <name>:` → field. At most one constructor is
   * allowed (`dsl/multiple-constructors`). Once the member list itself
   * parses cleanly, runs the extends/override/super structural checks in
   * `validateClassStructure` — kept as a separate post-pass rather than
   * interleaved here since several of those checks (e.g. "does this
   * extending class have an override constructor at all") can only be
   * answered after every member has been seen.
   */
  private parseClassMembers(endExclusive: number, className: string, hasExtends: boolean): SyntaxChild[] {
    const children: SyntaxChild[] = [];
    let constructorNode: SyntaxNode | undefined;

    while (this.pos < endExclusive) {
      if (this.diagnostics.length > 0) break;

      if (this.check(TokenKind.Override)) {
        const overrideToken = this.advance();

        if (this.check(TokenKind.Constructor)) {
          if (constructorNode) {
            this.error('dsl/multiple-constructors', `Class "${className}" declares more than one constructor.`, overrideToken);
            break;
          }
          const node = this.parseConstructorDeclaration(overrideToken);
          constructorNode = node;
          children.push(node);
          continue;
        }

        if (this.check(TokenKind.Public) || this.check(TokenKind.Private) || this.check(TokenKind.Protected)) {
          children.push(this.parseClassMethod(overrideToken));
          continue;
        }

        this.error(
          'dsl/invalid-class-member',
          'Expected "constructor" or a visibility keyword ("public"/"private"/"protected") after "override".',
          this.peek(),
        );
        break;
      }

      if (this.check(TokenKind.Constructor)) {
        if (constructorNode) {
          this.error('dsl/multiple-constructors', `Class "${className}" declares more than one constructor.`, this.peek());
          break;
        }
        const node = this.parseConstructorDeclaration(undefined);
        constructorNode = node;
        children.push(node);
        continue;
      }

      if (this.check(TokenKind.Public) || this.check(TokenKind.Private) || this.check(TokenKind.Protected)) {
        const next = this.tokens[this.pos + 1];
        if (next && next.kind === TokenKind.Function) {
          children.push(this.parseClassMethod(undefined));
          continue;
        }
        if (next && next.kind === TokenKind.Stream) {
          children.push(this.parseClassStreamFieldDeclaration());
          continue;
        }
        children.push(this.parseClassFieldDeclaration());
        continue;
      }

      const token = this.peek();
      this.error(
        'dsl/invalid-class-member',
        `Unexpected content in class "${className}" — expected a field, constructor, or method declaration: "${token.text}"`,
        token,
      );
      children.push(this.errorNode([this.advance()]));
      break;
    }

    if (this.diagnostics.length === 0) {
      this.validateClassStructure(className, hasExtends, children, constructorNode);
    }

    return children;
  }

  /**
   * Cross-member structural checks that can only run once every class
   * member has been seen — see GRAMMAR.md's "class declarations" section:
   * `override` requires `extends` (on the class doing the overriding);
   * `super(...)` requires `extends` too, and only makes sense inside an
   * `override constructor`; an extending class must have an explicit
   * `override constructor` (no implicit base-constructor inheritance in
   * this pass); that constructor's `super(...)` call must appear exactly
   * once, as its first statement.
   */
  private validateClassStructure(className: string, hasExtends: boolean, members: readonly SyntaxChild[], constructorNode: SyntaxNode | undefined): void {
    if (!hasExtends) {
      for (const member of members) {
        if (!isNode(member)) continue;
        if (
          (member.kind === SyntaxKind.ConstructorDeclaration || member.kind === SyntaxKind.ClassMethodDeclaration) &&
          member.findToken(TokenKind.Override)
        ) {
          this.error(
            'dsl/override-without-extends',
            `"override" used in class "${className}", which has no "extends" — there is no base member to override.`,
            member.childTokens[0],
          );
          return;
        }
      }

      if (constructorNode) {
        const body = constructorNode.findChild(SyntaxKind.ConstructorBody);
        const superCall = body?.findChild(SyntaxKind.SuperCallStatement);
        if (superCall) {
          this.error(
            'dsl/unexpected-super-call',
            `super(...) used in class "${className}"'s constructor, which has no "extends" — there is no base constructor to call.`,
            superCall.childTokens[0],
          );
        }
      }
      return;
    }

    const isOverrideConstructor = constructorNode !== undefined && constructorNode.findToken(TokenKind.Override) !== undefined;
    if (!isOverrideConstructor) {
      const anchor = constructorNode?.childTokens[0] ?? this.peek();
      this.error(
        'dsl/missing-override-constructor',
        `Class "${className}" extends a base class but has no "override constructor" — an explicit "override constructor(...) { super(...); ... }" is required.`,
        anchor,
      );
      return;
    }

    const body = constructorNode!.findChild(SyntaxKind.ConstructorBody)!;
    const bodyStatements = body.children.slice(1, -1).filter(isNode);
    const superCallIndex = bodyStatements.findIndex((s) => s.kind === SyntaxKind.SuperCallStatement);

    if (superCallIndex === -1) {
      const anchor = bodyStatements[0]?.childTokens[0] ?? body.childTokens[0] ?? this.peek();
      this.error(
        'dsl/missing-super-call',
        `Class "${className}"'s override constructor must start with a super(...) call to the base class.`,
        anchor,
      );
      return;
    }

    if (superCallIndex !== 0) {
      this.error(
        'dsl/super-call-not-first',
        `Class "${className}"'s super(...) call must be the constructor's first statement.`,
        bodyStatements[superCallIndex].childTokens[0],
      );
      return;
    }

    for (let i = 1; i < bodyStatements.length; i++) {
      if (bodyStatements[i].kind === SyntaxKind.SuperCallStatement) {
        this.error(
          'dsl/super-call-not-first',
          `Class "${className}"'s constructor calls super(...) more than once — it must appear exactly once, as the first statement.`,
          bodyStatements[i].childTokens[0],
        );
        return;
      }
    }
  }

  // ---- fields -------------------------------------------------------

  /** `[public|private|protected] <name>: <Type> = <literal>` at class-body top level — a class-owned default assigned once, before the constructor runs. `<Type>` is an unrestricted identifier, same rationale as `state`/`derived`: a class field is a private/public AA member, never a SceneGraph `<field>`. */
  private parseClassFieldDeclaration(): SyntaxNode {
    const MSG = 'Invalid class field. Expected: public|private|protected <name>: <Type> = <literal>';
    const visibilityToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-class-field', MSG);
    if (!nameToken) return this.errorNode([visibilityToken]);

    const colonToken = this.expect(TokenKind.Colon, 'dsl/invalid-class-field', MSG);
    if (!colonToken) return this.errorNode([visibilityToken, nameToken]);

    const typeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-class-field', MSG);
    if (!typeToken) return this.errorNode([visibilityToken, nameToken, colonToken]);
    if (!this.rejectVoidType(typeToken)) return this.errorNode([visibilityToken, nameToken, colonToken, typeToken]);

    const equalsToken = this.expect(TokenKind.Equals, 'dsl/invalid-class-field', MSG);
    if (!equalsToken) return this.errorNode([visibilityToken, nameToken, colonToken, typeToken]);

    const literalToken = this.expectLiteral(MSG, 'dsl/invalid-class-field');
    if (!literalToken) return this.errorNode([visibilityToken, nameToken, colonToken, typeToken, equalsToken]);

    const next = this.peek();
    if (next.kind !== TokenKind.EndOfFile && next.line === literalToken.line) {
      this.error('dsl/invalid-class-field', MSG, next);
      return this.errorNode([visibilityToken, nameToken, colonToken, typeToken, equalsToken, literalToken]);
    }

    return new SyntaxNode(SyntaxKind.ClassFieldDeclaration, [visibilityToken, nameToken, colonToken, typeToken, equalsToken, literalToken]);
  }

  /**
   * `[public|private|protected] stream <name>: <Type>` — a class-owned
   * stream field, same "no initializer" shape as the script-level `stream`
   * declaration (`ScriptParser.parseStreamDeclaration`): its runtime value
   * is always a fresh `ft_createStream()` AA, never a literal. Only valid at
   * class-body top level — a constructor's own field-init grammar
   * (`parseConstructorFieldInit`) unconditionally requires `= <expr>`, so
   * `private stream x: T` inside a constructor already fails there with the
   * existing `dsl/invalid-constructor-field-init`, no new diagnostic needed.
   */
  private parseClassStreamFieldDeclaration(): SyntaxNode {
    const MSG = 'Invalid class stream field. Expected: public|private|protected stream <name>: <Type>';
    const visibilityToken = this.advance();

    const streamToken = this.expect(TokenKind.Stream, 'dsl/invalid-class-stream-field', MSG);
    if (!streamToken) return this.errorNode([visibilityToken]);

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-class-stream-field', MSG);
    if (!nameToken) return this.errorNode([visibilityToken, streamToken]);

    const colonToken = this.expect(TokenKind.Colon, 'dsl/invalid-class-stream-field', MSG);
    if (!colonToken) return this.errorNode([visibilityToken, streamToken, nameToken]);

    const typeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-class-stream-field', MSG);
    if (!typeToken) return this.errorNode([visibilityToken, streamToken, nameToken, colonToken]);
    if (!this.rejectVoidType(typeToken)) return this.errorNode([visibilityToken, streamToken, nameToken, colonToken, typeToken]);

    const next = this.peek();
    if (next.kind !== TokenKind.EndOfFile && next.line === typeToken.line) {
      this.error('dsl/invalid-class-stream-field', MSG, next);
      return this.errorNode([visibilityToken, streamToken, nameToken, colonToken, typeToken]);
    }

    return new SyntaxNode(SyntaxKind.ClassStreamFieldDeclaration, [visibilityToken, streamToken, nameToken, colonToken, typeToken]);
  }

  // ---- constructor ----------------------------------------------------

  /** `[override] constructor(<param>: <Type>, ...) { <ConstructorBody> }`. */
  private parseConstructorDeclaration(overrideToken: Token | undefined): SyntaxNode {
    const HEADER_MSG = 'Invalid constructor header. Expected: [override] constructor(<param>: <Type>, ...) {';
    const constructorToken = this.advance();
    const prefix: SyntaxChild[] = overrideToken ? [overrideToken, constructorToken] : [constructorToken];

    const lparenToken = this.expect(TokenKind.LParen, 'dsl/invalid-constructor-header', HEADER_MSG);
    if (!lparenToken) return this.errorNode(prefix);

    const paramList = this.parseParameterList('constructor');
    if (!paramList) return this.errorNode(prefix);

    const lbraceToken = this.expect(TokenKind.LBrace, 'dsl/invalid-constructor-header', HEADER_MSG);
    if (!lbraceToken) return this.errorNode([...prefix, paramList.node]);

    const lbraceIndex = this.pos - 1;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('dsl/unterminated-class', 'No closing "}" found for constructor.', constructorToken);
      return this.errorNode([...prefix, paramList.node, lbraceToken]);
    }

    const bodyChildren = this.parseConstructorBlockContent(rbraceIndex);
    const rbraceToken = this.tokens[rbraceIndex];
    this.pos = rbraceIndex + 1;
    const body = new SyntaxNode(SyntaxKind.ConstructorBody, [lbraceToken, ...bodyChildren, rbraceToken]);

    return new SyntaxNode(SyntaxKind.ConstructorDeclaration, [...prefix, paramList.node, body]);
  }

  /**
   * A constructor body's statement loop — deliberately separate from the
   * shared `parseBlockContent` (an ordinary method's `Block`): it
   * recognizes `super(...)` and `[visibility] <name>: <Type> = <expr>`
   * field-inits, which only ever make sense inside a constructor, plus the
   * shared `if`. `state`/`store` are NOT special-cased here — a class has no
   * `state` declarations to write to in the first place, so `state x = ...`
   * simply falls through to the generic passthrough scan below and surfaces
   * as an ordinary `statement/parse-error` from `kopytko-brightscript-parser`
   * (since `state` isn't a real BrightScript keyword) rather than needing a
   * dedicated diagnostic.
   */
  private parseConstructorBlockContent(endExclusive: number): SyntaxChild[] {
    const children: SyntaxChild[] = [];

    while (this.pos < endExclusive) {
      if (this.diagnostics.length > 0) break;

      const rawBlock = this.tryParseRawBlock(endExclusive);
      if (rawBlock) {
        children.push(rawBlock);
        continue;
      }

      const kind = this.tokens[this.pos].kind;

      if (kind === TokenKind.Super) {
        children.push(this.parseSuperCallStatement());
        continue;
      }

      if (kind === TokenKind.Public || kind === TokenKind.Private || kind === TokenKind.Protected) {
        children.push(this.parseConstructorFieldInit());
        continue;
      }

      if (kind === TokenKind.If) {
        children.push(this.parseIfStatement());
        continue;
      }

      if (kind === TokenKind.Else) {
        this.error('statement/dangling-else', 'else with no matching if.', this.tokens[this.pos]);
        break;
      }

      if (kind === TokenKind.For) {
        children.push(this.parseForOrForEachStatement());
        continue;
      }

      if (kind === TokenKind.While) {
        children.push(this.parseWhileStatement());
        continue;
      }

      if (kind === TokenKind.Try) {
        children.push(this.parseTryStatement());
        continue;
      }

      if (kind === TokenKind.Catch) {
        this.error('statement/dangling-catch', 'catch with no matching try.', this.tokens[this.pos]);
        break;
      }

      const regionStart = this.pos;
      while (
        this.pos < endExclusive &&
        this.tokens[this.pos].kind !== TokenKind.Super &&
        this.tokens[this.pos].kind !== TokenKind.Public &&
        this.tokens[this.pos].kind !== TokenKind.Private &&
        this.tokens[this.pos].kind !== TokenKind.Protected &&
        this.tokens[this.pos].kind !== TokenKind.If &&
        this.tokens[this.pos].kind !== TokenKind.Else &&
        this.tokens[this.pos].kind !== TokenKind.For &&
        this.tokens[this.pos].kind !== TokenKind.While &&
        this.tokens[this.pos].kind !== TokenKind.Try &&
        this.tokens[this.pos].kind !== TokenKind.Catch &&
        // A raw block's own start marker must never be silently swallowed into this StatementRegion
        // as inert comment text — stop here so the outer loop's tryParseRawBlock() check picks it up
        // on its next iteration (see the identical fix in token-stream-parser.ts's parseBlockContent).
        !(this.pos > regionStart && hasRawStartMarker(this.tokens[this.pos].leadingTrivia))
      ) {
        this.pos++;
      }
      const regionTokens = this.tokens.slice(regionStart, this.pos);
      if (regionTokens.length > 0) children.push(this.makeStatementRegion(regionTokens));
    }

    return children;
  }

  /** `[public|private|protected] <name>: <Type> = <expr>` inside a constructor body — declares AND assigns an instance field from a constructor param or expression. Same single-line-scan shape as `parseDerivedDeclaration`/`parseStateAssignment`. */
  private parseConstructorFieldInit(): SyntaxNode {
    const MSG = 'Invalid constructor field init. Expected: public|private|protected <name>: <Type> = <expression>';
    const visibilityToken = this.advance();

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-constructor-field-init', MSG);
    if (!nameToken) return this.errorNode([visibilityToken]);

    const colonToken = this.expect(TokenKind.Colon, 'dsl/invalid-constructor-field-init', MSG);
    if (!colonToken) return this.errorNode([visibilityToken, nameToken]);

    const typeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-constructor-field-init', MSG);
    if (!typeToken) return this.errorNode([visibilityToken, nameToken, colonToken]);
    if (!this.rejectVoidType(typeToken)) return this.errorNode([visibilityToken, nameToken, colonToken, typeToken]);

    const equalsToken = this.expect(TokenKind.Equals, 'dsl/invalid-constructor-field-init', MSG);
    if (!equalsToken) return this.errorNode([visibilityToken, nameToken, colonToken, typeToken]);

    if (this.peek().kind === TokenKind.EndOfFile || this.peek().line !== equalsToken.line) {
      this.error('dsl/invalid-constructor-field-init', MSG, equalsToken);
      return this.errorNode([visibilityToken, nameToken, colonToken, typeToken, equalsToken]);
    }

    const exprTokens: Token[] = [];
    while (this.peek().kind !== TokenKind.EndOfFile && this.peek().line === equalsToken.line) {
      exprTokens.push(this.advance());
    }

    const region = this.makeExpressionRegion(exprTokens);
    return new SyntaxNode(SyntaxKind.ConstructorFieldInit, [visibilityToken, nameToken, colonToken, typeToken, equalsToken, region]);
  }

  /**
   * `super(<args>)` — the raw, comma-separated argument-list text between
   * the parens is wrapped with a synthetic callee (`parseEmbeddedCallArgs`)
   * so `kopytko-brightscript-parser` can validate it as a real call's
   * argument list without this DSL needing its own comma-list grammar. The
   * wrapped parse is attached to the args span the same way
   * `makeExpressionRegion` attaches an ordinary expression's parse — later,
   * `splitEmbeddedCallArgs` (embedded.ts) re-derives the individual
   * argument texts from that same (memoized) parse on demand.
   */
  private parseSuperCallStatement(): SyntaxNode {
    const superToken = this.advance();

    const lparenToken = this.expect(TokenKind.LParen, 'dsl/invalid-super-call', 'Invalid super call. Expected: super(<args>)');
    if (!lparenToken) return this.errorNode([superToken]);

    const lparenIndex = this.pos - 1;
    const rparenIndex = this.findMatchingParen(lparenIndex);
    if (rparenIndex === -1) {
      this.error('dsl/invalid-super-call', 'Unterminated super(...) call.', superToken);
      return this.errorNode([superToken, lparenToken]);
    }

    const argTokens = this.tokens.slice(this.pos, rparenIndex);
    const rparenToken = this.tokens[rparenIndex];
    this.pos = rparenIndex + 1;

    const argsRegion = new SyntaxNode(SyntaxKind.ExpressionRegion, argTokens);
    this.attachBrightScriptParse(argsRegion, parseEmbeddedCallArgs, 'dsl/invalid-super-call');

    return new SyntaxNode(SyntaxKind.SuperCallStatement, [superToken, lparenToken, argsRegion, rparenToken]);
  }

  // ---- methods --------------------------------------------------------

  /** `[override] public|private|protected function <name>(<param>: <Type>, ...) [: <Type>] { <Block> }` — identical shape to a `.thr` `FunctionDeclaration` plus the optional leading `override` and a third `protected` visibility; the body reuses the shared `Block` grammar completely unchanged. */
  private parseClassMethod(overrideToken: Token | undefined): SyntaxNode {
    const HEADER_MSG = 'Invalid class method header. Expected: [override] public|private|protected function <name>(<param>: <Type>, ...) { or ...): <Type> {';
    const visibilityToken = this.advance();
    const prefix: SyntaxChild[] = overrideToken ? [overrideToken, visibilityToken] : [visibilityToken];

    const functionToken = this.expect(TokenKind.Function, 'dsl/invalid-class-method-header', HEADER_MSG);
    if (!functionToken) return this.errorNode(prefix);

    const nameToken = this.expect(TokenKind.Identifier, 'dsl/invalid-class-method-header', HEADER_MSG);
    if (!nameToken) return this.errorNode([...prefix, functionToken]);

    const msgFor = (methodName: string) =>
      `Invalid class method header for "${methodName}". Expected: [override] public|private|protected function <name>(<param>: <Type>, ...) { or ...): <Type> {`;

    const lparenToken = this.expect(TokenKind.LParen, 'dsl/invalid-class-method-header', msgFor(nameToken.text));
    if (!lparenToken) return this.errorNode([...prefix, functionToken, nameToken]);

    const paramList = this.parseParameterList(nameToken.text);
    if (!paramList) return this.errorNode([...prefix, functionToken, nameToken]);

    const headerTail: SyntaxChild[] = [];
    if (this.check(TokenKind.Colon)) {
      const colonToken = this.advance();
      const returnTypeToken = this.expect(TokenKind.Identifier, 'dsl/invalid-class-method-header', msgFor(nameToken.text));
      if (!returnTypeToken) return this.errorNode([...prefix, functionToken, nameToken, paramList.node, colonToken]);
      if (!this.rejectVoidType(returnTypeToken)) return this.errorNode([...prefix, functionToken, nameToken, paramList.node, colonToken, returnTypeToken]);
      headerTail.push(colonToken, returnTypeToken);
    }

    const lbraceToken = this.expect(TokenKind.LBrace, 'dsl/invalid-class-method-header', msgFor(nameToken.text));
    if (!lbraceToken) return this.errorNode([...prefix, functionToken, nameToken, paramList.node, ...headerTail]);

    const lbraceIndex = this.pos - 1;
    const rbraceIndex = this.findMatchingBrace(lbraceIndex);
    if (rbraceIndex === -1) {
      this.error('dsl/unterminated-class', `No closing "}" found for method "${nameToken.text}".`, nameToken);
      return this.errorNode([...prefix, functionToken, nameToken, paramList.node, ...headerTail, lbraceToken]);
    }

    const blockChildren = this.parseBlockContent(rbraceIndex);
    const rbraceToken = this.tokens[rbraceIndex];
    this.pos = rbraceIndex + 1;
    const block = new SyntaxNode(SyntaxKind.Block, [lbraceToken, ...blockChildren, rbraceToken]);

    return new SyntaxNode(SyntaxKind.ClassMethodDeclaration, [...prefix, functionToken, nameToken, paramList.node, ...headerTail, block]);
  }
}
