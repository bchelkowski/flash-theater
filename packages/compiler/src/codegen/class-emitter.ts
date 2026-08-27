/**
 * Emits a `.flsh` class as a plain BrightScript "prototype object" — a
 * function returning an associative array, with fields as AA members and
 * methods as AA-member closures (so `m` inside a method is automatically
 * bound to the instance, standard BrightScript semantics, no special
 * runtime needed). Not built on the shared `emitXml`/`emitBrs` pipeline
 * `compile.ts` uses for a `.thr` component — same reasoning `theme-emitter.ts`
 * already documents for itself: a class has no template, no XML `<interface>`,
 * nothing SceneGraph-shaped about it at all, so reusing that pipeline would
 * mean threading class-specific cases through code that otherwise has
 * nothing to do with classes.
 *
 * See GRAMMAR.md's "class declarations" section for the full worked example
 * this mirrors, and `analysis/class-identifier-rewrite.ts` for the
 * single most important correctness detail here: an ordinary method is
 * invoked as `instance.method()` (so BrightScript auto-binds `m`), but the
 * generated `private_constructor` helper is invoked as a **plain function
 * call** (`private_constructor(prototype, a, b)`), so `m` does NOT
 * auto-bind inside it — every member reference there must go through its
 * own explicit `self` parameter instead. Every print function below is
 * threaded with `selfExpr` for exactly this reason.
 */
import {
  IfStatement,
  ForStatement,
  ForEachStatement,
  WhileStatement,
  TryStatement,
  StateAssignment,
  StatementRegion,
  StoreWriteStatement,
  FocusStatement,
  JumpFocusStatement,
  ConstructorFieldInit,
  SuperCallStatement,
  TernaryAssignmentStatement,
  AnonymousFunctionAssignmentStatement,
  ScaleLocalAssignmentStatement,
  ScaleStateAssignmentStatement,
  RawBrightScriptStatement,
} from 'flash-parser';
import { CompileError, ClassMethodDecl, ConstructorDecl, ThrClassAst } from '../dsl-parser/dsl-ast.js';
import { ClassShape } from '../analysis/class-shape.js';
import { buildClassScriptBindings, buildConstructorScope, buildFunctionScope, FunctionScope, ScriptBindings, emitParamName, resolveIdentifier } from '../analysis/scope-resolution.js';
import { rewriteClassExpression, rewriteClassStatement, SelfExpr, CLASS_GLOBAL_ACCESS_ROOT } from '../analysis/class-identifier-rewrite.js';
import { ThemeShape } from '../analysis/global-bindings.js';
import { privateFunctionName, brsTypeAnnotation, CLASS_GLOBAL_AA_LOCAL_NAME, usesRuntimeHelperCall } from './naming.js';
import { GLOBAL_FIELD_NAMES } from './global-fields.js';
import {
  SharedPrintContext,
  printBlockStatements,
  printForStatement,
  printForEachStatement,
  printWhileStatement,
  printTryStatement,
  printAnonymousFunctionAssignment,
  lowerAnonymousFunctionsInText,
  printTernaryAssignment,
  printScaleLocalAssignment,
  printIfStatement,
  printGenericLeafStatement,
  printRawBrightScriptStatement,
} from './statement-printer.js';

