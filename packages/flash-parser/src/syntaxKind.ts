export enum SyntaxKind {
  ThrFile = 'ThrFile',
  ScriptSection = 'ScriptSection',
  /** A `<theme-template>` file's body — the canonical theme shape + defaults. */
  ThemeTemplateSection = 'ThemeTemplateSection',
  /** A `<theme name="...">` file's body — a partial override of the template. */
  ThemeVariantSection = 'ThemeVariantSection',
  /** `<name>: { <member>* }` inside a theme template/variant — unbounded nesting. */
  ThemeGroupDeclaration = 'ThemeGroupDeclaration',
  /** `<name>: <Type> = <literal>` inside a theme template/variant — same shape as `FieldDeclaration` minus the `field` keyword. */
  ThemeLeafDeclaration = 'ThemeLeafDeclaration',
  FieldDeclaration = 'FieldDeclaration',
  DerivedDeclaration = 'DerivedDeclaration',
  /** `state <name>: <Type> = <literal>` — component-local reactive state, declared like `field`. */
  StateDeclaration = 'StateDeclaration',
  FunctionDeclaration = 'FunctionDeclaration',
  ParameterList = 'ParameterList',
  Parameter = 'Parameter',
  Block = 'Block',
  IfStatement = 'IfStatement',
  /** An `if`'s `else` continuation — `else { }`, `else if (...)` (a nested IfStatement), or inline `else <stmt>`. */
  ElseClause = 'ElseClause',
  /** `for (<var> = <start> to <end> [step <step>]) { }` — JS-bracket sugar over BrightScript's `for`/`end for`, never surfacing `then`/`end for` in DSL source. See GRAMMAR.md. */
  ForStatement = 'ForStatement',
  /** `for each (<item> in <collection>) { }` — JS-bracket sugar over BrightScript's `for each`/`end for`. */
  ForEachStatement = 'ForEachStatement',
  /** `while (<condition>) { }` — JS-bracket sugar over BrightScript's `while`/`end while`. */
  WhileStatement = 'WhileStatement',
  /** `try { } catch (<name>) { }` — JS-bracket sugar over BrightScript's `try`/`catch`/`end try`. Always has exactly one `CatchClause` — this DSL has no catch-less `try`. */
  TryStatement = 'TryStatement',
  /** A `TryStatement`'s mandatory `catch (<name>) { }` clause — parens around the caught variable are mandatory in this DSL, unlike real BrightScript's optional-paren `catch e`/`catch (e)`. */
  CatchClause = 'CatchClause',
  /** `state <name> = <expr>` — a function-body statement writing to a declared `state`. */
  StateAssignment = 'StateAssignment',
  /** `read <name> = store(<path>)` — a one-time, non-reactive snapshot of a store value, evaluated once in `init()`. */
  ReadDeclaration = 'ReadDeclaration',
  /** `watch <name> = store(<path>)` — a reactive store binding, recomputed whenever the store's top-level key changes. */
  WatchDeclaration = 'WatchDeclaration',
  /** `scale field <name>: <Type> = <literal>` — same shape as `FieldDeclaration`, index-shifted by 1 for the leading `scale` token. See GRAMMAR.md's "scale" section. */
  ScaleFieldDeclaration = 'ScaleFieldDeclaration',
  /** `scale state <name>: <Type> = <literal>` — same shape as `StateDeclaration`, index-shifted by 1. */
  ScaleStateDeclaration = 'ScaleStateDeclaration',
  /** `scale derived <name>: <Type> = <expression>` — same shape as `DerivedDeclaration`, index-shifted by 1. */
  ScaleDerivedDeclaration = 'ScaleDerivedDeclaration',
  /** `scale watch <name> = store(<path>)` — same shape as `WatchDeclaration`, index-shifted by 1. */
  ScaleWatchDeclaration = 'ScaleWatchDeclaration',
  /** `scale read <name> = store(<path>)` — same shape as `ReadDeclaration`, index-shifted by 1. */
  ScaleReadDeclaration = 'ScaleReadDeclaration',
  /** `scale <name> = <expr>` — a function-body statement declaring/assigning a local variable whose value is scaled at runtime. See GRAMMAR.md's "scale" section. */
  ScaleLocalAssignmentStatement = 'ScaleLocalAssignmentStatement',
  /** `scale state <name> = <expr>` — the function-body write form of a declared `state`, also scaled at runtime. */
  ScaleStateAssignmentStatement = 'ScaleStateAssignmentStatement',
  /** `stream <name>: <Type>` — a per-instance, BehaviorSubject-like pub-sub value. No `=`/initializer, unlike every other script-level declaration: its runtime value is always a fresh ft_createStream() AA. See GRAMMAR.md's "stream" section. */
  StreamDeclaration = 'StreamDeclaration',
  /** `request <Kind> { ... }` — declares this component as a single HTTP request/endpoint, at most one per file (enforced in packages/compiler, not here). `<Kind>` is captured as a plain identifier token, unvalidated at this layer — same discipline as `extends="..."` staying unvalidated in the parser. See GRAMMAR.md's "Requests" section. */
  RequestDeclaration = 'RequestDeclaration',
  /** `animation <name> { ... }` — declares a named, reusable Roku Animation/composition. `<name>` is a real DSL identifier (referenced later via `.start()`/`.stop()`/... and template `transition:`/`in:`/`out:` attribute values), unlike `request`'s `<Kind>` enum-like identifier. Any number allowed per file, unlike `request`. The `{ ... }` config literal is captured the same opaque, brace-matched way `request`'s is — unvalidated at this layer. See GRAMMAR.md's "animation" section. */
  AnimationDeclaration = 'AnimationDeclaration',
  /** A dotted identifier chain inside `store(<path>)` — segment 1 is the store's top-level key, the rest is unchecked dynamic dot-access. */
  StorePathExpression = 'StorePathExpression',
  /** `store(<topLevelKey>) = <expr>` — a function-body statement; the path must be exactly one segment (no dots), enforced at parse time. */
  StoreWriteStatement = 'StoreWriteStatement',
  /** `focus(<expr>)` — a function-body statement transferring real focus into another component, identified by node reference or string id. */
  FocusStatement = 'FocusStatement',
  /** `jumpFocus(<direction>, <count>, <press>)` — a function-body statement jumping real focus several registered candidates at once in a geometric direction, RowList-style; the reserved-keyword counterpart to the automatic single-step LRUD `navigate()` fallthrough. */
  JumpFocusStatement = 'JumpFocusStatement',
  /** A raw span of embedded BrightScript expression text (a `derived` RHS or an `if` condition) — see embedded.ts. */
  ExpressionRegion = 'ExpressionRegion',
  /** A raw span of embedded BrightScript statement text (function-body content that isn't a DSL `if`) — see embedded.ts. */
  StatementRegion = 'StatementRegion',
  /** `' flash-theater:raw` ... `' flash-theater:end-raw` — a marker-delimited span of BrightScript copied byte-for-byte into generated `.brs`, bypassing identifier-rewrite entirely. See GRAMMAR.md's "Raw BrightScript passthrough" section and raw-block.ts. */
  RawBrightScriptRegion = 'RawBrightScriptRegion',
  /** `<condition> ? <whenTrue> : <whenFalse>` — DSL-only syntax (BrightScript has no ternary). See ternary.ts. */
  TernaryExpression = 'TernaryExpression',
  /** An otherwise-opaque expression with one or more `TernaryExpression`s nested somewhere inside it (e.g. `1 + (cond ? a : b)`) — see ternary.ts. */
  TernaryOperand = 'TernaryOperand',
  /** `<target> = <expr>` in a function body where `<expr>` contains a ternary somewhere — a ternary-free plain assignment stays an ordinary `StatementRegion`, see ternary.ts. */
  TernaryAssignmentStatement = 'TernaryAssignmentStatement',
  /** `function (<param>: <Type>, ...) [: <Type>] { <Block> }` used as a value — an anonymous function/closure literal, using this DSL's own `: Type` convention (never BrightScript's `as Type`). See GRAMMAR.md's "Anonymous function expressions". */
  AnonymousFunctionExpression = 'AnonymousFunctionExpression',
  /** `<target> = function (...) { }` in a function body — a plain bare assignment whose whole right-hand side is an anonymous function expression (Tier 1: the RHS must be exactly the function literal, not a larger expression containing one). */
  AnonymousFunctionAssignmentStatement = 'AnonymousFunctionAssignmentStatement',
  /** The .thr template markup (valid XML) — see embedded.ts. */
  TemplateSection = 'TemplateSection',
  /** A `.flsh` file's root — zero or more `ImportDeclaration`s followed by exactly one `ClassDeclaration`, no `<script>` wrapper, no template. */
  FlshFile = 'FlshFile',
  /** `import <ClassName> from "<path>"` — valid in a `.thr` `<script>` section and in a `.flsh` file. */
  ImportDeclaration = 'ImportDeclaration',
  /** `class Name [extends Base] { <member>* }`. */
  ClassDeclaration = 'ClassDeclaration',
  /** `[public|private|protected] <name>: <Type> = <literal>` at class-body top level (a class-owned default, not a constructor-time assignment). */
  ClassFieldDeclaration = 'ClassFieldDeclaration',
  /** `[public|private|protected] stream <name>: <Type>` at class-body top level — same "no initializer" shape as the script-level `StreamDeclaration`, only valid at class-body top level (never inside a constructor). */
  ClassStreamFieldDeclaration = 'ClassStreamFieldDeclaration',
  /** `[override] constructor(<param>: <Type>, ...) { <ConstructorBody> }`. */
  ConstructorDeclaration = 'ConstructorDeclaration',
  /**
   * A constructor's body — deliberately NOT a `Block`: `Block.statements`'s
   * type union is consumed by exhaustive `instanceof` dispatch elsewhere
   * (brs-emitter.ts, scope-resolution.ts) with a `StatementRegion` catch-all
   * fallback. Keeping `SuperCallStatement`/`ConstructorFieldInit` structurally
   * impossible to produce outside this dedicated parse path means they can
   * never silently land in that fallback and be mistaken for opaque text.
   */
  ConstructorBody = 'ConstructorBody',
  /** `[public|private|protected] <name>: <Type> = <expr>` inside a constructor body — declares AND assigns an instance field. */
  ConstructorFieldInit = 'ConstructorFieldInit',
  /** `super(<args>)` — required as an override constructor's first statement when the class extends a base. */
  SuperCallStatement = 'SuperCallStatement',
  /** `[override] public|private|protected function <name>(<param>: <Type>, ...): <Type> { <Block> }` — body reuses `Block` unchanged. */
  ClassMethodDeclaration = 'ClassMethodDeclaration',
  /** Wraps whatever tokens were consumed before a syntax error — always the last child produced by a parse, see parser.ts. */
  ErrorNode = 'ErrorNode',

  // ── Full BrightScript grammar — every kind here is `Bs`-prefixed, uniformly,
  // even where no DSL kind of the same bare name exists yet, so a reader
  // never has to remember which ones needed disambiguating: a `Bs*` kind
  // always means "this is real BrightScript syntax that can appear verbatim
  // inside a pass-through function body, `derived` expression, or template
  // `{expr}`," never a DSL-level construct. Faithfully ported from
  // kopytko-brightscript-parser's own `SyntaxKind`
  // (`node_modules/kopytko-brightscript-parser/dist/src/syntaxKind.js`) — see
  // `findings/compiler-parser-architecture.md` for why flash-parser now owns this
  // outright instead of delegating to that package. The DSL's own
  // `IfStatement`/`ElseClause` (the JS-shaped `if (cond) { }`) and
  // `FunctionDeclaration`/`ParameterList`/`Parameter` (the DSL's `private|
  // public function` header) are structurally different grammar from their
  // `Bs`-prefixed counterparts below and are never interchangeable.
  BsSourceFile = 'BsSourceFile',
  BsFunctionDeclaration = 'BsFunctionDeclaration',
  BsParameterList = 'BsParameterList',
  BsParameter = 'BsParameter',
  BsReturnTypeClause = 'BsReturnTypeClause',
  BsIfStatement = 'BsIfStatement',
  BsElseIfClause = 'BsElseIfClause',
  BsElseClause = 'BsElseClause',
  BsForStatement = 'BsForStatement',
  BsForEachStatement = 'BsForEachStatement',
  BsWhileStatement = 'BsWhileStatement',
  BsTryStatement = 'BsTryStatement',
  BsCatchClause = 'BsCatchClause',
  BsReturnStatement = 'BsReturnStatement',
  BsPrintStatement = 'BsPrintStatement',
  BsThrowStatement = 'BsThrowStatement',
  BsDimStatement = 'BsDimStatement',
  BsStopStatement = 'BsStopStatement',
  BsEndStatement = 'BsEndStatement',
  BsGotoStatement = 'BsGotoStatement',
  BsLabelStatement = 'BsLabelStatement',
  BsAssignmentStatement = 'BsAssignmentStatement',
  BsExpressionStatement = 'BsExpressionStatement',
  BsExitForStatement = 'BsExitForStatement',
  BsExitWhileStatement = 'BsExitWhileStatement',
  BsContinueForStatement = 'BsContinueForStatement',
  BsContinueWhileStatement = 'BsContinueWhileStatement',
  BsConditionalCompilation = 'BsConditionalCompilation',
  BsHashConstStatement = 'BsHashConstStatement',
  BsHashErrorStatement = 'BsHashErrorStatement',
  BsBinaryExpression = 'BsBinaryExpression',
  BsUnaryExpression = 'BsUnaryExpression',
  BsGroupingExpression = 'BsGroupingExpression',
  BsCallExpression = 'BsCallExpression',
  BsDotExpression = 'BsDotExpression',
  BsIndexExpression = 'BsIndexExpression',
  /**
   * `?.`/`?[`/`?(`/`?@` — real BrightScript syntax the grammar must parse,
   * but never DSL-author-facing: only the compiler's own chain-safety pass
   * (see GRAMMAR.md's "Chain safety" section) ever produces one in DSL
   * source, inserted into the generated output, never written by hand.
   */
  BsOptionalChainingExpression = 'BsOptionalChainingExpression',
  /** An anonymous `function`/`sub ... end function`/`end sub` closure literal used as a value. */
  BsFunctionExpression = 'BsFunctionExpression',
  BsIdentifierExpression = 'BsIdentifierExpression',
  BsLiteralExpression = 'BsLiteralExpression',
  BsArrayLiteral = 'BsArrayLiteral',
  BsAALiteral = 'BsAALiteral',
  BsAAField = 'BsAAField',
  BsArgumentList = 'BsArgumentList',
  /**
   * `<left> == <right>` / `<left> != <right>` — DSL-only sugar (see
   * GRAMMAR.md's "Comparison" section), lowered to `ftEquals(...)`/`Not
   * ftEquals(...)`. `Bs`-prefixed even though it isn't real BrightScript
   * syntax, since it lives in the same expression-grammar layer as
   * `BsBinaryExpression` and is found via the same operator-precedence walk.
   */
  BsComparisonExpression = 'BsComparisonExpression',
  /**
   * `!<operand>` — DSL-only crash-safe unary NOT sugar (see GRAMMAR.md's
   * "Safe NOT" section), lowered to `ft_not(<operand>)`. `Bs`-prefixed even
   * though it isn't real BrightScript syntax, for the same reason
   * `BsComparisonExpression` is: it lives in the same expression-grammar
   * layer as `BsUnaryExpression` (real `Not`/unary `-`/`+`) and is found via
   * the same precedence walk, but is kept structurally distinct so the
   * compiler's lowering can target it specifically without risking a
   * false-positive match on a real, deliberately-unguarded unary node.
   */
  BsSafeNotExpression = 'BsSafeNotExpression',
}
