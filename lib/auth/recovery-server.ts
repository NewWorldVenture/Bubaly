import 'server-only';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type RecoveryErrorKey = `authRecovery.${'invalidLink' | 'expiredLink' | 'sessionChanged' | 'temporarilyUnavailable' | 'setupRequired' | 'invalidPassword' | 'passwordRejected' | 'weakPassword' | 'samePassword' | 'mfaRequired' | 'reauthenticationRequired' | 'currentPasswordRequired' | 'rateLimited' | 'saveUncertain'}`;
export class RecoveryError extends Error {
  constructor(public readonly key: RecoveryErrorKey) { super(key); this.name = 'RecoveryError'; }
}
export type RecoveryIdentity = { userId: string; sessionId: string; email: string; expiresAt: number };
export const RECOVERY_HANDOFF_COOKIE = 'bubaly-recovery-handoff';
type Method = 'otp' | 'recovery';
type Evidence = { method: Method; at: number };
type Verified = { identity: RecoveryIdentity; evidence: Evidence[]; selected: Evidence };
type Grant = { version: 1; purpose: 'password-recovery'; sub: string; sid: string; method: Method; authenticatedAt: number; issuedAt: number; expiresAt: number; nonce: string };
type Configuration = { origin: string; anon: string; secret: string };
type Context = { config: Configuration; client: Pick<SupabaseClient, 'auth'>; request: (path: string, init?: RequestInit, onHeaders?: (status: number) => void) => Promise<Response> };
const WINDOW_MS = 15 * 60_000;
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAC_DOMAIN = 'bubaly.auth.recovery.v1\0';
const fail = (key: RecoveryErrorKey): never => { throw new RecoveryError(key); };
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function cleanEnv(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}
function configuration(): Configuration {
  const raw = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const anon = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const secret = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
  let url: URL;
  try { url = new URL(raw); } catch { return fail('authRecovery.setupRequired'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!anon || !secret || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('authRecovery.setupRequired');
  return { origin: url.origin, anon, secret };
}
function tokenShape(token: string): Record<string, unknown> {
  if (typeof token !== 'string' || token.length > 16_384) return fail('authRecovery.invalidLink');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !BASE64URL.test(part))) return fail('authRecovery.invalidLink');
  try {
    const payload = object(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp)) return fail('authRecovery.invalidLink');
    // This early rejection never grants authority. The SDK verifies the exact
    // token before any remaining claims can be used, and expired fragments are
    // never refreshed into a potentially different identity.
    if (payload.exp * 1000 <= Date.now()) return fail('authRecovery.expiredLink');
    return payload;
  } catch (error) { if (error instanceof RecoveryError) throw error; return fail('authRecovery.invalidLink'); }
}
function temporary(error: unknown): boolean {
  const value = object(error);
  return value.name === 'AuthRetryableFetchError' || value.name === 'AbortError' || value.name === 'TimeoutError'
    || (typeof value.status === 'number' && (value.status >= 500 || value.status === 408 || value.status === 429));
}
function providerFailure(error: unknown): never { return fail(temporary(error) ? 'authRecovery.temporarilyUnavailable' : 'authRecovery.invalidLink'); }

