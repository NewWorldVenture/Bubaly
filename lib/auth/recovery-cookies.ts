import 'server-only';
import { combineChunks, createServerClient, stringFromBase64URL, stringToBase64URL, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import { durableCookieOptions, isSecureOrigin } from '@/lib/auth/session';
import { RecoveryError } from '@/lib/auth/recovery-server';

const MAX_COOKIE_LENGTH = 65_536;
const MAX_CHUNKS = 24;
type Cookie = { name: string; value: string };
type CookieChange = Cookie & { options: CookieOptions };
function cleanEnv(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}
function configuration() {
  let url: URL;
  try { url = new URL(cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL)); }
  catch { throw new RecoveryError('authRecovery.setupRequired'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new RecoveryError('authRecovery.setupRequired');
  }
  // Match SupabaseClient's default storage key; another project's cookie must
  // never become this request's candidate just because it has an auth suffix.
  return { origin: url.origin, key: `sb-${url.hostname.split('.')[0]}-auth-token` };
}
function sessionCookie(name: string, key: string): boolean { return name === key || name.startsWith(`${key}.`); }
function invalid(): never { throw new RecoveryError('authRecovery.sessionChanged'); }

/** Read a candidate only. No SDK construction, refresh, user lookup or writes. */
export async function readRecoveryCookieToken(): Promise<string> {
  const { key } = configuration();
  const selected = (await cookies()).getAll().filter(cookie => sessionCookie(cookie.name, key));
  if (!selected.length || selected.length > MAX_CHUNKS) return invalid();
  const values = new Map<string, string>();
  let length = 0;
  for (const cookie of selected) {
    if (values.has(cookie.name) || typeof cookie.value !== 'string' || !cookie.value) return invalid();
    length += cookie.value.length;
    if (length > MAX_COOKIE_LENGTH) return invalid();
    values.set(cookie.name, cookie.value);
  }
  if (values.has(key)) {
    if (values.size !== 1) return invalid();
  } else {
    // Reject gaps, noncanonical indices and unexpected suffixes before the
    // SDK helper can silently stop at the first missing chunk.
    for (let index = 0; index < values.size; index++) if (!values.has(`${key}.${index}`)) return invalid();
  }
  const encoded = await combineChunks(key, name => values.get(name));
  if (!encoded) return invalid();
  try {
    let json = encoded;
    if (encoded.startsWith('base64-')) {
      const body = encoded.slice(7);
      if (!/^[A-Za-z0-9_-]+$/.test(body)) return invalid();
      json = stringFromBase64URL(body);
      if (stringToBase64URL(json) !== body) return invalid();
    }
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('access_token' in value)
      || typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 16_384) return invalid();
    return value.access_token;
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    return invalid();
  }
}

/** Stage the exchange's cookies until the exact returned token is verified. */
export async function createRecoveryCookieExchange() {
  const { origin, key } = configuration();
  const anon = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (!anon) throw new RecoveryError('authRecovery.setupRequired');
  const incoming = (await cookies()).getAll().map(({ name, value }) => ({ name, value }));
  const pending = new Map<string, CookieChange>();
  const client = createServerClient(origin, anon, {
    cookieOptions: durableCookieOptions(isSecureOrigin(process.env.NEXT_PUBLIC_SITE_URL)),
    cookies: {
      // Retain names for the SDK's old-chunk cleanup and retain the verifier.
      // Hide ambient session values from constructor INITIAL_SESSION reads,
      // which can otherwise refresh even with automatic refresh disabled.
      getAll: () => incoming.map(cookie => sessionCookie(cookie.name, key) ? { ...cookie, value: '' } : cookie),
      setAll: changes => { for (const change of changes) pending.set(change.name, change); },
    },
  });
  return {
    client,
    applyTo(response: Pick<NextResponse, 'cookies'>) {
      for (const { name, value, options } of pending.values()) response.cookies.set(name, value, options);
    },
    dispose: () => client.auth.dispose(),
  };
}
