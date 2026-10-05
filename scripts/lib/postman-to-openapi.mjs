/**
 * Postman collection (v2.1) -> OpenAPI 3.1 converter.
 *
 * Keeps everything that makes the collections valuable as documentation:
 * folder structure (tags), long-form descriptions, request body examples,
 * query/path parameter examples and every saved response example.
 *
 * Postman `{{variables}}` are preserved verbatim: the local proxy
 * (scripts/serve.mjs) resolves them at request time from the environment file.
 */

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu;

export const stripEmoji = (s = '') => s.replace(EMOJI, '').trim();

export function slugify(s = '') {
  return stripEmoji(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Tolerant JSON parse: Postman bodies sometimes carry trailing commas or comments. */
export function tryParseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {}
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    return { ok: false };
  }
}

/** Infer a JSON Schema from an example value so Scalar can render a real form. */
export function inferSchema(value, depth = 0) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    if (!value.length || depth > 6) return { type: 'array', items: {} };
    return { type: 'array', items: inferSchema(value[0], depth + 1) };
  }
  switch (typeof value) {
    case 'string': {
      const schema = { type: 'string', examples: [value] };
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]/.test(value)) schema.format = 'date-time';
      else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) schema.format = 'date';
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) schema.format = 'uuid';
      else if (/^https?:\/\//.test(value)) schema.format = 'uri';
      return schema;
    }
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number', examples: [value] };
    case 'boolean':
      return { type: 'boolean', examples: [value] };
    case 'object': {
      const properties = {};
      for (const [k, v] of Object.entries(value)) properties[k] = inferSchema(v, depth + 1);
      return { type: 'object', properties };
    }
    default:
      return {};
  }
}

/** Postman path segment -> OpenAPI path template. `:id` and `{{id}}` both become `{id}`. */
function normalizeSegment(seg) {
  if (typeof seg !== 'string') return { seg: String(seg), param: null };
  const colon = seg.match(/^:(.+)$/);
  if (colon) return { seg: '{' + colon[1] + '}', param: colon[1] };
  const mustache = seg.match(/^\{\{(.+?)\}\}$/);
  if (mustache) return { seg: '{' + mustache[1] + '}', param: mustache[1], fromVariable: true };
  return { seg, param: null };
}

function buildPath(url) {
  const rawSegments = Array.isArray(url?.path)
    ? url.path
    : String(url?.raw || '')
        .replace(/^\{\{\w+\}\}/, '')
        .split('?')[0]
        .split('/')
        .filter(Boolean);

  const params = [];
  const segments = rawSegments.map((s) => {
    const parsed = normalizeSegment(s);
    if (parsed.param) params.push({ name: parsed.param, fromVariable: parsed.fromVariable });
    return parsed.seg;
  });
  return { path: '/' + segments.join('/'), pathParams: params };
}

const SKIP_HEADERS = new Set([
  'content-type',
  'accept',
  'authorization',
  'content-length',
  'host',
  'user-agent',
]);

function detectSecurity(headers, schemesInUse) {
  const security = [];
  for (const h of headers) {
    if (h.disabled) continue;
    const key = String(h.key || '').toLowerCase();
    const value = String(h.value || '');
    if (key === 'authorization') {
      if (/^bearer\s/i.test(value)) {
        schemesInUse.bearerToken = value;
        security.push({ bearerToken: [] });
      } else {
        schemesInUse.cognitoIdToken = value;
        security.push({ cognitoIdToken: [] });
      }
    } else if (key === 'x-api-key') {
      schemesInUse.apiKeyHeader = value;
      security.push({ apiKeyHeader: [] });
    }
  }
  return security;
}

function bodyToContent(body) {
  if (!body || body.mode === 'none') return null;

  if (body.mode === 'raw') {
    const raw = body.raw || '';
    if (!raw.trim()) return null;
    const lang = body.options?.raw?.language;
    const parsed = tryParseJson(raw);
    if (parsed.ok && (lang === 'json' || !lang || typeof parsed.value === 'object')) {
      return {
        'application/json': {
          schema: inferSchema(parsed.value),
          example: parsed.value,
        },
      };
    }
    return {
      [lang === 'xml' ? 'application/xml' : 'text/plain']: {
        schema: { type: 'string' },
        example: raw,
      },
    };
  }

  if (body.mode === 'formdata' || body.mode === 'urlencoded') {
    const entries = body[body.mode] || [];
    const properties = {};
    const example = {};
    for (const f of entries) {
      if (f.disabled) continue;
      properties[f.key] =
        f.type === 'file'
          ? { type: 'string', format: 'binary', description: f.description || undefined }
          : {
              type: 'string',
              description: f.description || undefined,
              examples: f.value ? [f.value] : undefined,
            };
      if (f.type !== 'file' && f.value) example[f.key] = f.value;
    }
    const mime = body.mode === 'formdata' ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
    return { [mime]: { schema: { type: 'object', properties }, example } };
  }

  return null;
}

