/**
 * Post-codegen validator — the second (and last) deliberate role
 * `kopytko-brightscript-parser` keeps in this repo, per
 * findings/compiler-architecture.md's refined dependency rule: never used to
 * *parse* `.thr`/`.flsh` source (flash-parser owns that outright), but still
 * useful as a genuinely independent check that the `.brs` text
 * `codegen/brs-emitter.ts`/`codegen/class-emitter.ts` emit is itself valid
 * BrightScript — catching a codegen bug that would otherwise only surface as
 * a cryptic runtime compile error on an actual Roku device.
 *
 * This is not a new idea — `packages/compiler/test/codegen/golden.test.ts`
 * already asserts this per-fixture, by hand, ~20 times over
 * (`const { diagnostics } = parse(brs); expect(diagnostics).to.deep.equal([])`).
 * This module is that same check, extracted once so it can also be wired
 * into `compile.ts` itself (see `CompileOptions.validateGeneratedBrs`) —
 * deliberately opt-in and off by default there, since re-parsing every
 * generated `.brs` on every real compile is pure overhead once codegen is
 * trusted; useful for tests/CI, not for a production build's hot path.
 */
import { parse } from 'kopytko-brightscript-parser';

export interface GeneratedBrsValidationResult {
  readonly valid: boolean;
  /** Empty when `valid` is true. */
  readonly diagnostics: readonly { readonly message: string; readonly line: number }[];
}

/** Parses `brs` (this compiler's own generated output, never DSL source) as real BrightScript and reports whether it's syntactically valid. */
export function validateGeneratedBrs(brs: string): GeneratedBrsValidationResult {
  const { diagnostics } = parse(brs);
  return {
    valid: diagnostics.length === 0,
    diagnostics: diagnostics.map((d) => ({ message: d.message, line: d.line })),
  };
}

/** Thrown by `compileThrSource`/`compileFlshSource` when `validateGeneratedBrs` is opted into and the generated `.brs` fails to parse — always a codegen bug, never a DSL-author error. */
export class GeneratedBrsValidationError extends Error {
  readonly diagnostics: readonly { readonly message: string; readonly line: number }[];

  constructor(componentName: string, result: GeneratedBrsValidationResult) {
    const first = result.diagnostics[0];
    super(`Internal error: generated .brs for "${componentName}" is not valid BrightScript (line ${first?.line ?? '?'}: ${first?.message ?? 'unknown error'}) — this is a compiler codegen bug, not a problem with your .thr/.flsh source.`);
    this.name = 'GeneratedBrsValidationError';
    this.diagnostics = result.diagnostics;
  }
}
