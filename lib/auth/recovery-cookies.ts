import 'server-only';
import { combineChunks, createServerClient, isChunkLike, stringFromBase64URL, stringToBase64URL } from '@supabase/ssr';
import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { durableCookieOptions, isSecureOrigin } from '@/lib/auth/session';
import { RecoveryError } from '@/lib/auth/recovery-server';
import type { Database } from '@/lib/database.types';
import { callbackAdmissionMaterial, parseCallbackAdmissionCookies } from './callback-witness';
import { isPkceInitiationNonce, readPkceInitiationSlot } from './pkce-initiation';

const MAX_COOKIE_LENGTH = 65_536;
const MAX_CHUNKS = 24;
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

/** Compare the original initiation owner and captured verifier before constructing an isolated SDK. */
export async function createPkceCookieExchange(options: { attempt: string; recovery: boolean; verifierFingerprint: string; fetch: typeof fetch }) {
  const { origin, key } = configuration();
  const anon = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (!anon) throw new RecoveryError('authRecovery.setupRequired');
  const incoming = parseCallbackAdmissionCookies((await headers()).get('cookie'));
  if (!incoming || !isPkceInitiationNonce(options.attempt) || typeof options.recovery !== 'boolean') invalid();
  const record = readPkceInitiationSlot(incoming, key)?.record;
  const material = callbackAdmissionMaterial(incoming, key);
  if (!record || !material || record.nonce !== options.attempt
    || (options.recovery ? record.kind !== 'recovery' : record.kind === 'recovery')) invalid();
  for (const field of ['project', 'generation', 'verifier', 'session'] as const) {
    if (!timingSafeEqual(createHash('sha256').update(material[field]).digest(), Buffer.from(record[field], 'hex'))) invalid();
  }
  const verifierKey = `${key}-code-verifier`;
  const selected = incoming.filter(cookie => isChunkLike(cookie.name, verifierKey)).sort((a, b) => a.name.localeCompare(b.name));
  if (!selected.length || selected.length > 128 || selected.reduce((size, cookie) => size + cookie.value.length, 0) > 256 * 1024
    || new Set(selected.map(cookie => cookie.name)).size !== selected.length || selected.some(cookie => !cookie.value)
    || (selected.some(cookie => cookie.name === verifierKey) ? selected.length !== 1
      : selected.some((_cookie, index) => !selected.some(cookie => cookie.name === `${verifierKey}.${index}`)))) invalid();
  if (typeof options.verifierFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(options.verifierFingerprint)) invalid();
  const fingerprint = createHash('sha256').update(JSON.stringify(selected)).digest();
  if (!timingSafeEqual(fingerprint, Buffer.from(options.verifierFingerprint, 'hex'))) invalid();
  // Ambient session values never enter this operation. Every SDK write remains
  // private; there is deliberately no response-cookie publication method.
  const staged = new Map(selected.map(cookie => [cookie.name, cookie.value]));
  const client = createServerClient<Database>(origin, anon, {
    cookieOptions: durableCookieOptions(isSecureOrigin(process.env.NEXT_PUBLIC_SITE_URL)),
    global: { fetch: options.fetch },
    cookies: {
      getAll: () => [...staged].map(([name, value]) => ({ name, value })),
      setAll: changes => {
        for (const change of changes) {
          if (change.options.maxAge === 0) staged.delete(change.name);
          else staged.set(change.name, change.value);
        }
      },
    },
  });
  return {
    client,
    origin,
    anonymousId: incoming.find(cookie => cookie.name === 'bubaly_vid')?.value ?? null,
    dispose: () => client.auth.dispose(),
  };
}
