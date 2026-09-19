import 'server-only';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { connect, constants, sensitiveHeaders, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { fetchExternal } from '@/lib/server/external-fetch';
import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';

type Payload = { title: string; body?: string | null; url?: string | null };
type Delivery = 'sent' | 'failed' | 'unconfigured' | 'unregistered';
type FcmConfig = { project: string; email: string; key: string };
type ApnsConfig = { team: string; keyId: string; key: string; topic: string; sandbox: boolean };
type CachedToken = { fingerprint: string; token: string; issuedAt: number; refreshAt: number };
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
let fcmToken: CachedToken | undefined;
let fcmPending: { fingerprint: string; promise: Promise<CachedToken> } | undefined;
let apnsToken: CachedToken | undefined;

function privateKeyEnv(name: string): string {
  return (process.env[name] ?? '').trim().replace(/\\n/g, '\n');
}

function fcmConfig(): FcmConfig | null {
  const project = process.env.FCM_PROJECT_ID?.trim() ?? '';
  const email = process.env.FCM_CLIENT_EMAIL?.trim() ?? '';
  const key = privateKeyEnv('FCM_PRIVATE_KEY');
  return /^[a-z][a-z0-9-]{4,62}$/.test(project) && /^[^\s@]+@[^\s@]+$/.test(email) && key
    ? { project, email, key } : null;
}

function apnsConfig(): ApnsConfig | null {
  const team = process.env.APNS_TEAM_ID?.trim() ?? '';
  const keyId = process.env.APNS_KEY_ID?.trim() ?? '';
  const key = privateKeyEnv('APNS_PRIVATE_KEY');
  const topic = process.env.APNS_TOPIC?.trim() ?? '';
  const environment = process.env.APNS_ENVIRONMENT?.trim() || 'production';
  return /^[A-Z0-9]{10}$/.test(team) && /^[A-Z0-9]{10}$/.test(keyId) && key
    && /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(topic)
    && (environment === 'production' || environment === 'sandbox')
    ? { team, keyId, key, topic, sandbox: environment === 'sandbox' } : null;
}

/** Configuration presence only; delivery still verifies signing and provider acceptance. */
export function nativePushConfigured(): { fcm: boolean; apns: boolean } {
  return { fcm: fcmConfig() !== null, apns: apnsConfig() !== null };
}

function fingerprint(value: FcmConfig | ApnsConfig): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function jwtContent(header: Record<string, string>, claims: Record<string, string | number>): string {
  return `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
}

function usable(token: CachedToken | undefined, identity: string): token is CachedToken {
  return !!token && token.fingerprint === identity && Date.now() >= token.issuedAt && Date.now() < token.refreshAt;
}

async function mintFcmToken(config: FcmConfig, identity: string): Promise<CachedToken> {
  const issuedAt = Date.now();
  const nowSeconds = Math.floor(issuedAt / 1000);
  const content = jwtContent({ alg: 'RS256', typ: 'JWT' }, {
    iss: config.email, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600,
  });
  const key = createPrivateKey(config.key);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('Invalid FCM signing key type');
  const assertion = `${content}.${sign('RSA-SHA256', Buffer.from(content), key).toString('base64url')}`;
  const response = await fetchExternal(GOOGLE_TOKEN_URL, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  }, TIMEOUT_MS);
  if (!response.ok) { await response.body?.cancel(); throw new Error('FCM authorization failed'); }
  const result = await readBoundedResponseJson<{ access_token?: unknown; expires_in?: unknown }>(response, MAX_RESPONSE_BYTES);
  if (typeof result.access_token !== 'string' || !result.access_token || /\s/.test(result.access_token)
    || typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
    throw new Error('Invalid FCM authorization response');
  }
  const lifetime = Math.min(result.expires_in, 3600) * 1000;
  return { fingerprint: identity, token: result.access_token, issuedAt, refreshAt: issuedAt + lifetime - Math.min(60_000, lifetime / 10) };
}

async function fcmAccessToken(config: FcmConfig): Promise<CachedToken> {
  const identity = fingerprint(config);
  if (usable(fcmToken, identity)) return fcmToken;
  if (fcmPending?.fingerprint === identity) return fcmPending.promise;
  const pending = { fingerprint: identity, promise: mintFcmToken(config, identity) };
  fcmPending = pending;
  try {
    const token = await pending.promise;
    // An older in-flight credential exchange must not replace a rotated cache.
    if (fcmPending === pending) fcmToken = token;
    return token;
  } finally {
    if (fcmPending === pending) fcmPending = undefined;
  }
}

async function sendFcm(config: FcmConfig, token: string, payload: Payload): Promise<Delivery> {
  const body = JSON.stringify({ message: {
    token, notification: { title: payload.title, body: payload.body ?? '' }, data: { url: payload.url ?? '/dashboard' },
  } });
  if (Buffer.byteLength(body) > 4096) return 'failed';
  const credential = await fcmAccessToken(config);
  const response = await fetchExternal(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.project)}/messages:send`, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}` }, body,
  }, TIMEOUT_MS);
  if (response.status === 401 && fcmToken === credential) fcmToken = undefined;
  const result = await readBoundedResponseJson<{
    name?: unknown; error?: { details?: Array<{ '@type'?: string; errorCode?: string }> };
  }>(response, MAX_RESPONSE_BYTES);
  if (response.ok) return typeof result.name === 'string' && /^projects\/[^/]+\/messages\/.+/.test(result.name) ? 'sent' : 'failed';
  // A permission/project/path 404 or generic INVALID_ARGUMENT is not evidence
  // that a device registration is gone. Only the documented FCM detail is.
  return response.status === 404 && Array.isArray(result.error?.details) && result.error.details.some(
    detail => detail?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && detail.errorCode === 'UNREGISTERED',
  ) ? 'unregistered' : 'failed';
}

function apnsBearer(config: ApnsConfig): string {
  const identity = fingerprint(config);
  if (usable(apnsToken, identity)) return apnsToken.token;
  const issuedAt = Date.now();
  const content = jwtContent({ alg: 'ES256', kid: config.keyId }, { iss: config.team, iat: Math.floor(issuedAt / 1000) });
  const key = createPrivateKey(config.key);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Invalid APNs signing key type');
  const token = `${content}.${sign('sha256', Buffer.from(content), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  // Apple requires reuse for at least 20 minutes and refresh within one hour.
  apnsToken = { fingerprint: identity, token, issuedAt, refreshAt: issuedAt + 50 * 60_000 };
  return token;
}

type ApnsConnection = {
  fingerprint: string; session: ClientHttp2Session; failures: Set<() => void>;
  idle?: ReturnType<typeof setTimeout>;
};
let apnsConnection: ApnsConnection | undefined;

function discardConnection(connection: ApnsConnection) {
  if (apnsConnection === connection) apnsConnection = undefined;
  clearTimeout(connection.idle);
  for (const fail of [...connection.failures]) fail();
  connection.session.destroy();
}

function connectionFor(config: ApnsConfig): ApnsConnection {
  const identity = fingerprint(config);
  if (apnsConnection && (apnsConnection.fingerprint !== identity || apnsConnection.session.closed || apnsConnection.session.destroyed)) {
    discardConnection(apnsConnection);
  }
  if (!apnsConnection) {
    const session = connect(config.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com', { minVersion: 'TLSv1.2' });
    const connection: ApnsConnection = { fingerprint: identity, session, failures: new Set() };
    apnsConnection = connection;
    session.on('error', () => discardConnection(connection));
    session.once('goaway', () => discardConnection(connection));
    session.once('close', () => {
      if (apnsConnection === connection) apnsConnection = undefined;
      clearTimeout(connection.idle);
      for (const fail of [...connection.failures]) fail();
    });
  }
  clearTimeout(apnsConnection.idle);
  apnsConnection.session.ref();
  return apnsConnection;
}

function idleConnection(connection: ApnsConnection) {
  if (connection.failures.size || connection.session.destroyed || connection.session.closed) return;
  // Reuse the HTTP/2 session for the batch, then retire an idle serverless socket.
  connection.session.unref();
  connection.idle = setTimeout(() => discardConnection(connection), 5 * 60_000);
  connection.idle.unref();
}

async function sendApns(config: ApnsConfig, token: string, payload: Payload): Promise<Delivery> {
  if (!/^[a-f0-9]{32,512}$/i.test(token) || token.length % 2 !== 0) return 'failed';
  const body = JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body ?? '' }, sound: 'default' }, url: payload.url ?? '/dashboard' });
  if (Buffer.byteLength(body) > 4096) return 'failed';
  const bearer = apnsBearer(config);
  const connection = connectionFor(config);
  return new Promise<Delivery>((resolve) => {
    let stream: ClientHttp2Stream | undefined;
    let settled = false;
    let status = 0;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (result: Delivery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.failures.delete(fail);
      stream?.close(constants.NGHTTP2_CANCEL);
      idleConnection(connection);
      resolve(result);
    };
    const fail = () => finish('failed');
    const timer = setTimeout(() => { fail(); discardConnection(connection); }, TIMEOUT_MS);
    connection.failures.add(fail);
    try {
      stream = connection.session.request({
        ':method': 'POST', ':path': `/3/device/${token}`,
        authorization: `bearer ${bearer}`, 'apns-topic': config.topic,
        'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json',
        [sensitiveHeaders]: [':path', 'authorization'],
      });
      stream.on('response', headers => { status = Number(headers[':status'] ?? 0); });
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { fail(); return; }
        chunks.push(chunk);
      });
      stream.once('error', fail);
      stream.once('aborted', fail);
      stream.once('close', fail);
      stream.once('end', () => {
        if (status === 200) { finish('sent'); return; }
        let reason: unknown;
        try { reason = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: unknown }).reason; } catch { /* malformed provider response */ }
        if (status === 403 && reason === 'ExpiredProviderToken' && apnsToken?.token === bearer) apnsToken = undefined;
        finish(status === 410 && reason === 'Unregistered' ? 'unregistered' : 'failed');
      });
      stream.end(body);
    } catch { fail(); }
  });
}

/** Provider acceptance only; physical device receipt still needs device verification. */
export async function sendNativePush(provider: 'fcm' | 'apns', token: string, payload: Payload): Promise<Delivery> {
  try {
    if (!token || /[\s\x00-\x1f]/.test(token) || !payload.title?.trim()) return 'failed';
    if (provider === 'fcm') {
      const config = fcmConfig();
      return config ? await sendFcm(config, token, payload) : 'unconfigured';
    }
    if (provider === 'apns') {
      const config = apnsConfig();
      return config ? await sendApns(config, token, payload) : 'unconfigured';
    }
    return 'failed';
  } catch {
    // Provider bodies may include tokens, device IDs or notification content.
    // Never log them or return them to the caller.
    return 'failed';
  }
}
