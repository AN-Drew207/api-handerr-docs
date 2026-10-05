#!/usr/bin/env node
/**
 * Local documentation server.
 *
 * Three jobs:
 *   1. Serve the Scalar reference UI and the generated OpenAPI documents.
 *   2. Read/write the local environment file behind /env.
 *   3. Proxy every "Test Request" so that `{{variables}}` get resolved and the
 *      Cognito id token is fetched/renewed automatically — and so CORS never
 *      gets in the way.
 *
 * Binds to 127.0.0.1 only: the environment file holds credentials.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  DOCS_ROOT,
  loadEnv,
  saveEnv,
  loadTokens,
  saveTokens,
  variablesFor,
  profileForUrl,
  envVersion,
} from './lib/env-store.mjs';
import { ensureIdToken, login, tokenStatus, decodeExp } from './lib/cognito.mjs';

const PORT = Number(process.env.PORT || argValue('--port') || 4400);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(DOCS_ROOT, 'public');
const OPENAPI_DIR = path.join(DOCS_ROOT, 'openapi');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Headers that must not be copied to the upstream request or back to the browser. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'origin',
  'referer',
  'accept-encoding',
  'cookie',
]);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

function sendFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — no encontrado');
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const isVendor = file.includes(path.sep + 'vendor' + path.sep);
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': isVendor ? 'public, max-age=86400' : 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/** Replaces every `{{name}}` occurrence for which we have a value. */
function substitute(text, variables) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name) => {
    const value = variables[name];
    return value === undefined || value === '' ? match : String(value);
  });
}

const usesVariable = (text, name) =>
  typeof text === 'string' && new RegExp('\\{\\{\\s*' + name + '\\s*\\}\\}').test(text);

const TEXTUAL = /^(application\/(json|xml|x-www-form-urlencoded|javascript)|text\/)/i;

async function handleProxy(req, res, url) {
  const target = url.searchParams.get('scalar_url');
  if (!target) return sendJson(res, 400, { error: 'Falta el parametro scalar_url' });

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return sendJson(res, 400, { error: 'scalar_url no es una URL valida: ' + target });
  }

  const env = loadEnv();
  const profileName = profileForUrl(env, targetUrl.origin + targetUrl.pathname);
  const variables = variablesFor(env, profileName);

  const rawBody = await readBody(req);
  const contentType = req.headers['content-type'] || '';
  const bodyIsText = !rawBody.length || TEXTUAL.test(contentType);
  const bodyText = bodyIsText ? rawBody.toString('utf8') : '';

  // Resolve the Cognito token only when something actually asks for it.
  const needsToken =
    usesVariable(target, 'idToken') ||
    usesVariable(bodyText, 'idToken') ||
    Object.values(req.headers).some((v) => usesVariable(Array.isArray(v) ? v.join(' ') : v, 'idToken'));

  let tokenSource = null;
  if (needsToken) {
    try {
      const result = await ensureIdToken(env, profileName);
      variables.idToken = result.token;
      tokenSource = result.source;
    } catch (err) {
      // A stale cached token is still worth trying; with nothing at all, stop here.
      if (!variables.idToken) {
        return sendJson(res, 401, {
          error: 'No se pudo obtener el token de Cognito para el perfil "' + profileName + '"',
          detail: err.message,
          hint: 'Configura credenciales en http://' + HOST + ':' + PORT + '/env',
        });
      }
      tokenSource = 'stale';
    }
  }

  const finalUrl = substitute(target, variables);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers[key] = substitute(Array.isArray(value) ? value.join(', ') : String(value), variables);
  }

  const method = req.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : bodyIsText
        ? Buffer.from(substitute(bodyText, variables), 'utf8')
        : rawBody;

  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await fetch(finalUrl, { method, headers, body, redirect: 'manual' });
  } catch (err) {
    return sendJson(res, 502, {
      error: 'El proxy no pudo alcanzar ' + finalUrl,
      detail: err.cause?.message || err.message,
      hint: finalUrl.includes('localhost')
        ? 'Comprueba que `npx serverless offline` este corriendo en ese puerto.'
        : 'Revisa la URL del servidor en /env.',
    });
  }

  const responseBody = Buffer.from(await upstream.arrayBuffer());
  const outHeaders = {
    'Access-Control-Allow-Origin': '*',
    'X-Docs-Profile': profileName,
    'X-Docs-Elapsed-Ms': String(Date.now() - startedAt),
  };
  if (tokenSource) outHeaders['X-Docs-Token-Source'] = tokenSource;
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === 'content-encoding') continue;
    outHeaders[key] = value;
  }

  console.log(
    '  ' + method + ' ' + finalUrl.replace(/(\?|&)scalar_url=.*/, '') +
      ' -> ' + upstream.status + ' (' + (Date.now() - startedAt) + 'ms, perfil ' + profileName +
      (tokenSource ? ', token ' + tokenSource : '') + ')',
  );

  res.writeHead(upstream.status, outHeaders);
  res.end(responseBody);
}

