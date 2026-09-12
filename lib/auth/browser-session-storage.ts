import { isChunkLike, parseCookieHeader, serializeCookieHeader, stringFromBase64URL, type CookieOptions } from '@supabase/ssr';
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { durableCookieOptions, isSecureOrigin } from './session';
import { createSessionRefreshFetch } from '@/shared/auth/refresh-fetch';

type Cookie = { name: string; value: string };
type CookieWrite = Cookie & { options: CookieOptions };

/** Cookie data is only an ownership comparison, never authentication evidence. */
export type BrowserSessionSnapshot = {
  storageKey: string;
  cookies: Cookie[];
  generation: string;
  accessToken: string | null;
  userId: string | null;
  sessionId: string | null;
};

function storageKey(url = process.env.NEXT_PUBLIC_SUPABASE_URL!): string {
  return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
}
const generationKey = (key: string) => `${key}-logout-generation`;
const read = (): Cookie[] => parseCookieHeader(document.cookie).map(({ name, value }) => ({ name, value: value ?? '' }));
const isOwned = (name: string, key: string) => isChunkLike(name, key) || isChunkLike(name, `${key}-user`) || isChunkLike(name, `${key}-code-verifier`);
const owned = (cookies: Cookie[], key: string) => cookies.filter(cookie => isOwned(cookie.name, key)).sort((a, b) => a.name.localeCompare(b.name));
const generation = (cookies: Cookie[], key: string) => cookies.find(cookie => cookie.name === generationKey(key))?.value ?? '';

function payload(cookies: Cookie[], key: string): Record<string, unknown> | null {
  const sessionCookies = cookies.filter(cookie => isChunkLike(cookie.name, key));
  if (!sessionCookies.length) return null;
  if (sessionCookies.length > 128 || sessionCookies.reduce((size, cookie) => size + cookie.value.length, 0) > 256 * 1024
    || new Set(sessionCookies.map(cookie => cookie.name)).size !== sessionCookies.length) {
    throw new Error('Session cookie layout is invalid');
  }
  const whole = sessionCookies.find(cookie => cookie.name === key)?.value;
  if (whole && sessionCookies.length !== 1) throw new Error('Session cookie generations overlap');
  let encoded = whole ?? '';
  if (!whole) {
    for (let i = 0; i < sessionCookies.length; i++) {
      const part = sessionCookies.find(cookie => cookie.name === `${key}.${i}`);
      if (!part?.value) throw new Error('Session cookie chunks are incomplete');
      encoded += part.value;
    }
  }
  const value: unknown = JSON.parse(encoded.startsWith('base64-') ? stringFromBase64URL(encoded.slice(7)) : encoded);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session cookies are unreadable');
  return value as Record<string, unknown>;
}

/** Null means absent; a failed cookie read throws. Malformed bytes stay clearable. */
export function captureBrowserSessionSnapshot(): BrowserSessionSnapshot | null {
  const key = storageKey();
  const cookies = read();
  if (!cookies.some(cookie => isChunkLike(cookie.name, key))) return null;
  let session: Record<string, unknown> | null = null;
  try { session = payload(cookies, key); } catch { /* Explicit logout can clear malformed cookie bytes too. */ }
  const user = session?.user as Record<string, unknown> | undefined;
  const accessToken = typeof session?.access_token === 'string' && session.access_token ? session.access_token : null;
  const userId = typeof user?.id === 'string' && user.id ? user.id : null;
  let sessionId: string | null = null;
  try {
    const claims = JSON.parse(stringFromBase64URL(accessToken!.split('.')[1])) as Record<string, unknown>;
    if (userId && claims.sub === userId && typeof claims.session_id === 'string' && claims.session_id.length > 0
      && claims.session_id.length <= 128) sessionId = claims.session_id;
  } catch { /* Some providers do not include a readable session identifier. */ }
  return { storageKey: key, cookies: owned(cookies, key), generation: generation(cookies, key), accessToken, userId, sessionId };
}

/** Compare and clear without yielding, then verify the browser accepted it. */
export function clearBrowserSessionSnapshot(snapshot: BrowserSessionSnapshot | null): boolean {
  const key = storageKey();
  const current = read();
  if (snapshot) {
    if (snapshot.storageKey !== key || generation(current, key) !== snapshot.generation
      || JSON.stringify(owned(current, key)) !== JSON.stringify(snapshot.cookies)) return false;
  } else if (current.some(cookie => isChunkLike(cookie.name, key))) return false;
  const options = durableCookieOptions(isSecureOrigin(window.location.origin));
  // getRandomValues also works in a plain HTTP LAN shell where randomUUID is
  // unavailable. This value is a freshness marker, never a credential.
  const nextGeneration = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
  document.cookie = serializeCookieHeader(generationKey(key), nextGeneration, options);
  if (generation(read(), key) !== nextGeneration) throw new Error('Logout state could not be persisted');
  for (const cookie of snapshot?.cookies ?? []) document.cookie = serializeCookieHeader(cookie.name, '', { ...options, maxAge: 0 });
  const remaining = read();
  if (snapshot ? owned(remaining, key).length : remaining.some(cookie => isChunkLike(cookie.name, key))) {
    throw new Error('Session cookies could not be cleared');
  }
  return true;
}

