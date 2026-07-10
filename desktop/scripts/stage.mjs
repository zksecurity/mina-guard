#!/usr/bin/env node
// Stages the built UI + backend Prisma client into packaging-stage/ and
// ui-standalone/ for electron-builder. Cross-platform replacement for the
// former bash `cp -R` chain.
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
//
// WHY A CUSTOM WALKER INSTEAD OF fs.cpSync:
// Next.js's standalone tree is produced by bun, whose `.bun` store links every
// package via a symlink. Shipping those symlinks fails on Windows CI, where
// creating a symlink needs Developer Mode / elevation (EPERM). So the staged
// tree must be completely link-free.
//
// WHY WE CAN'T JUST DEREFERENCE EVERY SYMLINK INDEPENDENTLY:
// The obvious fix — `cpSync({dereference:true})`, or a walker that resolves
// each symlink to its real target and drops the copy at the link's own path —
// produces a link-free tree that DOES NOT BOOT. It crashes at startup with
//   Error: Cannot find module 'styled-jsx/package.json'
//     at next/dist/server/require-hook.js
// The reason is Node's module resolution. bun's `.bun` store is a flat set of
// `<pkg>@<version>/node_modules/<pkg>` dirs, and every package finds its
// dependencies as *co-located siblings* inside that store directory. The two
// entry points into the store — `ui/node_modules/next` and
// `ui/node_modules/react` — are symlinks that redirect into it, so at runtime
// Node's realpath lands inside the store where `next`'s siblings (styled-jsx,
// react-dom, …) live. Replace those entry symlinks with a plain real copy of
// just the `next` package and the realpath now points at `ui/node_modules/next`,
// whose parent `ui/node_modules/` holds none of those siblings → resolution
// fails.
//
// THE FIX (verified by actually booting the staged server):
//   * STORE-INTERNAL symlinks (anything under `node_modules/.bun/…`) are
//     replaced by a real copy of their target AT THE SAME PATH. The store stays
//     laid out 1:1, so every package still finds its siblings — the store is
//     self-sufficient once materialised in place.
//   * ENTRY symlinks (a symlink that itself lives OUTSIDE any `.bun` dir but
//     points INTO the store, i.e. `ui/node_modules/{next,react}`) are replaced
//     by copying the target's ENTIRE store `node_modules` directory — the
//     package PLUS its co-located siblings — into the link's parent directory.
//     That gives Node's walk-up resolution the sibling deps it expects.
// The result is a fully link-free tree that is portable/writable on all
// platforms AND boots correctly.

import {
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  lstatSync,
  statSync,
  copyFileSync,
  realpathSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const repo = join(desktop, '..');

const uiStandalone = join(desktop, 'ui-standalone');
const packagingStage = join(desktop, 'packaging-stage');

const standaloneSrc = join(repo, 'ui', '.next', 'standalone');

// True when `p` has a path segment named exactly `.bun` — i.e. it lives inside
// bun's package store. Used to tell store-internal links from entry links.
function isInsideBunStore(p) {
  return p.split(sep).includes('.bun');
}

/**
 * Recursively copy `src` → `dest`, resolving every symlink to a real copy of
 * its target so the result is link-free. A symlink to a directory is walked
 * (its real contents are copied under `dest`); a symlink to a file copies the
 * bytes. Directories are created as needed and merged into any that already
 * exist. Dangling/broken symlinks and vanished entries are skipped with a
 * warning rather than throwing (matches the old `|| true` public-dir guard).
 *
 * This alone is correct for the store-internal links, whose targets keep their
 * dependency siblings co-located. Entry links into the store are fixed up
 * afterwards by copyEntryLinkSiblings().
 */
function copyResolved(src, dest) {
  let ls;
  try {
    ls = lstatSync(src);
  } catch (err) {
    console.error(`[stage] skipping unreadable path ${src}: ${err.code ?? err.message}`);
    return;
  }

  if (ls.isSymbolicLink()) {
    let realStat;
    let real;
    try {
      real = realpathSync(src);
      realStat = statSync(src); // follows the link
    } catch (err) {
      // Dangling/broken symlink — skip it rather than abort the whole build.
      console.error(`[stage] skipping broken symlink ${src}: ${err.code ?? err.message}`);
      return;
    }
    if (realStat.isDirectory()) {
      copyResolved(real, dest); // walk the real target's contents into dest
    } else if (realStat.isFile()) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(real, dest);
    }
    return;
  }

  if (ls.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      copyResolved(join(src, name), join(dest, name));
    }
  } else if (ls.isFile()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  // Sockets/FIFOs/devices are irrelevant to a build tree — ignore.
}

