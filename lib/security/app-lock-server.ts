import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { AppLockRecord } from '@/lib/security/app-lock-store';

// App Lock hides the web UI for casual device privacy. Supabase authentication
// and RLS remain the authorization boundary for API/native clients. Credentials
// live in the service-only store; no PIN verifier is sent to the browser.
export const APP_UNLOCK_COOKIE = 'bubaly_app_unlock';
export const APP_UNLOCK_LIFETIME_MS = 12 * 60 * 60_000;
const DEV_KEY = 'bubaly-dev-app-lock-unlock';
const DOMAIN = 'bubaly-app-lock-unlock\0v2\0';
const IDENTIFIER = /^[0-9A-Za-z-]{1,64}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

function signingKey(): string | null {
  const configured = [process.env.INTERNAL_SECRET, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .find((value) => typeof value === 'string' && value.trim() !== '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    console.error('[app-lock] signing key unavailable');
    return null;
  }
  return DEV_KEY;
}

export function canSignAppUnlock(): boolean { return signingKey() !== null; }

function signature(key: string, payload: string): Buffer {
  return createHmac('sha256', key).update(DOMAIN).update(payload).digest();
}

/** Read a session id ONLY from the exact access token verified by Auth. */
export async function readAppLockSessionId(supabase: SupabaseClient<Database>, userId: string): Promise<string | null> {
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (sessionError || !token || token.length > 16_384) return null;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || data.user?.id !== userId) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return null;
    const { sub, session_id: sessionId } = claims as Record<string, unknown>;
    return sub === userId && typeof sessionId === 'string' && IDENTIFIER.test(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

/** Binds the unlock to a verified auth session and private lock revision. */
export function sealAppUnlock(userId: string, record: AppLockRecord, sessionId: string): string | null {
  const key = signingKey();
  if (!key || record.userId !== userId || !record.config?.enabled
    || ![userId, sessionId, record.revision].every((value) => IDENTIFIER.test(value))) return null;
  const expiresAt = Date.now() + APP_UNLOCK_LIFETIME_MS;
  const payload = `v2.${userId}.${sessionId}.${record.revision}.${expiresAt}`;
  return `${payload}.${signature(key, payload).toString('base64url')}`;
}

export function isAppUnlocked(userId: string, record: AppLockRecord, sessionId: string | null, value: string | undefined | null): boolean {
  if (!sessionId || record.userId !== userId || !record.config?.enabled || typeof value !== 'string' || value.length > 400) return false;
  const [version, id, session, revision, expiration, presentedMac, ...rest] = value.split('.');
  if (rest.length || version !== 'v2' || id !== userId || session !== sessionId || revision !== record.revision
    || !presentedMac || !MAC.test(presentedMac) || !/^\d{13}$/.test(expiration ?? '')) return false;
  const expiresAt = Number(expiration);
  if (expiresAt <= Date.now() || expiresAt > Date.now() + APP_UNLOCK_LIFETIME_MS) return false;
  const key = signingKey();
  if (!key) return false;
  const presented = Buffer.from(presentedMac, 'base64url');
  const expected = signature(key, [version, id, session, revision, expiration].join('.'));
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Browser-session cookie, with an independent server expiry even after session restore. */
export function appUnlockCookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
}
