import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('node:http2', async (original) => ({
  ...await original<typeof import('node:http2')>(), connect: mocks.connect,
}));

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rotatedRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = (key: typeof rsa.privateKey) => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const payload = { title: 'Fixture notification', body: 'Fixture body', url: '/dashboard/notifications' };
const deviceToken = 'ab'.repeat(32);
const tokenUrl = 'https://oauth2.googleapis.com/token';
const sendUrl = 'https://fcm.googleapis.com/v1/projects/fixture-project/messages:send';
const fetchMock = vi.fn<typeof fetch>();
let api: typeof import('@/lib/server/native-push');

function configureFcm(key = rsa.privateKey) {
  vi.stubEnv('FCM_PROJECT_ID', 'fixture-project');
  vi.stubEnv('FCM_CLIENT_EMAIL', 'sender@fixture-project.iam.gserviceaccount.com');
  vi.stubEnv('FCM_PRIVATE_KEY', pem(key).replace(/\n/g, '\\n'));
}

function configureApns(environment = 'production') {
  vi.stubEnv('APNS_TEAM_ID', 'TEAM123456');
  vi.stubEnv('APNS_KEY_ID', 'KEY1234567');
  vi.stubEnv('APNS_PRIVATE_KEY', pem(ec.privateKey));
  vi.stubEnv('APNS_TOPIC', 'com.bubaly.fixture');
  vi.stubEnv('APNS_ENVIRONMENT', environment);
}

function decodeJwt(value: string) {
  const [header, claims, signature] = value.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>,
    content: Buffer.from(`${header}.${claims}`), signature: Buffer.from(signature, 'base64url'),
  };
}

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function fcmResponses(response: () => Response = () => json({ name: 'projects/fixture-project/messages/fixture-id' })) {
  let tokens = 0;
  fetchMock.mockImplementation(async (url) => String(url) === tokenUrl
    ? json({ access_token: `fixture-access-${++tokens}`, expires_in: 3600 }) : response());
  return { tokenRequests: () => tokens };
}

type ApnsHeaders = Record<string | symbol, unknown>;
class FakeStream extends EventEmitter {
  body = '';
  close = vi.fn(() => { this.emit('close'); });
  constructor(readonly headers: ApnsHeaders, private reply: (stream: FakeStream) => void) { super(); }
  end = vi.fn((body: string) => {
    this.body = body;
    queueMicrotask(() => this.reply(this));
  });
}

class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  streams: FakeStream[] = [];
  ref = vi.fn();
  unref = vi.fn();
  constructor(private reply: (stream: FakeStream) => void) { super(); }
  request = vi.fn((headers: ApnsHeaders) => {
    const stream = new FakeStream(headers, this.reply);
    this.streams.push(stream);
    return stream;
  });
  destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closed = true;
    this.emit('close');
  });
}

function apnsResponse(stream: FakeStream, status = 200, body?: unknown) {
  stream.emit('response', { ':status': status });
  if (body !== undefined) stream.emit('data', Buffer.from(JSON.stringify(body)));
  stream.emit('end');
}

