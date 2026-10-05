/**
 * Manual documentation overrides for admin-v2 routes that exist in
 * `api/serverless.admin-v2.yml` but have no entry in
 * `api/postman/handerr-admin-v2-sql.postman_collection.json`.
 *
 * Postman is the source of truth for this repo's API docs — these 18
 * entries are a stopgap read directly from `api/src` (handler + domain
 * service + request-model validation) so the reference stops rendering
 * them as bare stubs. They should be moved into the real Postman
 * collection once someone documents them there; when that happens, delete
 * the matching entry here (a route documented in Postman always wins, see
 * `convertCollection` in ./postman-to-openapi.mjs).
 *
 * Keyed by the same `routeKey(method, path)` used everywhere else in this
 * converter — reused from serverless-routes.mjs rather than reimplemented.
 *
 * Shape of each entry mirrors what `addOperation()` in postman-to-openapi.mjs
 * builds from a real Postman item:
 *   - summary / description: plain strings (description supports Markdown).
 *   - parameters: OpenAPI parameter objects (path/query only — no headers).
 *   - requestBody: `{ example }` — schema is inferred from the example the
 *     same way a Postman raw JSON body would be (see inferSchema()).
 *   - responses: `{ [statusCode]: { description, example } }` — schema is
 *     inferred from `example` the same way responsesFrom() does for a saved
 *     Postman response.
 *
 * None of these are the v2 canonical read-model contract (page/pageSize/
 * sortBy/sortOrder/search -> { items, page, pageSize, total }, documented in
 * the collection's own info.description). All 4 list endpoints here
 * (auditAdminList, supportAdminList, countryAdminList,
 * categoryAliasesAdminList) predate that contract and were moved into this
 * stack only to relieve serverless.admin.yml's CloudFormation resource
 * limit (see the HAN-347 comment block at the top of serverless.admin-v2.yml)
 * — they keep their own DynamoDB-cursor-based pagination, confirmed by
 * reading each handler below. Verified while researching this file, not
 * assumed.
 */

/** @typedef {{ name: string, in: 'path'|'query', required: boolean, schema: object, example?: unknown, description?: string }} OverrideParameter */
/** @typedef {{ description: string, example: unknown }} OverrideResponse */
/** @typedef {{ summary: string, description: string, parameters?: OverrideParameter[], requestBody?: { example: unknown }, responses: Record<string, OverrideResponse> }} OverrideOperation */

