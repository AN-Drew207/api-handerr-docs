# Handerr — Referencia de API local

Documentación navegable **y ejecutable** de la API de Handerr, servida en tu
máquina. Estilo "doc book" (sidebar por módulos, descripciones largas, ejemplos
de body y de respuesta) con un cliente HTTP integrado en cada endpoint.

Vive **fuera de los repos** (`api/`, `mobile/`, `admin/`) y no se sube a ningún
sitio. Se regenera desde las colecciones de Postman del repo `api`, así que no
hay una segunda documentación que mantener a mano.

---

## Arranque

```bash
cd api-docs
npm install        # solo la primera vez
npm start          # genera los documentos y levanta el servidor
```

Abre **http://127.0.0.1:4400**.

Para cambiar el puerto: `npm start -- --port 4500` (o `PORT=4500 npm start`).

---

## Qué contiene

| Documento | Origen | Endpoints |
|---|---|---|
| **App (mobile)** | `api/postman/handerr-app.postman_collection.json` + `api/serverless.yml` | ~104 |
| **Admin (backoffice)** | `handerr-admin.postman_collection.json` + `serverless.admin.yml` | ~126 |
| **Admin v2 (SQL)** | `handerr-admin-v2-sql.postman_collection.json` + `serverless.admin-v2.yml` | 14 |
| **ChinChin (pagos)** | `chinchin-pago-movil-testing.postman_collection.json` | 5 |

Se cambia de documento con el selector de arriba del sidebar.

De cada endpoint verás:

- La descripción completa que ya estaba en Postman (reglas de negocio, estados
  válidos, códigos de error).
- **Body de ejemplo** con esquema inferido campo a campo.
- **Todas las respuestas guardadas**: 200, 400, 409… cada una con su ejemplo real
  y su nombre (`409 — BUDGET_ALREADY_OPEN`, etc.).
- Parámetros de path y query con ejemplo.
- **La Lambda que lo atiende** y su authorizer, leídos de `serverless.yml`:
  `budgetsCreate → src/domains/budget/handlers/create.handler`. Esto es lo que
  hace que la referencia sirva para *entender* el backend, no sólo para llamarlo.

Los endpoints que existen en `serverless.yml` pero **no** están en Postman se
listan aparte, bajo la etiqueta **"Sin documentar en Postman"**, con su Lambda y
su authorizer. Así la referencia es completa y a la vez señala qué falta
documentar.

```bash
npm run coverage   # lista exactamente qué endpoints faltan por documentar
```

---

## Cómo se hacen las peticiones

Cada endpoint tiene un botón **Test Request**. Todo pasa por el proxy local, que
se encarga de tres cosas:

1. **Sustituye las `{{variables}}`** en la URL, las cabeceras y el body.
2. **Resuelve `{{idToken}}` solo**: pide el token a Cognito con usuario y
   contraseña, lo cachea y lo renueva con el refresh token cuando caduca. Es el
   mismo flujo del pre-request script de Postman, pero sin Postman.
3. **Evita el CORS**, tanto contra `localhost` como contra AWS.

En la esquina superior derecha hay dos indicadores (`app`, `admin`) con el estado
del token y los minutos que le quedan.

### Elegir el servidor

Cada documento trae los servidores configurados en `env.local.json`:

- `http://localhost:3000/dev` — tu `serverless offline`
- `https://….execute-api.us-east-1.amazonaws.com/dev` — el desplegado

El selector de servidor está en el bloque de ejemplo de cada endpoint.

> Para pegarle a tu código local necesitas el backend corriendo:
> `cd api && npx serverless offline`. Recuerda que `serverless-offline` sólo
> cubre la lógica y el HTTP: las tablas, roles y buckets siguen siendo los de
> AWS dev.

---

## Configuración: `/env`

En **http://127.0.0.1:4400/env** configuras, por perfil (`app`, `admin`,
`chinchin`):

- **Servidores** (local y dev).
- **Cognito**: region, app client ID, usuario y contraseña.
- **Variables**: `serviceId`, `draftId`, `targetUserId`… Las variables se
  descubren solas al generar los documentos, así que la lista siempre coincide
  con lo que la referencia necesita.

