/**
 * Every token kind flash-parser's lexer can produce — the DSL's own surface
 * grammar (`field`/`derived`/`state`/...) AND the full BrightScript
 * expression/statement grammar a function body, `derived` expression, or
 * template `{expr}` can contain. One unified kind space, not two parallel
 * ones: a DSL keyword and a same-spelled BrightScript keyword (`if`, `else`,
 * `true`, `false`, `invalid`) share one kind, since a token doesn't care
 * which grammar rule ends up consuming it. See
 * `findings/compiler-parser-architecture.md` for why flash-parser owns this outright
 * now rather than delegating BrightScript tokenizing to
 * `kopytko-brightscript-parser` — this enum's BrightScript-keyword/operator
 * section is a faithful port of that package's own `TokenKind`
 * (`node_modules/kopytko-brightscript-parser/dist/src/tokenKind.js`),
 * reconciled against the DSL's pre-existing names for shared punctuation
 * (`LParen` not `LeftParen`, `Equals` not `Equal`, `Question` not
 * `QuestionMark`, `EndOfFile` not `Eof`) rather than introducing synonyms.
 */
export enum TokenKind {
  // ── DSL keywords — case-sensitive, exact lowercase match only (GRAMMAR.md's
  // case-sensitivity rule applies to the DSL layer, not just identifiers).
  Field = 'Field',
  Derived = 'Derived',
  State = 'State',
  Private = 'Private',
  Public = 'Public',
  If = 'If',
  Else = 'Else',
  True = 'True',
  False = 'False',
  Invalid = 'Invalid',
  /** `store(<path>)` — a reserved keyword (see GRAMMAR.md's "Global store" section), never a plain identifier. */
  Store = 'Store',
  /** `focus(<expr>)` — a reserved keyword (see GRAMMAR.md's "Focus system" section), never a plain identifier. */
  Focus = 'Focus',
  /** `jumpFocus(<direction>, <count>, <press>)` — a reserved keyword (see GRAMMAR.md's "Focus system" section, `jumpFocus`), never a plain identifier. */
  JumpFocus = 'JumpFocus',
  /** `read <name> = store(<path>)` — a one-time, non-reactive store snapshot. */
  Read = 'Read',
  /** `watch <name> = store(<path>)` — a reactive store binding. */
  Watch = 'Watch',
  /** `scale <field|state|derived|watch|read> ...` (script-level) or `scale <name> = <expr>`/`scale state <name> = <expr>` (function-body statement) — see GRAMMAR.md's "scale" section. Reserved globally like `store`/`focus`/`stream`/`request` — never usable as a plain identifier anywhere. */
  Scale = 'Scale',
  /** `stream <name>: <Type>` (script-level) or `[visibility] stream <name>: <Type>` (class field) — a per-instance, BehaviorSubject-like pub-sub value. See GRAMMAR.md's "stream" section. */
  Stream = 'Stream',
  /** `request <Kind> { ... }` (script-level, at most one per file) — declares this component as a single HTTP/Channel Store request/endpoint. See GRAMMAR.md's "Requests" section. Reserved globally like `store`/`focus`/`stream` — never usable as a plain identifier anywhere in the file, including inside a function body. */
  Request = 'Request',
  /** `animation <name> { ... }` (script-level, any number per file) — declares a named, reusable Roku Animation/composition, later triggered via `.start()`/`.stop()`/`.pause()`/`.resume()`/`.finish()` or referenced from a template `transition:`/`in:`/`out:` attribute. See GRAMMAR.md's "animation" section. Reserved globally like `stream`/`request` — never usable as a plain identifier anywhere in the file. */
  Animation = 'Animation',
  /** `class Name [extends Base] { ... }` — see GRAMMAR.md's "class declarations" section. */
  Class = 'Class',
  /** `class Name extends Base { ... }`. Also reused for a real BrightScript `for ... to ... [step ...] ... end for` loop's `to` — a real BrightScript keyword, distinct from `Extends`, see the BrightScript keyword block below. */
  Extends = 'Extends',
  /** Marks a constructor/method as replacing a same-named member declared by the extended base class. */
  Override = 'Override',
  /** A third class-member visibility, alongside `public`/`private` — compiles identically to `public` for now (no real enforcement, see GRAMMAR.md). */
  Protected = 'Protected',
  /** A class's constructor member — `[override] constructor(<param>: <Type>, ...) { ... }`. */
  Constructor = 'Constructor',
  /** `super(<args>)` — required as an override constructor's first statement when the class extends a base. */
  Super = 'Super',
  /** `import <ClassName> from "<path>"` — valid in a `.thr` `<script>` section and in a `.flsh` file. */
  Import = 'Import',
  /** The `from` in `import <ClassName> from "<path>"`. */
  From = 'From',

