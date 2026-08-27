/**
 * Public API for flash-parser — the flash-theater DSL's lossless CST + typed
 * AST, the counterpart to kopytko-brightscript-parser for BrightScript.
 */
export { TokenKind, KEYWORD_MAP } from './tokenKind.js';
export type { Token } from './token.js';
export { tokenFullText, tokensToText } from './token.js';
export { TriviaKind } from './trivia.js';
export type { Trivia } from './trivia.js';
export { tokenize } from './lexer.js';
export type { TokenizeOptions } from './lexer.js';

export { SyntaxKind } from './syntaxKind.js';
export { SyntaxNode, isNode, isToken, firstToken, lastToken } from './syntaxNode.js';
export type { SyntaxChild, EmbeddedParse, EmbeddedBrightScriptParse, EmbeddedXmlParse } from './syntaxNode.js';

export { parse, parseFlshFile, parseThr, parseFlsh } from './parser.js';
export type { ParseResult } from './parser.js';
export type { ParseDiagnostic } from './diagnostics.js';

// Full BrightScript grammar (Phase 0 — see findings/compiler-parser-architecture.md).
// Note: TokenKind/SyntaxKind (exported above) are ONE unified kind space
// covering both the DSL and the full BrightScript grammar — the
// BrightScript keywords/operators live directly on TokenKind, and every
// BrightScript CST node kind is the same SyntaxKind enum's `Bs`-prefixed
// members (BsIfStatement, BsBinaryExpression, ...). No separate
// "BsTokenKind"/"BsSyntaxKind" exists to alias here.
export { tokenizeBrightScript } from './brightscript-lexer.js';
export type { BrightScriptTokenizeOptions } from './brightscript-lexer.js';
export { parseBrightScript } from './brightscript-parser.js';
export type { BrightScriptParseResult, BrightScriptParseDiagnostic } from './brightscript-parser.js';
export {
  wrapBrightScriptNode,
  BsAstNode,
  BsSourceFile,
  BsFunctionDeclaration,
  BsFunctionExpression,
  BsParameterList,
  BsParameter,
  BsReturnTypeClause,
  BsIfStatement,
  BsElseIfClause,
  BsElseClause,
  BsForStatement,
  BsForEachStatement,
  BsWhileStatement,
  BsTryStatement,
  BsCatchClause,
  BsReturnStatement,
  BsPrintStatement,
  BsThrowStatement,
  BsDimStatement,
  BsGotoStatement,
  BsLabelStatement,
  BsStopStatement,
  BsEndStatement,
  BsExitForStatement,
  BsExitWhileStatement,
  BsContinueForStatement,
  BsContinueWhileStatement,
  BsAssignmentStatement,
  BsExpressionStatement,
  BsBinaryExpression,
  BsComparisonExpression,
  BsSafeNotExpression,
  BsUnaryExpression,
  BsGroupingExpression,
  BsCallExpression,
  BsArgumentList,
  BsDotExpression,
  BsIndexExpression,
  BsOptionalChainingExpression,
  BsIdentifierExpression,
  BsLiteralExpression,
  BsArrayLiteral,
  BsAALiteral,
  BsAAField,
  BsConditionalCompilation,
  BsHashConstStatement,
  BsHashErrorStatement,
  BsErrorNodeWrapper,
} from './brightscript-ast.js';
export { buildScopes as buildBrightScriptScopes, resolve as resolveBrightScriptName, findScopeAtLine as findBrightScriptScopeAtLine } from './brightscript-scope.js';
export type { Scope as BrightScriptScope, Declaration as BrightScriptDeclaration, Reference as BrightScriptReference, DeclarationKind as BrightScriptDeclarationKind } from './brightscript-scope.js';

