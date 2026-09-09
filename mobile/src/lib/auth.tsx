import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { resolveActiveFamily, type ActiveFamily } from './family';
import { friendlyAuthError } from './auth-core';
import { connectAuthSession } from './auth-session';
import { FamilySession } from './family-session';
import type { FreshFamily } from './voice-session';
import { deviceLocale, mobileTranslate } from './mobile-i18n';

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
  freshFamily: () => Promise<FreshFamily>;
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
    const connection = connectAuthSession<Session>({
      read: async () => { const { data, error } = await supabase.auth.getSession(); return { session: data.session, error }; },
      subscribe: (listener) => {
        const { data } = supabase.auth.onAuthStateChange(listener);
        return () => data.subscription.unsubscribe();
      },
      session: setSession, restoring: setRestoring, ready: setReady,
    });
    return connection.dispose;
  }, []);

  const userId = session?.user.id ?? null;
  const userRef = useRef(userId); userRef.current = userId;
  const loader = useRef<FamilySession | null>(null);
  if (!loader.current) loader.current = new FamilySession({ user: () => userRef.current,
    read: (id) => resolveActiveFamily(supabase, id), loading: setFamilyLoading,
    result: (next, failed) => { setFamily(next); setFamilyError(failed ? mobileTranslate(deviceLocale(), 'mobileAssistant.familyUnavailable') : null); } });
  const freshFamily = useCallback(() => loader.current!.refresh(), []);

  useEffect(() => {
    loader.current!.invalidate(); setFamily(null); setFamilyError(null); setFamilyLoading(false);
    if (userId) void freshFamily();
    return () => loader.current!.invalidate();
  }, [userId, freshFamily]);

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
    await freshFamily();
  }, [freshFamily]);

  const value = useMemo<AuthState>(() => ({
    ready, restoring, session, accessToken: session?.access_token ?? null, family, familyLoading, familyError, signIn, signOut, refreshFamily, freshFamily,
  }), [ready, restoring, session, family, familyLoading, familyError, signIn, signOut, refreshFamily, freshFamily]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
