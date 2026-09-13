'use client';

import { captureBrowserSessionSnapshot, clearBrowserSessionSnapshot, type BrowserSessionSnapshot } from './browser-session-storage';
import { notifySessionStorageChanged } from './session-change';
import { revokeSessionToken, type SessionRevocation } from './revoke-session';
import { clearAllCache } from '@/lib/offline/cache';
import { createClient } from '@/lib/supabase/client';

// A readable session ID survives normal token rotation. Providers without one
// use an exact cookie comparison kept only in browser memory.
export type SignOutIntent = { kind: 'empty' } | { kind: 'session'; userId: string; sessionId: string }
  | { kind: 'snapshot'; cookies: string };
export type BrowserSignOutResult = {
  status: 'signed-out' | 'session-changed' | 'unavailable';
  revocation?: Promise<SessionRevocation>;
};

function intentFor(session: BrowserSessionSnapshot | null): SignOutIntent {
  if (!session) return { kind: 'empty' };
  return session.sessionId && session.userId ? { kind: 'session', userId: session.userId, sessionId: session.sessionId }
    : { kind: 'snapshot', cookies: JSON.stringify(session.cookies) };
}

export function captureSignOutIntent(): SignOutIntent | null {
  try { return intentFor(captureBrowserSessionSnapshot()); }
  catch { return null; }
}

export function isBrowserSignedOut(): boolean {
  try { return captureBrowserSessionSnapshot() === null; }
  catch { return false; }
}

/** No network await precedes the guarded local decision or follows it with cleanup. */
export function signOutBrowserSession(
  intent: SignOutIntent,
  options: { revoke?: boolean; revocation?: SessionRevocation } = {},
): BrowserSignOutResult {
  try {
    const current = captureBrowserSessionSnapshot();
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
    const revocation = current?.accessToken && options.revoke !== false
      ? revokeSessionToken(current.accessToken)
      : Promise.resolve<SessionRevocation>(options.revocation ?? (current ? 'unconfirmed' : 'confirmed'));
    return { status: 'signed-out', revocation };
  } catch { return { status: 'unavailable' }; }
}
