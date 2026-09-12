'use client';

import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { clearAllCache } from '@/lib/offline/cache';

export type CacheSessionIdentity = { userId: string; sessionId: string };
export type CacheSessionSnapshot = {
  status: 'restoring' | 'ready' | 'unavailable' | 'signed-out';
  identity: CacheSessionIdentity | null;
  observedUserId: string | null;
  revision: number;
  error: string | null;
};

const INITIAL: CacheSessionSnapshot = { status: 'restoring', identity: null, observedUserId: null, revision: 0, error: null };
const UNAVAILABLE = 'Your session is temporarily unavailable. Please try again.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let snapshot = INITIAL;
let connection: { client: ReturnType<typeof createClient>; unsubscribe: () => void; revision: number; read: number; initialSuperseded: boolean } | null = null;
let pending: Promise<void> | null = null;
let pendingStartedAt = 0;
const listeners = new Set<() => void>();
const authListeners = new Set<(event: AuthChangeEvent, userId: string | null) => void>();

/** Decode only a cache discriminator. This does not validate authorization. */
export function cacheSessionIdentity(session: Pick<Session, 'access_token' | 'user'> | null): CacheSessionIdentity | null {
  const userId = session?.user?.id;
  if (!session || typeof userId !== 'string' || !UUID.test(userId) || typeof session.access_token !== 'string') return null;
  try {
    const parts = session.access_token.split('.');
    if (parts.length !== 3 || !parts[1] || parts[1].length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
    const { sub, session_id: sessionId } = claims as Record<string, unknown>;
    if (typeof sub !== 'string' || sub !== userId || !UUID.test(sub)
      || typeof sessionId !== 'string' || !UUID.test(sessionId)) return null;
    return { userId: sub, sessionId };
  } catch { return null; }
}

function sameIdentity(a: CacheSessionIdentity | null, b: CacheSessionIdentity | null): boolean {
  return a?.userId === b?.userId && a?.sessionId === b?.sessionId;
}

function publish(status: CacheSessionSnapshot['status'], identity: CacheSessionIdentity | null, error: string | null, observedUserId = identity?.userId ?? null) {
  const changed = status !== snapshot.status || !sameIdentity(identity, snapshot.identity) || observedUserId !== snapshot.observedUserId;
  if (!changed && error === snapshot.error) return;
  snapshot = { status, identity, observedUserId, error, revision: snapshot.revision + (changed ? 1 : 0) };
  for (const listener of listeners) listener();
}

function acceptSession(session: Session | null, definitiveNull: boolean) {
  const identity = cacheSessionIdentity(session);
  if (session && !identity) {
    if (snapshot.identity) clearAllCache();
    publish('unavailable', null, UNAVAILABLE, typeof session.user?.id === 'string' ? session.user.id : null);
  } else if (identity) {
    if (snapshot.identity && !sameIdentity(identity, snapshot.identity)) clearAllCache();
    publish('ready', identity, null);
  } else if (definitiveNull) {
    clearAllCache();
    publish('signed-out', null, null);
  }
}

function unavailable() {
  // A failed refresh does not retire an established, unchanged session.
  publish(snapshot.identity ? 'ready' : 'unavailable', snapshot.identity, UNAVAILABLE, snapshot.observedUserId);
}

function ensureConnection() {
  if (connection || typeof window === 'undefined') return;
  try {
    const client = createClient();
    const current = { client, unsubscribe: () => {}, revision: 0, read: 0, initialSuperseded: false };
    connection = current;
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (connection !== current) return;
      // SDK INITIAL_SESSION can finish an old storage read after SIGNED_IN or
      // a newer explicit read. It cannot revive that older owner/session.
      if (event === 'INITIAL_SESSION' && current.initialSuperseded) return;
      if (event !== 'INITIAL_SESSION' || session !== null) current.initialSuperseded = true;
      if (event !== 'INITIAL_SESSION' || session !== null) current.revision += 1;
      // An INITIAL_SESSION null can follow a transient bootstrap error. Only
      // an explicit sign-out or successful stored-session read proves null.
      acceptSession(session, event === 'SIGNED_OUT');
      for (const listener of authListeners) listener(event, session?.user?.id ?? null);
    });
    current.unsubscribe = () => subscription.unsubscribe();
    void refreshCacheSession();
  } catch {
    connection = null;
    unavailable();
  }
}

function disconnectIfUnused() {
  if (listeners.size || authListeners.size) return;
  const old = connection;
  connection = null;
  pending = null;
  old?.unsubscribe();
  // A remount must check current cookies again before hydrating prior rows.
  snapshot = { ...INITIAL, revision: snapshot.revision + 1 };
}

export function getCacheSessionSnapshot(): CacheSessionSnapshot {
  return typeof window === 'undefined' ? INITIAL : snapshot;
}
export function getServerCacheSessionSnapshot(): CacheSessionSnapshot { return INITIAL; }

export function subscribeCacheSession(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  listeners.add(listener);
  ensureConnection();
  return () => { listeners.delete(listener); disconnectIfUnused(); };
}

export function subscribeCacheAuthEvents(listener: (event: AuthChangeEvent, userId: string | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  authListeners.add(listener);
  ensureConnection();
  return () => { authListeners.delete(listener); disconnectIfUnused(); };
}

/** Coalesced SDK read; auth events and connection disposal supersede its result. */
export function refreshCacheSession(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (!connection) {
    ensureConnection();
    return pending ?? Promise.resolve();
  }
  // Coalesce a burst, but let a later lifecycle event supersede a hung read.
  if (pending && Date.now() - pendingStartedAt < 30_000) return pending;
  const current = connection;
  const revision = current.revision;
  const read = ++current.read;
  pendingStartedAt = Date.now();
  const work = Promise.resolve().then(() => current.client.auth.getSession()).then(({ data, error }) => {
    if (connection !== current || revision !== current.revision || read !== current.read) return;
    current.initialSuperseded = true;
    if (error) unavailable();
    else acceptSession(data.session, true);
  }).catch(() => {
    if (connection === current && revision === current.revision && read === current.read) {
      current.initialSuperseded = true;
      unavailable();
    }
  }).finally(() => { if (pending === work) pending = null; });
  pending = work;
  return work;
}