function responsesFrom(item) {
  const byCode = new Map();

  for (const res of item.response || []) {
    const code = String(res.code || 'default');
    if (!byCode.has(code)) byCode.set(code, { descriptions: [], examples: {} });
    const bucket = byCode.get(code);
    const label = res.name || code + ' response';
    bucket.descriptions.push(label);

    const parsed = tryParseJson(res.body);
    const key = slugify(label) || 'example-' + (Object.keys(bucket.examples).length + 1);
    bucket.examples[key] = {
      summary: label,
      value: parsed.ok ? parsed.value : res.body || '',
    };
  }

  if (!byCode.size) {
    return {
      default: {
        description: 'Sin ejemplo guardado en Postman. Ejecuta la peticion para ver la respuesta real.',
      },
    };
  }

  const responses = {};
  for (const [code, bucket] of byCode) {
    const first = Object.values(bucket.examples)[0]?.value;
    const isJson = first !== undefined && typeof first === 'object';
    responses[code] = {
      description: bucket.descriptions.join(' | '),
      content: {
        [isJson ? 'application/json' : 'text/plain']: {
          schema: isJson ? inferSchema(first) : { type: 'string' },
          examples: bucket.examples,
        },
      },
    };
  }
  return responses;
}

const descriptionText = (d) => (typeof d === 'string' ? d : d?.content || '');

/**
 * Scalar disables every non-path parameter that is not `required`, so an
 * optional query param would document fine but never actually be sent. The
 * `x-disabled` extension overrides that, and it is only read from inside an
 * `examples` map — not from the plain `example` field. Postman's own
 * enabled/disabled checkbox maps onto it one to one.
 */
function parameterExample(value, disabled) {
  return {
    examples: { default: { value: value ?? '', 'x-disabled': Boolean(disabled) } },
    schema: { type: 'string', examples: value === undefined ? undefined : [value] },
  };
}

/** `SERVICE_ID_HERE`, `<id>`, `` — values nobody meant literally. */
const isPlaceholder = (value) =>
  !value || /^<.*>$/.test(value) || (/^[A-Z0-9_]{3,}$/.test(value) && !/^\d+$/.test(value));

/**
 * Path params keep a usable default: a real example when Postman had one, and
 * otherwise `{{paramName}}` so the value can be set once in /env and reused by
 * every endpoint that takes it.
 */
function pathParamExample(name, postmanValue) {
  return isPlaceholder(postmanValue) ? '{{' + name + '}}' : postmanValue;
}

/** `GET /services/{id}` -> `GET /services/{}` so param naming never breaks matching. */
export const routeKey = (method, path) =>
  method.toUpperCase() + ' ' + path.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '');

function handlerNote(handler) {
  const lines = [
    '**Lambda:** `' + handler.functionName + '` -> `' + handler.handler + '`',
    handler.authorizer
      ? '**Authorizer:** `' + handler.authorizer + '`'
      : '**Authorizer:** publico (sin auth)',
  ];
  if (handler.file) lines.push('**Config:** `' + handler.file + '`');
  if (handler.description) lines.push('**Serverless:** ' + handler.description);
  return '\n\n---\n\n' + lines.join('  \n');
}

/**
 * @param {object} options
 * @param {object} options.collection Parsed Postman collection
 * @param {string} options.title
 * @param {Array<{url:string,description?:string}>} options.servers
 * @param {Map<string, object>} [options.handlers] routeKey -> serverless function info
 * @param {boolean} [options.includeMissing] Add stubs for routes present in
 *   serverless.yml but absent from the collection.
 * @param {Map<string, object>} [options.manualOverrides] routeKey -> manual
 *   override operation (see lib/manual-overrides.mjs) for a route that is
 *   present in serverless.yml but absent from the collection. When set, the
 *   route gets a full operation built from the override instead of the bare
 *   stub `includeMissing` would otherwise produce, tagged separately so it
 *   stays obvious it did not come from Postman.
 */