/**
 * Find every ENTRY symlink in the standalone SOURCE tree — a symlink that lives
 * OUTSIDE bun's `.bun` store but resolves to a package INSIDE it (e.g.
 * `ui/node_modules/next`, `ui/node_modules/react`) — and, for each, copy the
 * target's whole store `node_modules` directory (the package plus its
 * co-located sibling deps) into the corresponding destination directory. This
 * is what lets the staged, link-free `next`/`react` resolve `styled-jsx`,
 * `react-dom`, etc. via Node's normal walk-up.
 *
 * We read the links from the SOURCE (they still exist there); copyResolved()
 * dereferences as it copies, so nothing symlinked leaks into the destination.
 */
function copyEntryLinkSiblings(srcDir, destDir) {
  let entries;
  try {
    entries = readdirSync(srcDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const srcPath = join(srcDir, name);
    const destPath = join(destDir, name);
    let ls;
    try {
      ls = lstatSync(srcPath);
    } catch {
      continue;
    }

    if (ls.isSymbolicLink()) {
      // Only entry links matter here: the link is outside the store, its target
      // is inside it. Store-internal links were already handled by copyResolved.
      if (isInsideBunStore(srcPath)) continue;
      let target;
      try {
        target = realpathSync(srcPath);
      } catch {
        continue; // broken — copyResolved already warned/skipped it
      }
      if (!isInsideBunStore(target)) continue;
      const storeNodeModules = dirname(target); // e.g. .bun/next@…/node_modules
      // Copy pkg + siblings into the link's parent dir in the destination.
      console.error(
        `[stage] entry link ${srcPath} -> materialising store deps from ${storeNodeModules}`,
      );
      copyResolved(storeNodeModules, destDir);
      continue;
    }

    // Recurse into real directories to reach nested entry links.
    if (ls.isDirectory()) {
      copyEntryLinkSiblings(srcPath, destPath);
    }
  }
}

// 1. Clean slate — rm -rf packaging-stage ui-standalone
rmSync(packagingStage, { recursive: true, force: true });
rmSync(uiStandalone, { recursive: true, force: true });

// 2. mkdir -p ui-standalone/ui/.next packaging-stage/generated/prisma
mkdirSync(join(uiStandalone, 'ui', '.next'), { recursive: true });
mkdirSync(join(packagingStage, 'generated', 'prisma'), { recursive: true });

// 3. cp -R ../ui/.next/standalone/. ui-standalone/  (contents of standalone → root)
//    Store-internal symlinks become real copies in place; entry links become a
//    (temporarily incomplete) real copy of just their package — fixed in 3b.
console.error('[stage] copying standalone tree (dereferencing store symlinks)…');
copyResolved(standaloneSrc, uiStandalone);

// 3b. Fix the entry links (ui/node_modules/{next,react}) by bringing their
//     store siblings alongside so Node module resolution works link-free.
copyEntryLinkSiblings(standaloneSrc, uiStandalone);

// 4. cp -R ../ui/.next/static ui-standalone/ui/.next/static
copyResolved(
  join(repo, 'ui', '.next', 'static'),
  join(uiStandalone, 'ui', '.next', 'static'),
);

// 5. cp -R ../ui/public ui-standalone/ui/public  (only if ../ui/public exists)
const uiPublic = join(repo, 'ui', 'public');
if (existsSync(uiPublic)) {
  copyResolved(uiPublic, join(uiStandalone, 'ui', 'public'));
}

// 6. cp -R ../backend/src/generated/prisma/. packaging-stage/generated/prisma/
copyResolved(
  join(repo, 'backend', 'src', 'generated', 'prisma'),
  join(packagingStage, 'generated', 'prisma'),
);

// Guard: the whole point of this script is a link-free tree. If any symlink
// survived, fail loudly here (in CI on Linux) rather than shipping a build
// that breaks on Windows or on the user's machine.
let leaked = 0;
function assertNoSymlinks(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const ls = lstatSync(p);
    if (ls.isSymbolicLink()) {
      leaked++;
      let tgt;
      try {
        tgt = realpathSync(p);
      } catch {
        tgt = '(broken)';
      }
      console.error(`[stage] LEAKED SYMLINK: ${p} -> ${tgt}`);
    } else if (ls.isDirectory()) {
      assertNoSymlinks(p);
    }
  }
}
assertNoSymlinks(uiStandalone);
assertNoSymlinks(packagingStage);
if (leaked > 0) {
  console.error(`[stage] ${leaked} symlink(s) survived staging — aborting.`);
  process.exit(1);
}

console.error('[stage] staged ui-standalone/ and packaging-stage/ (link-free)');
