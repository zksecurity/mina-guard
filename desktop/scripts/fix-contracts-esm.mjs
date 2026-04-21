#!/usr/bin/env node
// Rewrites extensionless relative imports/exports in contracts/build/**/*.js
// to use explicit `.js` extensions. The contracts package builds with
// moduleResolution: "node", which Bun tolerates but Electron's Node
// (v20+) rejects under strict ESM. This script is idempotent.
//
// Usage: node desktop/scripts/fix-contracts-esm.mjs

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const buildRoot = resolve(here, '..', '..', 'contracts', 'build', 'src');

/** Walks a dir, returns every .js file path (not .d.ts, not .map). */
async function walkJs(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkJs(p)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(p);
    }
  }
  return results;
}

/** Returns true if the specifier is relative (`./x` or `../x`). */
function isRelative(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

/** Resolves `spec` against `fromFile`'s dir. Returns either a `.js` file path
 *  or the `/index.js` under a directory, whichever exists. Null if neither. */
async function resolveTarget(fromFile, spec) {
  const baseDir = dirname(fromFile);
  const candidateJs = resolve(baseDir, spec + '.js');
  try {
    const s = await stat(candidateJs);
    if (s.isFile()) return spec + '.js';
  } catch {}
  const candidateIndex = resolve(baseDir, spec, 'index.js');
  try {
    const s = await stat(candidateIndex);
    if (s.isFile()) return spec + '/index.js';
  } catch {}
  return null;
}

async function patchFile(path) {
  const src = await readFile(path, 'utf8');
  // Match: import/export ... from 'spec' or from "spec"
  const re = /((?:^|\n)\s*(?:import|export)[^\n'"]+from\s+)(['"])([^'"]+)(['"])/g;
  let changed = false;
  const out = [];
  let lastEnd = 0;
  for (const m of src.matchAll(re)) {
    const [full, prefix, openQuote, spec, closeQuote] = m;
    const start = m.index;
    out.push(src.slice(lastEnd, start));
    lastEnd = start + full.length;
    if (!isRelative(spec) || spec.endsWith('.js') || spec.endsWith('.json')) {
      out.push(full);
      continue;
    }
    const replacement = await resolveTarget(path, spec);
    if (!replacement) {
      out.push(full);
      continue;
    }
    out.push(prefix + openQuote + replacement + closeQuote);
    changed = true;
  }
  out.push(src.slice(lastEnd));
  if (changed) {
    await writeFile(path, out.join(''), 'utf8');
  }
  return changed;
}

const files = await walkJs(buildRoot);
let patched = 0;
for (const f of files) {
  if (await patchFile(f)) patched++;
}
console.error(`[fix-contracts-esm] patched ${patched}/${files.length} files under ${buildRoot}`);
