#!/usr/bin/env node
/**
 * Builds the OpenAPI documents that the local reference UI serves.
 *
 * Sources:
 *   - api/postman/*.postman_collection.json  (descriptions, bodies, examples)
 *   - api/serverless*.yml                    (real routes, lambda + authorizer)
 *
 * Nothing is written back into the api repository: every output lands in
 * api-docs/openapi/ and api-docs/public/vendor/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertCollection } from './lib/postman-to-openapi.mjs';
import { readRoutes } from './lib/serverless-routes.mjs';
import { validateDocument } from './lib/validate-doc.mjs';
import { loadEnv, saveEnv, DOCS_ROOT } from './lib/env-store.mjs';
import { MANUAL_OVERRIDES } from './lib/manual-overrides.mjs';

const API_ROOT = path.resolve(DOCS_ROOT, '..', 'api');
const OUT_DIR = path.join(DOCS_ROOT, 'openapi');
const VENDOR_DIR = path.join(DOCS_ROOT, 'public', 'vendor');

/** Which Postman collection pairs with which serverless config. */
const TARGETS = [
  {
    slug: 'app',
    title: 'Handerr App API',
    short: 'App (mobile)',
    collection: 'handerr-app.postman_collection.json',
    serverless: 'serverless.yml',
    profile: 'app',
  },
  {
    slug: 'admin',
    title: 'Handerr Admin API',
    short: 'Admin (backoffice)',
    collection: 'handerr-admin.postman_collection.json',
    serverless: 'serverless.admin.yml',
    profile: 'admin',
  },
  {
    slug: 'admin-v2',
    title: 'Handerr Admin v2 (SQL)',
    short: 'Admin v2 (SQL)',
    collection: 'handerr-admin-v2-sql.postman_collection.json',
    serverless: 'serverless.admin-v2.yml',
    profile: 'admin',
  },
  {
    slug: 'chinchin',
    title: 'ChinChin (pasarela de pago)',
    short: 'ChinChin (pagos)',
    collection: 'chinchin-pago-movil-testing.postman_collection.json',
    serverless: null,
    profile: 'chinchin',
  },
];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * routeKey -> manual override, only for the admin-v2 target (the only one
 * with overrides today — see lib/manual-overrides.mjs). Kept as a plain
 * per-target lookup here rather than a restriction baked into
 * postman-to-openapi.mjs, which stays agnostic about which target owns them.
 */
const MANUAL_OVERRIDES_BY_SLUG = {
  'admin-v2': new Map(Object.entries(MANUAL_OVERRIDES)),
};

function serversFor(profile, env) {
  const list = env.profiles?.[profile]?.servers || [];
  const usable = list
    .filter((s) => s.url && !/YOUR_|<.*>/.test(s.url))
    .map((s) => ({ url: s.url.replace(/\/+$/, ''), description: s.description }));
  return usable.length ? usable : [{ url: 'http://localhost:3000/dev', description: 'serverless-offline' }];
}

/** Variables the proxy resolves itself — the user never fills these in by hand. */
const MANAGED_VARS = new Set([
  'idToken',
  'accessToken',
  'refreshToken',
  'awsRegion',
  'cognitoClientId',
  'cognitoUsername',
  'cognitoPassword',
  'idTokenExp',
  'baseUrl',
  'adminBaseUrl',
]);

/** Every `{{name}}` the generated document still expects at request time. */
function collectVariables(doc) {
  const names = new Set();
  for (const match of JSON.stringify(doc).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
    if (!MANAGED_VARS.has(match[1])) names.add(match[1]);
  }
  return names;
}

/**
 * Adds any newly discovered variable to the profile as an empty field, so /env
 * lists exactly what the docs need. Existing values are never touched.
 */
function seedVariables(env, profileName, names) {
  const profile = (env.profiles ||= {})[profileName];
  if (!profile) return 0;
  profile.vars ||= {};
  let added = 0;
  for (const name of names) {
    if (!(name in profile.vars)) {
      profile.vars[name] = '';
      added++;
    }
  }
  return added;
}

function vendorScalar() {
  const src = path.join(
    DOCS_ROOT,
    'node_modules',
    '@scalar',
    'api-reference',
    'dist',
    'browser',
    'standalone.js',
  );
  if (!fs.existsSync(src)) {
    console.warn('! Falta @scalar/api-reference. Ejecuta `npm install` en api-docs/.');
    return false;
  }
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  fs.copyFileSync(src, path.join(VENDOR_DIR, 'scalar.standalone.js'));
  return true;
}

