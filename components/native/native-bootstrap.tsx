'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { PluginListenerHandle } from '@capacitor/core';
import { safeInternalRedirect } from '@/lib/auth/redirect';
import { isNative } from '@/lib/native/capacitor';

/**
 * Initializes native-shell behaviour when running inside the Capacitor app
 * (iOS/iPadOS/Android). No-op on the web and the installed PWA. Everything is
 * dynamically imported so the native plugin code never enters the web bundle.
 *
 * Wires:
 *  - Status bar style/colour to match the app theme.
 *  - Splash screen hide once the web app has mounted.
 *  - Hardware back button (Android) → router back, or exit at the root.
 *  - Deep links / OAuth + magic-link returns (appUrlOpen) → in-app navigation.
 */
export function NativeBootstrap() {
  const router = useRouter();

  useEffect(() => {
    if (!isNative()) return;
    let disposed = false;
    const handles = new Set<PluginListenerHandle>();
    const remove = (handle: PluginListenerHandle) => { void handle.remove().catch(() => {}); };
    const retain = (handle: PluginListenerHandle) => {
      // The native listener can finish registering after React has unmounted.
      // Its handle still needs removal, even though initialization has ended.
      if (disposed) { remove(handle); return false; }
      handles.add(handle);
      return true;
    };
    const cleanup = () => {
      disposed = true;
      handles.forEach(remove);
      handles.clear();
    };

    (async () => {
      try {
        const [{ StatusBar, Style }, { SplashScreen }, { App }] = await Promise.all([
          import('@capacitor/status-bar'),
          import('@capacitor/splash-screen'),
          import('@capacitor/app'),
        ]);
        if (disposed) return;

        const dark = !document.documentElement.classList.contains('light');
        await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
        if (disposed) return;
        await SplashScreen.hide().catch(() => {});
        if (disposed) return;

        const backHandle = await App.addListener('backButton', ({ canGoBack }) => {
          if (disposed) return;
          if (canGoBack) router.back();
          else App.exitApp().catch(() => {});
        });
        if (!retain(backHandle)) return;

        // Deep links: open https://www.bubaly.com/<path> and supabase auth
        // callbacks inside the shell by routing to the path portion.
        const urlHandle = await App.addListener('appUrlOpen', ({ url }) => {
          if (disposed) return;
          try {
            const parsed = new URL(url);
            // A URL on the app host can still contain a //host pathname,
            // which the router interprets as an external navigation. Validate
            // the path before retaining opaque OAuth query/hash values.
            const pathname = safeInternalRedirect(parsed.pathname, '');
            if (!pathname) return;
            const target = `${pathname}${parsed.search}${parsed.hash}`;
            if (target && target !== '/') router.push(target);
          } catch {
            /* ignore malformed deep links */
          }
        });
        retain(urlHandle);
      } catch {
        // A partially initialized plugin must not leave the first listener
        // active when registering the second one fails.
        cleanup();
      }
    })();

    return cleanup;
  }, [router]);

  return null;
}
