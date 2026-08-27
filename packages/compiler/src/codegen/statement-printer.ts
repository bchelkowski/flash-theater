/**
 * Statement/expression-printing engine shared by `codegen/brs-emitter.ts` (a `.thr` component's
 * function bodies) and `codegen/class-emitter.ts` (a `.flsh` class's method/constructor bodies) —
 * both sides print the exact same DSL statement shapes (`for`/`for each`/`while`/`try`/`if`/
 * `else if`/`else`, anonymous functions, ternary assignment, `scale <local> = expr`) into
 * BrightScript, differing only in *how an identifier resolves* (a `.thr` component's
 * `rewriteExpression`/`rewriteStatement` vs a class body's `rewriteClassExpression`/
 * `rewriteClassStatement`, plus the `m.global` vs `GetGlobalAA().global` access root — see
 * `findings/class-pipeline-global-singleton-access.md`). `SharedPrintContext` captures that difference as a small
 * set of closures bound once per top-level function/method/constructor being printed, so every
 * function below is written once instead of twice.
 */
import {
  Block,
  ElseClause,
  IfStatement,
  ForStatement,
  ForEachStatement,
  WhileStatement,
  TryStatement,
  StatementRegion,
  RawBrightScriptStatement,
  TernaryAssignmentStatement,
  TernaryExpression,
  TernaryOperand,
  ExpressionRegion,
  AnonymousFunctionExpression,
  AnonymousFunctionAssignmentStatement,
  ScaleLocalAssignmentStatement,
  parseEmbeddedExpression,
  parseEmbeddedStatements,
  findAnonymousFunctionExpressions,
  findGlobalFunctionCalls,
  RAW_BLOCK_START_MARKER,
  RAW_BLOCK_END_MARKER,
} from 'flash-parser';
import type { GlobalFunctionCallMatch } from 'flash-parser';
import { CompileError } from '../dsl-parser/dsl-ast.js';
import { FunctionScope, ScriptBindings, buildAnonymousFunctionScope, emitParamName } from '../analysis/scope-resolution.js';
import { applySplices, withRouterFocusHandoff, isRouterNavigationStatement } from '../analysis/identifier-rewrite.js';
import { elideUnusedLocalAssignments } from '../analysis/unused-locals.js';
import { brsTypeAnnotation, nextTernaryTempName, nextAnonFunctionTempName, nextTimerTempName, timerCallbacksFieldAccess, TIMER_FIRE_TRAMPOLINE_SUB_NAME } from './naming.js';
import { globalFieldRef, GlobalAccessRoot } from './global-fields.js';

const TIMER_START_FUNCTION_NAMES = ['setTimeout', 'setInterval'] as const;

export const INDENT_UNIT = '  ';

export type PrintMode = 'expression' | 'statement';

/** Every statement kind a `Block`'s own body can contain — the parameter type both sides' top-level dispatcher (`printStatement`/`printClassStatement`) already declared independently; reused here instead of re-typed a third time. */
export type PrintableStatement = Block['statements'][number];

/** One expression's worth of ternary/anon-function-lowering output: `hoistedLines` (zero or more `.brs` lines that must run, in order, immediately before whatever line consumes `rewrittenText`) plus the final, already-fully-resolved expression text itself. */
export interface LoweredExpression {
  readonly hoistedLines: string[];
  readonly rewrittenText: string;
}

/**
 * Everything a shared print function needs, bundled so this module never has to know whether it's
 * printing a `.thr` function body or a `.flsh` class method/constructor body. Built once per
 * top-level function/method/constructor (mirroring `FunctionPrintContext`/`ClassPrintContext`'s own
 * existing "one per emitFunction/emitMethod call" counters) — entering a nested anonymous
 * function's own scope is a plain `{ ...ctx, functionScope }` object spread (see
 * `printAnonymousFunctionExpression` below), never a rebuild of the closures themselves, since
 * `functionScope` is always threaded as an explicit argument to `rewriteText`/
 * `resolveAssignmentTarget` rather than captured — the one piece of context that legitimately
 * changes mid-print.
 */
export interface SharedPrintContext {
  readonly scriptBindings: ScriptBindings;
  readonly functionScope: FunctionScope;
  /** This function/method/constructor's own base label (e.g. `"myFunction"` or `class Foo method "bar"`) — never itself changes when descending into a nested anonymous function's own scope, matching existing behavior (an anon-function body's own nested statements still label errors against the *enclosing* function). */
  readonly contextLabel: string;
  readonly globalAccessRoot: GlobalAccessRoot;
  /** Fresh-name counter for this function's own hoisted ternary temp vars (`ft_ternary_1`, ...) — see `naming.ts`'s `nextTernaryTempName`. */
  readonly ternaryCounter: { value: number };
  /** Fresh-name counter for this function's own hoisted Tier-2 anonymous-function temp vars (`ft_anon_1`, ...) — see `naming.ts`'s `nextAnonFunctionTempName`. */
  readonly anonFunctionCounter: { value: number };
  /**
   * Fresh-name counter for `setTimeout(...)`/`setInterval(...)` temp vars (`ft_timer_1`, ...) — see
   * `naming.ts`'s `nextTimerTempName` doc comment for why this is a whole-COMPONENT counter (built
   * once in `codegen/brs-emitter.ts`'s `emitBrs`, threaded unchanged through every `emitFunction`
   * call), unlike `ternaryCounter`/`anonFunctionCounter` which reset per function. `null` on the
   * `.flsh` class side (`codegen/class-emitter.ts`'s two `SharedPrintContext`-construction sites) —
   * `setTimeout`/`setInterval` are structurally unsupported from a class body (see
   * `class/timer-not-supported`); `lowerTimerStartCallsInText` throws when it sees `null`.
   */
  readonly timerCounter: { value: number } | null;

