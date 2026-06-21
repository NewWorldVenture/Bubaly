'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
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
    let cleanup = () => {};

    (async () => {
      try {
        const [{ StatusBar, Style }, { SplashScreen }, { App }] = await Promise.all([
          import('@capacitor/status-bar'),
          import('@capacitor/splash-screen'),
          import('@capacitor/app'),
        ]);

        const dark = !document.documentElement.classList.contains('light');
        await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
        await SplashScreen.hide().catch(() => {});

        const backHandle = await App.addListener('backButton', ({ canGoBack }) => {
          if (canGoBack) router.back();
          else App.exitApp().catch(() => {});
        });

        // Deep links: open https://www.bubaly.com/<path> and supabase auth
        // callbacks inside the shell by routing to the path portion.
        const urlHandle = await App.addListener('appUrlOpen', ({ url }) => {
          try {
            const parsed = new URL(url);
            const target = `${parsed.pathname}${parsed.search}${parsed.hash}`;
            if (target && target !== '/') router.push(target);
          } catch {
            /* ignore malformed deep links */
          }
        });

        cleanup = () => {
          backHandle.remove();
          urlHandle.remove();
        };
      } catch {
        /* plugin not available — running as plain web */
      }
    })();

    return () => cleanup();
  }, [router]);

  return null;
}
