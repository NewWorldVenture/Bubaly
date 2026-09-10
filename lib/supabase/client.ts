// lib/supabase/client.ts — browser client (RLS enforced as the signed-in user)
//
// Sign-in is durable: the session is stored in cookies that outlive the tab,
// a browser restart, and the native shell being swiped away, and only an
// explicit sign-out clears it. Two things make that true, and both belong here
// rather than at the 130+ call sites:
//
//  1. ONE client per browser. Every extra GoTrue instance runs its own refresh
//     timer, and several of them racing to rotate the same refresh token is a
//     real way to get logged out mid-session: one wins, the losers hold a
//     consumed token, and reuse detection revokes the whole session family.
//     `createBrowserClient` caches a singleton itself today; memoizing on our
//     side makes that a property of this module rather than of a library
//     internal, and keeps the server-render path from sharing one.
//  2. The auth options below, stated rather than inherited — persistence and
//     background refresh are the whole feature, so a change to them should be
//     a visible edit to this file.
import { createBrowserClient } from '@supabase/ssr';
import { durableCookieOptions, isSecureOrigin } from '../auth/session';
import { createSessionRefreshFetch } from '@/shared/auth/refresh-fetch';
import type { Database } from '../database.types';

type BrowserClient = ReturnType<typeof createBrowserClient<Database>>;

let client: BrowserClient | null = null;

function build(): BrowserClient {
  const secure = typeof window !== 'undefined' && isSecureOrigin(window.location.origin);
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Scope + transport for the auth cookies; @supabase/ssr sets the 400-day
      // lifetime itself. `secure` is omitted off https so the localhost dev
      // server and a Capacitor LAN shell keep their cookies at all.
      cookieOptions: durableCookieOptions(secure),
      global: { fetch: createSessionRefreshFetch(process.env.NEXT_PUBLIC_SUPABASE_URL!) },
      auth: {
        // Stay signed in until sign-out: keep the session across restarts,
        // refresh the access token in the background, and finish the PKCE
        // OAuth / magic-link handoff when the browser lands back on the app.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    },
  );
}

/**
 * The browser Supabase client — the same instance for the life of the page.
 * Always go through this rather than calling `createBrowserClient` directly,
 * which would reintroduce the competing-refresh-timer logout described above.
 */
export function createClient(): BrowserClient {
  // During a client component's server render there is no cookie jar to
  // memoize against; build a throwaway rather than caching one process-wide
  // and leaking one visitor's session into another visitor's request.
  if (typeof window === 'undefined') return build();
  client ??= build();
  return client;
}