  /** Resolves+rewrites one piece of DSL text (a `.thr` component's `rewriteExpression`/`rewriteStatement`, or a class body's `rewriteClassExpression`/`rewriteClassStatement`) — closes over each side's own immutable bindings (a `.thr` component's `ScriptBindings`+`GlobalBindingsContext`, or a class's `ClassShape`+`ScriptBindings`+`SelfExpr`+`ThemeShape`), taking `functionScope` as an explicit argument since that's the one piece of ambient state that changes mid-print. */
  rewriteText(text: string, mode: PrintMode, contextLabel: string, functionScope: FunctionScope): string;
  /** Builds a derived sub-label, e.g. `describeContext('for-header')` — owns the cosmetic `"function "` prefix a `.thr` component's own contextLabel needs (a class's own contextLabel already reads like `class X method "y"`). `describeContext('')` returns the bare base label, for the (also cosmetically differing) no-suffix case ternary/scale-local/anon-function assignment use. */
  describeContext(suffix: string): string;
  /** Resolves a bare assignment target (ternary/scale-local/anon-function assignment's own LHS), throwing a side-specific `CompileError` message on failure (a `.thr` component's "field/derived/state/function" wording vs a class's "field/method" wording) — closes over each side's own bindings, taking `functionScope` explicitly for the same reason `rewriteText` does. */
  resolveAssignmentTarget(target: string, contextLabel: string, functionScope: FunctionScope): string;
  /** The caller's own full top-level statement dispatcher (`printStatement`/`printClassStatement`) — a plain function reference, not a closure, so it always runs against whichever `ctx` is passed at the call site (including one with an updated `functionScope`/nested nothing-else-differs shape from `{ ...ctx, functionScope }`). Recurses back out to file-local handling for statement kinds this shared engine deliberately never knows about (`State`/`Store`/`Focus`/`ScaleState` assignments — a `.thr` component handles these for real, a class body hard-rejects them). */
  printStatement(statement: PrintableStatement, depth: number, ctx: SharedPrintContext): string;
  /** Post-processes a just-printed function/anonymous-function body immediately before its footer — identity on the `.thr` side, `hoistGlobalAAIfNeeded` on the class side (see `class-emitter.ts`'s own doc comment for why a class body needs this and a `.thr` component never does). */
  hoistIfNeeded(body: string, indent: string): string;
  /** The one genuine non-duplicate between the two sides' own `lowerAnonymousFunctionsInText`: a `.thr` component's statement-mode Layer 1 animation-refresh-line hoisting (`collectAnimationFieldRefreshLines`) — omitted entirely on the class side (a class body can't reference an `animation {}` declaration by construction). Returns already-indented lines, matching the pre-extraction contract. */
  collectExtraHoistedLines?(text: string, mode: PrintMode, indent: string): string[];
}

/**
 * Prints a `Block`'s own statements — a JS-shaped `if (cond) { }` becomes BrightScript's
 * `if (cond) then ... end if`, at a fixed 2-space indent per nesting depth. Delegates each
 * statement to `ctx.printStatement` rather than any function this module owns, so a statement kind
 * this shared engine doesn't know about (`State`/`Store`/`Focus`/`ScaleState` on the `.thr` side)
 * still routes correctly back to the caller's own file-local handling.
 */
export function printBlockStatements(block: Block, depth: number, ctx: SharedPrintContext): string {
  return block.statements
    .map((statement) => ctx.printStatement(statement, depth, ctx))
    .filter((printed) => printed.length > 0)
    .join('\n');
}

/** Joins `header`/`body`/`footer`, dropping the body line entirely when it elides to nothing (an empty `for`/`while`/`try`/`catch` body is valid BrightScript) — avoids the spurious blank line a naive `[header, body, footer].join('\n')` would otherwise produce when `body === ''`. */
export function joinBlockLines(header: string, body: string, footer: string): string {
  return [header, body, footer].filter((s) => s.length > 0).join('\n');
}

/**
 * Prints `for (<var> = <start> to <end> [step <step>]) { }` as real BrightScript
 * `for <var> = <start> to <end> [step <step>] ... end for` — the loop variable is printed verbatim,
 * never through identifier rewriting (it's a declaration site); `startExpr`/`endExpr`/`stepExpr`
 * each go through `lowerAnonymousFunctionsInText` independently, since the header as a whole
 * (`<var> = <start> to <end>`) is for-statement-specific syntax, not a standalone expression.
 */
