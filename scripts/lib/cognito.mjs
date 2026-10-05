/**
 * Cognito token helper — the Node equivalent of the pre-request script that
 * lives in the Postman collections.
 *
 * Keeps an id token cached in `.tokens.json` and silently renews it with the
 * refresh token, falling back to USER_PASSWORD_AUTH when the refresh token is
 * gone or expired. Callers only ever ask for `ensureIdToken()`.
 */

import { loadTokens, saveTokens, resolveSecret } from './env-store.mjs';
import { srpLogin } from './srp.mjs';

const SKEW_SECONDS = 60;

/**
 * The two app clients enable different flows:
 *   - app pool client   -> ALLOW_USER_PASSWORD_AUTH  (plain InitiateAuth, no AWS creds)
 *   - admin pool client -> ALLOW_ADMIN_USER_PASSWORD_AUTH (AdminInitiateAuth, signed
 *                          with AWS credentials, and it needs the user pool id)
 * Both enable ALLOW_REFRESH_TOKEN_AUTH, so renewals always take the plain path.
 */
const ADMIN_FLOW = 'ADMIN_USER_PASSWORD_AUTH';
const SRP_FLOW = 'USER_SRP_AUTH';

/**
 * Role profiles guarded by MFA cannot be resolved without a prompt, so pointing
 * the SDK at one from a server process fails. Exporting the credentials the AWS
 * CLI already holds sidesteps profile resolution entirely.
 */
const AWS_CREDENTIALS_HINT = [
  'El flujo de admin va firmado con credenciales de AWS. Si tu perfil pide MFA',
  '(handerr-backend lo hace), no lo nombres en /env: exporta las credenciales antes',
  'de arrancar el servidor y deja "Perfil AWS" vacio.',
  '',
  '  eval "$(aws configure export-credentials --profile handerr-backend --format env)"',
  '  npm start',
].join('\n');

export function decodeExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    return Number(payload.exp || 0);
  } catch {
    return 0;
  }
}

async function initiateAuth({ region, clientId, flow, parameters }) {
  const response = await fetch('https://cognito-idp.' + region + '.amazonaws.com/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({ AuthFlow: flow, ClientId: clientId, AuthParameters: parameters }),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('Cognito devolvio una respuesta no-JSON (' + response.status + ')');
  }

  if (!response.ok) {
    const message = body.message || body.__type || 'Cognito respondio ' + response.status;
    if (/auth flow not enabled|USER_PASSWORD_AUTH/i.test(message)) {
      throw new Error(
        message + ' — este app client no permite USER_PASSWORD_AUTH. Es el caso del pool de ' +
          'backoffice: pon "authFlow": "' + ADMIN_FLOW + '" y el "userPoolId" en /env.',
      );
    }
    throw new Error(message);
  }
  if (body.ChallengeName) {
    throw new Error(
      'Cognito pide el challenge "' + body.ChallengeName + '". Resuelvelo una vez en la app/consola ' +
        'y luego vuelve a intentar, o pega un idToken manualmente.',
    );
  }
  if (!body.AuthenticationResult) {
    throw new Error('Cognito no devolvio AuthenticationResult');
  }
  return body.AuthenticationResult;
}

/**
 * AdminInitiateAuth — needs SigV4, so it goes through the SDK and picks up the
 * usual credential chain (AWS_PROFILE, env vars, SSO…).
 */
async function adminInitiateAuth({ region, awsProfile, userPoolId, clientId, username, password }) {
  const { CognitoIdentityProviderClient, AdminInitiateAuthCommand } = await import(
    '@aws-sdk/client-cognito-identity-provider'
  );

  const clientConfig = { region };
  if (awsProfile) {
    // Naming a profile only works for profiles the SDK can resolve without
    // prompting. A role profile guarded by MFA cannot be resolved headlessly —
    // for those, leave `awsProfile` empty and export the credentials instead
    // (see the AWS_CREDENTIALS_HINT below).
    const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
    clientConfig.credentials = defaultProvider({ profile: awsProfile });
  }

  const client = new CognitoIdentityProviderClient(clientConfig);

  try {
    const response = await client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
        AuthFlow: ADMIN_FLOW,
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }),
    );
    if (response.ChallengeName) {
      throw new Error(
        'Cognito pide el challenge "' + response.ChallengeName + '". Resuelvelo una vez en el ' +
          'backoffice y luego usa el token/refresh que te de.',
      );
    }
    if (!response.AuthenticationResult) throw new Error('Cognito no devolvio AuthenticationResult');
    return response.AuthenticationResult;
  } catch (err) {
    if (/credential|token.*expired|security token|multi-factor|profile/i.test(err.message || '')) {
      throw new Error(err.message + '\n\n' + AWS_CREDENTIALS_HINT);
    }
    throw err;
  }
}

