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
// A session ends here only when Supabase says it ended. Nothing on this path
// clears a session, so a failed refresh leaves the user signed in and the next
// attempt retries.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { isNative } from '@/lib/native/capacitor';

/** Don't re-check more than this often; the triggers below can arrive in bursts. */
const REVIVE_INTERVAL_MS = 30_000;

export function SessionKeeper() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let disposed = false;
    let lastRevive = 0;

    // `getSession()` reads the stored session and refreshes it when the access
    // token has expired, so this is "make sure we're still current" — never a
    // sign-out, even when it fails.
    const revive = () => {
      const now = Date.now();
      if (disposed || now - lastRevive < REVIVE_INTERVAL_MS) return;
      lastRevive = now;
      void supabase.auth.getSession().catch(() => { /* offline; the timer retries */ });
    };

    const onVisible = () => { if (document.visibilityState === 'visible') revive(); };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      // Re-render the server tree against the session that now exists. On
      // SIGNED_OUT that means the route guards see no user and route to /login,
      // so the redirect stays in one place instead of being duplicated here.
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        router.refresh();
      }
    });

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', revive);
    window.addEventListener('online', revive);
    // bfcache: a back-navigation restores a page frozen with an old token.
    window.addEventListener('pageshow', revive);

    // Native shells can stay suspended for days. `resume` is the one event that
    // always fires there, and it is the moment the user is looking at the app
    // again expecting to still be signed in.
    let removeResume = () => {};
    if (isNative()) {
      void import('@capacitor/app')
        .then(({ App }) => App.addListener('resume', revive))
        .then((handle) => {
          if (disposed) void handle.remove();
          else removeResume = () => { void handle.remove(); };
        })
        .catch(() => { /* plugin unavailable — web build */ });
    }

    return () => {
      disposed = true;
      subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', revive);
      window.removeEventListener('online', revive);
      window.removeEventListener('pageshow', revive);
      removeResume();
    };
  }, [router]);

  return null;
}