export function printForStatement(statement: ForStatement, depth: number, ctx: SharedPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const contextLabel = ctx.describeContext('for-header');
  const startLowered = lowerAnonymousFunctionsInText(statement.startExpr.text, 'expression', depth, ctx, contextLabel);
  const endLowered = lowerAnonymousFunctionsInText(statement.endExpr.text, 'expression', depth, ctx, contextLabel);
  const stepExpr = statement.stepExpr;
  const stepLowered = stepExpr ? lowerAnonymousFunctionsInText(stepExpr.text, 'expression', depth, ctx, contextLabel) : null;
  const step = stepLowered ? ` step ${stepLowered.rewrittenText}` : '';
  const hoistedLines = [...startLowered.hoistedLines, ...endLowered.hoistedLines, ...(stepLowered?.hoistedLines ?? [])];
  const headerLine = `${indent}for ${statement.loopVariable} = ${startLowered.rewrittenText} to ${endLowered.rewrittenText}${step}`;
  const body = printBlockStatements(statement.body, depth + 1, ctx);
  return joinBlockLines([...hoistedLines, headerLine].join('\n'), body, `${indent}end for`);
}

/** Prints `for each (<item> in <collection>) { }` as real BrightScript `for each <item> in <collection> ... end for` — `itemVariable` is printed verbatim (a declaration site), `collectionExpr` goes through `lowerAnonymousFunctionsInText`. */
export function printForEachStatement(statement: ForEachStatement, depth: number, ctx: SharedPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const { hoistedLines, rewrittenText } = lowerAnonymousFunctionsInText(statement.collectionExpr.text, 'expression', depth, ctx, ctx.describeContext('for-each-header'));
  const headerLine = `${indent}for each ${statement.itemVariable} in ${rewrittenText}`;
  const body = printBlockStatements(statement.body, depth + 1, ctx);
  return joinBlockLines([...hoistedLines, headerLine].join('\n'), body, `${indent}end for`);
}

/** Prints `while (<condition>) { }` as real BrightScript `while <condition> ... end while` — same condition-lowering shape as `if`'s own condition (`lowerAnonymousFunctionsInText`, not a bare rewrite call). */
export function printWhileStatement(statement: WhileStatement, depth: number, ctx: SharedPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const { hoistedLines, rewrittenText } = lowerAnonymousFunctionsInText(statement.condition.text, 'expression', depth, ctx, ctx.describeContext('while-condition'));
  const headerLine = `${indent}while ${rewrittenText}`;
  const body = printBlockStatements(statement.body, depth + 1, ctx);
  return joinBlockLines([...hoistedLines, headerLine].join('\n'), body, `${indent}end while`);
}

/** Prints `try { } catch (<name>) { }` as real BrightScript `try ... catch <name> ... end try` — the caught variable is printed verbatim (a declaration site), same treatment as a loop variable. */
export function printTryStatement(statement: TryStatement, depth: number, ctx: SharedPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const tryBody = printBlockStatements(statement.tryBlock, depth + 1, ctx);
  const catchClause = statement.catchClause;
  const catchBody = printBlockStatements(catchClause.body, depth + 1, ctx);
  const tryPart = joinBlockLines(`${indent}try`, tryBody, `${indent}catch ${catchClause.variableName}`);
  return joinBlockLines(tryPart, catchBody, `${indent}end try`);
}

/**
 * Prints `function (<param>: <Type>, ...) [: <Type>] { }` as a real BrightScript anonymous
 * `sub(...)`/`function(...) as Type ... end sub`/`end function` closure literal. Gets its own,
 * fully independent lexical scope (`buildAnonymousFunctionScope`) rather than inheriting
 * `ctx.functionScope`: a real BrightScript anonymous closure does not close over its enclosing
 * function's own locals (only `m`/`self` is shared), so a name that would've resolved to an
 * *outer* local correctly resolves as `unresolved` here instead. `ctx.hoistIfNeeded` runs on the
 * printed body immediately before the footer — a no-op on the `.thr` side, the class side's
 * `GetGlobalAA()` hoist on the other.
 */
export function printAnonymousFunctionExpression(fn: AnonymousFunctionExpression, depth: number, ctx: SharedPrintContext, contextLabel: string): string {
  const functionScope = buildAnonymousFunctionScope(fn);
  const innerCtx: SharedPrintContext = { ...ctx, functionScope };
  const paramsText = fn.parameters.map((p) => `${emitParamName(p.name, functionScope, `${contextLabel} anonymous function`)} as ${brsTypeAnnotation(p.type)}`).join(', ');
  const isSub = fn.returnType === null;
  const header = isSub ? `sub(${paramsText})` : `function(${paramsText}) as ${brsTypeAnnotation(fn.returnType!)}`;
  const indent = INDENT_UNIT.repeat(depth);
  const body = ctx.hoistIfNeeded(printBlockStatements(fn.block, depth + 1, innerCtx), INDENT_UNIT.repeat(depth + 1));
  const footer = `${indent}${isSub ? 'end sub' : 'end function'}`;
  return body.length > 0 ? `${header}\n${body}\n${footer}` : `${header}\n${footer}`;
}

/** Prints `<target> = function (...) { }` — Tier 1 anonymous-function-as-plain-assignment. `target` is resolved through `ctx.resolveAssignmentTarget` (in practice always the plain-local branch — a bare assignment target is always a genuine new/existing local). */
export function printAnonymousFunctionAssignment(statement: AnonymousFunctionAssignmentStatement, depth: number, ctx: SharedPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const contextLabel = ctx.describeContext('');
  const target = ctx.resolveAssignmentTarget(statement.target, contextLabel, ctx.functionScope);
  const fnText = printAnonymousFunctionExpression(statement.value, depth, ctx, contextLabel);
  return `${indent}${target} = ${fnText}`;
}

