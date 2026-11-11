'use client';

import { useEffect } from 'react';
import { isNative, getPlatform } from '@/lib/native/capacitor';
import { subscribeWebPush, webPushSupported, VAPID_PUBLIC_KEY } from '@/lib/push/web-client';
import { rememberPushDevice } from '@/lib/push/device-registration';

async function persist(payload: Record<string, unknown>) {
  try {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // Remembered so sign-out can take this device off the leaving account.
    if (res.ok) rememberPushDevice(payload as { endpoint?: string; token?: string });
  } catch {
    /* offline / transient — the registrar re-runs on next mount */
  }
}

/**
 * Keeps this device's push registration in sync with Supabase.
 *  - Native (Capacitor): requests permission, registers with APNs/FCM, and
 *    persists the device token. Runs once per app launch.
 *  - Web (installed PWA): re-syncs an existing Web Push subscription when
 *    notification permission is already granted. First-time opt-in is an
 *    explicit user action (EnablePushButton) to avoid an unsolicited prompt.
 * No-op on the plain website and when push is unconfigured.
 */
export function PushRegistrar() {
  useEffect(() => {
    let cleanup = () => {};

    (async () => {
      if (isNative()) {
        try {
          const { PushNotifications } = await import('@capacitor/push-notifications');
          const perm = await PushNotifications.checkPermissions();
          let granted = perm.receive === 'granted';
          if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
            granted = (await PushNotifications.requestPermissions()).receive === 'granted';
          }
          if (!granted) return;

          const regHandle = await PushNotifications.addListener('registration', (token) => {
            persist({
              platform: getPlatform(),
              provider: getPlatform() === 'ios' ? 'apns' : 'fcm',
              token: token.value,
              userAgent: navigator.userAgent,
            });
          });
          await PushNotifications.register();
          cleanup = () => { regHandle.remove(); };
        } catch {
          /* plugin unavailable */
        }
        return;
      }

      // Web: only re-sync a subscription this browser still holds. Permission
      // outlives "turn off", so it must never be the reason to subscribe.
      if (webPushSupported() && VAPID_PUBLIC_KEY && Notification.permission === 'granted') {
        try {
          const payload = await subscribeWebPush({ existingOnly: true });
          if (payload) await persist(payload);
        } catch { /* no service worker answer: the next mount tries again */ }
      }
    })();

    return () => cleanup();
  }, []);

  return null;
}
