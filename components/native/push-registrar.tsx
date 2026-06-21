'use client';

import { useEffect } from 'react';
import { isNative, getPlatform } from '@/lib/native/capacitor';
import { subscribeWebPush, webPushSupported, VAPID_PUBLIC_KEY } from '@/lib/push/web-client';

async function persist(payload: Record<string, unknown>) {
  try {
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
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

      // Web: only re-sync if the user already granted notifications.
      if (webPushSupported() && VAPID_PUBLIC_KEY && Notification.permission === 'granted') {
        const payload = await subscribeWebPush();
        if (payload) await persist(payload);
      }
    })();

    return () => cleanup();
  }, []);

  return null;
}
