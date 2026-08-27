# flash-parser

[![npm version](https://img.shields.io/npm/v/flash-parser.svg)](https://www.npmjs.com/package/flash-parser)
[![license](https://img.shields.io/npm/l/flash-parser.svg)](https://github.com/bchelkowski/flash-theater/blob/main/LICENSE)

A lossless CST + typed AST parser for the [flash-theater](https://github.com/bchelkowski/flash-theater)
DSL (`.thr`/`.flsh`) — the flash-theater counterpart to
[`kopytko-brightscript-parser`](https://www.npmjs.com/package/kopytko-brightscript-parser). Owns the
DSL-specific surface grammar (`field`/`derived`/`private|public function`, the JS-shaped `if`, template
markup) **and** a full, self-sufficient BrightScript expression/statement grammar plus a SceneGraph XML
parser — both vendored and adapted from `kopytko-brightscript-parser`, but parsed independently, not
delegated to it at parse time.

Used by [`flash-theater-compiler`](https://www.npmjs.com/package/flash-theater-compiler) as its only
parsing layer — the compiler never hand-parses anything BrightScript- or XML-shaped itself.

## Installation

```bash
npm install flash-parser
```

Requires Node.js ≥ 24.

## Quick start

```typescript
import { parseThr, findAll, SyntaxKind, FieldDeclaration } from 'flash-parser';

const source = `
<script>
field count: integer = 0
derived doubled: integer = count * 2
</script>
<component>
  <Label id="label" text="{doubled}" />
</component>
`;

const { root, diagnostics } = parseThr(source);

diagnostics; // [] — no parse errors

// Lossless CST: printing every token's full text (with trivia) reproduces
// the exact original source, byte for byte.
root.getText() === source; // true

// findAll + one of the typed AST classes from ast.ts — walk() itself is a
// plain (node: SyntaxNode) => void callback over every CST node, not a
// per-kind visitor object; findAll is how you collect just one kind.
const fields = findAll(root, SyntaxKind.FieldDeclaration, (n) => new FieldDeclaration(n));
for (const f of fields) console.log(f.name, f.type, f.defaultLiteral);
// "count integer 0"
```

`.flsh` (class-only) files use the same lossless-CST contract through `parseFlsh`/`parseFlshFile`.

## Diagnostics

`parseThr`/`parseFlsh` never throw on malformed source — a syntax problem always comes back as an
entry in `diagnostics` instead (this is also what `flash-theater-compiler`'s own `CompileError`
wraps `diagnostics[0]` into, on top of this package):

```typescript
const { diagnostics } = parseThr(`
<script>
field count: integer = 0
<component></component>
`); // missing </script>

diagnostics[0];
// { code: 'thr/unterminated-script', message: 'No closing </script> found.',
//   pos: 9, end: 59, line: 1 }
```

`ParseDiagnostic` shape: `{ code: string, message: string, pos: number, end: number, line:
number }` — `pos`/`end` are byte offsets into the source, `line` is 0-based.

## What this package owns

- **DSL grammar** — `.thr`'s `<script>`/template split, `field`/`derived`/`state`/`read`/`watch`,
  `private`/`public function`, the JS-shaped `if`/`for`/`while`/`try`, and `.flsh` classes
  (`extends`/`override`/`super`).
- **A full BrightScript grammar**, independent of `kopytko-brightscript-parser` at parse time —
  lexer, recursive-descent parser, and a typed AST wrapper layer, used for every embedded
  expression/statement region inside DSL source and for BrightScript-level scope resolution.
- **A SceneGraph XML lexer/parser/AST**, for the template markup and generated `.xml` output.

`kopytko-brightscript-parser` remains a dependency for two narrow, non-parsing roles inside the
`flash-theater-compiler` package only (validating generated `.brs` post-codegen, and supplying
Roku's builtin-function name catalog) — never for parsing DSL source.

## Full API surface

Beyond the examples above, the package also exports:

- **DSL AST nodes** — `ThrFile`/`FieldDeclaration`/`DerivedDeclaration`/`IfStatement`/
  `ClassDeclaration`/... — one typed class per grammar construct, from `ast.ts`.
- **BrightScript AST + scopes** — `BsFunctionDeclaration`/`BsIfStatement`/`BsCallExpression`/...,
  plus `buildBrightScriptScopes`/`resolveBrightScriptName`/`findBrightScriptScopeAtLine`.
- **Tokens & trivia** — `tokenize`/`TokenKind`/`Token`/`tokenFullText`, the raw token stream with
  whitespace/comments attached, underneath the CST.
- **Embedded-region helpers** — `parseEmbeddedExpression`/`parseEmbeddedStatements`/
  `findTopLevelIdentifiers`/`findMemberAccesses`/... — used by the compiler to analyze one
  BrightScript expression/statement region inside DSL source without reparsing the whole file.

The full, current export list is
[`src/index.ts`](https://github.com/bchelkowski/flash-theater/blob/main/packages/flash-parser/src/index.ts) —
every symbol there ships with its own TypeScript types.

## Documentation

- [flash-theater docs site](https://bchelkowski.github.io/flash-theater/parser/) — architecture
  overview and more examples.
- [`packages/compiler/GRAMMAR.md`](https://github.com/bchelkowski/flash-theater/blob/main/packages/compiler/GRAMMAR.md) —
  the exact grammar this package implements.
- [Source](https://github.com/bchelkowski/flash-theater/tree/main/packages/flash-parser)

## License

MIT
