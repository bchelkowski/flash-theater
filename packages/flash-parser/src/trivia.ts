/**
 * Trivia — whitespace and comments between tokens. In a lossless CST every
 * byte of the source must be represented; trivia is how whitespace/comments
 * are preserved without polluting the structural token stream.
 *
 * Unlike kopytko-brightscript-parser's leading/trailing split, flash-parser
 * attaches ALL trivia between two tokens as the LEADING trivia of the
 * second one (trailing trivia is always empty). This is a deliberate
 * simplification — nothing in this package's consumers needs the
 * leading/trailing distinction, and always-leading is simpler and faster to
 * compute (no same-line lookahead needed) — see
 * findings/compiler-parser-architecture.md.
 */
export enum TriviaKind {
  /** Horizontal whitespace: spaces, tabs, and carriage returns (no line breaks). */
  Whitespace = 'Whitespace',
  /** One line break: `\n`. */
  LineBreak = 'LineBreak',
  /** Tick comment: starts with `'`, extends to end of line (not including the line break). */
  Comment = 'Comment',
}

export interface Trivia {
  readonly kind: TriviaKind;
  /** The original source text of this trivia piece. */
  readonly text: string;
  /** Byte offset in the source where this trivia starts. */
  readonly pos: number;
  /** Byte offset just past the end of this trivia. */
  readonly end: number;
  /** 0-based line number of the trivia start. */
  readonly line: number;
  /** 0-based column (character offset within the line) of the trivia start. */
  readonly column: number;
}
