// lib/push/device-registration.ts
// Remembers which push registration THIS browser or app install made, so that
// signing out can take it off the account that is leaving.
//
// push_devices rows are keyed (user_id, device_key) and nothing removed them on
// sign-out: a parent signing out of a shared tablet left their row enabled, and
// the tablet kept receiving that parent's personally addressed notifications.
// The key is the endpoint (web) or provider token (native). It is not a
// credential for anything but this device's own push channel, and it already
// lives in this browser's PushManager or the native plugin; keeping a copy here
// only makes it readable synchronously at sign-out.

const STORAGE_KEY = 'bubaly.push.device';
const DETACH_TIMEOUT_MS = 4_000;

export type PushDeviceKey = { endpoint: string } | { token: string };

function read(): PushDeviceKey | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.endpoint === 'string' && value.endpoint) return { endpoint: value.endpoint };
    if (typeof value.token === 'string' && value.token) return { token: value.token };
    return null;
  } catch { return null; }
}

/** Called after the server accepted a registration for the signed-in user. */
export function rememberPushDevice(payload: { endpoint?: string | null; token?: string | null }): void {
  const key: PushDeviceKey | null = payload.endpoint ? { endpoint: payload.endpoint }
    : payload.token ? { token: payload.token } : null;
  if (!key) return;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(key)); } catch { /* storage unavailable */ }
}

export function forgetPushDevice(): void {
  try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}

/**
 * Remove this device's registration from the account that is signing out.
 *
 * Authenticated with the leaving session's access token rather than cookies:
 * sign-out clears the cookies synchronously, before any request could carry
 * them. The caller must revoke that token only after this settles, because a
 * revoked session cannot prove ownership of the row. Returns null when this
 * device registered nothing, so a sign-out with no push pays no wait.
 * Bounded, and never rejects: sign-out must not hang on push cleanup.
 */
export function detachPushDevice(accessToken: string, fetcher: typeof fetch = fetch): Promise<void> | null {
  const key = read();
  if (!key || !accessToken) return null;
  forgetPushDevice();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(); }, DETACH_TIMEOUT_MS);
  });
  let request: Promise<void>;
  try {
    request = fetcher('/api/push/unsubscribe', {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(key),
    }).then(() => undefined, () => undefined);
  } catch { request = Promise.resolve(); }
  return Promise.race([request, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}