export interface CompiledClass {
  readonly className: string;
  readonly brs: string;
  /** True if this class's own compiled `.brs` calls `ft_equals(` (an `==`/`!=` DSL comparison lowered somewhere in a field initializer, a method, or the constructor) — `app-compiler.ts` folds this into a class's own transitive script-URI set (alongside its own `.brs` and its imports') so `runtime-assets/SafeCompare/FlashTheaterSafeCompare.brs` reaches every component that transitively imports this class, mirroring `CompiledThrFile.usesComparisonHelper`. */
  readonly usesComparisonHelper: boolean;
  /** True if this class's own compiled `.brs` calls `ft_not(` (a `!` DSL safe-NOT lowered somewhere in a field initializer, a method, or the constructor) — same "fold into the class's own transitive script-URI set" treatment as `usesComparisonHelper`, so `runtime-assets/SafeNot/FlashTheaterSafeNot.brs` reaches every component that transitively imports this class, mirroring `CompiledThrFile.usesSafeNotHelper`. */
  readonly usesSafeNotHelper: boolean;
  /**
   * True if this class's own compiled `.brs` reads/calls `router.*`/`taskManager.*` anywhere
   * (detected the same post-hoc-substring way `usesComparisonHelper` already is —
   * `brs.includes(GLOBAL_FIELD_NAMES.router)`/`.taskManager`, simpler and just as reliable as a
   * parallel AST-walk scanner). `app-compiler.ts` OR-folds these into the app-wide `usesRouter`/
   * `usesTaskManager` flags alongside `.thr` components' own — **required**, not optional: a
   * component that never calls `router.*`/`taskManager.*` itself but imports a class that does
   * would otherwise never get the runtime singleton wired into `globalsBrs`, and the generated code
   * would crash at runtime reading `invalid.callFunc(...)`. No equivalent `usesTheme` flag is
   * needed — theme's runtime wiring is already unconditional on `<theme-template>` existing
   * anywhere in the app, independent of usage (see `app-compiler.ts`).
   */
  readonly usesRouter: boolean;
  readonly usesTaskManager: boolean;
  /** True if this class's own compiled `.brs` calls `ft_createStream(` — a `stream` field declared directly on this class, or one constructed inline anywhere in a method/constructor. Folded into the app-wide/transitive script-URI set exactly like `usesComparisonHelper`, so `runtime-assets/Stream/FlashTheaterStream.brs` reaches every component that transitively imports this class. */
  readonly usesStreamHelper: boolean;
  /** True if this class's own compiled `.brs` calls `ft_scale(` — a `scale <local> = <expr>` assignment anywhere in a method/constructor. Folded into the app-wide/transitive script-URI set exactly like `usesComparisonHelper`/`usesStreamHelper`, so `runtime-assets/Scale/FlashTheaterScale.brs` reaches every component that transitively imports this class. */
  readonly usesScaleHelper: boolean;
  /** True if this class's own compiled `.brs` calls `ft_relationalGuard(` (a `<`/`>`/`<=`/`>=` DSL relational comparison lowered somewhere in a field initializer, a method, or the constructor) — same "fold into the class's own transitive script-URI set" treatment as `usesComparisonHelper`, so `runtime-assets/SafeRelational/FlashTheaterSafeRelational.brs` reaches every component that transitively imports this class, mirroring `CompiledThrFile.usesRelationalHelper`. */
  readonly usesRelationalHelper: boolean;
  /** True if this class's own compiled `.brs` reads `env.*` anywhere — same "fold into the app-wide flag" treatment as `usesRouter`/`usesTaskManager` (required, not optional: a component that only imports this class still needs `ft_env` wired into `globalsBrs`), detected the same post-hoc-substring way (`brs.includes(GLOBAL_FIELD_NAMES.env)`), mirroring `CompiledThrFile.usesEnv`. */
  readonly usesEnv: boolean;
}

const INDENT_UNIT = '  ';
const PRIVATE_CONSTRUCTOR_NAME = 'private_constructor';

/**
 * Prepends a `ft_globalAA = GetGlobalAA()` hoist line to `body` whenever it references the
 * class-context global-singleton access root (`ft_globalAA.global...` — see
 * `analysis/class-identifier-rewrite.ts`'s `CLASS_GLOBAL_ACCESS_ROOT`). Confirmed live, real Roku
 * device: a bare (return-value-discarded) statement chained directly off `GetGlobalAA()`'s own call
 * result fails to install ("Compilation Failed"), while the identical chain off a local variable
 * holding that same call's result compiles and runs fine — see `codegen/naming.ts`'s
 * `CLASS_GLOBAL_AA_LOCAL_NAME` for the full writeup and findings/class-pipeline-global-singleton-access.md's
 * `GetGlobalAA()` entry for the live-device bisection that found this.
 *
 * Hoists unconditionally whenever ANY class-context global access appears in `body` — even one
 * whose return value IS captured (where the bug doesn't apply, e.g. `taskManager.run(...)`'s
 * result assigned to a local) — rather than trying to detect the bare-vs-captured case precisely:
 * `ft_globalAA.global.X.callFunc(...)` compiles fine in EITHER context, so the unconditional hoist
 * is exactly as correct and much simpler. `router.navigate(...)`/`router.back()` are ALWAYS emitted
 * as a bare statement (never assigned — see `checkRouterActionIsStandaloneStatement`), so this is
 * the common case for any class that uses the router at all, not a rare edge case.
 *
 * Called independently at every method/constructor/anonymous-function-body print site — a nested
 * anonymous function does NOT close over an enclosing function's own locals in this codebase's own
 * generated code (see `codegen/brs-emitter.ts`'s equivalent note), so a hoist in an outer method is
 * NOT visible inside a callback defined within it; each generated `sub`/`function` needs its own.
 */
