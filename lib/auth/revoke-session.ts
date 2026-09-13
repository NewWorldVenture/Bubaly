import { AuthAdminApi } from '@supabase/supabase-js';

export type SessionRevocation = 'confirmed' | 'unconfirmed';

/** Revoke this token without constructing a client that can write session storage. */
export async function revokeSessionToken(accessToken: string, scope: 'local' | 'global' = 'local'): Promise<SessionRevocation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!accessToken || !key || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return 'unconfirmed';
    const admin = new AuthAdminApi({
      url: `${url.origin}/auth/v1`,
      headers: { apikey: key },
      fetch: (input, init) => fetch(input, { ...init, signal: controller.signal, credentials: 'omit', keepalive: true }),
    });
    const deadline = new Promise<SessionRevocation>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve('unconfirmed'); }, 8_000);
    });
    const request = admin.signOut(accessToken, scope)
      .then(({ error }): SessionRevocation => error ? 'unconfirmed' : 'confirmed')
      .catch((): SessionRevocation => 'unconfirmed');
    return await Promise.race([request, deadline]);
  } catch { return 'unconfirmed'; }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
