// lib/supabase/server.ts — server client bound to the request cookies (RLS as the user)
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient as createAdmin } from '@supabase/supabase-js';
import type { Database } from '../database.types';

export async function createServer() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
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
