import { FlshFile, parseFlshFile } from 'flash-parser';
import { adaptFlshFile } from '../../src/dsl-parser/dsl-parser.js';
import { CompileError, ThrClassAst } from '../../src/dsl-parser/dsl-ast.js';

/**
 * Parses a whole `.flsh` file body into a `ThrClassAst`, for tests that want
 * to exercise the compiler's class adapter/analysis/codegen layers against
 * small synthetic fixtures. Mirrors `parseScriptFixture.ts`'s "throw
 * CompileError on the first diagnostic" policy, since `compileFlshSource`
 * does the same.
 */
export function parseClassFixture(source: string): ThrClassAst {
  const result = parseFlshFile(source);

  if (result.diagnostics.length > 0) {
    const first = result.diagnostics[0];
    throw new CompileError({ code: first.code, message: first.message, span: { line: first.line } });
  }

  const file = new FlshFile(result.root);
  return adaptFlshFile(file);
}
