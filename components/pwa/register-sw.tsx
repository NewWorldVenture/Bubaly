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

    const serviceWorker = navigator.serviceWorker;
    let disposed = false;
    let started = false;
    let reg: ServiceWorkerRegistration | undefined;
    const cleanups: Array<() => void> = [];
    const watchedWorkers = new Set<ServiceWorker>();
    const markUpdate = () => { if (!disposed) setUpdateReady(true); };

    const watchInstalling = (installing: ServiceWorker | null) => {
      if (!installing || watchedWorkers.has(installing)) return;
      watchedWorkers.add(installing);
      const onStateChange = () => {
        // "installed" + an existing controller ⇒ this is an UPDATE, not the
        // first install, so prompt the user to reload.
        if (installing.state === 'installed' && serviceWorker.controller) markUpdate();
      };
      installing.addEventListener('statechange', onStateChange);
      cleanups.push(() => installing.removeEventListener('statechange', onStateChange));
      onStateChange();
    };

    const watch = (r: ServiceWorkerRegistration) => {
      // Registration can finish after navigation or a StrictMode teardown.
      // The persistent worker belongs to the browser; these observers belong
      // only to the still-mounted component.
      if (disposed) return;
      reg = r;
      // A worker already waiting (installed while the page was closed).
      if (r.waiting && serviceWorker.controller) markUpdate();
      const onUpdateFound = () => watchInstalling(r.installing);
      r.addEventListener('updatefound', onUpdateFound);
      cleanups.push(() => r.removeEventListener('updatefound', onUpdateFound));
      // updatefound may have fired before register() resolved.
      onUpdateFound();
    };

    const onLoad = () => {
      if (disposed || started) return;
      started = true;
      // A denied/unavailable worker must not break the online application or
      // display a false update prompt. A later mount can attempt registration.
      serviceWorker.register('/sw.js').then(watch).catch(() => {});
    };
    // Sign-in and client navigation can mount AppFrame after window.load.
    if (document.readyState === 'complete') onLoad();
    else window.addEventListener('load', onLoad, { once: true });

    // The SW self-activates (skipWaiting), so a controller swap while the page is
    // open also signals a fresh version is now in charge.
    let hadController = !!serviceWorker.controller;
    const onControllerChange = () => {
      if (hadController) markUpdate();
      hadController = !!serviceWorker.controller;
    };
    serviceWorker.addEventListener('controllerchange', onControllerChange);

    // Poll for updates hourly so a long-lived tab isn't left on stale code.
    const poll = window.setInterval(() => reg?.update().catch(() => {}), 60 * 60 * 1000);

    return () => {
      disposed = true;
      window.removeEventListener('load', onLoad);
      serviceWorker.removeEventListener('controllerchange', onControllerChange);
      window.clearInterval(poll);
      cleanups.forEach((cleanup) => cleanup());
      watchedWorkers.clear();
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
