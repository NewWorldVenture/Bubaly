import { createBrowserClient, isChunkLike, parseCookieHeader, serializeCookieHeader, stringFromBase64URL, type CookieOptions } from '@supabase/ssr';
import { AuthRetryableFetchError, isAuthError, type AuthTokenResponsePassword, type Session, type SignInWithPasswordCredentials } from '@supabase/supabase-js';
import { durableCookieOptions, isSecureOrigin } from './session';
import { captureBrowserSessionSnapshot } from './browser-session-storage';
import { notifySessionStorageChanged } from './session-change';

type Cookie = { name: string; value: string; options: CookieOptions };
type Tokens = { access_token: string; refresh_token: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const interrupted = () => new AuthRetryableFetchError('Sign-in could not be completed. Please try again.', 0);
const unavailable = (error: unknown): never => { throw isAuthError(error) ? error : interrupted(); };

function claims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part || part.length > 64 * 1024) return null;
    const value: unknown = JSON.parse(stringFromBase64URL(part));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function validSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Partial<Session>;
  const jwt = typeof session.access_token === 'string' ? claims(session.access_token) : null;
  return typeof session.user?.id === 'string' && UUID.test(session.user.id)
    && typeof session.access_token === 'string' && !!session.access_token.trim()
    && typeof session.refresh_token === 'string' && !!session.refresh_token.trim()
    && session.token_type === 'bearer' && Number.isFinite(session.expires_in) && session.expires_in! > 0
    && Number.isFinite(session.expires_at) && session.expires_at! > Date.now() / 1000
    && jwt?.sub === session.user.id && typeof jwt.exp === 'number' && Number.isFinite(jwt.exp) && jwt.exp > Date.now() / 1000;
}

/** Ownership check only: provider verification remains the source of authority. */
export function isPasswordSessionCurrent(session: Session): boolean {
  try {
    const current = captureBrowserSessionSnapshot();
    if (!current || current.userId !== session.user.id) return false;
    const sid = claims(session.access_token)?.session_id;
    return typeof sid === 'string' && current.sessionId ? sid === current.sessionId : current.accessToken === session.access_token;
  } catch { return false; }
}

function sessionFromWrites(cookies: Cookie[], key: string): Session | null {
  const parts = cookies.filter(cookie => isChunkLike(cookie.name, key) && cookie.options.maxAge !== 0);
  if (!parts.length || parts.length > 128 || parts.reduce((size, part) => size + part.value.length, 0) > 256 * 1024) return null;
  let encoded = parts.find(cookie => cookie.name === key)?.value ?? '';
  if (encoded && parts.length !== 1) return null;
  if (!encoded) for (let index = 0; index < parts.length; index++) {
    const part = parts.find(cookie => cookie.name === `${key}.${index}`);
    if (!part?.value) return null;
    encoded += part.value;
  }
  try {
    const value: unknown = JSON.parse(encoded.startsWith('base64-') ? stringFromBase64URL(encoded.slice(7)) : encoded);
    return validSession(value) ? value : null;
  } catch { return null; }
}

/** A disposable SDK operation owns its storage from before the first await. */
async function withOwnedClient(
  run: (client: ReturnType<typeof createBrowserClient>, owns: () => boolean) => Promise<AuthTokenResponsePassword>,
  canCommitSession: () => boolean,
  canAdoptSession: (session: Session) => boolean = () => true,
): Promise<AuthTokenResponsePassword> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
  const isSession = (name: string) => isChunkLike(name, key) || isChunkLike(name, `${key}-user`);
  const isOwnership = (name: string) => isSession(name) || name === `${key}-logout-generation`;
  const read = () => parseCookieHeader(document.cookie).map(cookie => ({ name: cookie.name, value: cookie.value ?? '' }));
  const snapshot = () => JSON.stringify(read().filter(cookie => isOwnership(cookie.name)).sort((a, b) => a.name.localeCompare(b.name)));
  let expected = snapshot();
  let active = true;
  let exposed = false;
  let adopted: Session | null = null;
  const owns = () => active && canCommitSession() && snapshot() === expected;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const client = createBrowserClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    isSingleton: false,
    cookieOptions: { ...durableCookieOptions(isSecureOrigin(window.location.origin)), name: key },
    auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, skipAutoInitialize: true, flowType: 'pkce' },
    global: { fetch: (input, init) => {
      if (!exposed || !owns()) throw interrupted();
      return fetch(input, { ...init, signal: controller.signal, credentials: 'omit' });
    } },
    cookies: {
      getAll: () => exposed ? read() : [],
      setAll: cookies => {
        // Password login must not consume a pending OAuth/signup verifier.
        const writes = cookies.filter(cookie => isSession(cookie.name));
        if (!writes.length) return;
        const candidate = sessionFromWrites(writes, key);
        if (!candidate || !canAdoptSession(candidate) || !exposed || !owns()) throw interrupted();
        const intended = new Map(read().filter(cookie => isOwnership(cookie.name)).map(cookie => [cookie.name, cookie.value]));
        for (const cookie of writes) {
          if (cookie.options.maxAge === 0) intended.delete(cookie.name);
          else intended.set(cookie.name, cookie.value);
        }
        // Recheck immediately before the synchronous browser writes.
        if (!owns()) throw interrupted();
        for (const cookie of writes) document.cookie = serializeCookieHeader(cookie.name, cookie.value, cookie.options);
        expected = snapshot();
        const planned = JSON.stringify([...intended].map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)));
        if (expected !== planned || !isPasswordSessionCurrent(candidate)) throw interrupted();
        adopted = candidate;
      },
    },
  });
  try {
    const work = (async () => {
      await new Promise<void>(resolve => {
        const initial = client.auth.onAuthStateChange(event => {
          if (event === 'INITIAL_SESSION') { initial.data.subscription.unsubscribe(); resolve(); }
        });
      });
      if (!owns()) throw interrupted();
      exposed = true;
      const result = await run(client, owns);
      if (result.error) return result;
      if (!validSession(result.data.session) || !canAdoptSession(result.data.session) || !adopted || !active || !canCommitSession()
        || !isPasswordSessionCurrent(result.data.session)) throw interrupted();
      notifySessionStorageChanged();
      return result;
    })();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { active = false; controller.abort(); reject(interrupted()); }, 20_000);
    });
    return await Promise.race([work, deadline]);
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
    controller.abort();
    await client.auth.dispose();
  }
}

export function signInWithOwnedSession(credentials: SignInWithPasswordCredentials, canCommitSession: () => boolean): Promise<AuthTokenResponsePassword> {
  return withOwnedClient(client => client.auth.signInWithPassword(credentials), canCommitSession).catch(unavailable);
}

/** Capture browser ownership before the authorized server action produces tokens. */
export function signInWithOwnedSessionTokens(receiveTokens: () => Promise<Tokens>, canCommitSession: () => boolean): Promise<AuthTokenResponsePassword> {
  let owner: { userId: string; sessionId: string | null } | null = null;
  return withOwnedClient(async (client, owns) => {
    const tokens = await receiveTokens();
    if (!owns()) throw interrupted();
    const submitted = typeof tokens?.access_token === 'string' ? claims(tokens.access_token) : null;
    if (typeof submitted?.sub !== 'string' || !UUID.test(submitted.sub)) throw interrupted();
    owner = { userId: submitted.sub, sessionId: typeof submitted.session_id === 'string' ? submitted.session_id : null };
    return client.auth.setSession(tokens);
  }, canCommitSession, session => !!owner && session.user.id === owner.userId
    && (owner.sessionId === null || claims(session.access_token)?.session_id === owner.sessionId)).catch(unavailable);
}
