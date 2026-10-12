'use client';

import { isChunkLike } from '@supabase/ssr';
import { captureBrowserSessionSnapshot, clearBrowserSessionSnapshot, type BrowserSessionSnapshot } from './browser-session-storage';
import { notifySessionStorageChanged } from './session-change';
import { revokeSessionToken, type SessionRevocation } from './revoke-session';
import { clearAllCache } from '@/lib/offline/cache';
import { detachPushDevice } from '@/lib/push/device-registration';
import { createClient } from '@/lib/supabase/client';

// A readable session ID survives normal token rotation. Providers without one
// use an exact cookie comparison kept only in browser memory.
export type SignOutIntent = { kind: 'empty' } | { kind: 'session'; userId: string; sessionId: string; pendingVerifier?: string }
  | { kind: 'snapshot'; cookies: string };
export type BrowserSignOutResult = {
  status: 'signed-out' | 'session-changed' | 'unavailable';
  revocation?: Promise<SessionRevocation>;
};

function intentFor(session: BrowserSessionSnapshot | null): SignOutIntent {
  if (!session) return { kind: 'empty' };
  // Session identity survives token rotation, but a newly started signup or
  // OAuth handoff belongs to a newer decision than the captured logout.
  const pending = session.cookies.filter(cookie => isChunkLike(cookie.name, `${session.storageKey}-code-verifier`)
    || isChunkLike(cookie.name, `${session.storageKey}-pkce-initiation`))
    .sort((a, b) => a.name.localeCompare(b.name));
  return session.sessionId && session.userId ? { kind: 'session', userId: session.userId, sessionId: session.sessionId,
    ...(pending.length ? { pendingVerifier: JSON.stringify(pending) } : {}) }
    : { kind: 'snapshot', cookies: JSON.stringify(session.cookies) };
}

export function captureSignOutIntent(): SignOutIntent | null {
  try { return intentFor(captureBrowserSessionSnapshot(true)); }
  catch { return null; }
}

export function isBrowserSignedOut(): boolean {
  try { return captureBrowserSessionSnapshot(true) === null; }
  catch { return false; }
}

/** No network await precedes the guarded local decision or follows it with cleanup. */
export function signOutBrowserSession(
  intent: SignOutIntent,
  options: { revoke?: boolean; revocation?: SessionRevocation } = {},
): BrowserSignOutResult {
  try {
    const current = captureBrowserSessionSnapshot(true);
    if (current && JSON.stringify(intentFor(current)) !== JSON.stringify(intent)) return { status: 'session-changed' };
    if (!clearBrowserSessionSnapshot(current)) return { status: 'session-changed' };
    if (!isBrowserSignedOut()) return { status: 'unavailable' };
    clearAllCache();
    // A nonempty public key updates Realtime synchronously inside its SDK path.
    // No delayed getSession resolver may replace a newer login's token.
    try {
      const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (key) void createClient().realtime.setAuth(key).catch(() => {});
    } catch { /* Cookie deletion and cache retirement already succeeded. */ }
    notifySessionStorageChanged();
    // This device's push registration leaves with the account: otherwise the
    // next person on a shared device receives this account's notifications.
    // Revocation waits for it, because a revoked token cannot remove the row.
    const accessToken = current?.accessToken;
    const revocation = accessToken && options.revoke !== false
      ? (detachPushDevice(accessToken)?.then(() => revokeSessionToken(accessToken)) ?? revokeSessionToken(accessToken))
      : Promise.resolve<SessionRevocation>(options.revocation ?? (current ? 'unconfirmed' : 'confirmed'));
    return { status: 'signed-out', revocation };
  } catch { return { status: 'unavailable' }; }
}
