// lib/supabase/server.ts — server client bound to the request cookies (RLS as the user)
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient as createAdmin } from '@supabase/supabase-js';
import { durableCookieOptions, isSecureOrigin } from '../auth/session';
import type { Database } from '../database.types';

export async function createServer() {
  const cookieStore = await cookies();
  // The canonical app origin decides whether the auth cookies may carry
  // `Secure`. Reading it from config rather than per-request headers keeps the
  // answer stable across proxies, and an unset value simply omits the attribute
  // — the safe direction, since a Secure cookie on an http origin is dropped
  // and would read as an instant logout.
  const secure = isSecureOrigin(process.env.NEXT_PUBLIC_SITE_URL);
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Same scope + transport the browser client writes, so a session refreshed
      // on the server keeps the cookie the browser already has instead of
      // shadowing it with a differently-scoped one.
      cookieOptions: durableCookieOptions(secure),
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet: { name: string; value: string; options: CookieOptions }[]) => {
          try {
            toSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            /* called from a Server Component; middleware refreshes the session */
          }
        },
      },
    },
  );
}

// Service-role client. SERVER ONLY. Bypasses RLS — use only for webhooks,
// cron/notification dispatch, and trusted background jobs. Never expose to the browser.
export function createServiceClient() {
  return createAdmin<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