/**
 * Generalizes `ctx.rewriteText` to also hoist every Tier-2 anonymous function nested anywhere
 * inside `text` (a call argument, a condition, an operand, ...) — every plain-text
 * `ExpressionRegion`/`StatementRegion` consumer needs this, not just `state`/ternary's own RHS
 * position (`lowerTernaryRhs`, which already treats a bare `AnonymousFunctionExpression` *node* as
 * a Tier-1 host needing no hoisting at all — this function is what a Tier-2 occurrence buried
 * inside ordinary text needs instead, and `lowerTernaryRhs`'s own `ExpressionRegion` branch
 * delegates to it below).
 *
 * Each outermost anon function found is recursively printed via `printAnonymousFunctionExpression`
 * and hoisted to a fresh `ft_anon_N = <printed literal>` line *before* the statement, with only the
 * bare temp name spliced back into `text` at that span — never inlined directly, since a second
 * rewrite pass over already-printed, already-resolved text would try to re-resolve identifiers that
 * belong to the anon function's own independent scope against the *outer* function's scope instead.
 */
export function lowerAnonymousFunctionsInText(text: string, mode: PrintMode, depth: number, ctx: SharedPrintContext, contextLabel: string): LoweredExpression {
  const indent = INDENT_UNIT.repeat(depth);
  const extraHoistedLines = ctx.collectExtraHoistedLines?.(text, mode, indent) ?? [];

  const parsed = mode === 'expression' ? parseEmbeddedExpression(text) : parseEmbeddedStatements(text);
  if (parsed.result.diagnostics.length > 0) {
    return { hoistedLines: extraHoistedLines, rewrittenText: ctx.rewriteText(text, mode, contextLabel, ctx.functionScope) }; // surfaced as expression/parse-error right after this returns
  }

  // Detected BEFORE anon-function hoisting below so a timer call's own callback argument (which may
  // itself be an anonymous function, e.g. `setTimeout(function() {...}, 1000)`) is lowered
  // recursively through THIS SAME function, via lowerTimerStartCallsInText's own calls back into it.
  const timerCalls = findGlobalFunctionCalls(parsed, TIMER_START_FUNCTION_NAMES, text);
  if (timerCalls.length > 0) {
    return lowerTimerStartCallsInText(text, timerCalls, mode, depth, ctx, contextLabel, extraHoistedLines);
  }

  const accesses = findAnonymousFunctionExpressions(parsed, text);
  if (accesses.length === 0) {
    return { hoistedLines: extraHoistedLines, rewrittenText: ctx.rewriteText(text, mode, contextLabel, ctx.functionScope) };
  }

  const hoistedLines: string[] = [...extraHoistedLines];
  const replacements = accesses.map((access) => {
    const fn = new AnonymousFunctionExpression(access.node);
    const printedFn = printAnonymousFunctionExpression(fn, depth, ctx, contextLabel);
    const tempName = nextAnonFunctionTempName(ctx.anonFunctionCounter);
    hoistedLines.push(`${indent}${tempName} = ${printedFn}`);
    return { start: access.start, end: access.end, replacement: tempName };
  });

  const spliced = applySplices(text, replacements);
  return { hoistedLines, rewrittenText: ctx.rewriteText(spliced, mode, contextLabel, ctx.functionScope) };
}

/**
 * `setTimeout(...)`/`setInterval(...)` may appear only as a bare statement of its own, or as the
 * entire right-hand side of a plain `<local> = ` assignment — each occupying its own line. Unlike
 * `identifier-rewrite.ts`'s `checkAnimationControlCallIsStandaloneStatement` (which only ever allows
 * the bare-statement shape, since `.control =` has no value), this construct genuinely produces a
 * value (the created Timer node, usable later with `clearTimeout`/`clearInterval`) — so a plain
 * assignment target is legal, but anything else (a call argument, a condition, a `for`/`while`
 * header, nested inside a larger expression) is rejected: this compiler has no general "N setup
 * lines, arbitrary use site" mechanism the way a hoisted ternary temp-var has, since a Timer's setup
 * is multi-statement AND stateful (registers a real SceneGraph observer), not a pure value
 * computation.
 */
// A bare local (`t =`) or a plain dotted field-write target (`m.pollHandle =`, `m.top.pollHandle =`)
// — deliberately NOT an index/call target ([i], (...)), which this construct doesn't support as an
// assignment target at all.
const TIMER_ASSIGNMENT_TARGET_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*\s*=\s*$/;

function checkTimerStartCallPosition(match: GlobalFunctionCallMatch, text: string, contextLabel: string): void {
  const lineStart = text.lastIndexOf('\n', match.start - 1) + 1;
  const newlineAfter = text.indexOf('\n', match.end);
  const lineEnd = newlineAfter === -1 ? text.length : newlineAfter;

  const before = text.slice(lineStart, match.start).trim();
  const after = text.slice(match.end, lineEnd).trim();
  const trailingOk = after === '' || after.startsWith("'");
  const isBareStatement = before === '';
  const isAssignmentRhs = TIMER_ASSIGNMENT_TARGET_PATTERN.test(before);

  if (trailingOk && (isBareStatement || isAssignmentRhs)) return;

  throw new CompileError({
    code: 'expression/timer-call-must-be-standalone-or-assignment-rhs',
    message:
      `${match.name}(...) in ${contextLabel} must be either a statement of its own, or the entire right-hand side of a plain "<local> = ${match.name}(...)" assignment — ` +
      `it cannot be nested inside a larger expression, a condition, or a loop header.`,
  });
}

