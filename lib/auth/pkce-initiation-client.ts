import { createBrowserClient, isChunkLike, serializeCookieHeader, type CookieOptions } from '@supabase/ssr';
import { AuthRetryableFetchError, type AuthResponse, type SignUpWithPasswordCredentials } from '@supabase/supabase-js';
import { callbackAdmissionMaterial, parseCallbackAdmissionCookies, type CallbackAdmissionMaterial } from './callback-witness';
import { encodePkceInitiationRecord, pkceInitiationCookieName, readPkceInitiationSlot, type PkceInitiationKind } from './pkce-initiation';
import { durableCookieOptions, isRetryableAuthError, isSecureOrigin } from './session';
import { safeInternalRedirect } from './redirect';

type Cookie = { name: string; value: string };
type Write = Cookie & { options: CookieOptions };
const DEADLINE_MS = 35_000;
const interrupted = () => {
  const error = new AuthRetryableFetchError('Sign-in changed before it could be completed. Please try again.', 0);
  error.name = 'AuthSessionInterruptedError';
  return error;
};
const unavailable = () => new AuthRetryableFetchError('Sign-in could not be completed. Please try again.', 0);
const canonical = (cookies: Cookie[]) => JSON.stringify([...cookies].sort((a, b) => a.name.localeCompare(b.name)));
const isSession = (name: string, key: string) => isChunkLike(name, key) || isChunkLike(name, `${key}-user`);
const apply = (cookies: Cookie[], writes: Write[]): Cookie[] => {
  const result = new Map(cookies.map(cookie => [cookie.name, cookie.value]));
  for (const write of writes) {
    if (write.options.maxAge === 0) result.delete(write.name);
    else result.set(write.name, write.value);
  }
  return [...result].map(([name, value]) => ({ name, value }));
};

