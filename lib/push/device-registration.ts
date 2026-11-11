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
const RELEASE_TIMEOUT_MS = 2_000;

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

export type PushDetachResult =
  /** The server dropped this device from the leaving account. */
  | 'detached'
  /** The server did not, so this device closed its own push channel. */
  | 'released'
  /** Neither happened. The key is kept so a later sign-out can try again. */
  | 'kept';

function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, onTimeout: T): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(onTimeout); }, ms);
  });
  let run: Promise<T>;
  try { run = work(controller.signal).catch(() => onTimeout); } catch { run = Promise.resolve(onTimeout); }
  return Promise.race([run, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

/** True only when the server answered 2xx. A server fault or lost request is tried once more. */
async function removeFromServer(key: PushDeviceKey, accessToken: string, fetcher: typeof fetch, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 2 && !signal.aborted; attempt += 1) {
    try {
      const res = await fetcher('/api/push/unsubscribe', {
        method: 'POST',
        credentials: 'omit',
        keepalive: true,
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(key),
      });
      if (res.ok) return true;
      // A refusal (401, 429, 4xx) will be refused again.
      if (res.status < 500) return false;
    } catch { /* network error or abort */ }
  }
  return false;
}

/**
 * Close this device's own push channel, which needs no session: the browser
 * drops its subscription (the endpoint then answers 410 and the server prunes
 * the row), a native install unregisters from its provider. True once nothing
 * can be delivered here on the stored key.
 */
async function releaseLocalChannel(key: PushDeviceKey): Promise<boolean> {
  if ('token' in key) {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.unregister();
    return true;
  }
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  // No subscription: the remembered endpoint is already dead.
  return subscription ? subscription.unsubscribe() : true;
}

/**
 * Remove this device's registration from the account that is signing out.
 *
 * Authenticated with the leaving session's access token rather than cookies:
 * sign-out clears the cookies synchronously, before any request could carry
 * them. The caller must revoke that token only after this settles, because a
 * revoked session cannot prove ownership of the row. Returns null when this
 * device registered nothing, so a sign-out with no push pays no wait.
 *
 * Only a 2xx counts as removed. The key used to be forgotten before the request
 * left and any answer was called success, so a 401, 429, 500, lost request or
 * timeout left the row enabled with nothing left to retry it. When the server
 * does not drop the row (or there is no token to ask with) the device closes
 * its own channel instead, and the key is forgotten only once one of the two
 * has happened. Bounded, and never rejects: sign-out must not hang on push
 * cleanup.
 */
export function detachPushDevice(accessToken: string | null | undefined, fetcher: typeof fetch = fetch): Promise<PushDetachResult> | null {
  const key = read();
  if (!key) return null;
  const removed = accessToken
    ? bounded(signal => removeFromServer(key, accessToken, fetcher, signal), DETACH_TIMEOUT_MS, false)
    : Promise.resolve(false);
  return removed.then(async (detached): Promise<PushDetachResult> => {
    if (detached) { forgetPushDevice(); return 'detached'; }
    if (!(await bounded(() => releaseLocalChannel(key), RELEASE_TIMEOUT_MS, false))) return 'kept';
    forgetPushDevice();
    return 'released';
  });
}
