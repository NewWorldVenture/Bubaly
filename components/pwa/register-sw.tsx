'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from '@/components/i18n/locale-provider';

/**
 * Registers the service worker (PWA install + offline shell) AND surfaces a
 * visible, reliable update prompt so users never get stuck on stale code
 * (mission Phase 16). When a new SW has installed behind the current page, we show
 * a dismissible bottom banner with a Reload action — mobile-safe (fixed, above the
 * bottom tab bar, clears the home indicator via safe-bottom). No-op in dev.
 */
export function RegisterSW() {
  const t = useTranslations();
  const [updateReady, setUpdateReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (
      typeof navigator === 'undefined' ||
      !('serviceWorker' in navigator) ||
      process.env.NODE_ENV !== 'production'
    ) {
      return;
    }

    let reg: ServiceWorkerRegistration | undefined;
    const markUpdate = () => setUpdateReady(true);

    const watch = (r: ServiceWorkerRegistration) => {
      reg = r;
      // A worker already waiting (installed while the page was closed).
      if (r.waiting && navigator.serviceWorker.controller) markUpdate();
      r.addEventListener('updatefound', () => {
        const installing = r.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // "installed" + an existing controller ⇒ this is an UPDATE, not the
          // first install, so prompt the user to reload.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) markUpdate();
        });
      });
    };

    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').then(watch).catch(() => {});
    };
    window.addEventListener('load', onLoad);

    // The SW self-activates (skipWaiting), so a controller swap while the page is
    // open also signals a fresh version is now in charge.
    const hadController = !!navigator.serviceWorker.controller;
    const onControllerChange = () => { if (hadController) markUpdate(); };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    // Poll for updates hourly so a long-lived tab isn't left on stale code.
    const poll = window.setInterval(() => reg?.update().catch(() => {}), 60 * 60 * 1000);

    return () => {
      window.removeEventListener('load', onLoad);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      window.clearInterval(poll);
    };
  }, []);

  if (!updateReady || dismissed) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:bottom-4"
    >
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl border border-border bg-elevated px-4 py-3 shadow-glass">
        <span className="min-w-0 flex-1 text-sm font-medium text-fg">
          {t('registerSw.aNewVersionOfBubalyIs')}
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium text-muted transition hover:bg-surface hover:text-fg"
        >
          {t('registerSw.later')}
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg transition hover:opacity-90"
        >
          {t('registerSw.reload')}
        </button>
      </div>
    </div>
  );
}
