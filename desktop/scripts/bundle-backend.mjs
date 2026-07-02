#!/usr/bin/env node
// Bundles backend/src/embed-entry.ts into packaging-stage/backend-bundle.js
// via esbuild. Externals stay dynamic at runtime; contracts is inlined.
//
// Called from desktop's `stage` npm script.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const backendEntry = join(here, '..', '..', 'backend', 'src', 'embed-entry.ts');
const outFile = join(here, '..', 'packaging-stage', 'backend-bundle.js');

await build({
  entryPoints: [backendEntry],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Keep these resolved at runtime via desktop/node_modules:
  // - @prisma/client: the generated client ships separately with native
  //   engine binaries; bundling would detach it from its engine path resolver.
  // - o1js: ships WASM + native bindings that break when bundled.
  // - cors / express / zod: pure JS but already in desktop/node_modules,
  //   and keeping them external avoids duplicate instances (particularly
  //   matters for express where app vs router identity is important).
  // Also externalize the generated Prisma client (backend/src/db.ts imports
  // it via a relative path ./generated/prisma/index.js). It's CommonJS with
  // dynamic require('node:fs') etc., which esbuild's ESM bundling can't
  // inline correctly.
  external: [
    '@prisma/client',
    'o1js',
    'cors',
    'express',
    'zod',
    '*/generated/prisma/index.js',
  ],
  sourcemap: true,
  logLevel: 'info',
  // Rewrites `import 'contracts'` → the inlined contracts source, because
  // contracts is NOT in the external list.
});

console.error(`[bundle-backend] wrote ${outFile}`);