/** Fence SDK refresh responses and cookie writes against explicit local logout. */
export function createBrowserSessionStorage(url: string) {
  const key = storageKey(url);
  const endpoint = new URL(`${url.replace(/\/+$/, '')}/auth/v1/token`);
  // The singleton SDK serializes renewal through its public refresh operation.
  // Keep only its last response candidate, never an accumulating token cache.
  let candidate: { accessToken: string; generation: string } | null = null;
  let deletionGeneration: string | null = null;
  const providerFetch = createSessionRefreshFetch(url);
  const interrupted = () => new AuthRetryableFetchError('Session changed while renewal was in progress.', 0);
  const retryable = () => new Response(JSON.stringify({ message: 'Session changed while renewal was in progress.' }), {
    status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  const fetchWithOwnership: typeof fetch = async (input, init) => {
    let requestUrl: URL;
    try { requestUrl = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href); }
    catch { return providerFetch(input, init); }
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const refresh = method.toUpperCase() === 'POST' && requestUrl.origin === endpoint.origin
      && requestUrl.pathname === endpoint.pathname && requestUrl.searchParams.getAll('grant_type').length === 1
      && requestUrl.searchParams.get('grant_type') === 'refresh_token';
    if (!refresh) {
      // A deliberate SDK logout can follow an earlier rejected renewal. Its
      // exact current bearer selects a fresh deletion boundary; a replacement
      // session write alone must never release the old rejection's guard.
      if (method.toUpperCase() === 'POST' && requestUrl.origin === endpoint.origin
        && requestUrl.pathname === endpoint.pathname.replace(/\/token$/, '/logout')
        && requestUrl.searchParams.get('scope') !== 'others') {
        const before = read();
        const currentToken = payload(before, key)?.access_token;
        const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
        if (typeof currentToken === 'string' && headers.get('authorization') === `Bearer ${currentToken}`) {
          deletionGeneration = generation(before, key);
        }
      }
      return providerFetch(input, init);
    }
    candidate = null;
    const before = read();
    const expectedGeneration = generation(before, key);
    if (expectedGeneration && typeof init?.body === 'string') {
      // A retry from an old SDK operation must not dispatch the retired token.
      const request = JSON.parse(init.body) as { refresh_token?: unknown };
      if (payload(before, key)?.refresh_token !== request.refresh_token) return retryable();
    }
    const response = await providerFetch(input, init);
    // A definitive failure may arrive as headers before its body finishes.
    // Finish reading a clone before the final ownership check; otherwise logout
    // during a delayed error body could reach the SDK as a rejection of B.
    if (!response.ok) await response.clone().arrayBuffer();
    if (generation(read(), key) !== expectedGeneration) {
      void response.body?.cancel().catch(() => {});
      return retryable();
    }
    // The SDK still awaits its own body/storage reads after fetch returns.
    // Retain this boundary through the eventual deletion-only cookie write.
    deletionGeneration = expectedGeneration;
    if (response.ok) {
      const session = await response.clone().json() as Record<string, unknown>;
      if (generation(read(), key) !== expectedGeneration) return retryable();
      if (typeof session.access_token === 'string') candidate = { accessToken: session.access_token, generation: expectedGeneration };
    }
    return response;
  };
  return {
    fetch: fetchWithOwnership,
    cookies: {
      getAll: read,
      setAll: (cookies: CookieWrite[]) => {
        const writes = cookies.filter(cookie => cookie.options.maxAge !== 0);
        if (!writes.length && cookies.some(cookie => isOwned(cookie.name, key)) && deletionGeneration !== null
          && generation(read(), key) !== deletionGeneration) throw interrupted();
        const session = payload(writes, key);
        const token = session?.access_token;
        if (typeof token === 'string' && candidate?.accessToken === token) {
          if (generation(read(), key) !== candidate.generation) {
            throw interrupted();
          }
        }
        for (const cookie of cookies) document.cookie = serializeCookieHeader(cookie.name, cookie.value, cookie.options);
      },
    },
  };
}
