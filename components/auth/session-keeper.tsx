'use client';

// Keeps a signed-in session alive and keeps the server-rendered tree in step
// with it. Mounted once inside the authenticated layout; renders nothing.
//
// supabase-js already refreshes the access token on a timer and on tab
// visibility. What it cannot do on its own is the other half:
//
//  - When it rotates the token it writes new auth cookies, but the React Server
//    Component tree above it was rendered against the old ones. `router.refresh()`
//    re-renders it against the current session, so a long-lived tab keeps
//    working instead of drifting into "not signed in" on its next server action.
//  - Its visibility listener does not fire reliably in a Capacitor WebView that
//    was suspended for hours, and it has nothing bound to coming back online.
//    Both are exactly when a returning user expects to still be signed in.
//
// Auth events and successful reads of the current cookies establish whether a
// session ended. Nothing on this path clears credentials, so a failed refresh
// leaves the user signed in and the next attempt retries.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isNative } from '@/lib/native/capacitor';
import { getCacheSessionSnapshot, refreshCacheSession, subscribeCacheAuthEvents } from '@/lib/auth/cache-session';
import { subscribeSessionStorageChanges } from '@/lib/auth/session-change';

/** Don't re-check more than this often; the triggers below can arrive in bursts. */
const REVIVE_INTERVAL_MS = 30_000;

export function SessionKeeper({ userId }: { userId: string }) {
  const router = useRouter();

  useEffect(() => {
    let disposed = false;
    let lastRevive = -Infinity;
    let authRevision = 0;
    let lastRead = 0;

    // `getSession()` reads the stored session and refreshes it when the access
    // token has expired, so this is "make sure we're still current" — never a
    // sign-out, even when it fails.
    const reconcile = (explicitChange = false) => {
      const now = Date.now();
      if (disposed || (!explicitChange && now - lastRevive < REVIVE_INTERVAL_MS)) return;
      lastRevive = now;
      const revision = authRevision;
      const read = ++lastRead;
      void refreshCacheSession().then(() => {
        const session = getCacheSessionSnapshot();
        // An auth event or a later read supersedes this snapshot. A failed
        // refresh says nothing about whether the saved session still exists.
        if (disposed || revision !== authRevision || read !== lastRead || session.error
          || (session.status !== 'ready' && session.status !== 'signed-out')) return;
        // Server POST sign-out clears cookies without broadcasting an auth
        // event to other tabs. Reconcile their rendered identity on return.
        if ((session.identity?.userId ?? null) !== userId) {
          router.refresh();
        }
      }).catch(() => { /* offline; the next lifecycle event retries */ });
    };
    const revive = () => reconcile();

    const onVisible = () => { if (document.visibilityState === 'visible') revive(); };

    const unsubscribe = subscribeCacheAuthEvents((event, observedUserId) => {
      if (disposed) return;
      if (event !== 'INITIAL_SESSION' || observedUserId !== null) authRevision += 1;
      // Re-render the server tree against the session that now exists. On
      // SIGNED_OUT that means the route guards see no user and route to /login,
      // so the redirect stays in one place instead of being duplicated here.
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT' || event === 'USER_UPDATED'
        || ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && observedUserId && observedUserId !== userId)) {
        router.refresh();
      }
    });
    // Cookie changes are explicit user actions, so they bypass foreground
    // throttling and share the store's newly invalidated session read.
    const stopStorageChanges = subscribeSessionStorageChanges(() => reconcile(true));
    // Reconcile a cookie-only account change at first mount too. This shares
    // the store's bootstrap read and does not create a second SDK client.
    revive();

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', revive);
    window.addEventListener('online', revive);
    // bfcache: a back-navigation restores a page frozen with an old token.
    window.addEventListener('pageshow', revive);

    // Native shells can stay suspended for days. `resume` is the one event that
    // always fires there, and it is the moment the user is looking at the app
    // again expecting to still be signed in.
    let removeResume = () => {};
    const removeListener = (handle: { remove: () => Promise<void> }) => {
      try {
        void handle.remove().catch(() => { /* native bridge may already be gone */ });
      } catch { /* a suspended native bridge can throw synchronously */ }
    };
    if (isNative()) {
      void import('@capacitor/app')
        .then(({ App }) => App.addListener('resume', revive))
        .then((handle) => {
          if (disposed) removeListener(handle);
          else removeResume = () => removeListener(handle);
        })
        .catch(() => { /* plugin unavailable — web build */ });
    }

    return () => {
      disposed = true;
      unsubscribe();
      stopStorageChanges();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', revive);
      window.removeEventListener('online', revive);
      window.removeEventListener('pageshow', revive);
      removeResume();
    };
  }, [router, userId]);

  return null;
}
