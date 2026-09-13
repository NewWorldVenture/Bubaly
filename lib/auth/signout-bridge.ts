import 'server-only';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { readRecoveryCookieToken } from './recovery-cookies';
import { revokeSessionToken, type SessionRevocation } from './revoke-session';

export const SIGNOUT_BRIDGE_COOKIE = 'bubaly_signout_intent';
export const SIGNOUT_BRIDGE_PATH = '/auth/signout/complete';
type Owner = { kind: 'session'; userId: string; sessionId: string } | { kind: 'empty' };
export type SignOutBridge = { nonce: string; expiresAt: number; intent: Owner | null; revocation: SessionRevocation };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Captures the submitted account only; no session SDK or cookie writes. */
export async function prepareSignOutBridge(scope: 'local' | 'global'): Promise<SignOutBridge> {
  let token: string | null = null;
  let intent: Owner | null = null;
  try {
    const key = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]}-auth-token`;
    const present = (await cookies()).getAll().some(cookie => cookie.name === key || cookie.name.startsWith(`${key}.`));
    if (!present) intent = { kind: 'empty' };
    else {
      token = await readRecoveryCookieToken();
      const part = token.split('.')[1];
      if (part && part.length <= 16_384 && /^[A-Za-z0-9_-]+$/.test(part)) {
        const claims: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
        if (claims && typeof claims === 'object' && 'sub' in claims && 'session_id' in claims
          && typeof claims.sub === 'string' && UUID.test(claims.sub)
          && typeof claims.session_id === 'string' && UUID.test(claims.session_id)) {
          intent = { kind: 'session', userId: claims.sub, sessionId: claims.session_id };
        }
      }
    }
  } catch { /* Unreadable storage requires an explicit browser review. */ }
  // JWT decoding above selects an ownership comparison, never authorization.
  // Only the provider can accept the exact submitted token for revocation.
  const revocation = token ? await revokeSessionToken(token, scope) : intent?.kind === 'empty' ? 'confirmed' : 'unconfirmed';
  return { nonce: randomUUID(), expiresAt: Date.now() + 60_000, intent, revocation };
}

export function encodeSignOutBridge(value: SignOutBridge): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Only a matching short-lived POST receipt can trigger browser completion. */
export function decodeSignOutBridge(value: string | undefined, nonce: string | undefined): SignOutBridge | null {
  if (!value || value.length > 2048 || !nonce || !UUID.test(nonce) || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as SignOutBridge;
    if (!decoded || typeof decoded !== 'object' || decoded.nonce !== nonce
      || typeof decoded.expiresAt !== 'number' || decoded.expiresAt <= Date.now() || decoded.expiresAt > Date.now() + 60_000
      || !['confirmed', 'unconfirmed'].includes(decoded.revocation)) return null;
    const intent = decoded.intent;
    if (intent !== null && (!intent || typeof intent !== 'object'
      || (intent.kind !== 'empty' && (intent.kind !== 'session' || !UUID.test(intent.userId) || !UUID.test(intent.sessionId))))) return null;
    return decoded;
  } catch { return null; }
}