/** A bare, optionally unary-minus-prefixed integer/float literal, read straight from source text — deliberately conservative (a parenthesized literal like `(1000)` or a literal wrapped in any other syntax falls through to the runtime-division path in `msToSecondsBrsExpr` below, which is always correct, just less optimal codegen for that one rare shape). `null` for anything else, including a real BrightScript identifier/call/binary expression. */
function tryReadLiteralNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
}

function formatBrsFloatLiteral(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/**
 * Converts a `setTimeout`/`setInterval` duration argument from milliseconds (this feature's whole
 * point — JS parity, `setTimeout(fn, 1000)` means 1 second) to Roku's native `Timer.duration` field,
 * which is in SECONDS. `findings/animation.md` already documents this exact seconds-vs-ms confusion
 * once, for `animation {}`'s own `duration:`/`delay:` fields (a "400ms" bounce silently meaning
 * 6m40s on-device) — this conversion exists specifically so this feature never repeats that mistake.
 *
 * A LITERAL duration folds to a clean literal at compile time (`1000` → `1.0`, matching the style of
 * every hand-wired `Timer` example in this codebase, e.g. `m.loadTimer.duration = 1.5`); an
 * ARBITRARY expression divides at runtime instead (`(<expr>) / 1000.0`) — the AST gives no other way
 * to know a runtime value's sign/magnitude at compile time.
 */
function msToSecondsBrsExpr(rewrittenDurationText: string, originalDurationText: string, functionName: string, contextLabel: string): string {
  const literalMs = tryReadLiteralNumber(originalDurationText);
  if (literalMs === null) return `(${rewrittenDurationText}) / 1000.0`;

  if (literalMs <= 0) {
    throw new CompileError({
      code: 'expression/invalid-timer-duration',
      message: `${functionName}(...) in ${contextLabel} — duration must be a positive number of milliseconds, got ${literalMs}.`,
    });
  }
  return formatBrsFloatLiteral(literalMs / 1000);
}

/**
 * Lowers every `setTimeout(<callback>, <ms>)`/`setInterval(<callback>, <ms>)` call in `text` into its
 * full hoisted `.brs` setup — `CreateObject("roSGNode", "Timer")` → `.duration` (converted from ms to
 * seconds) → `.repeat = true` (interval only) → a registry entry on `timerCallbacksFieldAccess()`
 * (`{ node, callback, repeat }` — storing the NODE itself, not just the callback, is what keeps an
 * orphan Timer node alive when the DSL author discards the returned handle, and what
 * `codegen/brs-emitter.ts`'s `emitUnmountFunction` iterates to force-stop every still-pending timer
 * on component unmount) → `ObserveFieldScoped("fire", "on_timerFire")` → `.control = "start"` — with
 * only the bare temp name (the Timer node itself, usable as a `clearTimeout`/`clearInterval` handle)
 * spliced back into `text` at the call's own span. Exactly the same "N setup lines, one expression
 * value" shape `lowerTernaryRhs`/Tier-2 anon-function hoisting above already solve, applied to a
 * construct that's stateful (registers a real observer) rather than a pure value computation.
 *
 * A bare, handle-discarded `setTimeout(...)` statement (nothing before it on the line) reduces, after
 * splicing, to a LINE containing only the temp name — a syntactically valid but semantically
 * pointless "evaluate and discard a variable reference" line. Elided line-by-line (any post-splice
 * line that trims to exactly one of `tempNames` is dropped), never by checking whether the WHOLE
 * `text` reduces to just the temp name — `text` is one `StatementRegion`'s raw text, and a region
 * routinely bundles SEVERAL physical statements on separate lines (`analysis/unused-locals.ts`'s
 * `elideUnusedLocalAssignments` documents and handles the exact same reality for dead-local elision;
 * this function needs the same per-line treatment, not a whole-blob one). A real, live-caught bug:
 * `setTimeout(...)` as one statement immediately followed OR preceded by any other bare statement in
 * the same region (another call, `router.markReady()`, ...) left the spliced-but-unelided temp name
 * sitting on its own line — a bare, otherwise-harmless-looking `ft_timer_1` — which Roku's real
 * compiler rejects as an invalid statement, but this project's own lenient `validateGeneratedBrs`
 * didn't catch. See `findings/timer-statements.md`.
 */
function lowerTimerStartCallsInText(
  text: string,
  matches: readonly GlobalFunctionCallMatch[],
  mode: PrintMode,
  depth: number,
  ctx: SharedPrintContext,
  contextLabel: string,
  extraHoistedLines: readonly string[],
): LoweredExpression {
  if (mode === 'expression') {
    throw new CompileError({
      code: 'expression/timer-call-in-reactive-expression',
      message: `${matches[0].name}(...) in ${contextLabel} cannot be used inside a derived expression or a template binding — both recompute repeatedly, which would create a new Timer node every time. Call it once from a function body instead.`,
    });
  }
  if (ctx.timerCounter === null) {
    throw new CompileError({
      code: 'class/timer-not-supported',
      message: `${matches[0].name}(...) is not supported in ${contextLabel} — a .flsh class instance has no stable SceneGraph identity of its own to hang a Timer node's callback registry off of. Call ${matches[0].name}(...) from the owning .thr component instead.`,
    });
  }

  const indent = INDENT_UNIT.repeat(depth);
  const hoistedLines: string[] = [...extraHoistedLines];
  const tempNames: string[] = [];

  const replacements = matches.map((match) => {
    checkTimerStartCallPosition(match, text, contextLabel);
    if (match.argSpans.length !== 2) {
      throw new CompileError({
        code: match.name === 'setTimeout' ? 'expression/invalid-set-timeout-arguments' : 'expression/invalid-set-interval-arguments',
        message: `Invalid ${match.name}(...) call in ${contextLabel} — expected ${match.name}(<callback>, <milliseconds>), got ${match.argSpans.length} argument(s).`,
      });
    }

    const [callbackSpan, durationSpan] = match.argSpans;
    const originalDurationText = text.slice(durationSpan.start, durationSpan.end);
    const loweredCallback = lowerAnonymousFunctionsInText(text.slice(callbackSpan.start, callbackSpan.end), 'expression', depth, ctx, contextLabel);
    const loweredDuration = lowerAnonymousFunctionsInText(originalDurationText, 'expression', depth, ctx, contextLabel);
    hoistedLines.push(...loweredCallback.hoistedLines, ...loweredDuration.hoistedLines);

    const tempName = nextTimerTempName(ctx.timerCounter!);
    tempNames.push(tempName);
    const isInterval = match.name === 'setInterval';
    const durationSecondsExpr = msToSecondsBrsExpr(loweredDuration.rewrittenText, originalDurationText, match.name, contextLabel);
    const callbacks = timerCallbacksFieldAccess();

    hoistedLines.push(
      `${indent}${tempName} = CreateObject("roSGNode", "Timer")`,
      `${indent}${tempName}.id = "${tempName}"`,
      `${indent}${tempName}.duration = ${durationSecondsExpr}`,
      ...(isInterval ? [`${indent}${tempName}.repeat = true`] : []),
      `${indent}${callbacks}["${tempName}"] = { node: ${tempName}, callback: ${loweredCallback.rewrittenText}, repeat: ${isInterval} }`,
      `${indent}${tempName}.ObserveFieldScoped("fire", "${TIMER_FIRE_TRAMPOLINE_SUB_NAME}")`,
      `${indent}${tempName}.control = "start"`,
    );

    return { start: match.start, end: match.end, replacement: tempName };
  });

  const spliced = applySplices(text, replacements);
  const tempNameSet = new Set(tempNames);
  const remainingText = spliced
    .split('\n')
    .filter((line) => !tempNameSet.has(line.trim()))
    .join('\n');
  if (remainingText.trim().length === 0) {
    return { hoistedLines, rewrittenText: '' };
  }
  return { hoistedLines, rewrittenText: ctx.rewriteText(remainingText, mode, contextLabel, ctx.functionScope) };
}

/**
 * Lowers a possibly ternary-bearing right-hand side into BrightScript, since BrightScript itself
 * has no ternary operator. Every extracted `TernaryExpression` becomes its own hoisted
 * `ft_ternary_N = Invalid` + flattened `if`/`else`/`end if` block immediately before the statement
 * that needs its value, with the temp var's bare name substituted back in place of the ternary
 * wherever it was used. Recurses on `condition`/`whenTrue`/`whenFalse` (or, for a `TernaryOperand`,
 * every segment) generically — evaluation is eager, not short-circuited, a deliberate accepted
 * trade-off (see GRAMMAR.md's ternary section).
 */
export function lowerTernaryRhs(
  node: ExpressionRegion | TernaryExpression | TernaryOperand | AnonymousFunctionExpression,
  depth: number,
  ctx: SharedPrintContext,
  contextLabel: string,
): LoweredExpression {
  const indent = INDENT_UNIT.repeat(depth);

  if (node instanceof AnonymousFunctionExpression) {
    return { hoistedLines: [], rewrittenText: printAnonymousFunctionExpression(node, depth, ctx, contextLabel) };
  }

  if (node instanceof ExpressionRegion) {
    return lowerAnonymousFunctionsInText(node.text, 'expression', depth, ctx, contextLabel);
  }

  if (node instanceof TernaryExpression) {
    const condition = lowerTernaryRhs(node.condition, depth, ctx, contextLabel);
    const whenTrue = lowerTernaryRhs(node.whenTrue, depth, ctx, contextLabel);
    const whenFalse = lowerTernaryRhs(node.whenFalse, depth, ctx, contextLabel);
    const tempName = nextTernaryTempName(ctx.ternaryCounter);

    const hoistedLines = [
      ...condition.hoistedLines,
      ...whenTrue.hoistedLines,
      ...whenFalse.hoistedLines,
      `${indent}${tempName} = Invalid`,
      `${indent}if (${condition.rewrittenText}) then`,
      `${indent}  ${tempName} = ${whenTrue.rewrittenText}`,
      `${indent}else`,
      `${indent}  ${tempName} = ${whenFalse.rewrittenText}`,
      `${indent}end if`,
    ];
    return { hoistedLines, rewrittenText: tempName };
  }

  // TernaryOperand — reassemble every segment in order (a nested ternary's own hoisted lines
  // surface first, its temp-var name spliced into the buffer in its place), then rewrite the fully
  // substituted text exactly once.
  const hoistedLines: string[] = [];
  let assembled = '';
  for (const segment of node.segments) {
    if (typeof segment === 'string') {
      assembled += segment;
      continue;
    }
    const lowered = lowerTernaryRhs(segment, depth, ctx, contextLabel);
    hoistedLines.push(...lowered.hoistedLines);
    assembled += lowered.rewrittenText;
  }
  return { hoistedLines, rewrittenText: ctx.rewriteText(assembled, 'expression', contextLabel, ctx.functionScope) };
}

/** Prints `<target> = <cond> ? <a> : <b>` (possibly nested/chained/embedded arbitrarily — see `lowerTernaryRhs`) as its hoisted temp-var + `if`/`else` block(s), followed by the final `<target> = <tempVar>` assignment. */
export function printTernaryAssignment(statement: TernaryAssignmentStatement, depth: number, ctx: SharedPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const contextLabel = ctx.describeContext('');
  const { hoistedLines, rewrittenText } = lowerTernaryRhs(statement.rhs, depth, ctx, contextLabel);
  const target = ctx.resolveAssignmentTarget(statement.target, contextLabel, ctx.functionScope);
  return [...hoistedLines, `${indent}${target} = ${rewrittenText}`].join('\n');
}

/** Prints `scale <local> = <expr>` — same RHS lowering/target resolution as `printTernaryAssignment`, wrapping the final value in `ft_scale(...)` against `ctx.globalAccessRoot`'s `ft_scaleFactor`. See `runtime-assets/Scale/FlashTheaterScale.brs`. */
export function printScaleLocalAssignment(statement: ScaleLocalAssignmentStatement, depth: number, ctx: SharedPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const contextLabel = ctx.describeContext('');
  const { hoistedLines, rewrittenText } = lowerTernaryRhs(statement.rhs, depth, ctx, contextLabel);
  const target = ctx.resolveAssignmentTarget(statement.target, contextLabel, ctx.functionScope);
  return [...hoistedLines, `${indent}${target} = ft_scale(${rewrittenText}, ${globalFieldRef('scaleFactor', ctx.globalAccessRoot)})`].join('\n');
}

/**
 * Prints a full `if`/`else if`/`else` chain. BrightScript's `else if` is flat (one `end if` closes
 * the whole chain, not one per level), while the DSL's `ElseClause.elseIf` represents an "else if"
 * as a *nested* `IfStatement` (simpler for the parser) — this walks that nesting and flattens it
 * back into BrightScript's flat shape. Only reached from `printIfStatement` when there's at least
 * one `else`/`else if`.
 */
export function printIfElseChain(first: IfStatement, depth: number, ctx: SharedPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const lines: string[] = [];

  let current: IfStatement | null = first;
  let keyword = 'if';
  while (current) {
    const conditionLowered = lowerAnonymousFunctionsInText(current.condition.text, 'expression', depth, ctx, ctx.describeContext('if-condition'));
    lines.push(...conditionLowered.hoistedLines);
    lines.push(`${indent}${keyword} (${conditionLowered.rewrittenText}) then`);
    lines.push(printBranchBody(current.thenBlock, current.thenStatement, depth + 1, ctx));

    const clause: ElseClause | null = current.elseClause;
    if (!clause) break;

    if (clause.elseIf) {
      current = clause.elseIf;
      keyword = 'else if';
      continue;
    }

    lines.push(`${indent}else`);
    lines.push(printBranchBody(clause.block, clause.statement, depth + 1, ctx));
    current = null;
  }

  lines.push(`${indent}end if`);
  return lines.join('\n');
}

/** A branch's body is either a `{ }` block or a single inline statement — exactly one of the two arguments is non-null. */
export function printBranchBody(block: Block | null, statement: StatementRegion | null, depth: number, ctx: SharedPrintContext): string {
  if (block) return printBlockStatements(block, depth, ctx);
  const indent = INDENT_UNIT.repeat(depth);
  const { hoistedLines, rewrittenText } = lowerAnonymousFunctionsInText(statement!.text, 'statement', depth, ctx, ctx.describeContext('if-body'));
  // Every route change is followed by the shallow focus hand-off — see identifier-rewrite.ts's
  // withRouterFocusHandoff for why it has to be emitted here, as a sibling statement, rather than
  // inside the router runtime. Safe here since a branch body in an if/else chain already occupies
  // its own lines.
  return [...hoistedLines, withRouterFocusHandoff(`${indent}${rewrittenText}`, ctx.globalAccessRoot)].join('\n');
}

/**
 * Prints a whole `if (cond) { }` statement — the single-`if`-no-`else` case inline (a block body,
 * or the one-line `if (cond) then <stmt>` form; a route-changing inline statement is forced into
 * block form instead, since it carries a mandatory second, sibling focus-handoff statement the
 * single-line form has no room for), delegating to `printIfElseChain` the moment an `else`/`else if`
 * exists.
 */
export function printIfStatement(statement: IfStatement, depth: number, ctx: SharedPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);

  if (statement.elseClause) return printIfElseChain(statement, depth, ctx);

  const conditionLowered = lowerAnonymousFunctionsInText(statement.condition.text, 'expression', depth, ctx, ctx.describeContext('if-condition'));
  const condition = conditionLowered.rewrittenText;
  const thenBlock = statement.thenBlock;

  if (thenBlock) {
    const inner = printBlockStatements(thenBlock, depth + 1, ctx);
    return [...conditionLowered.hoistedLines, `${indent}if (${condition}) then\n${inner}\n${indent}end if`].join('\n');
  }

  const bodyLowered = lowerAnonymousFunctionsInText(statement.thenStatement!.text, 'statement', depth, ctx, ctx.describeContext('if-body'));
  const inlineStatement = bodyLowered.rewrittenText;
  const hoistedLines = [...conditionLowered.hoistedLines, ...bodyLowered.hoistedLines];
  if (isRouterNavigationStatement(statement.thenStatement!.text)) {
    const body = withRouterFocusHandoff(`${indent}${INDENT_UNIT}${inlineStatement}`, ctx.globalAccessRoot);
    return [...hoistedLines, `${indent}if (${condition}) then\n${body}\n${indent}end if`].join('\n');
  }
  return [...hoistedLines, `${indent}if (${condition}) then ${inlineStatement}`].join('\n');
}

