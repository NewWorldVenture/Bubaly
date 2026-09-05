import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { resolveActiveFamily, type ActiveFamily } from './family';
import { friendlyAuthError } from './auth-core';

export type AuthState = {
  /** Session bootstrap finished (so the splash can hide + routes can gate). */
  ready: boolean;
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
  const [session, setSession] = useState<Session | null>(null);
  const [family, setFamily] = useState<ActiveFamily | null>(null);
  const [familyLoading, setFamilyLoading] = useState(false);
  const [familyError, setFamilyError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession()
      .then(({ data }) => { if (alive) setSession(data.session); })
      .catch(() => { /* treated as signed out */ })
      .finally(() => { if (alive) setReady(true); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
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
    await supabase.auth.signOut();
  }, []);

  const refreshFamily = useCallback(async () => {
    if (userId) await loadFamily(userId);
  }, [userId, loadFamily]);

  const value = useMemo<AuthState>(() => ({
    ready, session, accessToken: session?.access_token ?? null, family, familyLoading, familyError, signIn, signOut, refreshFamily,
  }), [ready, session, family, familyLoading, familyError, signIn, signOut, refreshFamily]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