function hoistGlobalAAIfNeeded(body: string, indent: string): string {
  // `${CLASS_GLOBAL_AA_LOCAL_NAME}.` alone isn't enough: `identifier-rewrite.ts`'s
  // `rewriteOptionalChains` (findings/operators-optional-chaining.md) may have already spliced a
  // `?` between the local and its `.global` access (`ft_globalAA?.global...`), so the substring
  // check needs to tolerate both forms.
  if (!body.includes(`${CLASS_GLOBAL_AA_LOCAL_NAME}.`) && !body.includes(`${CLASS_GLOBAL_AA_LOCAL_NAME}?.`)) return body;
  const hoistLine = `${indent}${CLASS_GLOBAL_AA_LOCAL_NAME} = GetGlobalAA()`;
  return body.length > 0 ? `${hoistLine}\n${body}` : hoistLine;
}

export function compileClass(classAst: ThrClassAst, classShape: ClassShape, baseShape: ClassShape | null, themeShape: ThemeShape | null = null): CompiledClass {
  const classBindings = buildClassScriptBindings(classAst);
  const ctor = classAst.constructorDecl;
  const paramsText = ctor ? ctor.params.map((p) => `${p.name} as ${brsTypeAnnotation(p.type)}`).join(', ') : '';

  const lines: string[] = [];
  lines.push(`function ${classAst.name}(${paramsText}) as Object`);
  lines.push(`  prototype = ${emitPrototypeInit(classAst, ctor, classShape, classBindings, baseShape, themeShape)}`);

  for (const field of classAst.fields) {
    const name = memberName(field.name, field.visibility);
    lines.push(`  prototype.${name} = ${field.defaultLiteral}`);
  }

  // A stream field has no literal — its value is always a fresh ft_createStream() AA, same timing
  // as a literal-initialized field above (before super()/the constructor body runs). Reachable from
  // whoever holds the instance (`someInstance.streamFieldName.subscribe(...)`), not just from this
  // class's own methods, exactly like any other public field — `memberName` already handles that.
  for (const stream of classAst.streamFields) {
    const name = memberName(stream.name, stream.visibility);
    lines.push(`  prototype.${name} = ft_createStream()`);
  }

  if (ctor) {
    lines.push('');
    lines.push(...emitConstructor(ctor, classAst, classShape, classBindings, themeShape));
  }

  for (const method of classAst.methods) {
    lines.push('');
    lines.push(...emitMethod(method, classAst, classShape, classBindings, themeShape));
  }

  lines.push('');
  if (ctor) {
    const argNames = ctor.params.map((p) => p.name);
    lines.push(`  return ${PRIVATE_CONSTRUCTOR_NAME}(${['prototype', ...argNames].join(', ')})`);
  } else {
    lines.push('  return prototype');
  }
  lines.push('end function');

  const brs = lines.join('\n') + '\n';
  return {
    className: classAst.name,
    brs,
    usesComparisonHelper: usesRuntimeHelperCall(brs, 'ft_equals'),
    usesSafeNotHelper: usesRuntimeHelperCall(brs, 'ft_not'),
    usesRouter: brs.includes(GLOBAL_FIELD_NAMES.router),
    usesTaskManager: brs.includes(GLOBAL_FIELD_NAMES.taskManager),
    usesStreamHelper: usesRuntimeHelperCall(brs, 'ft_createStream'),
    usesScaleHelper: usesRuntimeHelperCall(brs, 'ft_scale'),
    usesRelationalHelper: usesRuntimeHelperCall(brs, 'ft_relationalGuard'),
    usesEnv: brs.includes(GLOBAL_FIELD_NAMES.env),
  };
}

function memberName(name: string, visibility: 'public' | 'private' | 'protected'): string {
  // `protected` compiles identically to `public` — BrightScript has no real access boundary to
  // enforce either way (everything is just an AA-key read), and this repo already tracks
  // "lint-enforced visibility" as its own, separate, future deferred item (docs/features.md).
  return visibility === 'private' ? privateFunctionName(name) : name;
}