El botón **Obtener token** hace el login contra Cognito y guarda los tokens. A
partir de ahí no vuelves a tocarlo: el proxy los renueva.

Datos que suelen faltar y de dónde salen:

```bash
cd api
npx serverless info --stage dev                              # URL y client ID de app
npx serverless info --config serverless.admin.yml --stage dev # URL de admin
```

### Los dos pools de Cognito no usan el mismo flujo

| | Pool app | Pool backoffice |
|---|---|---|
| Client | `handerr-app-cognito-<stage>-client` | `…-admin-client` |
| Flujo de login | `USER_PASSWORD_AUTH` | `ADMIN_USER_PASSWORD_AUTH` |
| ¿Necesita credenciales de AWS? | No | **Sí**, el login va firmado |
| Campos extra en `/env` | — | `userPoolId`, `awsProfile` |
| Renovación | `REFRESH_TOKEN_AUTH` | `REFRESH_TOKEN_AUTH` (sin AWS) |

El client del backoffice no habilita `USER_PASSWORD_AUTH` (ver
`api/serverless/cognito/adminUserPoolClient.yml`), así que el login inicial pasa
por `AdminInitiateAuth` con tus credenciales de AWS. Sólo el primero: a partir de
ahí las renovaciones usan el refresh token y no tocan AWS.

El perfil `handerr-backend` **pide MFA**, así que ni el SDK ni Serverless pueden
resolverlo sin un prompt (`Profile handerr-backend requires multi-factor
authentication`). La salida es exportar las credenciales que la CLI ya tiene en
caché y dejar el campo "Perfil AWS" vacío en `/env`:

```bash
eval "$(aws configure export-credentials --profile handerr-backend --format env)"
npm start
```

Son temporales (≈1 h). Cuando caduquen solo afecta a un **login nuevo** de admin:
las renovaciones usan el refresh token y no tocan AWS. Vuelve a exportarlas y
reinicia el servidor cuando lo necesites.

El mismo truco arregla `serverless info`/`deploy` sobre `serverless.admin.yml`,
que falla con `AWS profile "handerr-backend" doesn't seem to be configured`.

### Sobre la contraseña

`env.local.json` está gitignorado y la carpeta está fuera de los repos, pero
**lo más seguro es no escribirla en disco**. Deja el campo contraseña vacío y
exporta la variable de entorno antes de arrancar:

```powershell
$env:HANDERR_APP_PASSWORD = "..."
npm start
```

El nombre de la variable es configurable por perfil en `/env`. Si prefieres, el
tercer camino es no usar credenciales: pega un `idToken` a mano con

```bash
curl -X POST http://127.0.0.1:4400/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"profile":"app","idToken":"eyJ..."}'
```

---

## Regenerar

Cada vez que cambien las colecciones de Postman o los `serverless.yml`:

```bash
npm run build
```

`npm start` ya lo hace por ti al arrancar.

**La fuente de verdad sigue siendo `api/postman/*.postman_collection.json`.**
Esta carpeta no la sustituye: la lee. Si documentas un endpoint nuevo, hazlo en
la colección de Postman del repo `api` y vuelve a generar.

---

## Estructura

```
api-docs/
├── env.example.json          plantilla (esta sí se puede compartir)
├── env.local.json            tu configuración — gitignorado
├── .tokens.json              tokens cacheados — gitignorado
├── openapi/                  documentos generados — gitignorado
├── public/
│   ├── index.html            referencia (Scalar)
│   ├── env.html              editor de entorno y tokens
│   └── vendor/               Scalar servido localmente (funciona sin internet)
└── scripts/
    ├── build.mjs             Postman + serverless.yml → OpenAPI 3.1
    ├── serve.mjs             servidor estático + proxy + auth Cognito
    ├── coverage.mjs          qué endpoints faltan por documentar
    └── lib/
        ├── postman-to-openapi.mjs
        ├── serverless-routes.mjs
        ├── env-store.mjs
        ├── cognito.mjs
        └── validate-doc.mjs
```

El servidor escucha sólo en `127.0.0.1` porque el archivo de entorno contiene
credenciales.