/** The signal also bounds response bodies; SDK JSON parsing sees a bounded copy. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener('abort', onAbort); }
}
async function boundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => {});
    return fail('authRecovery.temporarilyUnavailable');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) return fail('authRecovery.temporarilyUnavailable');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function operation<T>(run: (context: Context) => Promise<T>): Promise<T> {
  const config = configuration();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Recovery request deadline', 'AbortError')), TIMEOUT_MS);
  const request = async (path: string, init: RequestInit = {}, onHeaders?: (status: number) => void): Promise<Response> => {
    controller.signal.throwIfAborted();
    const url = new URL(path, config.origin);
    if (url.origin !== config.origin || !['/auth/v1/user', '/auth/v1/token', '/auth/v1/.well-known/jwks.json'].includes(url.pathname)) fail('authRecovery.invalidLink');
    const headers = new Headers(init.headers);
    headers.set('apikey', config.anon);
    const response = await abortable(fetch(url, { ...init, headers, signal: controller.signal, redirect: 'manual', cache: 'no-store' }), controller.signal);
    onHeaders?.(response.status);
    const body = await boundedBody(response, controller.signal);
    return new Response([204, 205, 304].includes(response.status) ? null : new TextDecoder().decode(body), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  // Only explicit-token SDK validation uses this client. No request cookies,
  // persistence, refresh timer or browser singleton are involved.
  const sdkFetch: typeof fetch = async (input, init) => {
    try { return await request(input instanceof Request ? input.url : String(input), init); }
    catch {
      // Auth-js logs thrown fetch errors. Return a sanitized retryable result
      // instead so transport diagnostics cannot expose credentials in logs.
      return Response.json({ code: 'recovery_temporarily_unavailable', message: 'Recovery verification unavailable' }, { status: 503 });
    }
  };
  const client = createClient(config.origin, config.anon, { auth: {
    persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: `recovery-${randomUUID()}`,
  }, global: { fetch: sdkFetch } });
  try { return await run({ config, client, request }); }
  catch (error) { if (error instanceof RecoveryError) throw error; return fail('authRecovery.temporarilyUnavailable'); }
  finally { clearTimeout(timer); await client.auth.dispose(); }
}
async function verified(context: Context, token: string): Promise<Verified> {
  tokenShape(token);
  const verifiedClaims = await context.client.auth.getClaims(token);
  if (verifiedClaims.error) return providerFailure(verifiedClaims.error);
  const claims = object(verifiedClaims.data?.claims);
  const now = Date.now();
  const audience = claims.aud;
  const audValid = audience === 'authenticated' || (Array.isArray(audience) && audience.length === 1 && audience[0] === 'authenticated');
  if (claims.iss !== `${context.config.origin}/auth/v1` || !audValid || claims.role !== 'authenticated'
    || typeof claims.sub !== 'string' || !UUID.test(claims.sub) || typeof claims.session_id !== 'string' || !UUID.test(claims.session_id)
    || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp)
    || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat * 1000 > now + 30_000
    || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > now))) return fail('authRecovery.invalidLink');
  if (claims.exp * 1000 <= now) return fail('authRecovery.expiredLink');
  if (!Array.isArray(claims.amr) || claims.amr.length > 32) return fail('authRecovery.invalidLink');
  const evidence: Evidence[] = [];
  for (const raw of claims.amr) {
    const entry = object(raw);
    if (typeof entry.method !== 'string' || typeof entry.timestamp !== 'number' || !Number.isSafeInteger(entry.timestamp) || entry.timestamp < 0 || entry.timestamp * 1000 > now + 30_000) return fail('authRecovery.invalidLink');
    // Legacy implicit recovery is issued as OTP by Supabase. This is verified
    // recent bearer-session compatibility, not unique recovery-purpose proof.
    if (entry.method === 'recovery' || entry.method === 'otp') evidence.push({ method: entry.method, at: entry.timestamp * 1000 });
  }
  const selected = evidence.sort((a, b) => b.at - a.at)[0];
  if (!selected) return fail('authRecovery.invalidLink');
  if (selected.at + WINDOW_MS <= now) return fail('authRecovery.expiredLink');
  const current = await context.client.auth.getUser(token);
  if (current.error) return providerFailure(current.error);
  if (current.data.user?.id !== claims.sub) return fail('authRecovery.sessionChanged');
  if (typeof current.data.user.email !== 'string' || !current.data.user.email || current.data.user.email.length > 320) return fail('authRecovery.invalidLink');
  if (claims.exp * 1000 <= Date.now() || selected.at + WINDOW_MS <= Date.now()) return fail('authRecovery.expiredLink');
  return { identity: { userId: claims.sub, sessionId: claims.session_id, email: current.data.user.email, expiresAt: selected.at + WINDOW_MS }, evidence, selected };
}
function mac(payload: string, secret: string): Buffer { return createHmac('sha256', secret).update(MAC_DOMAIN).update(payload).digest(); }
function issueGrant(value: Verified, config: Configuration): { identity: RecoveryIdentity; grant: string } {
  const now = Date.now();
  const identity = { ...value.identity, expiresAt: Math.min(value.identity.expiresAt, now + WINDOW_MS) };
  const grant: Grant = { version: 1, purpose: 'password-recovery', sub: identity.userId, sid: identity.sessionId, method: value.selected.method,
    authenticatedAt: value.selected.at, issuedAt: now, expiresAt: identity.expiresAt, nonce: randomBytes(24).toString('base64url') };
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return { identity, grant: `${payload}.${mac(payload, config.secret).toString('base64url')}` };
}
function readGrant(value: string, config: Configuration): Grant {
  if (typeof value !== 'string' || value.length > 2048) return fail('authRecovery.invalidLink');
  const parts = value.split('.');
  if (parts.length !== 2 || !parts.every(part => BASE64URL.test(part))) return fail('authRecovery.invalidLink');
  const signature = Buffer.from(parts[1], 'base64url');
  if (signature.length !== 32 || signature.toString('base64url') !== parts[1] || !timingSafeEqual(mac(parts[0], config.secret), signature)) return fail('authRecovery.invalidLink');
  let grant: Record<string, unknown>;
  try { grant = object(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))); } catch { return fail('authRecovery.invalidLink'); }
  if (grant.version !== 1 || grant.purpose !== 'password-recovery' || typeof grant.sub !== 'string' || !UUID.test(grant.sub) || typeof grant.sid !== 'string' || !UUID.test(grant.sid)
    || !['otp', 'recovery'].includes(String(grant.method)) || typeof grant.nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(grant.nonce)
    || typeof grant.authenticatedAt !== 'number' || !Number.isSafeInteger(grant.authenticatedAt)
    || typeof grant.issuedAt !== 'number' || !Number.isSafeInteger(grant.issuedAt)
    || typeof grant.expiresAt !== 'number' || !Number.isSafeInteger(grant.expiresAt)
    || grant.issuedAt > Date.now() + 30_000 || grant.authenticatedAt > grant.issuedAt + 30_000
    || grant.expiresAt > grant.authenticatedAt + WINDOW_MS || grant.expiresAt > grant.issuedAt + WINDOW_MS || grant.expiresAt <= grant.issuedAt) return fail('authRecovery.invalidLink');
  if (grant.expiresAt <= Date.now()) return fail('authRecovery.expiredLink');
  return grant as Grant;
}
async function validateGrant(context: Context, grant: string, token: string): Promise<RecoveryIdentity> {
  const expected = readGrant(grant, context.config);
  const value = await verified(context, token);
  if (expected.expiresAt <= Date.now()) return fail('authRecovery.expiredLink');
  if (value.identity.userId !== expected.sub || value.identity.sessionId !== expected.sid) return fail('authRecovery.sessionChanged');
  if (!value.evidence.some(entry => entry.method === expected.method && entry.at === expected.authenticatedAt)) return fail('authRecovery.sessionChanged');
  return { ...value.identity, expiresAt: expected.expiresAt };
}

export async function createRecoveryGrant(accessToken: string): Promise<{ identity: RecoveryIdentity; grant: string }> {
  tokenShape(accessToken);
  return operation(async context => issueGrant(await verified(context, accessToken), context.config));
}
export async function verifyRecoveryGrant(grant: string, accessToken: string): Promise<RecoveryIdentity> {
  return operation(context => validateGrant(context, grant, accessToken));
}
export async function prepareImplicitRecovery(accessToken: string, refreshToken: string): Promise<{ identity: RecoveryIdentity; grant: string; session: { access_token: string; refresh_token: string } }> {
  tokenShape(accessToken);
  if (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 8192 || /[\s\x00-\x1f\x7f]/.test(refreshToken)) return fail('authRecovery.invalidLink');
  return operation(async context => {
    const original = await verified(context, accessToken);
    // A single isolated refresh proves that the pair agrees. SDK refreshSession
    // retries retryable failures; this explicit request intentionally never does.
    const response = await context.request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }) });
    if (!response.ok) return fail(response.status >= 500 || [408, 429].includes(response.status) ? 'authRecovery.temporarilyUnavailable' : 'authRecovery.invalidLink');
    let result: Record<string, unknown>;
    try { result = object(await response.json()); } catch { return fail('authRecovery.temporarilyUnavailable'); }
    const candidateAccess = result.access_token; const candidateRefresh = result.refresh_token;
    if (typeof candidateAccess !== 'string' || typeof candidateRefresh !== 'string' || !candidateRefresh || candidateRefresh.length > 8192 || /[\s\x00-\x1f\x7f]/.test(candidateRefresh) || result.token_type !== 'bearer') return fail('authRecovery.invalidLink');
    const rotated = await verified(context, candidateAccess);
    if (rotated.identity.userId !== original.identity.userId || rotated.identity.sessionId !== original.identity.sessionId || object(result.user).id !== original.identity.userId
      || !rotated.evidence.some(entry => entry.method === original.selected.method && entry.at === original.selected.at)) return fail('authRecovery.sessionChanged');
    const resultGrant = issueGrant({ ...rotated, selected: original.selected, identity: { ...rotated.identity, expiresAt: original.identity.expiresAt } }, context.config);
    return { ...resultGrant, session: { access_token: candidateAccess, refresh_token: candidateRefresh } };
  });
}
function rejection(status: number, code: unknown): RecoveryErrorKey {
  if (status === 429) return 'authRecovery.rateLimited';
  if (code === 'weak_password') return 'authRecovery.weakPassword';
  if (code === 'same_password') return 'authRecovery.samePassword';
  if (code === 'insufficient_aal') return 'authRecovery.mfaRequired';
  if (code === 'reauthentication_needed' || code === 'reauthentication_not_valid') return 'authRecovery.reauthenticationRequired';
  if (code === 'current_password_required' || code === 'current_password_mismatch') return 'authRecovery.currentPasswordRequired';
  return 'authRecovery.passwordRejected';
}
export async function updateRecoveryPassword(grant: string, accessToken: string, password: string): Promise<{ outcome: 'updated' | 'failed' | 'uncertain'; errorKey?: string }> {
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) return { outcome: 'failed', errorKey: 'authRecovery.invalidPassword' };
  let attempted = false;
  let responseStatus: number | null = null;
  try {
    return await operation(async context => {
      const identity = await validateGrant(context, grant, accessToken);
      // Pin this PUT to the token just checked. No cookie/storage reread,
      // refresh, privileged client, SDK session writeback or automatic retry.
      attempted = true;
      const response = await context.request('/auth/v1/user', { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }, status => { responseStatus = status; });
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        let body: Record<string, unknown> = {};
        try { body = object(await response.json()); } catch { /* HTTP rejection is definitive even without diagnostic JSON. */ }
        return { outcome: 'failed', errorKey: rejection(response.status, body.code) };
      }
      if (!response.ok) return { outcome: 'uncertain', errorKey: 'authRecovery.saveUncertain' };
      let body: Record<string, unknown>;
      try { body = object(await response.json()); } catch { return { outcome: 'uncertain', errorKey: 'authRecovery.saveUncertain' }; }
      return body.id === identity.userId ? { outcome: 'updated' } : { outcome: 'uncertain', errorKey: 'authRecovery.saveUncertain' };
    });
  } catch (error) {
    if (responseStatus !== null && responseStatus >= 400 && responseStatus < 500 && responseStatus !== 408) return { outcome: 'failed', errorKey: rejection(responseStatus, null) };
    if (attempted) return { outcome: 'uncertain', errorKey: 'authRecovery.saveUncertain' };
    return { outcome: 'failed', errorKey: error instanceof RecoveryError ? error.key : 'authRecovery.temporarilyUnavailable' };
  }
}
