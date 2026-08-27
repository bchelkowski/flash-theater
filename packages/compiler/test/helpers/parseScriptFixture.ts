import { parse, ThrFile } from 'flash-parser';
import { adaptScriptSection } from '../../src/dsl-parser/dsl-parser.js';
import { CompileError, ThrScriptAst } from '../../src/dsl-parser/dsl-ast.js';

/**
 * Parses a `<script>`-region-only snippet (no template needed) into a
 * `ThrScriptAst`, for tests that want to exercise the compiler's adapter
 * layer against small synthetic fixtures without writing a full `.thr`
 * file. Mirrors compile.ts's own "throw CompileError on the first
 * diagnostic" policy exactly, since that's what these tests assert on.
 */
export function parseScriptFixture(scriptBody: string): ThrScriptAst {
  const source = `<script>\n${scriptBody}\n</script>\n<component>\n<Label id="a" />\n</component>\n`;
  const result = parse(source);

  if (result.diagnostics.length > 0) {
    const first = result.diagnostics[0];
    throw new CompileError({ code: first.code, message: first.message, span: { line: first.line } });
  }

  const file = new ThrFile(result.root);
  return adaptScriptSection(file.script);
}
