'use client';

// Android hardware back-button support for the Capacitor shell. On web and iOS
// this renders nothing and registers nothing. On Android the OS back gesture
// must mean "close what's on top", not "leave the app": priority is
//   1. close the topmost open overlay (modal / nav drawer / lightbox) the same
//      way its Escape handler or scrim click would,
//   2. otherwise navigate history back,
//   3. otherwise (nothing left to close) minimize the app — the platform
//      convention for back on a root screen.
import { useEffect } from 'react';

/** Close the topmost `[role="dialog"]` overlay, if any. Returns true when an
 *  overlay was found (the back press is then considered handled). Escape is
 *  dispatched first — the shared Modal listens for it; overlays that don't
 *  (e.g. the mobile nav drawer) get their scrim or ✕ button clicked instead. */
function closeTopOverlay(): boolean {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  const top = dialogs[dialogs.length - 1];
  if (!top) return false;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  // Give React a beat to unmount; if the overlay ignored Escape, click it closed.
  window.setTimeout(() => {
    if (!top.isConnected) return;
    const scrim = (top.parentElement ?? top).querySelector<HTMLElement>('.overlay-scrim');
    if (scrim) { scrim.click(); return; }
    top.querySelector<HTMLElement>('button[aria-label^="Close"]')?.click();
  }, 80);
  return true;
}

export function AndroidBackHandler() {
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let unmounted = false;
    (async () => {
      try {
        const { Capacitor } = await import('@capacitor/core');
        if (Capacitor.getPlatform() !== 'android') return;
        const { App } = await import('@capacitor/app');
        const sub = await App.addListener('backButton', ({ canGoBack }) => {
          if (closeTopOverlay()) return;
          if (canGoBack || window.history.length > 1) { window.history.back(); return; }
          void App.minimizeApp();
        });
        if (unmounted) void sub.remove();
        else dispose = () => { void sub.remove(); };
      } catch {
        // Plugin unavailable (plain web build) — the default browser back is fine.
      }
    })();
    return () => { unmounted = true; dispose?.(); };
  }, []);
  return null;
}
