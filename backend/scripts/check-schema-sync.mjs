#!/usr/bin/env node
// Verifies that schema.prisma and schema.sqlite.prisma are identical modulo
// the provider line in their datasource block. Fails loudly if they've
// drifted, which catches the "edited one, forgot the other" class of bug.
//
// Usage: node scripts/check-schema-sync.mjs
// Exit code 0 on match, 1 on drift.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const postgresPath = join(here, '..', 'prisma', 'schema.prisma');
const sqlitePath = join(here, '..', 'prisma', 'schema.sqlite.prisma');

const [postgres, sqlite] = await Promise.all([
  readFile(postgresPath, 'utf8'),
  readFile(sqlitePath, 'utf8'),
]);

// Normalize the provider line so the two files should be byte-identical after.
const normalize = (s) => s.replace(/provider\s*=\s*"(postgresql|sqlite)"/, 'provider = "<<PROVIDER>>"');

if (normalize(postgres) === normalize(sqlite)) {
  console.error('[check-schema-sync] schemas are in sync');
  process.exit(0);
}

console.error('[check-schema-sync] DRIFT DETECTED between schema.prisma and schema.sqlite.prisma');
console.error('');
console.error('Both files must be identical except for the datasource provider line.');
console.error('If you edited schema.prisma, mirror the change into schema.sqlite.prisma');
console.error('(or vice versa), preserving the respective provider value.');
process.exit(1);
