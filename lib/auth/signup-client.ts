import { createBrowserClient, isChunkLike, parseCookieHeader, serializeCookieHeader, type CookieOptions } from '@supabase/ssr';
import type { AuthResponse, SignUpWithPasswordCredentials } from '@supabase/supabase-js';
import { durableCookieOptions, isRetryableAuthError, isSecureOrigin } from './session';
import type { createClient } from '../supabase/client';

type Cookie = { name: string; value: string; options: CookieOptions };
const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  const user = session.user as Record<string, unknown> | undefined;
  return !!user && typeof user.id === 'string' && userIdPattern.test(user.id)
    && typeof session.access_token === 'string' && !!session.access_token.trim()
    && typeof session.refresh_token === 'string' && !!session.refresh_token.trim()
    && typeof session.token_type === 'string' && !!session.token_type.trim()
    && typeof session.expires_in === 'number' && Number.isFinite(session.expires_in) && session.expires_in > 0;
}

/** One SDK signup with storage owned by that request. Never restores cookies. */
export async function signUpWithOwnedVerifier(
  _sharedClient: ReturnType<typeof createClient>,
  credentials: SignUpWithPasswordCredentials,
  canCommitSession: () => boolean,
): Promise<AuthResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  // This is SupabaseClient's default project storage key; the explicit name
  // keeps this isolated client on the same cookie and broadcast channel.
  const key = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
  const verifierKey = `${key}-code-verifier`;
  const read = () => parseCookieHeader(document.cookie).map(cookie => ({ name: cookie.name, value: cookie.value ?? '' }));
  const isVerifier = (name: string) => isChunkLike(name, verifierKey);
  const isSession = (name: string) => isChunkLike(name, key) || isChunkLike(name, `${key}-user`);
  const snapshot = () => JSON.stringify(read().filter(cookie => isSession(cookie.name) || isVerifier(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name)));
  const verifier = () => JSON.stringify(read().filter(cookie => isVerifier(cookie.name)).sort((a, b) => a.name.localeCompare(b.name)));
  let expected = snapshot();
  let owned: string | null = null;
  let deferredClears: Cookie[] = [];
  let dispatched = false;
  let validSession = false;
  let adoptedSession = false;
  let activeStorage = false;
  const write = (cookies: Cookie[]) => {
    const intended = new Map(read().filter(cookie => isSession(cookie.name) || isVerifier(cookie.name))
      .map(cookie => [cookie.name, cookie.value]));
    for (const cookie of cookies) {
      if (cookie.options.maxAge === 0) intended.delete(cookie.name);
      else intended.set(cookie.name, cookie.value);
    }
    for (const cookie of cookies) document.cookie = serializeCookieHeader(cookie.name, cookie.value, cookie.options);
    expected = snapshot();
    if (expected !== JSON.stringify([...intended].map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)))) {
      throw new Error('Signup cookies could not be persisted');
    }
  };
  const clearOwnedVerifier = () => {
    // The SDK's getAll may predate another operation. Re-read immediately at
    // the write, without an intervening await. Missing/newer cookies stay so.
    if (owned !== null && verifier() === owned) write(deferredClears);
    deferredClears = [];
  };
  const client = createBrowserClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    isSingleton: false,
    cookieOptions: { ...durableCookieOptions(isSecureOrigin(window.location.origin)), name: key },
    auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, skipAutoInitialize: true, flowType: 'pkce' },
    global: {
      fetch: async (input, init) => {
        if (!canCommitSession() || snapshot() !== expected || owned === null || verifier() !== owned) {
          throw new Error('Signup request ownership changed');
        }
        dispatched = true;
        const response = await fetch(input, init);
        if (response.ok) {
          try { validSession = sessionReceipt(await response.clone().json()); }
          catch { /* Unreadable receipts cannot authorize session persistence. */ }
        }
        return response;
      },
    },
    cookies: {
      // Supabase subscribes to INITIAL_SESSION even with initialization off.
      // Bootstrap against an empty view, then expose every cookie so valid
      // signup sessions still remove ALL previous cookie chunks.
      getAll: () => activeStorage ? read() : [],
      setAll: cookies => {
        const settingVerifier = cookies.some(cookie => isVerifier(cookie.name) && cookie.options.maxAge !== 0);
        const clears = cookies.filter(cookie => !settingVerifier && isVerifier(cookie.name) && cookie.options.maxAge === 0);
        deferredClears.push(...clears);
        const writes = cookies.filter(cookie => !clears.includes(cookie));
        if (!writes.length) return;
        const sessionWrite = writes.some(cookie => isSession(cookie.name));
        if (!activeStorage || !canCommitSession() || snapshot() !== expected
          || (sessionWrite && (!validSession || owned === null || verifier() !== owned))) {
          throw new Error('Signup storage ownership changed');
        }
        write(writes);
        if (settingVerifier) {
          const supplied = JSON.stringify(writes.filter(cookie => isVerifier(cookie.name) && cookie.options.maxAge !== 0)
            .map(({ name, value }) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)));
          if (verifier() !== supplied) throw new Error('Signup verifier could not be persisted');
          owned = supplied;
        }
        if (sessionWrite) adoptedSession = true;
      },
    },
  });
  try {
    await new Promise<void>(resolve => {
      const initial = client.auth.onAuthStateChange(event => {
        if (event === 'INITIAL_SESSION') { initial.data.subscription.unsubscribe(); resolve(); }
      });
    });
    activeStorage = true;
    const result = await client.auth.signUp(credentials);
    const status = result.error?.status;
    if ((status !== undefined && status >= 400 && status < 500 && !isRetryableAuthError(result.error))
      || (!result.error && result.data.session && adoptedSession)) clearOwnedVerifier();
    return result;
  } catch (error) {
    if (!dispatched) clearOwnedVerifier();
    throw error;
  } finally {
    await client.auth.dispose();
  }
}