/** Capture before the SDK's first await; a callback never invents this owner. */
function begin(kind: PkceInitiationKind, canCommit: () => boolean) {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  const key = `sb-${url.hostname.split('.')[0]}-auth-token`;
  const recordKey = pkceInitiationCookieName(key);
  const isVerifier = (name: string) => isChunkLike(name, `${key}-code-verifier`);
  const options = durableCookieOptions(isSecureOrigin(window.location.origin));
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
  const opened = Date.now();
  let retired = false, published = false;
  function read() {
    const cookies = parseCallbackAdmissionCookies(document.cookie);
    if (!cookies) throw interrupted();
    const material = callbackAdmissionMaterial(cookies, key), slot = readPkceInitiationSlot(cookies, key);
    if (!material || !slot) throw interrupted();
    return { cookies, material, slot };
  }
  const original = read();
  let expected = original.material, expectedRaw = original.slot.raw;
  function owns(): boolean {
    try {
      if (retired || Date.now() - opened > DEADLINE_MS || !canCommit()) return false;
      const current = read();
      return current.slot.raw === expectedRaw && (Object.keys(expected) as Array<keyof CallbackAdmissionMaterial>)
        .every(field => current.material[field] === expected[field]);
    } catch { return false; }
  }
  function assert() {
    if (!retired && Date.now() - opened > DEADLINE_MS) throw unavailable();
    if (!owns()) throw interrupted();
  }
  function commit(writes: Write[], next: CallbackAdmissionMaterial, raw: string | null, session?: string) {
    assert();
    // The final comparison and writes do not yield. Browser cookies are not a
    // cross-tab transaction; failed readback retires rather than restoring bytes.
    for (const write of writes) document.cookie = serializeCookieHeader(write.name, write.value, write.options);
    expected = next; expectedRaw = raw;
    if (!owns() || (session !== undefined && canonical(read().cookies.filter(cookie => isSession(cookie.name, key))) !== session)) {
      retired = true; throw unavailable();
    }
  }
  // Claim the single pending slot synchronously, before SDK initialization or
  // verifier hashing can yield. Readers deliberately reject this unfinished
  // marker; only publication of the complete record permits an exchange.
  // A later begin therefore retires an older task even if neither has a verifier.
  const reservation = `pending-v1-${nonce}`;
  commit([{ name: recordKey, value: reservation, options }], expected, reservation);
  return {
    url: url.origin, key, nonce, owns, assert,
    read: () => { assert(); return read().cookies; },
    published: () => published,
    retire: () => { retired = true; },
    callback(next: string) {
      const target = new URL('/auth/callback', window.location.origin);
      target.search = new URLSearchParams({ next, attempt: nonce }).toString();
      return target.href;
    },
    async publish(writes: Write[]) {
      assert();
      if (published || !writes.length || writes.some(write => !isVerifier(write.name))) throw interrupted();
      const intended = apply(read().cookies, writes);
      const next = callbackAdmissionMaterial(intended, key);
      if (!next || next.verifier === '[]' || next.project !== expected.project
        || next.generation !== expected.generation || next.session !== expected.session) throw interrupted();
      const fields = ['project', 'generation', 'verifier', 'session'] as const;
      const values = await Promise.all(fields.map(async field => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(next[field]));
        return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      }));
      assert();
      const raw = encodePkceInitiationRecord({ v: 1, nonce, kind, project: values[0], generation: values[1], verifier: values[2], session: values[3] });
      commit([...writes, { name: recordKey, value: raw, options }], next, raw);
      published = true;
    },
    adopt(writes: Write[]) {
      assert();
      if (kind !== 'signup' || !published || !writes.length || writes.some(write => !isSession(write.name, key))) throw interrupted();
      const intended = apply(read().cookies, writes), next = callbackAdmissionMaterial(intended, key);
      if (!next || next.verifier !== expected.verifier || next.generation !== expected.generation) throw interrupted();
      commit(writes, next, expectedRaw, canonical(intended.filter(cookie => isSession(cookie.name, key))));
    },
    consume() {
      assert();
      if (!published) return;
      const clears = read().cookies.filter(cookie => isVerifier(cookie.name) || cookie.name === recordKey)
        .map(cookie => ({ ...cookie, value: '', options: { ...options, maxAge: 0 } }));
      const next = callbackAdmissionMaterial(apply(read().cookies, clears), key);
      if (!next || next.verifier !== '[]') throw interrupted();
      commit(clears, next, null);
      published = false;
    },
  };
}

function sessionReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>, user = session.user as Record<string, unknown> | undefined;
  return !!user && typeof user.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.id)
    && typeof session.access_token === 'string' && !!session.access_token.trim()
    && typeof session.refresh_token === 'string' && !!session.refresh_token.trim()
    && typeof session.token_type === 'string' && !!session.token_type.trim()
    && typeof session.expires_in === 'number' && Number.isFinite(session.expires_in) && session.expires_in > 0;
}