function store(profileName, result) {
  const tokens = loadTokens();
  const current = tokens[profileName] || {};
  const next = { ...current };

  if (result.IdToken) {
    next.idToken = result.IdToken;
    next.idTokenExp = decodeExp(result.IdToken);
  }
  if (result.AccessToken) next.accessToken = result.AccessToken;
  if (result.RefreshToken) next.refreshToken = result.RefreshToken;
  next.updatedAt = new Date().toISOString();

  tokens[profileName] = next;
  saveTokens(tokens);
  return next;
}

/** Forces a fresh username/password login. */
export async function login(env, profileName) {
  const profile = env.profiles?.[profileName];
  const cognito = profile?.cognito || {};
  const username = cognito.username;
  const password = resolveSecret(profile, 'password');

  const usesAdminFlow = cognito.authFlow === ADMIN_FLOW;
  const usesSrp = cognito.authFlow === SRP_FLOW;

  const missing = [];
  if (!cognito.region) missing.push('region');
  if (!cognito.clientId) missing.push('clientId');
  if ((usesAdminFlow || usesSrp) && !cognito.userPoolId) missing.push('userPoolId (obligatorio con ' + cognito.authFlow + ')');
  if (!username) missing.push('username');
  if (!password) missing.push('password (o la variable de entorno ' + (cognito.passwordEnv || 'HANDERR_PASSWORD') + ')');
  if (missing.length) {
    throw new Error('Falta configurar en /env para el perfil "' + profileName + '": ' + missing.join(', '));
  }

  const result = usesSrp
    ? await srpLogin({
        userPoolId: cognito.userPoolId,
        clientId: cognito.clientId,
        username,
        password,
      })
    : usesAdminFlow
    ? await adminInitiateAuth({
        region: cognito.region,
        awsProfile: cognito.awsProfile,
        userPoolId: cognito.userPoolId,
        clientId: cognito.clientId,
        username,
        password,
      })
    : await initiateAuth({
        region: cognito.region,
        clientId: cognito.clientId,
        flow: 'USER_PASSWORD_AUTH',
        parameters: { USERNAME: username, PASSWORD: password },
      });

  return store(profileName, result);
}

/**
 * Returns a valid id token for a profile, renewing it when needed.
 * @returns {Promise<{token: string, source: 'cache'|'refresh'|'login'}>}
 */
export async function ensureIdToken(env, profileName) {
  const cached = loadTokens()[profileName] || {};
  const now = Math.floor(Date.now() / 1000);

  if (cached.idToken && Number(cached.idTokenExp || 0) > now + SKEW_SECONDS) {
    return { token: cached.idToken, source: 'cache' };
  }

  const cognito = env.profiles?.[profileName]?.cognito || {};

  if (cached.refreshToken && cognito.region && cognito.clientId) {
    try {
      const result = await initiateAuth({
        region: cognito.region,
        clientId: cognito.clientId,
        flow: 'REFRESH_TOKEN_AUTH',
        parameters: { REFRESH_TOKEN: cached.refreshToken },
      });
      const saved = store(profileName, result);
      return { token: saved.idToken, source: 'refresh' };
    } catch {
      // Refresh token no longer valid — fall through to a full login.
    }
  }

  const saved = await login(env, profileName);
  return { token: saved.idToken, source: 'login' };
}

/** Non-secret summary for the /env page. */
export function tokenStatus(profileName) {
  const cached = loadTokens()[profileName] || {};
  if (!cached.idToken) return { hasToken: false };
  const exp = Number(cached.idTokenExp || 0);
  const now = Math.floor(Date.now() / 1000);
  return {
    hasToken: true,
    expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    expiresInSeconds: exp ? exp - now : null,
    expired: exp ? exp <= now : false,
    hasRefreshToken: Boolean(cached.refreshToken),
    updatedAt: cached.updatedAt || null,
  };
}