/** Strips passwords before the environment leaves the process. */
function redactEnv(env) {
  const copy = JSON.parse(JSON.stringify(env));
  for (const profile of Object.values(copy.profiles || {})) {
    if (profile.cognito?.password) profile.cognito.password = '__KEEP__';
  }
  return copy;
}

/** Restores passwords the UI sent back as the `__KEEP__` sentinel. */
function mergeEnv(previous, incoming) {
  const next = JSON.parse(JSON.stringify(incoming));
  for (const [name, profile] of Object.entries(next.profiles || {})) {
    if (profile.cognito?.password === '__KEEP__') {
      profile.cognito.password = previous.profiles?.[name]?.cognito?.password || '';
    }
  }
  return next;
}

async function handleApi(req, res, url) {
  const route = req.method + ' ' + url.pathname;

  if (route === 'GET /api/env') {
    const env = loadEnv();
    const status = {};
    for (const name of Object.keys(env.profiles || {})) status[name] = tokenStatus(name);
    return sendJson(res, 200, { env: redactEnv(env), tokens: status, version: envVersion() });
  }

  if (route === 'PUT /api/env') {
    try {
      const { env: incoming, version } = JSON.parse((await readBody(req)).toString('utf8'));

      // Refuse a save built on a copy someone else has since replaced.
      if (version && version !== envVersion()) {
        return sendJson(res, 409, {
          error: 'El entorno cambió en disco desde que cargaste la página.',
          hint: 'Recarga /env para no pisar los valores nuevos y vuelve a guardar.',
        });
      }

      saveEnv(mergeEnv(loadEnv(), incoming));
      return sendJson(res, 200, {
        ok: true,
        version: envVersion(),
        note: 'Guardado. Ejecuta `npm run build` si cambiaste servidores.',
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (route === 'POST /api/auth/login') {
    const { profile } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    try {
      await login(loadEnv(), profile);
      return sendJson(res, 200, { ok: true, status: tokenStatus(profile) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (route === 'POST /api/auth/logout') {
    const { profile } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const tokens = loadTokens();
    delete tokens[profile];
    saveTokens(tokens);
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/auth/token') {
    const { profile, idToken, refreshToken } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const tokens = loadTokens();
    const entry = tokens[profile] || {};
    if (idToken) {
      entry.idToken = idToken;
      entry.idTokenExp = decodeExp(idToken);
    }
    if (refreshToken) entry.refreshToken = refreshToken;
    entry.updatedAt = new Date().toISOString();
    tokens[profile] = entry;
    saveTokens(tokens);
    return sendJson(res, 200, { ok: true, status: tokenStatus(profile) });
  }

  return sendJson(res, 404, { error: 'Ruta desconocida: ' + route });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);

  try {
    if (url.pathname === '/__proxy') return await handleProxy(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (url.pathname === '/env' || url.pathname === '/env.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'env.html'));
    }
    if (url.pathname.startsWith('/openapi/')) {
      const file = path.join(OPENAPI_DIR, path.basename(url.pathname));
      return sendFile(res, file);
    }

    const safe = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    return sendFile(res, path.join(PUBLIC_DIR, safe));
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  const base = 'http://' + HOST + ':' + PORT;
  console.log('');
  console.log('  Handerr API Docs');
  console.log('  ----------------');
  console.log('  Referencia : ' + base);
  console.log('  Entorno    : ' + base + '/env');
  console.log('');
  console.log('  El proxy resuelve {{variables}} y renueva el token de Cognito solo.');
  console.log('  Ctrl+C para parar.');
  console.log('');
});
