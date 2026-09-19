import 'server-only';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { CallbackInput, CallbackReceipt } from './callback';
import { createPkceCookieExchange } from './recovery-cookies';
import { createRecoveryGrant, RecoveryError } from './recovery-server';
import { safeInternalRedirect } from './redirect';
import { isRetryableAuthError } from './session';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { landingPathForRole } from './landing';
import { stitchVisitorIdentity } from '@/lib/marketing/identity';
import { isPkceInitiationNonce } from './pkce-initiation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = (): CallbackReceipt => ({ status: 'unavailable', errorKey: 'authRecovery.temporarilyUnavailable' });
const rejected = (errorKey = 'authRecovery.invalidLink'): CallbackReceipt => ({ status: 'rejected', errorKey });
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function clean(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}
function checkedSession(value: unknown, origin: string): value is Session {
  const session = object(value), user = object(session.user);
  if (typeof session.access_token !== 'string' || session.access_token.length > 16_384
    || typeof session.refresh_token !== 'string' || !session.refresh_token || session.refresh_token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(session.refresh_token)
    || session.token_type !== 'bearer' || typeof session.expires_at !== 'number' || !Number.isFinite(session.expires_at) || session.expires_at <= Date.now() / 1000
    || typeof session.expires_in !== 'number' || !Number.isFinite(session.expires_in) || session.expires_in <= 0
    || typeof user.id !== 'string' || !UUID.test(user.id)) return false;
  try {
    const parts = session.access_token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
    const claims = object(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    return claims.sub === user.id && typeof claims.session_id === 'string' && UUID.test(claims.session_id)
      && claims.iss === `${origin}/auth/v1` && claims.aud === 'authenticated' && claims.role === 'authenticated'
      && typeof claims.exp === 'number' && Number.isSafeInteger(claims.exp) && claims.exp > Date.now() / 1000;
  } catch { return false; }
}
async function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await Promise.race([Promise.resolve(work), new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Callback deadline exceeded'));
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
function boundedFetch(origin: string, signal: AbortSignal): typeof fetch {
  return async (input, init = {}) => {
    const requestSignal = AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]);
    try {
      requestSignal.throwIfAborted();
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== origin || (!url.pathname.startsWith('/rest/v1/')
        && !['/auth/v1/token', '/auth/v1/user'].includes(url.pathname))) throw new Error('Unexpected callback endpoint');
      const response = await abortable(fetch(input, { ...init, redirect: 'manual', cache: 'no-store', signal: requestSignal }), requestSignal);
      if (response.status >= 300 && response.status < 400) throw new Error('Callback transport redirected');
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        if (reader) while (true) {
          const part = await abortable(reader.read(), requestSignal);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 256 * 1024) throw new Error('Callback response exceeded limit');
          chunks.push(part.value);
        }
      } finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch {
      // The installed SDK logs thrown fetch diagnostics. Give it a sanitized
      // retryable response without exposing codes, tokens or raw provider text.
      return Response.json({ message: 'Callback temporarily unavailable' }, { status: 503 });
    }
  };
}

