/**
 * Parse diagnostics — errors produced by the parser. `code` uses the exact
 * same strings as the compiler's `CompileError` codes (`dsl/*`, `thr/*`,
 * `template/*`, `statement/*`, `expression/*`) since flash-parser now owns
 * the grammar those codes describe — the compiler's adapter layer just
 * throws `new CompileError(diagnostics[0])`, no code translation needed.
 */
export interface ParseDiagnostic {
  readonly code: string;
  readonly message: string;
  /** Byte offset where the problem starts, in the outer `.thr` source. */
  readonly pos: number;
  /** Byte offset just past the end of the problem. */
  readonly end: number;
  /** 0-based line number, in the outer `.thr` source. */
  readonly line: number;
}