function main() {
  if (!fs.existsSync(API_ROOT)) {
    console.error('No encuentro el repo api en ' + API_ROOT);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const env = loadEnv();
  const index = [];
  const coverage = [];
  let seededVars = 0;

  for (const target of TARGETS) {
    const collectionFile = path.join(API_ROOT, 'postman', target.collection);
    if (!fs.existsSync(collectionFile)) {
      console.warn('- ' + target.slug + ': no existe ' + target.collection + ', omitido');
      continue;
    }

    const handlers = target.serverless ? readRoutes(API_ROOT, target.serverless) : new Map();
    const { doc, stats } = convertCollection({
      collection: readJson(collectionFile),
      title: target.title,
      servers: serversFor(target.profile, env),
      handlers,
      includeMissing: Boolean(target.serverless),
      manualOverrides: MANUAL_OVERRIDES_BY_SLUG[target.slug] || new Map(),
    });

    doc.info.description = buildIntro(target, handlers, stats) + (doc.info.description || '');
    doc['x-profile'] = target.profile;

    const outFile = path.join(OUT_DIR, target.slug + '.json');
    fs.writeFileSync(outFile, JSON.stringify(doc, null, 2));

    const problems = validateDocument(doc);
    if (problems.length) {
      console.warn('  ! ' + target.slug + ': ' + problems.length + ' avisos de estructura');
      for (const problem of problems.slice(0, 8)) console.warn('    - ' + problem);
      if (problems.length > 8) console.warn('    ... y ' + (problems.length - 8) + ' mas');
    }

    seededVars += seedVariables(env, target.profile, collectVariables(doc));

    const operations = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
    index.push({
      slug: target.slug,
      title: target.title,
      short: target.short,
      profile: target.profile,
      url: '/openapi/' + target.slug + '.json',
      operations,
      documented: stats.covered,
      undocumented: stats.missing.length,
      manual: stats.manuallyDocumented.length,
      serverless: target.serverless,
    });

    if (target.serverless) {
      coverage.push({
        slug: target.slug,
        serverless: target.serverless,
        routes: handlers.size,
        documented: stats.covered,
        missing: stats.missing.map((h) => ({
          route: h.method + ' ' + h.path,
          fn: h.functionName,
          handler: h.handler,
          authorizer: h.authorizer,
        })),
        manuallyDocumented: stats.manuallyDocumented.map((h) => ({
          route: h.method + ' ' + h.path,
          fn: h.functionName,
          handler: h.handler,
          authorizer: h.authorizer,
        })),
      });
    }

    const gap = stats.missing.length ? ' | ' + stats.missing.length + ' sin documentar' : '';
    const manual = stats.manuallyDocumented.length ? ' | ' + stats.manuallyDocumented.length + ' documentados a mano' : '';
    console.log(
      '+ ' + target.slug.padEnd(9) + ' ' + String(operations).padStart(3) + ' operaciones' +
        (target.serverless ? ' | ' + handlers.size + ' rutas en ' + target.serverless : '') +
        manual + gap,
    );
  }

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({ documents: index }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'coverage.json'), JSON.stringify({ coverage }, null, 2));

  if (seededVars) {
    saveEnv(env);
    console.log('+ ' + seededVars + ' variables nuevas anadidas a env.local.json (vacias, se rellenan en /env)');
  }

  if (vendorScalar()) console.log('+ Scalar copiado a public/vendor/');

  const totalMissing = coverage.reduce((n, c) => n + c.missing.length, 0);
  if (totalMissing) {
    console.log('\n' + totalMissing + ' endpoints estan en serverless.yml pero no en Postman.');
    console.log('Aparecen en la referencia bajo la etiqueta "Sin documentar en Postman".');
  }
  console.log('\nListo. Arranca la UI con: npm start');
}

function buildIntro(target, handlers, stats) {
  const lines = [
    '> Referencia local generada desde `api/postman/' + target.collection + '`' +
      (target.serverless ? ' y `api/' + target.serverless + '`' : '') +
      '. **No editar a mano**: se regenera con `npm run build`.',
    '',
  ];

  if (target.serverless) {
    lines.push(
      '**Cobertura:** ' + stats.covered + ' de ' + handlers.size + ' rutas HTTP documentadas en Postman' +
        (stats.missing.length ? ' (' + stats.missing.length + ' pendientes).' : '.'),
      '',
    );
  }

  lines.push(
    '**Como probar:**',
    '',
    '1. Configura credenciales y variables en [/env](/env).',
    '2. Elige el servidor (local o dev) arriba a la derecha de cada endpoint.',
    '3. Pulsa **Test Request**. Las `{{variables}}` (incluido `{{idToken}}`) las resuelve el proxy local,',
    '   que ademas pide y renueva el token de Cognito por ti.',
    '',
    '---',
    '',
  );

  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