/** `{}` for a non-extending class; `BaseName(<rewritten super args>)` for an extending one — flash-parser's parser already guarantees an extending class has exactly one `override constructor` whose first statement is `super(...)` (`dsl/missing-override-constructor`/`dsl/missing-super-call`), so this never needs to handle "extends but no super call". */
function emitPrototypeInit(
  classAst: ThrClassAst,
  ctor: ConstructorDecl | null,
  classShape: ClassShape,
  classBindings: ScriptBindings,
  baseShape: ClassShape | null,
  themeShape: ThemeShape | null,
): string {
  if (!classAst.baseName) return '{}';

  const superCall = ctor!.body.statements.find((s): s is SuperCallStatement => s instanceof SuperCallStatement)!;
  const ctorScope = buildConstructorScope(ctor!);
  const contextLabel = `class ${classAst.name} constructor's super(...) call`;
  // `superCall.args` is already split into individual argument texts by flash-parser
  // (`splitEmbeddedCallArgs`) — each is rewritten as its own expression and rejoined, since the
  // combined `argsText` is a comma-separated list, not a single valid BrightScript expression.
  const rewrittenArgs = superCall.args.map((arg) => rewriteClassExpression(arg, classShape, classBindings, 'self', contextLabel, ctorScope, themeShape)).join(', ');

  if (!baseShape) {
    throw new CompileError({
      code: 'class/unresolved-base',
      message: `Class "${classAst.name}" extends "${classAst.baseName}", but no resolved base class shape was supplied to codegen — this is an app-compiler.ts wiring bug, not a DSL error (base resolution must happen before compileClass is called).`,
    });
  }

  return `${classAst.baseName}(${rewrittenArgs})`;
}

function emitConstructor(ctor: ConstructorDecl, classAst: ThrClassAst, classShape: ClassShape, classBindings: ScriptBindings, themeShape: ThemeShape | null): string[] {
  const ctorScope = buildConstructorScope(ctor);
  const paramsText = ctor.params.map((p) => `${emitParamName(p.name, ctorScope, 'constructor')} as ${brsTypeAnnotation(p.type)}`).join(', ');
  const header = `  ${PRIVATE_CONSTRUCTOR_NAME} = function (self as Object${paramsText.length > 0 ? ', ' + paramsText : ''}) as Object`;

  const printed = ctor.body.statements
    .filter(
      (s): s is ConstructorFieldInit | IfStatement | ForStatement | ForEachStatement | WhileStatement | TryStatement | RawBrightScriptStatement | StatementRegion =>
        !(s instanceof SuperCallStatement),
    )
    .map((s) => printConstructorStatement(s, classAst, classShape, classBindings, ctorScope, themeShape))
    .filter((line) => line.length > 0);
  const body = hoistGlobalAAIfNeeded(printed.join('\n'), INDENT_UNIT.repeat(2));

  return [header, body, '    return self', '  end function'].filter((s) => s.length > 0);
}

/**
 * Builds the print-context closures every statement-printing call site needs (`emitMethod`'s single
 * per-method ctx, and `printConstructorStatement`'s own per-statement ctx — see that function's own
 * doc comment for why the constructor needs fresh counters per top-level statement) — factored out
 * so the two construction sites can't drift on the `CompileError` wording/`describeContext` prefix
 * rule `codegen/statement-printer.ts`'s `SharedPrintContext` requires.
 */
function buildClassPrintClosures(
  classShape: ClassShape,
  classBindings: ScriptBindings,
  selfExpr: SelfExpr,
  themeShape: ThemeShape | null,
  contextLabel: string,
): Pick<SharedPrintContext, 'rewriteText' | 'describeContext' | 'resolveAssignmentTarget' | 'printStatement' | 'hoistIfNeeded'> {
  return {
    rewriteText: (text, mode, textContextLabel, functionScope) =>
      mode === 'expression'
        ? rewriteClassExpression(text, classShape, classBindings, selfExpr, textContextLabel, functionScope, themeShape)
        : rewriteClassStatement(text, classShape, classBindings, selfExpr, textContextLabel, functionScope, themeShape),
    describeContext: (suffix) => (suffix ? `${contextLabel} ${suffix}` : contextLabel),
    resolveAssignmentTarget: (target, targetContextLabel, functionScope) => {
      const resolved = resolveIdentifier(target, classBindings, functionScope);
      if (resolved.kind === 'unresolved') {
        throw new CompileError({
          code: 'expression/unresolved-identifier',
          message: `Unresolved identifier "${target}" in ${targetContextLabel} — not a declared field/method, a local variable, or a BrightScript builtin.`,
        });
      }
      return resolved.replacement ?? target;
    },
    printStatement: printClassStatement,
    hoistIfNeeded: hoistGlobalAAIfNeeded,
  };
}