/** Exchanges only captured PKCE evidence and returns data, never Set-Cookie. */
export async function completeCallback(input: CallbackInput): Promise<CallbackReceipt> {
  if (!input || typeof input.code !== 'string' || !input.code || input.code.length > 4096 || /[\s\x00-\x1f\x7f]/.test(input.code)
    || typeof input.next !== 'string' || input.next.length > 4096 || typeof input.verifierFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(input.verifierFingerprint) || !isPkceInitiationNonce(input.attempt)) return rejected();
  const next = safeInternalRedirect(input.next, '/home');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let exchange: Awaited<ReturnType<typeof createPkceCookieExchange>> | undefined;
  try {
    const origin = new URL(clean(process.env.NEXT_PUBLIC_SUPABASE_URL)).origin;
    const transport = boundedFetch(origin, controller.signal);
    exchange = await createPkceCookieExchange({ attempt: input.attempt, recovery: input.next === '/auth/recovery',
      verifierFingerprint: input.verifierFingerprint, fetch: transport });
    const current = exchange;
    const run = async (): Promise<CallbackReceipt> => {
      const result = await current.client.auth.exchangeCodeForSession(input.code);
      if (result.error) return isRetryableAuthError(result.error) ? unavailable() : rejected();
      if (!checkedSession(result.data.session, origin)) return rejected();
      // Near-expiry exchanges can rotate privately before receipt publication.
      const stored = await current.client.auth.getSession();
      if (stored.error) return isRetryableAuthError(stored.error) ? unavailable() : rejected();
      if (!checkedSession(stored.data.session, origin) || stored.data.session.user.id !== result.data.session.user.id
        || object(JSON.parse(Buffer.from(stored.data.session.access_token.split('.')[1], 'base64url').toString('utf8'))).session_id
          !== object(JSON.parse(Buffer.from(result.data.session.access_token.split('.')[1], 'base64url').toString('utf8'))).session_id) return rejected();
      const session = stored.data.session;
      const tokens = { access_token: session.access_token, refresh_token: session.refresh_token };
      if (input.next === '/auth/recovery') {
        const recovery = await createRecoveryGrant(tokens.access_token);
        return { status: 'exchanged', tokens, destination: '/auth/recovery', recovery };
      }
      const verified = await current.client.auth.getUser(tokens.access_token);
      if (verified.error) return isRetryableAuthError(verified.error)
        ? { status: 'exchanged', tokens, destination: next } : rejected();
      const user = verified.data.user;
      if (!user || user.id !== session.user.id) return rejected();
      const routingSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
      let isAdmin = isSuperAdminEmail(user.email);
      try {
        const admin = await abortable(current.client.rpc('is_super_admin').retry(false).abortSignal(routingSignal), routingSignal);
        isAdmin ||= !admin.error && admin.data === true;
      } catch { /* A valid sign-in survives an unavailable routing lookup. */ }
      let destination = isAdmin && next === '/home' ? '/admin' : next;
      if (next === '/home' && !isAdmin) {
        try {
          const membership = await abortable(current.client.from('family_members').select('family_id,role')
            .eq('user_id', user.id).eq('is_active', true).retry(false).abortSignal(routingSignal), routingSignal);
          if (!membership.error && Array.isArray(membership.data)) {
            if (!membership.data.length) destination = '/onboarding';
            else if (membership.data.every(member => member.role === 'guest')) destination = landingPathForRole('guest');
          }
        } catch { /* Unavailable membership is not an empty household. */ }
      }
      // Anonymous attribution is best effort. It cannot publish a visitor or
      // authentication cookie; the browser owns any later identity transition.
      let visitorReset = false;
      if (user.email && current.anonymousId && current.anonymousId.length <= 256 && clean(process.env.SUPABASE_SERVICE_ROLE_KEY)) {
        const attributionSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
        const service = createClient<Database>(origin, clean(process.env.SUPABASE_SERVICE_ROLE_KEY), {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: boundedFetch(origin, attributionSignal) },
        });
        try {
          const stitched = await abortable(stitchVisitorIdentity(service, { anonymousId: current.anonymousId, email: user.email, userId: user.id }), attributionSignal);
          visitorReset = stitched.decision === 'fork';
        }
        catch { /* Attribution does not decide authentication. */ }
        finally { await service.auth.dispose(); }
      }
      return { status: 'exchanged', tokens, destination, ...(visitorReset ? { visitorReset: true } : {}) };
    };
    return await abortable(run(), controller.signal);
  } catch (error) {
    return error instanceof RecoveryError && error.key !== 'authRecovery.temporarilyUnavailable'
      ? rejected(error.key) : unavailable();
  } finally {
    clearTimeout(timer); controller.abort(); await exchange?.dispose();
  }
}
