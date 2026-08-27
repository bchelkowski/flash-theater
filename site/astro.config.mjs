import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  site: 'https://bchelkowski.github.io',
  base: '/flash-theater',
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        // Use local TypeScript sources so the site always reflects the latest
        // compiler changes without waiting for a build/publish step. Aliased
        // directly to compile.ts/dsl-ast.ts (not src/index.ts) — index.ts also
        // re-exports cli.ts, which imports node:fs/node:path and would break
        // a browser bundle. compile.ts's whole pipeline is deliberately
        // Node-free, see findings/compiler-pipeline-and-build.md.
        'flash-theater-compiler/compile': fileURLToPath(
          new URL('../packages/compiler/src/compile.ts', import.meta.url),
        ),
        'flash-theater-compiler/dsl-ast': fileURLToPath(
          new URL('../packages/compiler/src/dsl-parser/dsl-ast.ts', import.meta.url),
        ),
        // Same reasoning as above, and also sidesteps a real issue: flash-parser's
        // built dist/ is CommonJS (no "type": "module" in its package.json, matching
        // kopytko-brightscript-parser's own convention), and Vite's dependency
        // optimizer doesn't reliably CJS-interop a workspace-symlinked package the
        // way it does a real npm-registry dependency — aliasing straight to the
        // source avoids needing dist/ (or the interop) at all in the browser build.
        'flash-parser': fileURLToPath(new URL('../packages/flash-parser/src/index.ts', import.meta.url)),
      },
    },
    server: {
      fs: { allow: ['..'] },
    },
  },
});