export function convertCollection({
  collection,
  title,
  servers,
  handlers = new Map(),
  includeMissing = true,
  missingTag = 'Sin documentar en Postman',
  manualOverrides = new Map(),
  manualTag = 'Documentado manualmente (api-docs)',
}) {
  const tags = [];
  const paths = {};
  const schemesInUse = {};
  const operationIds = new Set();
  const covered = new Set();

  const doc = {
    openapi: '3.1.0',
    info: {
      title: title || collection.info?.name || 'API',
      version: collection.info?.version?.raw || '1.0.0',
      description: descriptionText(collection.info?.description),
    },
    servers,
    tags,
    paths,
    components: { securitySchemes: {} },
  };

  function tagFor(folderPath) {
    if (!folderPath.length) return 'General';
    const name = folderPath.map((f) => f.name).join(' / ');
    if (!tags.find((t) => t.name === name)) {
      const description = folderPath.map((f) => descriptionText(f.description)).filter(Boolean).join('\n\n');
      tags.push({ name, description: description || undefined });
    }
    return name;
  }

  function uniqueOperationId(base) {
    let id = slugify(base) || 'operation';
    let n = 2;
    while (operationIds.has(id)) id = slugify(base) + '-' + n++;
    operationIds.add(id);
    return id;
  }

  function addOperation(item, folderPath) {
    const req = item.request;
    const method = String(req.method || 'GET').toLowerCase();
    const built = buildPath(req.url);
    const path = built.path;

    const existing = paths[path]?.[method];
    if (existing) {
      // Same route documented twice (e.g. two auth variants). OpenAPI allows one
      // operation per method+path, so fold the second one into the description.
      existing.description =
        (existing.description || '') +
        '\n\n---\n\n### ' +
        item.name +
        '\n\n' +
        descriptionText(req.description);
      return;
    }

    const tag = tagFor(folderPath);
    const parameters = [];
    const varDefaults = new Map((req.url?.variable || []).map((v) => [v.key, v]));

    for (const p of built.pathParams) {
      const known = varDefaults.get(p.name);
      parameters.push({
        name: p.name,
        in: 'path',
        required: true,
        description:
          descriptionText(known?.description) ||
          'Se resuelve desde la variable `' + p.name + '` del entorno local si la dejas como `{{' + p.name + '}}`.',
        schema: { type: 'string' },
        example: pathParamExample(p.name, known?.value),
      });
    }

    for (const q of req.url?.query || []) {
      if (!q.key) continue;
      parameters.push({
        name: q.key,
        in: 'query',
        required: false,
        description: descriptionText(q.description),
        ...parameterExample(q.value ?? undefined, q.disabled),
      });
    }

    const headers = req.header || [];
    for (const h of headers) {
      if (h.disabled) continue;
      const key = String(h.key || '').toLowerCase();
      if (!key || SKIP_HEADERS.has(key) || key === 'x-api-key') continue;
      parameters.push({
        name: h.key,
        in: 'header',
        required: false,
        description: descriptionText(h.description),
        ...parameterExample(h.value, false),
      });
    }

    const security = detectSecurity(headers, schemesInUse);
    const content = bodyToContent(req.body);

    const key = routeKey(method, path);
    covered.add(key);
    const handler = handlers.get(key);

    let description = descriptionText(req.description);
    if (handler) description += handlerNote(handler);

    paths[path] ||= {};
    paths[path][method] = {
      tags: [tag],
      summary: item.name,
      operationId: uniqueOperationId(folderPath.map((f) => f.name).join('-') + '-' + item.name),
      description: description || undefined,
      parameters: parameters.length ? parameters : undefined,
      requestBody: content ? { content, required: true } : undefined,
      responses: responsesFrom(item),
      security,
      'x-handler': handler,
    };
  }

  (function walk(items, folderPath) {
    for (const item of items || []) {
      if (item.item) {
        walk(item.item, folderPath.concat({ name: item.name, description: item.description }));
      } else if (item.request) {
        addOperation(item, folderPath);
      }
    }
  })(collection.item, []);

  // Routes that exist in serverless.yml but nobody documented in Postman.
  // A route with a manual override (see lib/manual-overrides.mjs) gets a full
  // operation from that override instead of the bare stub below, and is
  // tracked separately in `manuallyDocumented` — it is not "missing" in the
  // zero-documentation sense `missing` means everywhere else in this file.
  const missing = [];
  const manuallyDocumented = [];
  for (const [key, handler] of handlers) {
    if (covered.has(key)) continue;

    const method = handler.method.toLowerCase();
    const path = handler.path;
    const override = manualOverrides.get(key);

    if (override) {
      manuallyDocumented.push(handler);
      if (!includeMissing) continue;
      if (paths[path]?.[method]) continue;
      addManualOperation(path, method, handler, override);
      continue;
    }

    missing.push(handler);
    if (!includeMissing) continue;
    if (paths[path]?.[method]) continue;

    if (!tags.find((t) => t.name === missingTag)) {
      tags.push({
        name: missingTag,
        description:
          'Endpoints declarados en `serverless.yml` que **no** estan en la coleccion de Postman. ' +
          'No tienen ejemplo de body ni de respuesta: se listan para que la referencia sea completa ' +
          'y para saber que falta documentar.',
      });
    }

    const parameters = (path.match(/\{([^}]+)\}/g) || []).map((m) => {
      const name = m.slice(1, -1);
      return {
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
        example: '<' + name + '>',
      };
    });

    const secured = Boolean(handler.authorizer);
    if (secured) schemesInUse.cognitoIdToken ||= '{{idToken}}';

    paths[path] ||= {};
    paths[path][method] = {
      tags: [missingTag],
      summary: handler.functionName,
      operationId: uniqueOperationId('undocumented-' + handler.functionName),
      description:
        '> Sin documentar en Postman. Body y respuestas desconocidos.\n\n' +
        (handler.description ? handler.description + '\n' : '') +
        handlerNote(handler).replace(/^\n\n---\n\n/, ''),
      parameters: parameters.length ? parameters : undefined,
      responses: {
        default: { description: 'Sin ejemplo. Ejecuta la peticion para ver la respuesta real.' },
      },
      security: secured ? [{ cognitoIdToken: [] }] : [],
      'x-handler': handler,
      'x-undocumented': true,
    };
  }

  /**
   * Builds a full operation from a manual override (lib/manual-overrides.mjs)
   * for a route that exists in serverless.yml but has no Postman item —
   * follows the same operation shape `addOperation()` builds for a real
   * Postman item: parameters as given, `requestBody.content` inferred via
   * `inferSchema()`, and `responses` shaped like `responsesFrom()` produces
   * (`{ [code]: { description, content: { 'application/json': { schema,
   * examples } } } }`).
   */
  function addManualOperation(path, method, handler, override) {
    if (!tags.find((t) => t.name === manualTag)) {
      tags.push({
        name: manualTag,
        description:
          'Endpoints declarados en `serverless.yml` que **no** estan en la coleccion de Postman, ' +
          'documentados a mano leyendo directamente `api/src` (handler + domain service + request ' +
          'validation) en vez de desde Postman. Deberian terminar movidos a la coleccion real de ' +
          'Postman — ver `api-docs/scripts/lib/manual-overrides.mjs`.',
      });
    }

    const responses = {};
    for (const [code, res] of Object.entries(override.responses || {})) {
      const isJson = res.example !== undefined && typeof res.example === 'object' && res.example !== null;
      responses[code] = {
        description: res.description,
        content: {
          [isJson ? 'application/json' : 'text/plain']: {
            schema: isJson ? inferSchema(res.example) : { type: 'string' },
            examples: { default: { summary: res.description, value: res.example } },
          },
        },
      };
    }

    const secured = Boolean(handler.authorizer);
    if (secured) schemesInUse.cognitoIdToken ||= '{{idToken}}';

    paths[path] ||= {};
    paths[path][method] = {
      tags: [manualTag],
      summary: override.summary || handler.functionName,
      operationId: uniqueOperationId('manual-' + handler.functionName),
      description: (override.description || '') + handlerNote(handler),
      parameters: override.parameters?.length ? override.parameters : undefined,
      requestBody: override.requestBody
        ? {
            required: true,
            content: {
              'application/json': {
                schema: inferSchema(override.requestBody.example),
                example: override.requestBody.example,
              },
            },
          }
        : undefined,
      responses: Object.keys(responses).length
        ? responses
        : { default: { description: 'Sin ejemplo. Ejecuta la peticion para ver la respuesta real.' } },
      security: secured ? [{ cognitoIdToken: [] }] : [],
      'x-handler': handler,
      'x-source': 'manual-override',
    };
  }

  if (schemesInUse.cognitoIdToken) {
    doc.components.securitySchemes.cognitoIdToken = {
      type: 'apiKey',
      in: 'header',
      name: 'Authorization',
      description:
        'Cognito **ID token** crudo (sin prefijo `Bearer`).\n\n' +
        'Deja el valor `' +
        schemesInUse.cognitoIdToken +
        '`: el proxy local lo sustituye por un token fresco, ' +
        'pidiendolo o renovandolo contra Cognito automaticamente. Se configura en **/env**.',
      'x-default-value': schemesInUse.cognitoIdToken,
    };
  }
  if (schemesInUse.bearerToken) {
    doc.components.securitySchemes.bearerToken = {
      type: 'http',
      scheme: 'bearer',
      description:
        'Token Bearer. Valor por defecto `' +
        schemesInUse.bearerToken.replace(/^bearer\s+/i, '') +
        '`, resuelto por el proxy local.',
      'x-default-value': schemesInUse.bearerToken.replace(/^bearer\s+/i, ''),
    };
  }
  if (schemesInUse.apiKeyHeader) {
    doc.components.securitySchemes.apiKeyHeader = {
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
      description:
        'API key de servicio. Valor por defecto `' + schemesInUse.apiKeyHeader + '`, resuelto por el proxy local.',
      'x-default-value': schemesInUse.apiKeyHeader,
    };
  }

  return { doc, stats: { covered: covered.size, missing, manuallyDocumented } };
}
