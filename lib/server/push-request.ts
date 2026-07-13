export const MAX_PUSH_REQUEST_BYTES = 16_384;
export const MAX_PUSH_ENDPOINT_LENGTH = 2_048;
export const MAX_PUSH_TOKEN_LENGTH = 4_096;
export const MAX_PUSH_USER_AGENT_LENGTH = 400;

type PushPlatform = 'web' | 'ios' | 'android';
type PushProvider = 'webpush' | 'fcm' | 'apns';

export type PushRegistration = {
  platform: PushPlatform;
  provider: PushProvider;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  token: string | null;
  deviceKey: string;
  userAgent: string | null;
};

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHttpsEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PUSH_ENDPOINT_LENGTH) return null;
  const endpoint = value.trim();
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseNativeToken(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PUSH_TOKEN_LENGTH) return null;
  const token = value.trim();
  return /^[^\u0000-\u001f\u007f]+$/.test(token) ? token : null;
}

function parseWebKey(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !value || value.length > maxLength) return null;
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/** Strictly validates the browser/native registration contract before DB writes. */
export function parsePushRegistration(input: unknown): ParseResult<PushRegistration> {
  if (!isRecord(input)) return { ok: false, error: 'Invalid request body' };

  const platform = input.platform;
  const provider = input.provider;
  if (platform !== 'web' && platform !== 'ios' && platform !== 'android') {
    return { ok: false, error: 'Invalid push platform' };
  }
  if (provider !== 'webpush' && provider !== 'fcm' && provider !== 'apns') {
    return { ok: false, error: 'Invalid push provider' };
  }

  const userAgent = input.userAgent === undefined ? null : input.userAgent;
  if (userAgent !== null && (typeof userAgent !== 'string' || userAgent.length > MAX_PUSH_USER_AGENT_LENGTH)) {
    return { ok: false, error: 'Invalid user agent' };
  }

  if (platform === 'web' || provider === 'webpush') {
    if (platform !== 'web' || provider !== 'webpush') return { ok: false, error: 'Push platform and provider do not match' };
    const endpoint = parseHttpsEndpoint(input.endpoint);
    const p256dh = parseWebKey(input.p256dh, 256);
    const auth = parseWebKey(input.auth, 256);
    if (!endpoint || !p256dh || !auth) return { ok: false, error: 'Invalid web push subscription' };
    return { ok: true, value: { platform, provider, endpoint, p256dh, auth, token: null, deviceKey: endpoint, userAgent } };
  }

  const expectedProvider = platform === 'ios' ? 'apns' : 'fcm';
  const token = parseNativeToken(input.token);
  if (provider !== expectedProvider || !token) return { ok: false, error: 'Invalid native push registration' };
  return { ok: true, value: { platform, provider, endpoint: null, p256dh: null, auth: null, token, deviceKey: token, userAgent } };
}

/** Validates the endpoint/token key used when removing a device registration. */
export function parsePushDeviceKey(input: unknown): string | null {
  if (!isRecord(input)) return null;
  if ('endpoint' in input) return parseHttpsEndpoint(input.endpoint);
  if ('token' in input) return parseNativeToken(input.token);
  return null;
}