/**
 * Prints the generic catch-all leaf: any plain `StatementRegion` neither side special-cases (an
 * assignment, a bare call, `return`, ...). Elides an unused local assignment to nothing (see
 * `elideUnusedLocalAssignments`) rather than printing a dead line, then lowers/rewrites what
 * remains and appends the mandatory router-navigation focus hand-off when applicable.
 */
export function printGenericLeafStatement(statement: StatementRegion, depth: number, ctx: SharedPrintContext): string {
  const indent = INDENT_UNIT.repeat(depth);
  const elided = elideUnusedLocalAssignments(statement.text, ctx.functionScope, ctx.scriptBindings);
  if (elided.trim().length === 0) return '';

  const { hoistedLines, rewrittenText } = lowerAnonymousFunctionsInText(elided, 'statement', depth, ctx, ctx.describeContext(''));
  // A bare, handle-discarded setTimeout(...)/setInterval(...) statement fully expands into
  // hoistedLines with nothing left to splice at the original call site — see
  // lowerTimerStartCallsInText's own doc comment.
  if (rewrittenText.trim().length === 0) return hoistedLines.join('\n');
  return [...hoistedLines, withRouterFocusHandoff(`${indent}${rewrittenText}`, ctx.globalAccessRoot)].join('\n');
}