function apnsTransport(reply: (stream: FakeStream) => void = stream => apnsResponse(stream)) {
  const sessions: FakeSession[] = [];
  mocks.connect.mockImplementation(() => {
    const session = new FakeSession(reply);
    sessions.push(session);
    return session;
  });
  return sessions;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
  for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY', 'FCM_SERVER_KEY',
    'APNS_TEAM_ID', 'APNS_KEY_ID', 'APNS_PRIVATE_KEY', 'APNS_TOPIC', 'APNS_ENVIRONMENT']) vi.stubEnv(name, '');
  fetchMock.mockReset().mockRejectedValue(new Error('Unexpected external request'));
  mocks.connect.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api = await import('@/lib/server/native-push');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('native provider configuration', () => {
  it('does not treat a legacy FCM key as native provider configuration', async () => {
    vi.stubEnv('FCM_SERVER_KEY', 'fixture-legacy-key');
    expect(api.nativePushConfigured()).toEqual({ fcm: false, apns: false });
    expect(await api.sendNativePush('fcm', 'fixture-fcm-token', payload)).toBe('unconfigured');
    expect(await api.sendNativePush('apns', deviceToken, payload)).toBe('unconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('separates APNs and FCM credentials and rejects unsafe path/header configuration', () => {
    configureFcm();
    expect(api.nativePushConfigured()).toEqual({ fcm: true, apns: false });
    configureApns();
    expect(api.nativePushConfigured()).toEqual({ fcm: true, apns: true });
    vi.stubEnv('FCM_PROJECT_ID', '../another-project');
    vi.stubEnv('APNS_TOPIC', 'topic\r\ninjected: true');
    expect(api.nativePushConfigured()).toEqual({ fcm: false, apns: false });
  });
});

describe('FCM HTTP v1', () => {
  it('signs and verifies RS256 OAuth, then sends the device payload to the fixed project API', async () => {
    configureFcm();
    fcmResponses();
    expect(await api.sendNativePush('fcm', 'fixture-fcm-token', payload)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [oauthUrl, oauth] = fetchMock.mock.calls[0];
    expect(oauthUrl).toBe(tokenUrl);
    expect(oauth?.redirect).toBe('error');
    expect(oauth?.signal).toBeInstanceOf(AbortSignal);
    const params = new URLSearchParams(String(oauth?.body));
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = decodeJwt(params.get('assertion')!);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(jwt.claims).toEqual({
      iss: 'sender@fixture-project.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUrl,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(verify('RSA-SHA256', jwt.content, rsa.publicKey, jwt.signature)).toBe(true);
    const [url, request] = fetchMock.mock.calls[1];
    expect(url).toBe(sendUrl);
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer fixture-access-1');
    expect(JSON.parse(String(request?.body))).toEqual({ message: {
      token: 'fixture-fcm-token', notification: { title: payload.title, body: payload.body }, data: { url: payload.url },
    } });
  });

  it('shares concurrent OAuth exchanges, refreshes expiring tokens and handles credential rotation', async () => {
    configureFcm();
    const fcm = fcmResponses();
    expect(await Promise.all([api.sendNativePush('fcm', 'token-one', payload), api.sendNativePush('fcm', 'token-two', payload)])).toEqual(['sent', 'sent']);
    expect(fcm.tokenRequests()).toBe(1);
    vi.setSystemTime(new Date(Date.now() + 59 * 60_000));
    expect(await api.sendNativePush('fcm', 'token-three', payload)).toBe('sent');
    expect(fcm.tokenRequests()).toBe(2);
    configureFcm(rotatedRsa.privateKey);
    expect(await api.sendNativePush('fcm', 'token-four', payload)).toBe('sent');
    expect(fcm.tokenRequests()).toBe(3);
    const lastOAuth = fetchMock.mock.calls.filter(([url]) => url === tokenUrl).at(-1)!;
    const jwt = decodeJwt(new URLSearchParams(String(lastOAuth[1]?.body)).get('assertion')!);
    expect(verify('RSA-SHA256', jwt.content, rotatedRsa.publicKey, jwt.signature)).toBe(true);
  });

  it.each([
    [404, { error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, 'unregistered'],
    [404, { error: { status: 'NOT_FOUND' } }, 'failed'],
    [400, { error: { details: [{ errorCode: 'INVALID_ARGUMENT' }] } }, 'failed'],
    [403, { error: { status: 'PERMISSION_DENIED' } }, 'failed'],
    [429, { error: { status: 'RESOURCE_EXHAUSTED' } }, 'failed'],
    [503, { error: { status: 'UNAVAILABLE' } }, 'failed'],
    [200, {}, 'failed'],
    [200, { name: 'not-a-provider-message-id' }, 'failed'],
  ] as const)('classifies status %s conservatively', async (status, body, expected) => {
    configureFcm();
    fcmResponses(() => json(body, status));
    expect(await api.sendNativePush('fcm', 'fixture-token', payload)).toBe(expected);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('invalidates a rejected access token for the next queued retry', async () => {
    configureFcm();
    let reject = true;
    const fcm = fcmResponses(() => reject ? json({ error: { status: 'UNAUTHENTICATED' } }, 401) : json({ name: 'projects/fixture-project/messages/accepted' }));
    expect(await api.sendNativePush('fcm', 'fixture-token', payload)).toBe('failed');
    reject = false;
    expect(await api.sendNativePush('fcm', 'fixture-token', payload)).toBe('sent');
    expect(fcm.tokenRequests()).toBe(2);
  });

  it('fails safely on invalid keys, malformed OAuth responses and oversized payloads', async () => {
    configureFcm();
    vi.stubEnv('FCM_PRIVATE_KEY', 'fixture-invalid-private-key');
    expect(await api.sendNativePush('fcm', 'fixture-token', payload)).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
    configureFcm();
    fetchMock.mockResolvedValue(json({ access_token: 'fixture', expires_in: '3600' }));
    expect(await api.sendNativePush('fcm', 'fixture-token', payload)).toBe('failed');
    fetchMock.mockClear();
    expect(await api.sendNativePush('fcm', 'fixture-token', { ...payload, body: 'x'.repeat(4096) })).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('bounds a stalled authorization exchange with an abort signal', async () => {
    configureFcm();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    const send = api.sendNativePush('fcm', 'fixture-token', payload);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await send).toBe('failed');
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
  });
});

describe('APNs HTTP/2', () => {
  it.each(['production', 'sandbox'])('signs ES256 and sends raw APNs registration through %s HTTP/2', async (environment) => {
    configureApns(environment);
    const sessions = apnsTransport();
    expect(await api.sendNativePush('apns', deviceToken, payload)).toBe('sent');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledWith(environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com', { minVersion: 'TLSv1.2' });
    const stream = sessions[0].streams[0];
    expect(stream.headers).toMatchObject({ ':method': 'POST', ':path': `/3/device/${deviceToken}`, 'apns-topic': 'com.bubaly.fixture', 'apns-push-type': 'alert', 'apns-priority': '10' });
    const jwt = decodeJwt(String(stream.headers.authorization).replace(/^bearer /, ''));
    expect(jwt.header).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(jwt.claims).toEqual({ iss: 'TEAM123456', iat: Math.floor(Date.now() / 1000) });
    expect(jwt.signature).toHaveLength(64);
    expect(verify('sha256', jwt.content, { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature)).toBe(true);
    expect(JSON.parse(stream.body)).toEqual({ aps: { alert: { title: payload.title, body: payload.body }, sound: 'default' }, url: payload.url });
    expect(stream.close).toHaveBeenCalled();
    expect(sessions[0].unref).toHaveBeenCalled();
  });

  it('reuses session and token, refreshes after 50 minutes and closes rotated credentials', async () => {
    configureApns();
    const sessions = apnsTransport();
    expect(await api.sendNativePush('apns', deviceToken, payload)).toBe('sent');
    const original = sessions[0].streams[0].headers.authorization;
    vi.setSystemTime(new Date(Date.now() + 15 * 60_000));
    expect(await api.sendNativePush('apns', deviceToken, payload)).toBe('sent');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].streams[1].headers.authorization).toBe(original);
    vi.setSystemTime(new Date(Date.now() + 36 * 60_000));
    expect(await api.sendNativePush('apns', deviceToken, payload)).toBe('sent');
    expect(sessions[0].streams[2].headers.authorization).not.toBe(original);
    vi.stubEnv('APNS_KEY_ID', 'NEW1234567');
    expect(await api.sendNativePush('apns', deviceToken, payload)).toBe('sent');
    expect(sessions).toHaveLength(2);
    expect(sessions[0].destroy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sessions[1].destroy).toHaveBeenCalled();
  });

  it.each([
    [410, { reason: 'Unregistered' }, 'unregistered'],
    [410, { reason: 'SomethingElse' }, 'failed'],
    [400, { reason: 'BadDeviceToken' }, 'failed'],
    [400, { reason: 'DeviceTokenNotForTopic' }, 'failed'],
    [403, { reason: 'InvalidProviderToken' }, 'failed'],
    [429, { reason: 'TooManyRequests' }, 'failed'],
    [503, { reason: 'Shutdown' }, 'failed'],
  ] as const)('classifies status %s without pruning configuration failures', async (status, body, expected) => {
    configureApns();
    apnsTransport(stream => apnsResponse(stream, status, body));
    expect(await api.sendNativePush('apns', deviceToken, payload)).toBe(expected);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('cancels a stalled stream and destroys its connection after 15 seconds', async () => {
    configureApns();
    const sessions = apnsTransport(() => {});
    const pending = api.sendNativePush('apns', deviceToken, payload);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBe('failed');
    expect(sessions[0].streams[0].close).toHaveBeenCalled();
    expect(sessions[0].destroy).toHaveBeenCalled();
  });

  it.each(['error', 'close', 'goaway'])('settles in-flight work and cleans up on connection %s', async (event) => {
    configureApns();
    const sessions = apnsTransport(() => {});
    const pending = api.sendNativePush('apns', deviceToken, payload);
    sessions[0].emit(event, event === 'error' ? new Error('Fixture transport failure') : undefined);
    expect(await pending).toBe('failed');
    expect(sessions[0].streams[0].close).toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('rejects unsafe device paths and oversized data before opening a connection', async () => {
    configureApns();
    expect(await api.sendNativePush('apns', '../bad-device', payload)).toBe('failed');
    expect(await api.sendNativePush('apns', deviceToken, { ...payload, body: 'x'.repeat(4096) })).toBe('failed');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('bounds provider error responses and safely closes the stream', async () => {
    configureApns();
    const sessions = apnsTransport(stream => {
      stream.emit('response', { ':status': 400 });
      stream.emit('data', Buffer.alloc(64 * 1024 + 1));
    });
    expect(await api.sendNativePush('apns', deviceToken, payload)).toBe('failed');
    expect(sessions[0].streams[0].close).toHaveBeenCalled();
  });
});
