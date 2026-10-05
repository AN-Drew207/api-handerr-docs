/**
 * Reads the HTTP routes declared by a Serverless Framework config.
 *
 * The Handerr configs keep every function in its own file and reference it as
 * `myFn: ${file(serverless/functions/x/y.yml):myFn}`, so we resolve those
 * references ourselves instead of running `serverless print` (which needs AWS
 * credentials and takes ~30s).
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const FILE_REF = /^\$\{file\(([^)]+)\):([\w.-]+)\}$/;

function readYaml(file) {
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8'), { logLevel: 'silent' });
  } catch (err) {
    console.warn('  ! no se pudo parsear ' + path.basename(file) + ': ' + err.message);
    return null;
  }
}

/** Extracts the top-level `functions:` map without parsing the whole config. */
function readFunctionsBlock(configFile) {
  const text = fs.readFileSync(configFile, 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^functions:\s*$/.test(l));
  if (start === -1) return {};

  const entries = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim()) break; // next top-level key
    const m = line.match(/^ {2}([\w.-]+):\s*(.+?)\s*$/);
    if (m) entries[m[1]] = m[2];
  }
  return entries;
}

function authorizerName(http) {
  const auth = http?.authorizer;
  if (!auth) return null;
  if (typeof auth === 'string') return auth;
  return auth.name || auth.type || 'custom';
}

/** Serverless path (`services/{id}`) -> OpenAPI path (`/services/{id}`). */
function toOpenApiPath(p) {
  const clean = String(p || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return '/' + clean.replace(/\{([^}+]+)\+?\}/g, '{$1}');
}

export const routeKey = (method, openApiPath) =>
  method.toUpperCase() + ' ' + openApiPath.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '');

/**
 * @param {string} apiRoot Absolute path to the api repository
 * @param {string} configName e.g. `serverless.yml`
 * @returns {Map<string, object>} routeKey -> { method, path, functionName, handler, authorizer, file, description }
 */
export function readRoutes(apiRoot, configName) {
  const configFile = path.join(apiRoot, configName);
  if (!fs.existsSync(configFile)) return new Map();

  const routes = new Map();
  const fnFileCache = new Map();
  const functions = readFunctionsBlock(configFile);

  for (const [fnName, value] of Object.entries(functions)) {
    const ref = value.match(FILE_REF);
    let def = null;
    let sourceFile = configName;

    if (ref) {
      const relative = ref[1];
      sourceFile = relative;
      const abs = path.join(apiRoot, relative);
      if (!fnFileCache.has(abs)) fnFileCache.set(abs, fs.existsSync(abs) ? readYaml(abs) : null);
      def = fnFileCache.get(abs)?.[ref[2]] ?? null;
    }

    if (!def || !Array.isArray(def.events)) continue;

    for (const event of def.events) {
      const http = event?.http || event?.httpApi;
      if (!http) continue;

      const rawPath = typeof http === 'string' ? http.split(' ').pop() : http.path;
      const rawMethod = typeof http === 'string' ? http.split(' ')[0] : http.method;
      if (!rawPath || !rawMethod) continue;

      const method = String(rawMethod).toUpperCase();
      if (method === 'ANY' || method === '*') continue;

      const openApiPath = toOpenApiPath(rawPath);
      routes.set(routeKey(method, openApiPath), {
        method,
        path: openApiPath,
        functionName: fnName,
        handler: def.handler || '(sin handler)',
        authorizer: authorizerName(http),
        file: sourceFile,
        description: def.description || null,
      });
    }
  }

  return routes;
}
