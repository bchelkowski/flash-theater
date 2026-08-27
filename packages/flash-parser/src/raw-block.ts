/**
 * Marker-comment detection for the raw BrightScript passthrough feature
 * (`' flash-theater:raw` / `' flash-theater:end-raw`) — see GRAMMAR.md's
 * "Raw BrightScript passthrough" section and findings/raw-brightscript-
 * passthrough.md for why this is a deliberate, one-off exception to this
 * package's "never sniff comment content" grammar philosophy.
 *
 * A marker is recognized purely from `Trivia` — comments are never real
 * tokens (see trivia.ts), so nothing here influences ordinary tokenization;
 * only `TokenStreamParser.tryParseRawBlock` (token-stream-parser.ts) treats a
 * match as structurally significant.
 */
import { Trivia, TriviaKind } from './trivia.js';
import { firstToken, SyntaxNode } from './syntaxNode.js';

export const RAW_BLOCK_START_MARKER = 'flash-theater:raw';
export const RAW_BLOCK_END_MARKER = 'flash-theater:end-raw';

/** A `'`-comment's own text minus the leading `'` and surrounding whitespace — `null` for a non-comment trivia entry. */
function commentBody(trivia: Trivia): string | null {
  if (trivia.kind !== TriviaKind.Comment) return null;
  return trivia.text.slice(1).trim();
}

export function matchesRawStartMarker(trivia: Trivia): boolean {
  return commentBody(trivia) === RAW_BLOCK_START_MARKER;
}

export function matchesRawEndMarker(trivia: Trivia): boolean {
  return commentBody(trivia) === RAW_BLOCK_END_MARKER;
}

/** Does any entry in a token's `leadingTrivia` carry the raw-block start marker? */
export function hasRawStartMarker(leadingTrivia: readonly Trivia[]): boolean {
  return leadingTrivia.some(matchesRawStartMarker);
}

/** Does any entry in a token's `leadingTrivia` carry the raw-block end marker? */
export function hasRawEndMarker(leadingTrivia: readonly Trivia[]): boolean {
  return leadingTrivia.some(matchesRawEndMarker);
}

/**
 * Slices `node.getText()` to just past whichever leading-trivia entry `matcher` finds on `node`'s
 * own first token — used to strip a marker comment that's structurally part of `node`'s leading
 * trivia (the lossless CST always attaches it there, see trivia.ts) but semantically belongs to a
 * raw block, not to `node` itself. Returns the unmodified full text when `matcher` finds nothing,
 * so this is always safe to apply defensively, even on a node that never follows a raw block.
 */
function stripLeadingMarkerTrivia(node: SyntaxNode, matcher: (trivia: Trivia) => boolean): string {
  const first = firstToken(node);
  if (!first) return '';

  const marker = first.leadingTrivia.find(matcher);
  const full = node.getText();
  if (!marker) return full;

  const cut = Math.max(marker.end - node.pos, 0);
  return full.slice(cut).replace(/^\r?\n/, '');
}

/**
 * The real BrightScript code a `RawBrightScriptRegion` node carries, with the leading start-marker
 * comment line stripped — the node's own token span starts AT the marker-carrying token (so
 * `getText()` includes the marker as harmless leading trivia; see `RawBrightScriptStatement.text`
 * in ast.ts, the only caller). Slices from just past the marker comment's own text (its trailing
 * line break included), so every byte the author wrote after the marker line survives untouched —
 * only the marker line itself is removed, mirroring how `StatementRegion.text` strips a trailing
 * `;` rather than reformatting anything else.
 */
export function rawBlockCodeText(node: SyntaxNode): string {
  return stripLeadingMarkerTrivia(node, matchesRawStartMarker);
}

/**
 * Strips a raw block's own `' flash-theater:end-raw` marker from whatever immediately follows it —
 * called by `StatementRegion.text` (ast.ts), the one node kind whose own `getText()` is spliced
 * directly into generated output (every other construct that could follow a raw block, e.g.
 * `IfStatement`/`FieldDeclaration`, is reprinted structurally from its own named child tokens/nodes,
 * never from its own outer `getText()`, so a stray marker sitting in ITS leading trivia is inert).
 *
 * Without this, the end marker would double-print: once from the raw block's own explicit printer
 * (`codegen/statement-printer.ts`'s `printRawBrightScriptText`, which always emits both markers
 * itself, since a raw block at the very end of a function has nothing following it to carry the
 * marker forward) and a second time via the SAME mechanism that legitimately lets an ordinary
 * hand-written comment survive as part of the next statement's own leading trivia — which is
 * correct, desired behavior for a real comment, just not for this one, since it's already accounted
 * for elsewhere. A node with no preceding raw block is completely unaffected (the marker matcher
 * simply finds nothing).
 */
export function stripLeadingRawEndMarker(node: SyntaxNode): string {
  return stripLeadingMarkerTrivia(node, matchesRawEndMarker);
}