async function run<T>(kind: PkceInitiationKind, canCommit: () => boolean,
  operation: (client: ReturnType<typeof createBrowserClient>, owner: ReturnType<typeof begin>) => Promise<T>,
  onDispatch?: () => void): Promise<T> {
  const owner = begin(kind, canCommit), controller = new AbortController();
  let active = false, dispatched = false, validSession = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const client = createBrowserClient(owner.url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    isSingleton: false,
    cookieOptions: { ...durableCookieOptions(isSecureOrigin(window.location.origin)), name: owner.key },
    auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, skipAutoInitialize: true, flowType: 'pkce' },
    global: { fetch: async (input, init) => {
      owner.assert();
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (!active || !owner.published() || target.origin !== owner.url
        || target.pathname !== `/auth/v1/${kind === 'signup' ? 'signup' : 'recover'}` || kind === 'oauth') throw interrupted();
      dispatched = true; onDispatch?.();
      const response = await fetch(input, { ...init, credentials: 'omit', redirect: 'error',
        signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) });
      if (kind === 'signup' && response.ok) {
        try { validSession = sessionReceipt(await response.clone().json()); }
        catch { /* An unreadable receipt cannot authorize immediate adoption. */ }
      }
      return response;
    } },
    cookies: {
      getAll: () => active ? owner.read() : [],
      setAll: async writes => {
        if (!active) { if (writes.length) throw interrupted(); return; }
        const verifier = writes.filter(write => isChunkLike(write.name, `${owner.key}-code-verifier`));
        const setting = verifier.some(write => write.options.maxAge !== 0);
        if (setting) await owner.publish(verifier);
        // Deletion on an uncertain provider response must retain the pending
        // handoff. Only an explicit rejected response or adoption consumes it.
        const sessions = writes.filter(write => isSession(write.name, owner.key));
        if (sessions.length) {
          if (!validSession || kind !== 'signup') throw interrupted();
          owner.adopt(sessions);
        }
        if (writes.some(write => !isSession(write.name, owner.key) && !isChunkLike(write.name, `${owner.key}-code-verifier`))) throw interrupted();
      },
    },
  });
  let unsubscribe = () => {};
  try {
    const work = async () => {
      await new Promise<void>(resolve => {
        const initial = client.auth.onAuthStateChange(event => {
          if (event === 'INITIAL_SESSION') { initial.data.subscription.unsubscribe(); resolve(); }
        });
        unsubscribe = () => initial.data.subscription.unsubscribe();
      });
      owner.assert(); active = true;
      return operation(client, owner);
    };
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { owner.retire(); controller.abort(); reject(unavailable()); }, DEADLINE_MS);
    })]);
  } catch (error) {
    if (!dispatched && owner.owns()) owner.consume();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    owner.retire(); controller.abort(); unsubscribe(); await client.auth.dispose();
  }
}

/** One email signup keeps its original proof through confirmation or adoption. */
export function signUpWithInitiation(credentials: SignUpWithPasswordCredentials, canCommit: () => boolean): Promise<AuthResponse> {
  return run('signup', canCommit, async (client, owner) => {
    if (!('email' in credentials)) throw interrupted();
    const target = new URL(credentials.options?.emailRedirectTo ?? owner.callback('/onboarding'), window.location.origin);
    if (target.origin !== window.location.origin || target.pathname !== '/auth/callback') throw interrupted();
    target.searchParams.set('attempt', owner.nonce);
    const result = await client.auth.signUp({ ...credentials, options: { ...credentials.options, emailRedirectTo: target.href } });
    owner.assert();
    const status = result.error?.status;
    if (owner.owns() && ((status !== undefined && status >= 400 && status < 500 && !isRetryableAuthError(result.error))
      || (!result.error && result.data.session))) owner.consume();
    return result;
  });
}

/** The provider URL is navigated only while the original browser decision owns it. */
export async function signInWithOwnedOAuth(next: string | undefined, canCommit: () => boolean): Promise<void> {
  await run('oauth', canCommit, async (client, owner) => {
    const result = await client.auth.signInWithOAuth({ provider: 'google', options: {
      redirectTo: owner.callback(safeInternalRedirect(next, '/home')), skipBrowserRedirect: true,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    } });
    if (result.error) throw result.error;
    owner.assert();
    const target = new URL(result.data.url ?? '');
    if (!owner.published() || target.origin !== owner.url || target.pathname !== '/auth/v1/authorize') throw interrupted();
    window.location.assign(target.href);
  });
}

export function sendOwnedRecoveryEmail(email: string, canCommit: () => boolean, onDispatch?: () => void) {
  return run('recovery', canCommit, async (client, owner) => {
    const result = await client.auth.resetPasswordForEmail(email, { redirectTo: owner.callback('/auth/recovery') });
    owner.assert();
    const status = result.error?.status;
    if (owner.owns() && status !== undefined && status >= 400 && status < 500 && !isRetryableAuthError(result.error)) owner.consume();
    return result;
  }, onDispatch);
}
