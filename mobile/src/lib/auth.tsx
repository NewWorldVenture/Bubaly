import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { resolveActiveFamily, type ActiveFamily } from './family';
import { friendlyAuthError, isRetryableAuthError } from './auth-core';

export type AuthState = {
  /** Session bootstrap finished (so the splash can hide + routes can gate). */
  ready: boolean;
  /**
   * A session IS stored on this device, but it could not be verified yet —
   * a cold start with no network, or Supabase briefly unreachable. Distinct
   * from signed-out: the refresh token is still in the Keychain and the
   * auto-refresh ticker retries every 30s, so the app should wait rather than
   * ask a signed-in person to sign in again.
   */
  restoring: boolean;
  session: Session | null;
  accessToken: string | null;
  family: ActiveFamily | null;
  familyLoading: boolean;
  familyError: string | null;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshFamily: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [family, setFamily] = useState<ActiveFamily | null>(null);
  const [familyLoading, setFamilyLoading] = useState(false);
  const [familyError, setFamilyError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!alive) return;
        setSession(data.session);
        // No session AND a transient error means one is stored but could not be
        // refreshed right now — getSession() answers `null, null` when the
        // device is genuinely signed out. Hold in `restoring` so a plane-mode
        // launch doesn't hand a signed-in user the sign-in screen.
        setRestoring(!data.session && isRetryableAuthError(error));
      })
      .catch((error: unknown) => {
        if (alive) setRestoring(isRetryableAuthError(error));
      })
      .finally(() => { if (alive) setReady(true); });
    // The ticker recovers the session on its own once the network is back; this
    // is where that arrives, and it is also the only thing that ends `restoring`.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (next) setRestoring(false);
    });
    return () => { alive = false; listener.subscription.unsubscribe(); };
  }, []);

  const userId = session?.user.id ?? null;

  const loadFamily = useCallback(async (id: string) => {
    setFamilyLoading(true);
    try {
      setFamily(await resolveActiveFamily(supabase, id));
      setFamilyError(null);
    } catch (e) {
      setFamily(null);
      setFamilyError(e instanceof Error ? e.message : 'Could not load your family.');
    } finally {
      setFamilyLoading(false);
    }
  }, []);

  useEffect(() => {
    if (userId) void loadFamily(userId);
    else { setFamily(null); setFamilyError(null); }
  }, [userId, loadFamily]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    return { error: error ? friendlyAuthError(error.message) : null };
  }, []);

  const signOut = useCallback(async () => {
    // Local scope: signing out of the phone must not revoke the session on the
    // web or a tablet. Matches app/auth/signout/route.ts.
    setRestoring(false);
    await supabase.auth.signOut({ scope: 'local' });
  }, []);

  const refreshFamily = useCallback(async () => {
    if (userId) await loadFamily(userId);
  }, [userId, loadFamily]);

  const value = useMemo<AuthState>(() => ({
    ready, restoring, session, accessToken: session?.access_token ?? null, family, familyLoading, familyError, signIn, signOut, refreshFamily,
  }), [ready, restoring, session, family, familyLoading, familyError, signIn, signOut, refreshFamily]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