/**
 * Prints a `' flash-theater:raw` ... `' flash-theater:end-raw` block — the one statement kind that
 * skips this whole engine's rewrite pipeline entirely (no `elideUnusedLocalAssignments`, no
 * `lowerAnonymousFunctionsInText`, no `ctx.rewriteText`/identifier-rewrite of any kind), since the
 * whole point is that its content is copied unrewritten. Takes no `SharedPrintContext` for exactly
 * that reason — nothing here depends on which side (`.thr`/`.flsh`) or which bindings are in scope.
 *
 * The only shape change applied is re-indentation, for consistency with every other statement this
 * engine prints (see `findings/compiler-codegen-conventions.md`'s "prints from a structured AST" section):
 * `statement.text` is dedented to its own minimum common leading whitespace, then each line is
 * reprinted at the current depth — internal *relative* indentation between the block's own lines
 * survives untouched, only the base offset is normalized. Both marker comments are re-emitted
 * around the result, so a reader of the generated `.brs` can see exactly which span was passed
 * through untouched.
 */
export function printRawBrightScriptStatement(statement: RawBrightScriptStatement, depth: number): string {
  return printRawBrightScriptText(statement.text, depth);
}

/**
 * The text-only core of `printRawBrightScriptStatement` — also used directly by
 * `codegen/brs-emitter.ts`'s `emitInitFunction` for a top-level (declaration-level) raw block,
 * which only ever has `RawBlockDecl.text` (the compiler's own adapted `ThrScriptAst` shape, not
 * flash-parser's `RawBrightScriptStatement` node) to work with.
 */
export function printRawBrightScriptText(text: string, depth: number): string {
  const indent = INDENT_UNIT.repeat(depth);
  const body = dedentRawBlockLines(text)
    .map((line) => (line.length === 0 ? '' : `${indent}${line}`))
    .join('\n');
  return [`${indent}' ${RAW_BLOCK_START_MARKER}`, body, `${indent}' ${RAW_BLOCK_END_MARKER}`].join('\n');
}

/** Strips leading/trailing blank lines, then dedents every remaining line by the minimum common leading whitespace among the non-blank ones — relative indentation between the block's own lines is preserved, only the shared base offset is removed. */
function dedentRawBlockLines(text: string): string[] {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  if (lines.length === 0) return [];

  const nonBlank = lines.filter((line) => line.trim().length > 0);
  const minIndent = Math.min(...nonBlank.map((line) => line.length - line.trimStart().length));
  return lines.map((line) => (line.trim().length === 0 ? '' : line.slice(minIndent)));
}
