#!/usr/bin/env node
/**
 * Prints which HTTP routes declared in the serverless configs are missing from
 * the Postman collections — the collections are the source of truth for API
 * documentation, so this is the list of gaps to close.
 *
 * Run `npm run build` first (this reads openapi/coverage.json).
 */

import fs from 'node:fs';
import path from 'node:path';

import { DOCS_ROOT } from './lib/env-store.mjs';

const file = path.join(DOCS_ROOT, 'openapi', 'coverage.json');

if (!fs.existsSync(file)) {
  console.error('Falta openapi/coverage.json. Ejecuta primero: npm run build');
  process.exit(1);
}

const { coverage } = JSON.parse(fs.readFileSync(file, 'utf8'));
let total = 0;
let totalManual = 0;

for (const entry of coverage) {
  const manuallyDocumented = entry.manuallyDocumented || [];
  const percent = entry.routes ? Math.round((entry.documented / entry.routes) * 100) : 100;
  console.log('');
  console.log(entry.slug.toUpperCase() + '  (' + entry.serverless + ')');
  console.log('  ' + entry.documented + '/' + entry.routes + ' rutas documentadas en Postman — ' + percent + '%');

  // Documented by hand from api/src (see api-docs/scripts/lib/manual-overrides.mjs),
  // not from Postman — listed on their own so they are never counted as a
  // zero-documentation gap alongside `entry.missing` below.
  if (manuallyDocumented.length) {
    totalManual += manuallyDocumented.length;
    console.log('  ' + manuallyDocumented.length + ' documentadas a mano (api-docs, no en Postman):');
    const manualWidth = Math.max(...manuallyDocumented.map((m) => m.route.length));
    for (const m of manuallyDocumented) {
      console.log(
        '    ' + m.route.padEnd(manualWidth) + '  ' + m.fn +
          (m.authorizer ? '' : '  [publico]'),
      );
    }
  }

  if (!entry.missing.length) {
    console.log('  Sin huecos.');
    continue;
  }

  total += entry.missing.length;
  console.log('  Faltan:');
  const width = Math.max(...entry.missing.map((m) => m.route.length));
  for (const miss of entry.missing) {
    console.log(
      '    ' + miss.route.padEnd(width) + '  ' + miss.fn +
        (miss.authorizer ? '' : '  [publico]'),
    );
  }
}

console.log('');
console.log(total + ' endpoints sin documentar en total.');
if (totalManual) {
  console.log(totalManual + ' documentados a mano desde api/src (no en Postman) — ver api-docs/scripts/lib/manual-overrides.mjs.');
}
if (total) {
  console.log('Recuerda: cada cambio de endpoint debe reflejarse en api/postman/*.postman_collection.json.');
}