  // ── Shared identifiers & literals (DSL and BrightScript both use these) ──
  Identifier = 'Identifier',
  StringLiteral = 'StringLiteral',
  /**
   * A DSL-level number literal (a `field`/`state` default value) — kept as a
   * single undifferentiated kind for that narrow use, alongside the more
   * precise `IntegerLiteral`/`LongIntegerLiteral`/`FloatLiteral`/
   * `DoubleLiteral` kinds below that a full BrightScript numeric-literal
   * parse needs. Reconciling the DSL lexer's own emission onto the precise
   * kinds is Phase 1 work (see findings/compiler-parser-architecture.md), not done
   * here.
   */
  NumberLiteral = 'NumberLiteral',
  IntegerLiteral = 'IntegerLiteral',
  LongIntegerLiteral = 'LongIntegerLiteral',
  FloatLiteral = 'FloatLiteral',
  DoubleLiteral = 'DoubleLiteral',

  // ── Shared punctuation — DSL's existing short names, reused for BrightScript too ──
  Colon = 'Colon',
  Comma = 'Comma',
  LParen = 'LParen',
  RParen = 'RParen',
  LBrace = 'LBrace',
  RBrace = 'RBrace',
  /** `[` — array-literal/index-expression open bracket in full BrightScript; also bracket-depth context for ternary detection (see ternary.ts). */
  LBracket = 'LBracket',
  /** `]` — see `LBracket`. */
  RBracket = 'RBracket',
  /** `=` — BrightScript's own equality/assignment operator (context-dependent), and the DSL's `state x = expr`/`field x: T = literal` assignment syntax. Distinct from the DSL-only `EqualsEquals`/`BangEquals` below. */
  Equals = 'Equals',
  /** `.` — a `store(<path>)` dotted path, a DSL/BrightScript member-access chain, or the start of a `.5`-shaped float literal (disambiguated by the lexer). */
  Dot = 'Dot',
  /** `?` — a ternary `<condition> ? <whenTrue> : <whenFalse>` (see ternary.ts) or BrightScript's `?` print-shorthand. Bare, not part of `?.`/`?[`/`?(`/`?@` (see the optional-chaining kinds below). */
  Question = 'Question',
  /** `@` — attribute access (`node@attr`) or an optional-chaining `?@` (see below). */
  At = 'At',
  Semicolon = 'Semicolon',

  EndOfFile = 'EndOfFile',
  /** Any character the lexer doesn't specifically recognize. */
  Unknown = 'Unknown',
  /**
   * A single opaque span of embedded content not yet tokenized by the full
   * BrightScript grammar below — Phase 1 (see `findings/compiler-parser-architecture.md`)
   * retires every remaining producer/consumer of this kind and removes it;
   * kept for now so Phase 0 stays purely additive and the existing lexer/
   * embedded-region pipeline keeps compiling unchanged while the new grammar
   * is built out alongside it.
   */
  EmbeddedText = 'EmbeddedText',

  // ── BrightScript reserved words (52, per Roku's own reserved-words doc) ──
  // ported from kopytko-brightscript-parser's TokenKind — see this enum's
  // own doc comment above for the reconciliation-with-existing-names rule.
  And = 'And',
  As = 'As',
  Box = 'Box',
  Catch = 'Catch',
  Continue = 'Continue',
  CreateObject = 'CreateObject',
  Dim = 'Dim',
  Each = 'Each',
  ElseIf = 'ElseIf',
  End = 'End',
  EndFor = 'EndFor',
  EndFunction = 'EndFunction',
  EndIf = 'EndIf',
  EndSub = 'EndSub',
  EndWhile = 'EndWhile',
  EndTry = 'EndTry',
  Eval = 'Eval',
  Exit = 'Exit',
  ExitWhile = 'ExitWhile',
  For = 'For',
  /** `function <name>(...) [as <Type>] ... end function` — the DSL's own `function` keyword (`private`/`public function`) and a real BrightScript `function` share this one kind, same reasoning as `If`/`Else` above. */
  Function = 'Function',
  GetGlobalAA = 'GetGlobalAA',
  GetLastRunCompileError = 'GetLastRunCompileError',
  GetLastRunRunTimeError = 'GetLastRunRunTimeError',
  Goto = 'Goto',
  In = 'In',
  Let = 'Let',
  LineNum = 'LineNum',
  Mod = 'Mod',
  Next = 'Next',
  Not = 'Not',
  ObjFun = 'ObjFun',
  Or = 'Or',
  Pos = 'Pos',
  Print = 'Print',
  Return = 'Return',
  Run = 'Run',
  Step = 'Step',
  Stop = 'Stop',
  Sub = 'Sub',
  Tab = 'Tab',
  Then = 'Then',
  Throw = 'Throw',
  To = 'To',
  Try = 'Try',
  Type = 'Type',
  While = 'While',

