/**
 * Local environment store.
 *
 * `env.local.json` holds everything the proxy needs to resolve `{{variables}}`:
 * server URLs, Cognito config and free-form variables, grouped per profile
 * (app / admin / chinchin). It never leaves this machine and is gitignored.
 *
 * Tokens live apart in `.tokens.json` so the file you edit by hand stays small
 * and readable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ENV_FILE = path.join(DOCS_ROOT, 'env.local.json');
const EXAMPLE_FILE = path.join(DOCS_ROOT, 'env.example.json');
const TOKENS_FILE = path.join(DOCS_ROOT, '.tokens.json');

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/** Reads env.local.json, seeding it from env.example.json the first time. */
export function loadEnv() {
  if (!fs.existsSync(ENV_FILE) && fs.existsSync(EXAMPLE_FILE)) {
    fs.copyFileSync(EXAMPLE_FILE, ENV_FILE);
    console.log('+ Creado env.local.json a partir de env.example.json');
  }
  return readJson(ENV_FILE, readJson(EXAMPLE_FILE, { profiles: {} }));
}

export function saveEnv(env) {
  fs.writeFileSync(ENV_FILE, JSON.stringify(env, null, 2));
}

/**
 * Change stamp for the environment file. The /env page sends back the value it
 * loaded with, so a save made against a stale copy — the build script or
 * another tab wrote in the meantime — is refused instead of silently
 * clobbering the newer content.
 */
export function envVersion() {
  try {
    return String(fs.statSync(ENV_FILE).mtimeMs);
  } catch {
    return '0';
  }
}

export const loadTokens = () => readJson(TOKENS_FILE, {});

export function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * A password may be kept out of the file entirely by naming an OS environment
 * variable instead (`passwordEnv`). That path is preferred; the inline
 * `password` field is the convenience fallback.
 */
export function resolveSecret(profile, field) {
  const envVarName = profile?.cognito?.[field + 'Env'];
  if (envVarName && process.env[envVarName]) return process.env[envVarName];
  return profile?.cognito?.[field] || '';
}

/** Flat `{{name}} -> value` map for one profile, tokens included. */
export function variablesFor(env, profileName) {
  const profile = env.profiles?.[profileName] || {};
  const tokens = loadTokens()[profileName] || {};
  return {
    ...(env.shared?.vars || {}),
    ...(profile.vars || {}),
    ...(profile.cognito?.region ? { awsRegion: profile.cognito.region } : {}),
    ...(profile.cognito?.clientId ? { cognitoClientId: profile.cognito.clientId } : {}),
    ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
    ...(tokens.accessToken ? { accessToken: tokens.accessToken } : {}),
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
  };
}

/**
 * Picks the profile whose configured server URL is the longest prefix of an
 * outgoing request URL, so the proxy knows which credentials to apply.
 */
export function profileForUrl(env, url) {
  let bestName = null;
  let bestLength = -1;

  for (const [name, profile] of Object.entries(env.profiles || {})) {
    const candidates = [
      ...(profile.servers || []).map((s) => s.url),
      ...(profile.matchUrls || []),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const prefix = candidate.replace(/\/+$/, '');
      if (url.startsWith(prefix) && prefix.length > bestLength) {
        bestLength = prefix.length;
        bestName = name;
      }
    }
  }

  return bestName || env.activeProfile || Object.keys(env.profiles || {})[0] || null;
}
