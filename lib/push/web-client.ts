// lib/push/web-client.ts
// Browser-side Web Push helpers (PWA). The VAPID public key is safe to ship to
// the client (it's the public half); the private key stays server-side in
// lib/server/push.ts. Native (Capacitor) push uses APNs/FCM tokens instead and
// does not need these.

export const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

/** Convert a base64url VAPID key to the Uint8Array the Push API expects. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function webPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export type WebPushSubscriptionPayload = {
  platform: 'web';
  provider: 'webpush';
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
};

/**
 * Subscribe this browser to Web Push and return the payload to persist. Requires
 * the service worker to be registered (RegisterSW handles that) and a VAPID key.
 * Returns null if unsupported, not permitted, or unconfigured.
 *
 * `existingOnly` is the re-sync that runs on every signed-in page: it reports
 * the subscription this browser already holds and never makes one. Permission
 * stays "granted" after push is turned off, so a re-sync that subscribed
 * enrolled the device again on the next page.
 */
export async function subscribeWebPush(options: { existingOnly?: boolean } = {}): Promise<WebPushSubscriptionPayload | null> {
  if (!webPushSupported() || !VAPID_PUBLIC_KEY) return null;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    if (options.existingOnly) return null;
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });
  }
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null;
  return {
    platform: 'web',
    provider: 'webpush',
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    userAgent: navigator.userAgent,
  };
}

/** Whether this browser holds a push subscription right now. */
export async function hasWebPushSubscription(): Promise<boolean> {
  if (!webPushSupported()) return false;
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) !== null;
}

/**
 * Let go of this browser's subscription and return the endpoint to remove from
 * the server, or null when there was none. Rejects when the browser refuses or
 * answers false: the subscription is still live, so it must not read as off.
 */
export async function unsubscribeWebPush(): Promise<string | null> {
  if (!webPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  if (!(await sub.unsubscribe())) throw new Error('The browser kept its push subscription');
  return endpoint;
}