/** @type {Record<string, OverrideOperation>} */
export const MANUAL_OVERRIDES = {
  'GET /admin/audit-log': {
    summary: 'List audit log entries',
    description:
      'Query the audit log by actor, resource, or action, with an optional date range. ' +
      'Auth: Bearer from the admin pool; permission `audit:read`.\n\n' +
      'Exactly one of `actor` / `resource` / `action` is required — providing zero or more than ' +
      'one returns 400. `actor` filters by `actorUserId`, `resource` by the resource string ' +
      '(e.g. `support-ticket/<id>`, `country/<code>`), `action` by the permission string that was ' +
      'exercised (e.g. `support:update`). Each maps to its own DynamoDB GSI ' +
      '(`resource-timestamp-index` / `action-timestamp-index`) or the base table for `actor`.\n\n' +
      'Not the v2 canonical list contract: pagination is an opaque `cursor`, not page/pageSize, ' +
      'and there is no `total`.',
    parameters: [
      { name: 'actor', in: 'query', required: false, schema: { type: 'string' }, example: 'a1b2c3d4-5678-90ab-cdef-1234567890ab', description: 'Filter by actorUserId. Mutually exclusive with resource/action.' },
      { name: 'resource', in: 'query', required: false, schema: { type: 'string' }, example: 'support-ticket/9f2c1e4a-0b3d-4f5e-8a6b-1c2d3e4f5a6b', description: 'Filter by resource string. Mutually exclusive with actor/action.' },
      { name: 'action', in: 'query', required: false, schema: { type: 'string' }, example: 'support:update', description: 'Filter by the permission string exercised. Mutually exclusive with actor/resource.' },
      { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, example: '2026-08-01T00:00:00.000Z', description: 'ISO timestamp, inclusive lower bound on createdAt.' },
      { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, example: '2026-09-01T00:00:00.000Z', description: 'ISO timestamp, inclusive upper bound on createdAt.' },
      { name: 'limit', in: 'query', required: false, schema: { type: 'string' }, example: '50', description: 'Positive integer. Repository default 50, hard cap 200.' },
      { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, example: '', description: 'Opaque cursor from a previous response — echo it back verbatim to page forward.' },
    ],
    responses: {
      200: {
        description: 'OK',
        example: {
          items: [
            {
              actorUserId: 'a1b2c3d4-5678-90ab-cdef-1234567890ab',
              actorEmail: 'admin@handerr.com',
              actorRole: 'admin',
              action: 'support:update',
              resource: 'support-ticket/9f2c1e4a-0b3d-4f5e-8a6b-1c2d3e4f5a6b',
              result: 'success',
              createdAt: '2026-09-10T14:32:05.120Z',
              metadata: { statusChange: 'resolved', hasAdminNotes: true },
            },
          ],
          cursor: null,
        },
      },
      400: { description: 'BAD_REQUEST — zero or more than one of actor/resource/action provided, or limit is not a positive number', example: { error: 'Provide exactly one of: actor, resource, action' } },
      401: { description: 'UNAUTHORIZED — no valid session', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing audit:read permission', example: { error: 'Permission denied: audit:read' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Failed to query audit log' } },
    },
  },

  'GET /admin/support/tickets': {
    summary: 'List support tickets (admin)',
    description:
      'Backoffice list of support tickets, optionally filtered by status and/or userId. ' +
      'Auth: Bearer from the admin pool; permission `support:read`.\n\n' +
      'With `userId` set, queries the `userId-createdAt-index` GSI and applies `status` as an ' +
      'in-memory filter afterward (so the requested `limit` may return fewer than `limit` items ' +
      'when a status filter is combined with userId). Without `userId`, queries ' +
      '`status-createdAt-index` directly — defaulting to `status=open` when no status is given.\n\n' +
      'Not the v2 canonical list contract: pagination is DynamoDB `lastEvaluatedKey`, not page/' +
      'pageSize, and there is no `total`.',
    parameters: [
      { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['open', 'in_progress', 'resolved', 'closed'] }, example: 'open', description: 'Defaults to "open" when userId is not set; ignored (not "unset") when it is not one of the 4 valid values.' },
      { name: 'userId', in: 'query', required: false, schema: { type: 'string' }, example: 'a1b2c3d4-5678-90ab-cdef-1234567890ab', description: 'Restrict to one user\'s tickets, newest first.' },
      { name: 'limit', in: 'query', required: false, schema: { type: 'string' }, example: '20', description: 'Clamped to [1, 100]. Default 20.' },
      { name: 'lastEvaluatedKey', in: 'query', required: false, schema: { type: 'string' }, example: '', description: 'JSON-encoded DynamoDB ExclusiveStartKey from a previous response\'s lastKey. Silently ignored if it fails to JSON.parse.' },
    ],
    responses: {
      200: {
        description: 'OK',
        example: {
          items: [
            {
              ticketId: '9f2c1e4a-0b3d-4f5e-8a6b-1c2d3e4f5a6b',
              userId: 'a1b2c3d4-5678-90ab-cdef-1234567890ab',
              status: 'open',
              description: 'El profesional no llegó a la cita agendada.',
              category: 'service',
              serviceId: '7c8d9e0f-1a2b-3c4d-5e6f-7a8b9c0d1e2f',
              reason: 'work_not_done',
              reporterRole: 'client',
              relatedAlertId: null,
              attachments: ['support/a1b2c3d4/photo-1.jpg'],
              context: { appVersion: '1.8.2', osPlatform: 'android', osVersion: '14', locale: 'es-VE' },
              adminNotes: null,
              resolvedAt: null,
              createdAt: '2026-09-10T14:20:00.000Z',
              updatedAt: '2026-09-10T14:20:00.000Z',
            },
          ],
          lastKey: null,
        },
      },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing support:read permission', example: { error: 'Permission denied: support:read' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'GET /admin/support/tickets/{}': {
    summary: 'Get a support ticket detail (admin)',
    description:
      'Backoffice single-ticket view. Auth: Bearer from the admin pool; permission `support:read`.\n\n' +
      'Enriches the raw ticket with: presigned attachment URLs (S3), the related service\'s status/' +
      'payment snapshot when `serviceId` is set (budgetId, paymentId, paymentStatus, amount), and ' +
      'both parties (client/professional — name, email, verified phone) resolved from `UsersTable`. ' +
      '`parties`/`service` are both `null` when the ticket has no `serviceId`.',
    parameters: [
      { name: 'ticketId', in: 'path', required: true, schema: { type: 'string' }, example: '9f2c1e4a-0b3d-4f5e-8a6b-1c2d3e4f5a6b' },
    ],
    responses: {
      200: {
        description: 'OK',
        example: {
          ticket: {
            ticketId: '9f2c1e4a-0b3d-4f5e-8a6b-1c2d3e4f5a6b',
            userId: 'a1b2c3d4-5678-90ab-cdef-1234567890ab',
            status: 'open',
            description: 'El profesional no llegó a la cita agendada.',
            category: 'service',
            serviceId: '7c8d9e0f-1a2b-3c4d-5e6f-7a8b9c0d1e2f',
            reason: 'work_not_done',
            reporterRole: 'client',
            relatedAlertId: 'a5b6c7d8-e9f0-1a2b-3c4d-5e6f7a8b9c0d',
            attachments: [{ key: 'support/a1b2c3d4/photo-1.jpg', url: 'https://d123.cloudfront.net/support/a1b2c3d4/photo-1.jpg?Expires=...' }],
            context: { appVersion: '1.8.2', osPlatform: 'android', osVersion: '14', locale: 'es-VE' },
            adminNotes: null,
            resolvedAt: null,
            createdAt: '2026-09-10T14:20:00.000Z',
            updatedAt: '2026-09-10T14:20:00.000Z',
            parties: {
              client: { userId: 'a1b2c3d4-5678-90ab-cdef-1234567890ab', name: 'Carla Pérez', email: 'carla@example.com', phoneE164: '+584121234567' },
              professional: { userId: 'b2c3d4e5-6789-01bc-def0-234567890abc', name: 'Luis Gómez', email: 'luis@example.com', phoneE164: null },
            },
            service: { serviceId: '7c8d9e0f-1a2b-3c4d-5e6f-7a8b9c0d1e2f', status: 'in_progress', budgetId: 'c3d4e5f6-7890-12cd-ef01-34567890abcd', paymentId: 'd4e5f6a7-8901-23de-f012-4567890abcde', paymentStatus: 'held', amount: 45.5 },
          },
        },
      },
      400: { description: 'BAD_REQUEST — missing ticketId', example: { error: 'ticketId is required' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing support:read permission', example: { error: 'Permission denied: support:read' } },
      404: { description: 'NOT_FOUND', example: { error: 'Ticket not found' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'PATCH /admin/support/tickets/{}': {
    summary: 'Update a support ticket (admin)',
    description:
      'Update a ticket\'s `status` and/or `adminNotes`. Auth: Bearer from the admin pool; ' +
      'permission `support:update`. At least one of the two fields is required.\n\n' +
      'Moving `status` to `resolved` sets `resolvedAt`; moving it back to `open`/`in_progress` ' +
      'clears it. When the new status is `resolved` or `closed`, this also resolves the ticket\'s ' +
      '`relatedAlertId` (if any, and if it is still `open`/`acknowledged`) and releases the ' +
      'service\'s open-ticket pointer. Audited via `withAudit` on `support:update`.',
    parameters: [
      { name: 'ticketId', in: 'path', required: true, schema: { type: 'string' }, example: '9f2c1e4a-0b3d-4f5e-8a6b-1c2d3e4f5a6b' },
    ],
    requestBody: {
      example: { status: 'resolved', adminNotes: 'Reembolso procesado, cliente notificado.' },
    },
    responses: {
      200: {
        description: 'OK',
        example: {
          ticket: {
            ticketId: '9f2c1e4a-0b3d-4f5e-8a6b-1c2d3e4f5a6b',
            userId: 'a1b2c3d4-5678-90ab-cdef-1234567890ab',
            status: 'resolved',
            description: 'El profesional no llegó a la cita agendada.',
            category: 'service',
            serviceId: '7c8d9e0f-1a2b-3c4d-5e6f-7a8b9c0d1e2f',
            adminNotes: 'Reembolso procesado, cliente notificado.',
            resolvedAt: '2026-09-19T10:05:00.000Z',
            createdAt: '2026-09-10T14:20:00.000Z',
            updatedAt: '2026-09-19T10:05:00.000Z',
          },
        },
      },
      400: { description: 'BAD_REQUEST — missing ticketId, missing body, neither status nor adminNotes provided, status not one of the 4 valid values, or adminNotes not a string/null', example: { error: 'At least one of status or adminNotes is required' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing support:update permission', example: { error: 'Permission denied: support:update' } },
      404: { description: 'NOT_FOUND', example: { error: 'Ticket not found' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'GET /admin/countries': {
    summary: 'List country configs (admin)',
    description:
      'List every country config row, optionally restricted to enabled ones. Auth: Bearer from ' +
      'the admin pool; permission `countries:read`.\n\n' +
      'Not the v2 canonical list contract: no pagination at all (a full Query against the ' +
      '`entity-name-index` GSI, sorted by name) and no `total` — the catalogue is small by design.',
    parameters: [
      { name: 'enabled', in: 'query', required: false, schema: { type: 'string' }, example: 'true', description: 'Any value other than the literal string "true" is treated as false/absent (no filter).' },
    ],
    responses: {
      200: {
        description: 'OK',
        example: {
          items: [
            {
              countryCode: 'VE',
              entity: 'country',
              name: 'Venezuela',
              currency: 'VES',
              hasIva: true,
              ivaRate: 0.16,
              feeOverride: null,
              paymentMethods: ['BANK_MOBILE', 'TRANSFER_BANK', 'CHINCHIN'],
              enabled: true,
              createdAt: '2026-01-15T00:00:00.000Z',
              updatedAt: '2026-06-01T09:00:00.000Z',
              updatedBy: 'a1b2c3d4-5678-90ab-cdef-1234567890ab',
            },
          ],
        },
      },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing countries:read permission', example: { error: 'Permission denied: countries:read' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'GET /admin/countries/{}': {
    summary: 'Get a country config (admin)',
    description:
      'Single country config by its ISO 3166-1 alpha-2 code. Auth: Bearer from the admin pool; ' +
      'permission `countries:read`. Returns the item directly — not wrapped in `{ item }`.',
    parameters: [
      { name: 'countryCode', in: 'path', required: true, schema: { type: 'string' }, example: 'VE', description: 'ISO 3166-1 alpha-2, case-insensitive on input (stored/returned uppercase).' },
    ],
    responses: {
      200: {
        description: 'OK',
        example: {
          countryCode: 'VE',
          entity: 'country',
          name: 'Venezuela',
          currency: 'VES',
          hasIva: true,
          ivaRate: 0.16,
          feeOverride: null,
          paymentMethods: ['BANK_MOBILE', 'TRANSFER_BANK', 'CHINCHIN'],
          enabled: true,
          createdAt: '2026-01-15T00:00:00.000Z',
          updatedAt: '2026-06-01T09:00:00.000Z',
          updatedBy: 'a1b2c3d4-5678-90ab-cdef-1234567890ab',
        },
      },
      400: { description: 'BAD_REQUEST — missing countryCode', example: { error: 'countryCode is required' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing countries:read permission', example: { error: 'Permission denied: countries:read' } },
      404: { description: 'NOT_FOUND', example: { error: 'countryCode VE not found' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'POST /admin/countries': {
    summary: 'Create a country config',
    description:
      'Create a new country config. Auth: Bearer from the admin pool; permission ' +
      '`countries:create` (superadmin only). Audited via `withAudit` on `countries:create`.\n\n' +
      '`countryCode` must be unique (ISO 3166-1 alpha-2). `currency` must be ISO 4217. `ivaRate` ' +
      'is required (and clamped to be meaningful) when `hasIva` is true, otherwise forced to 0. ' +
      '`feeOverride` is optional (`null`/absent means "no override", otherwise a 0..1 rate). ' +
      '`paymentMethods` must be a non-empty array of strings (deduplicated on save; not restricted ' +
      'to a fixed enum in code, but see ChinChinService\'s known keys: `BANK_MOBILE`, ' +
      '`BANCAMIGA_BUTTON`, `BDV_BUTTON`, `BDV_BUTTON_BIZ`, `INMEDIATE_DEBIT`, `TRANSFER_BANK`, ' +
      '`CHINCHIN`). `enabled` defaults to `true`.',
    requestBody: {
      example: {
        countryCode: 'CO',
        name: 'Colombia',
        currency: 'COP',
        hasIva: true,
        ivaRate: 0.19,
        feeOverride: null,
        paymentMethods: ['TRANSFER_BANK'],
        enabled: true,
      },
    },
    responses: {
      201: {
        description: 'Created',
        example: {
          countryCode: 'CO',
          entity: 'country',
          name: 'Colombia',
          currency: 'COP',
          hasIva: true,
          ivaRate: 0.19,
          feeOverride: null,
          paymentMethods: ['TRANSFER_BANK'],
          enabled: true,
          createdAt: '2026-09-19T10:00:00.000Z',
          updatedAt: '2026-09-19T10:00:00.000Z',
          updatedBy: 'a1b2c3d4-5678-90ab-cdef-1234567890ab',
        },
      },
      400: { description: 'BAD_REQUEST — missing body or a field fails validation (countryCode format, currency format, hasIva/enabled not boolean, ivaRate/feeOverride out of [0,1], paymentMethods empty)', example: { error: 'countryCode must be a valid ISO 3166-1 alpha-2 code (e.g. "VE")' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing countries:create permission', example: { error: 'Permission denied: countries:create' } },
      409: { description: 'CONFLICT — countryCode already exists', example: { error: 'countryCode CO already exists' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'PATCH /admin/countries/{}': {
    summary: 'Update a country config',
    description:
      'Partially update a country config. Auth: Bearer from the admin pool; permission ' +
      '`countries:update` (superadmin only). Audited via `withAudit` on `countries:update`.\n\n' +
      '`countryCode`, `entity` and `createdAt` are immutable — sending any of them returns 400. ' +
      'Every other field from POST\'s body is optional here; sending `hasIva: false` without ' +
      '`ivaRate` resets `ivaRate` to 0. At least one mutable field must be present.',
    parameters: [
      { name: 'countryCode', in: 'path', required: true, schema: { type: 'string' }, example: 'VE' },
    ],
    requestBody: {
      example: { ivaRate: 0.16, paymentMethods: ['BANK_MOBILE', 'TRANSFER_BANK', 'CHINCHIN', 'BDV_BUTTON'] },
    },
    responses: {
      200: {
        description: 'OK',
        example: {
          countryCode: 'VE',
          entity: 'country',
          name: 'Venezuela',
          currency: 'VES',
          hasIva: true,
          ivaRate: 0.16,
          feeOverride: null,
          paymentMethods: ['BANK_MOBILE', 'TRANSFER_BANK', 'CHINCHIN', 'BDV_BUTTON'],
          enabled: true,
          createdAt: '2026-01-15T00:00:00.000Z',
          updatedAt: '2026-09-19T10:10:00.000Z',
          updatedBy: 'a1b2c3d4-5678-90ab-cdef-1234567890ab',
        },
      },
      400: { description: 'BAD_REQUEST — missing countryCode/body, an immutable field present, or a mutable field fails validation, or no mutable fields provided', example: { error: 'countryCode is immutable and cannot be updated' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing countries:update permission', example: { error: 'Permission denied: countries:update' } },
      404: { description: 'NOT_FOUND', example: { error: 'countryCode VE not found' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'PATCH /admin/families/{}/subgroups': {
    summary: 'Replace a family\'s subgroups',
    description:
      'Full-array replace of one family\'s `subgroups`, rejecting any other field (a copy-paste ' +
      'from the general family PATCH gets a 400 instead of a silent partial update). Auth: Bearer ' +
      'from the admin pool; permission `families:update`. Audited via `withAudit`.\n\n' +
      'Subgroups are soft-deleted only (HAN-307): a slug present in the family\'s current array ' +
      'but missing from the new `subgroups` returns 409 — archive it instead (see the `/archive` ' +
      'endpoint) rather than omitting it. Optimistic-locked on the family\'s `updatedAt`.',
    parameters: [
      { name: 'familyKey', in: 'path', required: true, schema: { type: 'string' }, example: 'hogar' },
    ],
    requestBody: {
      example: {
        subgroups: [
          { slug: 'plomeria', name: 'Plomería', order: 1 },
          { slug: 'electricidad', name: 'Electricidad', order: 2 },
          { slug: 'jardineria', name: 'Jardinería', order: 3, archived: true },
        ],
      },
    },
    responses: {
      200: {
        description: 'OK',
        example: {
          familyKey: 'hogar',
          name: 'Hogar',
          icon: 'home',
          color: '#F58A1F',
          enabled: true,
          sortOrder: 1,
          subgroups: [
            { slug: 'plomeria', name: 'Plomería', order: 1, archived: false },
            { slug: 'electricidad', name: 'Electricidad', order: 2, archived: false },
            { slug: 'jardineria', name: 'Jardinería', order: 3, archived: true },
          ],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-09-19T10:15:00.000Z',
        },
      },
      400: { description: 'BAD_REQUEST — missing familyKey, missing/invalid JSON body, a field other than "subgroups" present, "subgroups" missing, or a subgroup entry fails validation (slug/name format, duplicate slug)', example: { error: 'Field "name" is not allowed on this endpoint — only "subgroups"' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing families:update permission', example: { error: 'Permission denied: families:update' } },
      404: { description: 'NOT_FOUND', example: { error: 'Family not found' } },
      409: { description: 'CONFLICT — the update would drop an existing (non-archived-in-place) slug, or the family changed concurrently (optimistic lock)', example: { error: 'No se puede eliminar la(s) sección(es) jardineria: deben archivarse en lugar de quitarse.' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'GET /admin/families/{}/subgroups/{}': {
    summary: 'Get a family subgroup',
    description:
      'Fetch one subgroup by slug within a family. Auth: Bearer from the admin pool; permission ' +
      '`families:read`.',
    parameters: [
      { name: 'familyKey', in: 'path', required: true, schema: { type: 'string' }, example: 'hogar' },
      { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, example: 'plomeria' },
    ],
    responses: {
      200: { description: 'OK', example: { slug: 'plomeria', name: 'Plomería', order: 1, archived: false } },
      400: { description: 'BAD_REQUEST — familyKey or slug fails the slug-shape validator', example: { error: 'slug must be lowercase alphanumeric with hyphens (e.g. "hogar-reparaciones")' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing families:read permission', example: { error: 'Permission denied: families:read' } },
      404: { description: 'NOT_FOUND — family or subgroup does not exist', example: { error: 'Subgroup "plomeria" not found in family "hogar"' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'POST /admin/families/{}/subgroups/{}/archive': {
    summary: 'Archive a family subgroup',
    description:
      'Soft-delete (archive) one subgroup by slug within a family — flips `archived: true` in ' +
      'place, never removes the entry from the array. Idempotent: archiving an already-archived ' +
      'subgroup succeeds and returns it unchanged. Auth: Bearer from the admin pool; permission ' +
      '`families:update`. No request body. Audited via `withAudit`.',
    parameters: [
      { name: 'familyKey', in: 'path', required: true, schema: { type: 'string' }, example: 'hogar' },
      { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, example: 'jardineria' },
    ],
    responses: {
      200: { description: 'OK', example: { slug: 'jardineria', name: 'Jardinería', order: 3, archived: true } },
      400: { description: 'BAD_REQUEST — familyKey or slug fails the slug-shape validator', example: { error: 'slug must be lowercase alphanumeric with hyphens (e.g. "hogar-reparaciones")' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing families:update permission', example: { error: 'Permission denied: families:update' } },
      404: { description: 'NOT_FOUND — family or subgroup does not exist', example: { error: 'Subgroup "jardineria" not found in family "hogar"' } },
      409: { description: 'CONFLICT — the family changed concurrently (optimistic lock on the underlying update)', example: { error: 'Family state changed concurrently' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'POST /admin/families/{}/subgroups': {
    summary: 'Create a family subgroup',
    description:
      'Create ONE subgroup within a family (the single-item convenience over the full-array PATCH ' +
      'above). Auth: Bearer from the admin pool; permission `families:update`. Audited via ' +
      '`withAudit`.\n\n' +
      '`slug` must be unique within the family (409 if taken). Accepts only `slug`, `name`, ' +
      '`order`, `archived` — any other field is rejected.',
    parameters: [
      { name: 'familyKey', in: 'path', required: true, schema: { type: 'string' }, example: 'hogar' },
    ],
    requestBody: {
      example: { slug: 'pintura', name: 'Pintura', order: 4 },
    },
    responses: {
      201: { description: 'Created', example: { slug: 'pintura', name: 'Pintura', order: 4, archived: false } },
      400: { description: 'BAD_REQUEST — missing familyKey, missing/invalid JSON body, an unknown field present, or slug/name/order/archived fails validation', example: { error: 'Field "icon" is not allowed' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing families:update permission', example: { error: 'Permission denied: families:update' } },
      404: { description: 'NOT_FOUND — family does not exist', example: { error: 'Family not found' } },
      409: { description: 'CONFLICT — family already has a subgroup with this slug', example: { error: 'Family "hogar" already has a subgroup with slug "pintura"' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'POST /admin/families/{}/subgroups/{}/move': {
    summary: 'Move a subgroup to another family (async)',
    description:
      'Validate and enqueue moving a subgroup to a different family. Auth: Bearer from the admin ' +
      'pool; permission `families:update`. Audited via `withAudit`.\n\n' +
      'This endpoint only runs a cheap synchronous pre-check (`assertSubgroupMovable`) and then ' +
      'enqueues a `move-subgroup` job on the shared category-operation-jobs queue — the actual ' +
      'move plus per-category migration runs asynchronously in `categoryJobsProcess`, since it can ' +
      'exceed API Gateway\'s 29s ceiling. Poll job status via `GET /admin/category-jobs/{jobId}` ' +
      '(documented elsewhere — not one of these 18 routes).',
    parameters: [
      { name: 'familyKey', in: 'path', required: true, schema: { type: 'string' }, example: 'hogar', description: 'The subgroup\'s current family.' },
      { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, example: 'plomeria' },
    ],
    requestBody: {
      example: { toFamilyKey: 'mantenimiento' },
    },
    responses: {
      202: {
        description: 'Accepted — job enqueued',
        example: {
          jobId: 'e5f6a7b8-9012-34ef-0123-567890abcdef',
          type: 'move-subgroup',
          status: 'pending',
          input: { fromFamilyKey: 'hogar', slug: 'plomeria', toFamilyKey: 'mantenimiento' },
          createdAt: '2026-09-19T10:20:00.000Z',
          updatedAt: '2026-09-19T10:20:00.000Z',
        },
      },
      400: { description: 'BAD_REQUEST — missing familyKey/slug/body, toFamilyKey not present or fails the slug-shape validator, toFamilyKey equal to the subgroup\'s current family, or destination family does not exist/is disabled', example: { error: 'toFamilyKey must be different from the subgroup\'s current family' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing families:update permission', example: { error: 'Permission denied: families:update' } },
      404: { description: 'NOT_FOUND — source family or subgroup does not exist', example: { error: 'Subgroup "plomeria" not found in family "hogar"' } },
      409: { description: 'CONFLICT — destination family already has a subgroup with this slug', example: { error: 'Family "mantenimiento" already has a subgroup with slug "plomeria"' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'GET /admin/v2/taxonomy/categories/{}': {
    summary: 'Get a category detail (admin v2, Aurora read-model)',
    description:
      'Single-category detail view from the Aurora read-model — name/icon/aliases, plus the two ' +
      'aggregates the DynamoDB side has no cheap way to compute: `professionalCount` (active, ' +
      'non-archived professionals currently offering it) and `requestCount90d` (service requests ' +
      'in the last 90 days), together with the category\'s family/subgroup placement (absent on ' +
      'both means unclassified). Auth: Bearer from the admin pool; permission `categories:read`.\n\n' +
      'NOT the v2 canonical list contract (this is a single-item detail, not a list) — it does not ' +
      'take page/pageSize/sortBy/search. It reuses `TaxonomyReadQueries.tree()` under the hood ' +
      '(same 30s in-process cache as `GET /admin/v2/taxonomy/tree`), so a cold-cache request pays ' +
      'the full tree computation cost — same as tree() itself, hence the shared 29s Lambda timeout.',
    parameters: [
      { name: 'keyName', in: 'path', required: true, schema: { type: 'string' }, example: 'plomeria' },
    ],
    responses: {
      200: {
        description: 'OK',
        example: {
          keyName: 'plomeria',
          name: 'Plomería',
          icon: 'wrench',
          enabled: true,
          taxTreatment: 'taxable',
          aliases: [{ aliasKey: 'fontaneria', name: 'Fontanería', enabled: true }],
          professionalCount: 34,
          requestCount90d: 112,
          familyKey: 'hogar',
          subgroupSlug: 'plomeria-electricidad',
        },
      },
      400: { description: 'BAD_REQUEST — keyName fails the shape validator (length/pattern)', example: { error: 'keyName format is invalid' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing categories:read permission', example: { error: 'Permission denied: categories:read' } },
      404: { description: 'NOT_FOUND', example: { error: 'Category "plomeria" not found' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'GET /admin/category-aliases': {
    summary: 'List category aliases (admin)',
    description:
      'Backoffice list of category aliases (both enabled and disabled — the admin manages both), ' +
      'optionally filtered by canonical category, status, or a name search. Auth: Bearer from the ' +
      'admin pool; permission `category-aliases:read`.\n\n' +
      'Not the v2 canonical list contract: pagination is an opaque `lastKey` cursor (its `_mode` ' +
      'field is internal and switches between a GSI query when `canonicalKeyName` is set and a ' +
      'table scan otherwise — reusing a cursor across a filter change that flips the mode returns ' +
      '400), and the response carries `hasMore` instead of `total`.',
    parameters: [
      { name: 'limit', in: 'query', required: false, schema: { type: 'string' }, example: '50', description: 'Integer in [1, 100]. Default 50.' },
      { name: 'lastKey', in: 'query', required: false, schema: { type: 'string' }, example: '', description: 'Opaque cursor from a previous response — echo it back verbatim.' },
      { name: 'canonicalKeyName', in: 'query', required: false, schema: { type: 'string' }, example: 'plomeria', description: 'Restrict to aliases of one canonical category (uses the canonicalKeyName-index GSI).' },
      { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['enabled', 'disabled'] }, example: 'enabled' },
      { name: 'search', in: 'query', required: false, schema: { type: 'string' }, example: 'fontan', description: 'Case/accent-insensitive substring match on the alias name. Max 80 characters.' },
    ],
    responses: {
      200: {
        description: 'OK',
        example: {
          items: [
            { aliasKey: 'fontaneria', canonicalKeyName: 'plomeria', name: 'Fontanería', enabled: true, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
          ],
          lastKey: null,
          hasMore: false,
        },
      },
      400: { description: 'BAD_REQUEST — limit out of [1,100], lastKey malformed, canonicalKeyName fails the key-shape validator, status not enabled/disabled, search over 80 chars, or an incompatible/expired cursor reaches DynamoDB', example: { error: 'limit must be an integer between 1 and 100' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing category-aliases:read permission', example: { error: 'Permission denied: category-aliases:read' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'POST /admin/category-aliases': {
    summary: 'Create a category alias',
    description:
      'Create a new alias for an existing, enabled category. Auth: Bearer from the admin pool; ' +
      'permission `category-aliases:manage`. Audited via `withAudit`.\n\n' +
      '`aliasKey` cannot equal `canonicalKeyName` (every category already has its own self alias, ' +
      'created automatically on category creation) and cannot collide with an existing category ' +
      '`keyName`. Written transactionally alongside incrementing the target category\'s ' +
      '`dependentAliasCount`.',
    requestBody: {
      example: { aliasKey: 'grifero', canonicalKeyName: 'plomeria', name: 'Grifero' },
    },
    responses: {
      201: { description: 'Created', example: { aliasKey: 'grifero', canonicalKeyName: 'plomeria', name: 'Grifero', enabled: true, createdAt: '2026-09-19T10:25:00.000Z', updatedAt: '2026-09-19T10:25:00.000Z' } },
      400: { description: 'BAD_REQUEST — missing/invalid JSON body, aliasKey equals canonicalKeyName, or aliasKey/canonicalKeyName/name fails format validation, or the canonical category does not exist/is disabled', example: { error: 'aliasKey cannot equal canonicalKeyName — every category already has its self alias' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing category-aliases:manage permission', example: { error: 'Permission denied: category-aliases:manage' } },
      409: { description: 'CONFLICT — aliasKey already exists, aliasKey collides with a category keyName, or a concurrent write is in progress on the canonical category', example: { error: 'Alias "grifero" already exists' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'PATCH /admin/category-aliases/{}': {
    summary: 'Rename or enable/disable a category alias',
    description:
      'Rename an alias and/or flip its `enabled` flag — never moves it to another category ' +
      '(there is no `canonicalKeyName` in the accepted body). Auth: Bearer from the admin pool; ' +
      'permission `category-aliases:manage`. Audited via `withAudit`.\n\n' +
      'Rejects the category\'s own self alias (409 — rename/disable the category itself instead) ' +
      'and rejects disabling a converted alias (409 — undo the conversion instead, see the ' +
      '`/undo-conversion` endpoint). Disabling a non-self alias that was still enabled enqueues an ' +
      'async `disable-alias` job that migrates any professional currently on it to the category\'s ' +
      'self alias; when that happens the response carries `migrationJobId`.',
    parameters: [
      { name: 'aliasKey', in: 'path', required: true, schema: { type: 'string' }, example: 'grifero' },
    ],
    requestBody: {
      example: { enabled: false },
    },
    responses: {
      200: {
        description: 'OK. `migrationJobId` is present only when this patch just flipped enabled true -> false on a non-self, non-converted alias.',
        example: { aliasKey: 'grifero', canonicalKeyName: 'plomeria', name: 'Grifero', enabled: false, createdAt: '2026-09-19T10:25:00.000Z', updatedAt: '2026-09-19T10:30:00.000Z', migrationJobId: 'f6a7b8c9-0123-45f0-1234-67890abcdef0' },
      },
      400: { description: 'BAD_REQUEST — missing aliasKey, missing/invalid JSON body, an unknown field present, or name/enabled fails validation, or no editable field provided', example: { error: 'At least one editable field is required' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing category-aliases:manage permission', example: { error: 'Permission denied: category-aliases:manage' } },
      404: { description: 'NOT_FOUND', example: { error: 'Alias not found' } },
      409: { description: 'CONFLICT — this is the category\'s own self alias, or this alias was created by a conversion and enabled:false was sent', example: { error: '"plomeria" is the category\'s own self alias — rename or disable the category itself instead' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },

  'POST /admin/category-aliases/{}/undo-conversion': {
    summary: 'Undo a category-to-alias conversion (async)',
    description:
      'Undo a Fase 4 category-to-alias conversion, restoring the deleted category row and ' +
      'reassigning any professional migrated by that conversion back to it. Auth: Bearer from the ' +
      'admin pool; permission `categories:alias` (superadmin only — a destructive, harder-to-' +
      'reverse operation, deliberately separated from `category-aliases:manage`). No request body. ' +
      'Audited via `withAudit`.\n\n' +
      'Only valid on an alias that actually carries conversion provenance ' +
      '(`convertedAt`/`convertedFrom` set) — anything else 404s immediately as a cheap sync ' +
      'pre-check. The actual restore (recreate the category, migrate matched professionals back, ' +
      'clear the conversion markers) runs asynchronously in `categoryJobsProcess`, same reasoning ' +
      'as the subgroup move: it can exceed API Gateway\'s 29s ceiling. Poll via ' +
      '`GET /admin/category-jobs/{jobId}` (documented elsewhere — not one of these 18 routes).',
    parameters: [
      { name: 'aliasKey', in: 'path', required: true, schema: { type: 'string' }, example: 'plomeria', description: 'The alias created by the original conversion (its aliasKey is the original category\'s keyName).' },
    ],
    responses: {
      202: {
        description: 'Accepted — job enqueued',
        example: {
          jobId: 'a7b8c9d0-1234-56a1-2345-7890abcdef01',
          type: 'undo',
          status: 'pending',
          input: { aliasKey: 'plomeria' },
          createdAt: '2026-09-19T10:35:00.000Z',
          updatedAt: '2026-09-19T10:35:00.000Z',
        },
      },
      400: { description: 'BAD_REQUEST — aliasKey fails the key-shape validator', example: { error: 'aliasKey must be lowercase alphanumeric with hyphens (e.g. "plomero")' } },
      401: { description: 'UNAUTHORIZED', example: { error: 'Unauthorized' } },
      403: { description: 'FORBIDDEN — missing categories:alias permission (superadmin only)', example: { error: 'Permission denied: categories:alias' } },
      404: { description: 'NOT_FOUND — aliasKey has no conversion provenance to undo', example: { error: 'Alias "plomeria" was not created by a conversion — nothing to undo' } },
      500: { description: 'INTERNAL_SERVER_ERROR', example: { error: 'Internal server error' } },
    },
  },
};