  // ── BrightScript operators (23) ──
  Plus = 'Plus',
  Minus = 'Minus',
  Star = 'Star',
  Slash = 'Slash',
  /** `\` — integer division. */
  Backslash = 'Backslash',
  Caret = 'Caret',
  /** `<>` — BrightScript's real not-equal operator. Distinct from the DSL-only `!=` (`BangEquals` below), which lowers to a crash-safe `Not ft_equals(...)` call rather than a bare `<>` comparison. */
  LessGreater = 'LessGreater',
  Less = 'Less',
  Greater = 'Greater',
  LessEqual = 'LessEqual',
  GreaterEqual = 'GreaterEqual',
  LeftShift = 'LeftShift',
  RightShift = 'RightShift',
  PlusEqual = 'PlusEqual',
  MinusEqual = 'MinusEqual',
  StarEqual = 'StarEqual',
  SlashEqual = 'SlashEqual',
  BackslashEqual = 'BackslashEqual',
  LeftShiftEqual = 'LeftShiftEqual',
  RightShiftEqual = 'RightShiftEqual',
  PlusPlus = 'PlusPlus',
  MinusMinus = 'MinusMinus',

  /**
   * `==` — DSL-only crash-safe equality (see GRAMMAR.md's "Comparison"
   * section). Never valid BrightScript on its own; lowers to
   * `ft_equals(left, right)`. Distinct from real BrightScript `=`
   * (`Equals` above).
   */
  EqualsEquals = 'EqualsEquals',
  /** `!=` — DSL-only crash-safe inequality, lowers to `Not ft_equals(left, right)`. Distinct from real BrightScript `<>` (`LessGreater` above). */
  BangEquals = 'BangEquals',
  /**
   * `!` (bare, not followed by `=`) — DSL-only crash-safe unary NOT (see GRAMMAR.md's "Safe NOT"
   * section). Never valid BrightScript on its own; lowers to `ft_not(<operand>)`. Distinct from
   * the real BrightScript `Not` keyword (`Not` token), which stays unguarded passthrough.
   */
  Bang = 'Bang',

  // ── Optional chaining (Roku OS 11.0+) — compiler-generated output syntax
  // only; a DSL author never writes these themselves, see GRAMMAR.md's
  // "Chain safety" section. Still real, parseable BrightScript, so the
  // grammar must recognize them regardless of who wrote them.
  QuestionDot = 'QuestionDot',
  QuestionBracket = 'QuestionBracket',
  QuestionParen = 'QuestionParen',
  QuestionAt = 'QuestionAt',

  // ── Conditional compilation ──
  HashIf = 'HashIf',
  HashElseIf = 'HashElseIf',
  HashElse = 'HashElse',
  HashEndIf = 'HashEndIf',
  HashConst = 'HashConst',
  HashError = 'HashError',

  /**
   * A primitive BrightScript type name appearing after `as` in a type
   * annotation. The lexer does not produce this directly — like
   * kopytko-brightscript-parser's own convention, the parser re-classifies
   * whatever token follows `as` to `TypeName` regardless of its original
   * kind, so type positions are precisely targetable.
   */
  TypeName = 'TypeName',
}