function printConstructorStatement(
  statement: ConstructorFieldInit | IfStatement | ForStatement | ForEachStatement | WhileStatement | TryStatement | RawBrightScriptStatement | StatementRegion,
  classAst: ThrClassAst,
  classShape: ClassShape,
  classBindings: ScriptBindings,
  functionScope: FunctionScope,
  themeShape: ThemeShape | null,
): string {
  const contextLabel = `class ${classAst.name} constructor`;
  // A constructor body is deliberately NOT a `Block` (see flash-parser's `SyntaxKind.ConstructorBody`
  // doc comment), so it's never parsed via `parseBlockContent` and can never itself contain a
  // `TernaryAssignmentStatement` — these counters exist only because `ClassPrintContext` is shared
  // with `printClassStatement`'s `IfStatement`/`for`/`while`/`try` branches below, which recurse into
  // ordinary `Block` bodies (an `if`/`for`/`while`/`try`'s own `{ }`) that CAN.
  const ctx: ClassPrintContext = {
    classAst,
    classShape,
    classBindings,
    scriptBindings: classBindings,
    selfExpr: 'self',
    functionScope,
    contextLabel,
    ternaryCounter: { value: 0 },
    anonFunctionCounter: { value: 0 },
    // setTimeout(...)/setInterval(...) are structurally unsupported from a class body (see
    // class/timer-not-supported) — statement-printer.ts's lowerTimerStartCallsInText throws when it
    // sees this null, the same shape ternaryCounter/anonFunctionCounter can't express since both
    // ARE supported here.
    timerCounter: null,
    themeShape,
    globalAccessRoot: CLASS_GLOBAL_ACCESS_ROOT,
    ...buildClassPrintClosures(classShape, classBindings, 'self', themeShape, contextLabel),
  };

  if (statement instanceof ConstructorFieldInit) {
    const name = memberName(statement.name, statement.visibility);
    const indent = INDENT_UNIT.repeat(2);
    const { hoistedLines, rewrittenText } = lowerAnonymousFunctionsInText(statement.expression, 'expression', 2, ctx, contextLabel);
    return [...hoistedLines, `${indent}self.${name} = ${rewrittenText}`].join('\n');
  }

  return printClassStatement(statement, 2, ctx);
}

function emitMethod(method: ClassMethodDecl, classAst: ThrClassAst, classShape: ClassShape, classBindings: ScriptBindings, themeShape: ThemeShape | null): string[] {
  const name = memberName(method.name, method.visibility);
  const functionScope = buildFunctionScope(method);
  const paramsText = method.params.map((p) => `${emitParamName(p.name, functionScope, `method "${method.name}"`)} as ${brsTypeAnnotation(p.type)}`).join(', ');
  const isSub = method.returnType === null;
  const header = isSub ? `  prototype.${name} = sub(${paramsText})` : `  prototype.${name} = function(${paramsText}) as ${brsTypeAnnotation(method.returnType!)}`;

  const contextLabel = `class ${classAst.name} method "${method.name}"`;
  const ctx: ClassPrintContext = {
    classAst,
    classShape,
    classBindings,
    scriptBindings: classBindings,
    selfExpr: 'm',
    functionScope,
    contextLabel,
    ternaryCounter: { value: 0 },
    anonFunctionCounter: { value: 0 },
    // setTimeout(...)/setInterval(...) are structurally unsupported from a class body (see
    // class/timer-not-supported) — statement-printer.ts's lowerTimerStartCallsInText throws when it
    // sees this null, the same shape ternaryCounter/anonFunctionCounter can't express since both
    // ARE supported here.
    timerCounter: null,
    themeShape,
    globalAccessRoot: CLASS_GLOBAL_ACCESS_ROOT,
    ...buildClassPrintClosures(classShape, classBindings, 'm', themeShape, contextLabel),
  };
  const body = hoistGlobalAAIfNeeded(printBlockStatements(method.block, 2, ctx), INDENT_UNIT.repeat(2));
  const footer = isSub ? '  end sub' : '  end function';

  return [header, body, footer];
}

