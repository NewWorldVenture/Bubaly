import 'server-only';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { encryptSecret, decryptSecret } from '@/lib/sync/crypto';
import { fetchExternal } from '@/lib/server/external-fetch';
import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';
import { claimXReceipt, createXReceipt, isXId, saveXConnection, X_SCOPES, xFailure, type XActor, type XFlow, type XGrant } from './account-tokens';

export const X_COOKIE = 'social-x-authorization';
export const X_CALLBACK_PATH = '/api/social/x/callback';
const AUTHORIZATION_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const IDENTITY_URL = 'https://api.x.com/2/users/me';
export const X_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 65_536;
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

function requireXConfiguration(): void {
  const key = process.env.SYNC_TOKEN_KEY ?? '';
  // New X credentials require the documented 32-byte key, without changing
  // the legacy sync helper's passphrase compatibility for existing providers.
  const validKey = /^[0-9a-f]{64}$/i.test(key) || (/^[A-Za-z0-9+/]{43}=?$/.test(key) && Buffer.from(key, 'base64').length === 32);
  if (!process.env.X_CLIENT_ID?.trim() || !process.env.X_CLIENT_SECRET?.trim() || !validKey) xFailure('setupRequired');
}

export function xRedirectUri(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return xFailure('setupRequired');
  let url: URL;
  try { url = new URL(raw); } catch { return xFailure('setupRequired'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) xFailure('setupRequired');
  return new URL(X_CALLBACK_PATH, url.origin).toString();
}

export function xCookieOptions(redirectUri: string) {
  return { httpOnly: true, secure: new URL(redirectUri).protocol === 'https:', sameSite: 'lax' as const, path: X_CALLBACK_PATH, maxAge: 600 };
}

export async function beginXAuthorization(actor: XActor): Promise<{ authorizationUrl: string; cookie: string; redirectUri: string }> {
  requireXConfiguration();
  const redirectUri = xRedirectUri();
  const now = Date.now();
  const flow: XFlow = { ...actor, accountId: randomUUID(), revision: randomUUID(), state: randomBytes(32).toString('base64url'),
    verifier: randomBytes(48).toString('base64url'), redirectUri, issuedAt: now, expiresAt: now + 600_000 };
  const cookie = encryptSecret(JSON.stringify({ version: 1, ...flow }));
  await createXReceipt(flow, sha256(flow.state));
  const url = new URL(AUTHORIZATION_URL);
  url.search = new URLSearchParams({ response_type: 'code', client_id: process.env.X_CLIENT_ID!, redirect_uri: redirectUri,
    scope: X_SCOPES.join(' '), state: flow.state, code_challenge: sha256(flow.verifier), code_challenge_method: 'S256' }).toString();
  return { authorizationUrl: url.toString(), cookie, redirectUri };
}

export function readXAuthorization(cookie: string | undefined, state: string | null, requestUrl: string): XFlow {
  if (!cookie || cookie.length > 8192 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return xFailure('callbackInvalid');
  let flow: XFlow & { version: number };
  try { flow = JSON.parse(decryptSecret(cookie)) as XFlow & { version: number }; } catch { return xFailure('callbackInvalid'); }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!flow || flow.version !== 1 || ![flow.accountId, flow.familyId, flow.userId, flow.revision].every((v) => typeof v === 'string' && uuid.test(v)) ||
      typeof flow.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(flow.state) || typeof flow.verifier !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(flow.verifier) ||
      !Number.isFinite(flow.issuedAt) || !Number.isFinite(flow.expiresAt) || flow.issuedAt > Date.now() + 30_000 || flow.expiresAt <= Date.now() ||
      flow.expiresAt - flow.issuedAt !== 600_000 || flow.redirectUri !== xRedirectUri() ||
      new URL(requestUrl).origin + new URL(requestUrl).pathname !== flow.redirectUri ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))) xFailure('callbackInvalid');
  return flow;
}

/** Fixed endpoints, no credential-forwarding redirects, bounded response bodies and deadline. */
export async function xJsonRequest(url: typeof TOKEN_URL | typeof IDENTITY_URL | 'https://api.x.com/2/tweets', init: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetchExternal(url, { ...init, redirect: 'manual', cache: 'no-store' }, X_TIMEOUT_MS);
  try {
    if (response.status < 200 || response.status >= 300) return { status: response.status, body: null };
    return { status: response.status, body: await readBoundedResponseJson<unknown>(response, MAX_RESPONSE_BYTES) };
  } finally {
    // Includes advertised oversized bodies and redirects, which were never read.
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function finishXAuthorization(flow: XFlow, code: string): Promise<void> {
  if (!code || code.length > 4096 || /[\x00-\x20\x7f]/.test(code)) xFailure('callbackInvalid');
  requireXConfiguration();
  await claimXReceipt(flow, sha256(flow.state));
  const basic = Buffer.from(`${encodeURIComponent(process.env.X_CLIENT_ID!)}:${encodeURIComponent(process.env.X_CLIENT_SECRET!)}`).toString('base64');
  const exchanged = await xJsonRequest(TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }).toString() });
  const data = record(exchanged.body);
  const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [];
  if (exchanged.status !== 200 || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16384 || /[\r\n]/.test(data.access_token) ||
      typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 16384 ||
      typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
      typeof data.expires_in !== 'number' || !Number.isInteger(data.expires_in) || data.expires_in < 60 || data.expires_in > 31_536_000 ||
      !X_SCOPES.every((scope) => scopes.includes(scope))) xFailure('connectionFailed');
  const grant: XGrant = { accessToken: data.access_token as string, refreshToken: data.refresh_token as string, expiresAt: Date.now() + (data.expires_in as number) * 1000, scopes };
  const identityResponse = await xJsonRequest(IDENTITY_URL, { headers: { Authorization: `Bearer ${grant.accessToken}` } });
  const identity = record(record(identityResponse.body).data);
  if (identityResponse.status !== 200 || !isXId(identity.id) || typeof identity.username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(identity.username) ||
      typeof identity.name !== 'string' || !identity.name.trim() || identity.name.length > 200) xFailure('connectionFailed');
  await saveXConnection(flow, grant, { id: identity.id as string, username: identity.username as string, name: identity.name as string });
}
