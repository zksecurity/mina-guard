#!/usr/bin/env node
// Stages the built UI + backend Prisma client into packaging-stage/ and
// ui-standalone/ for electron-builder. Cross-platform replacement for the
// former bash `cp -R` chain, which failed on Git Bash / Windows with
// "cp: Operation not permitted" while copying Next.js's standalone tree onto
// NTFS. fs.cpSync has no such permission-emulation issues.
//
// Called from desktop's `stage` npm script, before bundle-backend.mjs.
//
// Mirrors the previous bash exactly:
//   rm -rf packaging-stage ui-standalone
//   mkdir -p ui-standalone/ui/.next packaging-stage/generated/prisma
//   cp -R ../ui/.next/standalone/.        ui-standalone/
//   cp -R ../ui/.next/static              ui-standalone/ui/.next/static
//   [ -d ../ui/public ] && cp -R ../ui/public ui-standalone/ui/public || true
//   cp -R ../backend/src/generated/prisma/. packaging-stage/generated/prisma/

import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const repo = join(desktop, '..');

const uiStandalone = join(desktop, 'ui-standalone');
const packagingStage = join(desktop, 'packaging-stage');

// 1. Clean slate — rm -rf packaging-stage ui-standalone
rmSync(packagingStage, { recursive: true, force: true });
rmSync(uiStandalone, { recursive: true, force: true });

// 2. mkdir -p ui-standalone/ui/.next packaging-stage/generated/prisma
mkdirSync(join(uiStandalone, 'ui', '.next'), { recursive: true });
mkdirSync(join(packagingStage, 'generated', 'prisma'), { recursive: true });

// 3. cp -R ../ui/.next/standalone/. ui-standalone/  (contents of standalone → root)
cpSync(join(repo, 'ui', '.next', 'standalone'), uiStandalone, { recursive: true });

// 4. cp -R ../ui/.next/static ui-standalone/ui/.next/static
cpSync(
  join(repo, 'ui', '.next', 'static'),
  join(uiStandalone, 'ui', '.next', 'static'),
  { recursive: true },
);

// 5. cp -R ../ui/public ui-standalone/ui/public  (only if ../ui/public exists)
const uiPublic = join(repo, 'ui', 'public');
if (existsSync(uiPublic)) {
  cpSync(uiPublic, join(uiStandalone, 'ui', 'public'), { recursive: true });
}

// 6. cp -R ../backend/src/generated/prisma/. packaging-stage/generated/prisma/
cpSync(
  join(repo, 'backend', 'src', 'generated', 'prisma'),
  join(packagingStage, 'generated', 'prisma'),
  { recursive: true },
);

console.error('[stage] staged ui-standalone/ and packaging-stage/');
