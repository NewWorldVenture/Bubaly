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
 */
export async function subscribeWebPush(): Promise<WebPushSubscriptionPayload | null> {
  if (!webPushSupported() || !VAPID_PUBLIC_KEY) return null;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
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

export async function unsubscribeWebPush(): Promise<string | null> {
  if (!webPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  return endpoint;
}