/**
 * Everything a class method/constructor body's statement-printing needs. Satisfies
 * `codegen/statement-printer.ts`'s `SharedPrintContext` (the `globalAccessRoot`/closure fields,
 * built once by `buildClassPrintClosures`) so every shared print function can be called directly
 * with a plain `ClassPrintContext` — see that module's own doc comment for why the closures are
 * never rebuilt when entering a nested anonymous function's own scope.
 */
interface ClassPrintContext extends SharedPrintContext {
  readonly classAst: ThrClassAst;
  readonly classShape: ClassShape;
  readonly classBindings: ScriptBindings;
  readonly selfExpr: SelfExpr;
  readonly functionScope: FunctionScope;
  readonly contextLabel: string;
  /** Fresh-name counter for this method's own ternary temp vars — see `naming.ts`'s `nextTernaryTempName`. One per `emitMethod` call. */
  readonly ternaryCounter: { value: number };
  /** Fresh-name counter for this method's own hoisted Tier-2 anonymous-function temp vars — see `naming.ts`'s `nextAnonFunctionTempName`. One per `emitMethod` call. */
  readonly anonFunctionCounter: { value: number };
  /** The app's theme shape (or `null` if the app has no `<theme-template>`), threaded through so a class body's `theme.*` reads resolve — see `rewriteClassExpression`'s own `themeShape` parameter. */
  readonly themeShape: ThemeShape | null;
}

function printClassStatement(
  statement:
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
    | StatementRegion,
  depth: number,
  ctx: ClassPrintContext,
): string {
  if (statement instanceof RawBrightScriptStatement) return printRawBrightScriptStatement(statement, depth);
  if (statement instanceof ForStatement) return printForStatement(statement, depth, ctx);
  if (statement instanceof ForEachStatement) return printForEachStatement(statement, depth, ctx);
  if (statement instanceof WhileStatement) return printWhileStatement(statement, depth, ctx);
  if (statement instanceof TryStatement) return printTryStatement(statement, depth, ctx);
  if (statement instanceof AnonymousFunctionAssignmentStatement) return printAnonymousFunctionAssignment(statement, depth, ctx);
  if (statement instanceof ScaleLocalAssignmentStatement) return printScaleLocalAssignment(statement, depth, ctx);
  if (statement instanceof ScaleStateAssignmentStatement) {
    throw new CompileError({
      code: 'class/state-store-not-supported',
      message: `Found a "scale state" write in ${ctx.contextLabel} — a class has no state; this construct is only valid inside a .thr component's function body.`,
    });
  }
  if (statement instanceof IfStatement) return printIfStatement(statement, depth, ctx);
  if (statement instanceof TernaryAssignmentStatement) return printTernaryAssignment(statement, depth, ctx);

  return printClassGenericStatement(statement, depth, ctx);
}

/** Handles everything `printClassStatement` doesn't special-case: a `state`/`store`/`focus` construct is a hard error (a class has none of these — it has no reactive lifecycle at all, a completely separate restriction from the `theme`/`router`/`taskManager` global-singleton access `GetGlobalAA().global` DOES support — see `class-identifier-rewrite.ts`), everything else is an ordinary passthrough statement handled by the shared engine's `printGenericLeafStatement`. Split out so `printConstructorStatement` can call it directly for a constructor's own non-field-init, non-`if` statements without going through `printClassStatement`'s dispatcher again. */
function printClassGenericStatement(statement: StateAssignment | StoreWriteStatement | FocusStatement | JumpFocusStatement | StatementRegion, depth: number, ctx: ClassPrintContext): string {
  if (statement instanceof StateAssignment || statement instanceof StoreWriteStatement || statement instanceof FocusStatement || statement instanceof JumpFocusStatement) {
    const kind =
      statement instanceof StateAssignment
        ? 'a "state" write'
        : statement instanceof StoreWriteStatement
          ? 'a "store(...)" write'
          : statement instanceof FocusStatement
            ? 'a "focus(...)" call'
            : 'a "jumpFocus(...)" call';
    throw new CompileError({
      code: 'class/state-store-not-supported',
      message: `Found ${kind} in ${ctx.contextLabel} — a class has no state/store/focus; this construct is only valid inside a .thr component's function body.`,
    });
  }

  return printGenericLeafStatement(statement, depth, ctx);
}