export const KEYWORD_MAP: Readonly<Record<string, TokenKind>> = {
  field: TokenKind.Field,
  derived: TokenKind.Derived,
  state: TokenKind.State,
  private: TokenKind.Private,
  public: TokenKind.Public,
  function: TokenKind.Function,
  if: TokenKind.If,
  else: TokenKind.Else,
  true: TokenKind.True,
  false: TokenKind.False,
  invalid: TokenKind.Invalid,
  store: TokenKind.Store,
  focus: TokenKind.Focus,
  jumpFocus: TokenKind.JumpFocus,
  read: TokenKind.Read,
  watch: TokenKind.Watch,
  scale: TokenKind.Scale,
  stream: TokenKind.Stream,
  request: TokenKind.Request,
  animation: TokenKind.Animation,
  class: TokenKind.Class,
  extends: TokenKind.Extends,
  override: TokenKind.Override,
  protected: TokenKind.Protected,
  constructor: TokenKind.Constructor,
  super: TokenKind.Super,
  import: TokenKind.Import,
  from: TokenKind.From,

  // ── BrightScript reserved words — lowercase canonical form. Unlike the DSL
  // keywords above (exact-lowercase-only, per GRAMMAR.md's case-sensitivity
  // rule), real BrightScript keyword matching is case-INSENSITIVE
  // (`IF`/`if`/`If` all equivalent) — the lexer must lowercase an
  // identifier-shaped word before this lookup when tokenizing BrightScript
  // content, never when tokenizing a DSL-region keyword. This map only
  // defines the canonical spelling → kind; the case-folding decision belongs
  // to the lexer, not here.
  and: TokenKind.And,
  as: TokenKind.As,
  box: TokenKind.Box,
  catch: TokenKind.Catch,
  continue: TokenKind.Continue,
  createobject: TokenKind.CreateObject,
  dim: TokenKind.Dim,
  each: TokenKind.Each,
  elseif: TokenKind.ElseIf,
  end: TokenKind.End,
  endfor: TokenKind.EndFor,
  endfunction: TokenKind.EndFunction,
  endif: TokenKind.EndIf,
  endsub: TokenKind.EndSub,
  endwhile: TokenKind.EndWhile,
  endtry: TokenKind.EndTry,
  eval: TokenKind.Eval,
  exit: TokenKind.Exit,
  exitwhile: TokenKind.ExitWhile,
  for: TokenKind.For,
  getglobalaa: TokenKind.GetGlobalAA,
  getlastruncompileerror: TokenKind.GetLastRunCompileError,
  getlastrunruntimeerror: TokenKind.GetLastRunRunTimeError,
  goto: TokenKind.Goto,
  in: TokenKind.In,
  let: TokenKind.Let,
  line_num: TokenKind.LineNum,
  mod: TokenKind.Mod,
  next: TokenKind.Next,
  not: TokenKind.Not,
  objfun: TokenKind.ObjFun,
  or: TokenKind.Or,
  pos: TokenKind.Pos,
  print: TokenKind.Print,
  return: TokenKind.Return,
  run: TokenKind.Run,
  step: TokenKind.Step,
  stop: TokenKind.Stop,
  sub: TokenKind.Sub,
  tab: TokenKind.Tab,
  then: TokenKind.Then,
  throw: TokenKind.Throw,
  to: TokenKind.To,
  try: TokenKind.Try,
  type: TokenKind.Type,
  while: TokenKind.While,
};

/**
 * Compound-keyword forms BrightScript accepts as a single token in both a
 * compact and a spaced spelling (`endif`/`end if`, `elseif`/`else if`,
 * `exitwhile`/`exit while`) — ported from kopytko-brightscript-parser's own
 * documented lexer convention (see its README's "Compound Keywords" table).
 * `KEYWORD_MAP` above only has the compact form; the lexer recognizes the
 * spaced form as two consecutive keyword tokens (`end` + `if`, `else` + `if`,
 * `exit` + `while`) and folds them into the compound kind itself.
 */
export const COMPOUND_KEYWORD_SPACED_FORMS: Readonly<Partial<Record<TokenKind, readonly [TokenKind, TokenKind]>>> = {
  [TokenKind.EndIf]: [TokenKind.End, TokenKind.If],
  [TokenKind.EndFor]: [TokenKind.End, TokenKind.For],
  [TokenKind.EndSub]: [TokenKind.End, TokenKind.Sub],
  [TokenKind.EndFunction]: [TokenKind.End, TokenKind.Function],
  [TokenKind.EndWhile]: [TokenKind.End, TokenKind.While],
  [TokenKind.EndTry]: [TokenKind.End, TokenKind.Try],
  [TokenKind.ElseIf]: [TokenKind.Else, TokenKind.If],
  [TokenKind.ExitWhile]: [TokenKind.Exit, TokenKind.While],
};
