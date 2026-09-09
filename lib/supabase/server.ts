// lib/supabase/server.ts — server client bound to the request cookies (RLS as the user)
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient as createAdmin } from '@supabase/supabase-js';
import { durableCookieOptions, isSecureOrigin } from '../auth/session';
import { createSessionRefreshFetch } from '@/shared/auth/refresh-fetch';
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
    cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL),
    cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      // Same scope + transport the browser client writes, so a session refreshed
      // on the server keeps the cookie the browser already has instead of
      // shadowing it with a differently-scoped one.
      cookieOptions: durableCookieOptions(secure),
      global: { fetch: createSessionRefreshFetch(cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL)) },
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

// A credential pasted into a dashboard picks up a trailing newline or a wrapping
// pair of quotes more often than anyone admits, and Supabase rejects the result
// with "Unregistered API key" / "Invalid Compact JWS" — errors that name nothing
// you can act on. Neither a URL nor a key ever legitimately carries surrounding
// whitespace or quotes, so removing them can only turn a broken deployment into
// a working one.
function cleanEnv(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

// Service-role client. SERVER ONLY. Bypasses RLS — use only for webhooks,
// cron/notification dispatch, and trusted background jobs. Never expose to the browser.
export function createServiceClient() {
  return createAdmin<Database>(
    cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL),
    cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY),
    { auth: { persistSession: false } },
  );
}

/**
 * What is actually IN `SUPABASE_SERVICE_ROLE_KEY` right now — its shape, never
 * its value.
 *
 * SERVER ONLY, and only ever rendered behind the super-admin gate. A key's
 * format is not a secret (a project's scheme is already visible in the
 * publishable key it ships to every browser), but the key itself must never
 * leave the server, so nothing here returns or interpolates it.
 *
 * This exists because "Unregistered API key" does not distinguish the two very
 * different mistakes it covers. Supabase projects that moved to the new API-key
 * scheme keep working for anyone holding an `sb_publishable_…` key while every
 * legacy `eyJ…` service key stops being registered — so the deployment reads
 * fine for signed-in families and returns nothing at all for admin. Naming the
 * mismatch turns "the key is wrong somehow" into one specific replacement.
 */
export function describeConfiguredServiceKey(): string | null {
  const raw = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!raw || raw.trim() === '') return 'SUPABASE_SERVICE_ROLE_KEY is empty on this deployment.';

  const key = cleanEnv(raw);
  const anon = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const projectUsesNewScheme = anon.startsWith('sb_publishable_');

  if (key.startsWith('sb_publishable_')) {
    return 'The configured key is a PUBLISHABLE key (sb_publishable_…) — that is the public key. Use the secret key (sb_secret_…) instead.';
  }
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(key)) {
    return projectUsesNewScheme
      ? 'The configured key is a legacy JWT (eyJ…), but this project has moved to the new API-key scheme — legacy keys are no longer registered. Replace it with the secret key (sb_secret_…).'
      : 'The configured key is a legacy JWT (eyJ…) that this project no longer accepts.';
  }
  if (key.startsWith('sb_secret_')) {
    return 'The configured key has the right shape (sb_secret_…) but this project does not accept it — it is likely from a different project, or has been revoked.';
  }
  return projectUsesNewScheme
    ? 'The configured key matches no known Supabase key format. This project uses sb_secret_… service keys.'
    : 'The configured key matches no known Supabase key format.';
}