// SceneGraph XML grammar (Phase 0's other remaining delegation point, now owned outright).
export { XmlTokenKind, XmlTriviaKind, XmlSyntaxKind, xmlTokenFullText, xmlTokensToText, isXmlNode, isXmlToken, XmlSyntaxNode } from './xml/xml-syntax.js';
export type { XmlToken, XmlTrivia, XmlSyntaxChild } from './xml/xml-syntax.js';
export { xmlTokenize } from './xml/xml-lexer.js';
export { parseXml } from './xml/xml-parser.js';
export type { XmlParseResult, XmlParseDiagnostic } from './xml/xml-parser.js';
export { XmlDocument, XmlElement, XmlAttribute, parseSceneGraphXml } from './xml/xml-ast.js';

export {
  wrapNode,
  AstNode,
  ThrFile,
  DeclarationsSection,
  ScriptSection,
  ThemeTemplateSection,
  ThemeVariantSection,
  ThemeGroupDeclaration,
  ThemeLeafDeclaration,
  FieldDeclaration,
  DerivedDeclaration,
  StateDeclaration,
  ReadDeclaration,
  WatchDeclaration,
  ScaleFieldDeclaration,
  ScaleStateDeclaration,
  ScaleDerivedDeclaration,
  ScaleReadDeclaration,
  ScaleWatchDeclaration,
  ScaleLocalAssignmentStatement,
  ScaleStateAssignmentStatement,
  StreamDeclaration,
  RequestDeclaration,
  AnimationDeclaration,
  StorePathExpression,
  StoreWriteStatement,
  FocusStatement,
  JumpFocusStatement,
  FunctionDeclaration,
  Block,
  IfStatement,
  ElseClause,
  ForStatement,
  ForEachStatement,
  WhileStatement,
  TryStatement,
  CatchClause,
  StateAssignment,
  ExpressionRegion,
  StatementRegion,
  RawBrightScriptStatement,
  TernaryExpression,
  TernaryOperand,
  TernaryAssignmentStatement,
  AnonymousFunctionExpression,
  AnonymousFunctionAssignmentStatement,
  reconstructTernaryText,
  TemplateSection,
  ImportDeclaration,
  ClassDeclaration,
  ClassFieldDeclaration,
  ClassStreamFieldDeclaration,
  ConstructorDeclaration,
  ConstructorBody,
  ConstructorFieldInit,
  SuperCallStatement,
  ClassMethodDeclaration,
  FlshFile,
} from './ast.js';
export type { ParameterInfo, FunctionVisibility, ThrFileKind, ThemeMember, ClassVisibility } from './ast.js';

export { RAW_BLOCK_START_MARKER, RAW_BLOCK_END_MARKER } from './raw-block.js';

export { walk, findAll } from './visitor.js';
export type { AstVisitor } from './visitor.js';

export type { TemplateAttribute, TemplateNode, TemplateElementNode, TemplateIfNode, TemplateEachNode } from './templateModel.js';
export type { ComponentOnKeyBinding } from './template-classify.js';

export {
  parseEmbeddedExpression,
  parseEmbeddedStatements,
  parseEmbeddedCallArgs,
  splitEmbeddedCallArgs,
  findTopLevelIdentifiers,
  findGlobalPathAccesses,
  findMemberAccesses,
  findRootCallExpression,
  findComparisonExpressions,
  findSafeNotExpressions,
  findChainAccesses,
  findAnonymousFunctionExpressions,
  findStreamSubscribeBoundReferences,
  findAnimationControlCalls,
  findAnimationOnFinishCalls,
  findGlobalFunctionCalls,
  translateBrightScriptDiagnostics,
} from './embedded.js';
export type {
  EmbeddedBrightScriptText,
  EmbeddedIdentifier,
  GlobalPathAccess,
  MemberAccess,
  RootCallExpressionShape,
  ComparisonAccess,
  SafeNotAccess,
  ChainAccess,
  AnonymousFunctionAccess,
  StreamSubscribeBoundReference,
  AnimationControlCallMatch,
  AnimationOnFinishCallMatch,
  GlobalFunctionCallMatch,
} from './embedded.js';
