'use client';

import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { clearAllCache } from '@/lib/offline/cache';
import { getSessionStorageChangeRevision, notifySessionStorageChanged, subscribeSessionStorageChanges } from '@/lib/auth/session-change';
import { captureBrowserSessionSnapshot } from '@/lib/auth/browser-session-storage';

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
let connection: { client: ReturnType<typeof createClient>; unsubscribe: () => void; revision: number; read: number; storageRevision: number; initialSuperseded: boolean; reconcilingEvent: boolean } | null = null;
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
  publish(snapshot.identity && snapshot.status === 'ready' ? 'ready' : 'unavailable', snapshot.identity, UNAVAILABLE, snapshot.observedUserId);
}

function reconcileRealtime(client: ReturnType<typeof createClient>, session: Session | null) {
  if (!client.realtime) return;
  try {
    const saved = captureBrowserSessionSnapshot();
    if (session ? saved?.accessToken !== session.access_token : saved !== null) return;
    const token = session?.access_token ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!token) return;
    // A peer signal is not identity authority. Check the exact current token
    // (or cookie absence) immediately before updating the connection.
    // An explicit nonempty token updates the installed Realtime client without
    // an async session resolver that could overwrite a newer sign-in.
    void client.realtime.setAuth(token).catch(() => { /* A later lifecycle read retries. */ });
  } catch { /* A failed cookie read cannot prove that a session ended. */ }
}

function ensureConnection() {
  if (connection || typeof window === 'undefined') return;
  try {
    const client = createClient();
    const current = { client, unsubscribe: () => {}, revision: 0, read: 0, storageRevision: getSessionStorageChangeRevision(), initialSuperseded: false, reconcilingEvent: false };
    connection = current;
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (connection !== current) return;
      // SDK INITIAL_SESSION can finish an old storage read after SIGNED_IN or
      // a newer explicit read. It cannot revive that older owner/session.
      if (event === 'INITIAL_SESSION' && current.initialSuperseded) return;
      if (event !== 'INITIAL_SESSION' || session !== null) current.initialSuperseded = true;
      if (event !== 'INITIAL_SESSION' || session !== null) current.revision += 1;
      if (event === 'SIGNED_OUT') {
        let absent = false;
        try { absent = captureBrowserSessionSnapshot() === null; }
        catch { /* A denied cookie read cannot confirm removal. */ }
        if (!absent) {
          // A stale SDK failure may emit SIGNED_OUT even when its guarded
          // adapter did not remove B's cookies. Do not forward that event.
          // One queued read per outstanding reconciliation avoids recursion
          // when an SDK callback runs while its session lock is still held.
          if (!current.reconcilingEvent) {
            current.reconcilingEvent = true;
            void Promise.resolve().then(() => {
              if (connection !== current) return;
              notifySessionStorageChanged({ broadcast: false });
              return refreshCacheSession();
            }).catch(() => { /* Lifecycle recovery remains available if a reader fails. */ })
              .finally(() => { current.reconcilingEvent = false; });
          }
          return;
        }
      }
      // An INITIAL_SESSION null can follow a transient bootstrap error. Only
      // an explicit sign-out or successful stored-session read proves null.
      acceptSession(session, event === 'SIGNED_OUT');
      for (const listener of authListeners) listener(event, session?.user?.id ?? null);
    });
    const stopStorageChanges = subscribeSessionStorageChanges(() => { void refreshCacheSession(); });
    current.unsubscribe = () => { subscription.unsubscribe(); stopStorageChanges(); };
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
export function refreshCacheSession(options: { force?: boolean } = {}): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (!connection) {
    ensureConnection();
    return pending ?? Promise.resolve();
  }
  const current = connection;
  const storageRevision = getSessionStorageChangeRevision();
  const storageChanged = storageRevision !== current.storageRevision;
  // Ordinary lifecycle bursts share a read. Explicit cookie changes must
  // invalidate even a just-started read, including its INITIAL_SESSION event.
  if (pending && !options.force && !storageChanged && Date.now() - pendingStartedAt < 30_000) return pending;
  if (options.force || storageChanged) {
    current.storageRevision = storageRevision;
    current.initialSuperseded = true;
    current.revision += 1;
  }
  const revision = current.revision;
  const read = ++current.read;
  pendingStartedAt = Date.now();
  const work = Promise.resolve().then(async () => {
    // A cookie write in another tab can precede its SDK broadcast. A null
    // receipt therefore needs a fresh absence check before it retires cache.
    // Retry that race once, outside an SDK event callback or session lock.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { data, error } = await current.client.auth.getSession();
      if (connection !== current || revision !== current.revision || read !== current.read) return;
      current.initialSuperseded = true;
      if (error) { unavailable(); return; }
      if (!data.session && captureBrowserSessionSnapshot() !== null) {
        if (attempt === 0) continue;
        // Conflicting evidence is stronger than an ordinary network outage:
        // retain the known identity without authorizing its cached UI to act.
        publish('unavailable', snapshot.identity, UNAVAILABLE, snapshot.observedUserId);
        return;
      }
      acceptSession(data.session, true);
      reconcileRealtime(current.client, data.session);
      return;
    }
  }).catch(() => {
    if (connection === current && revision === current.revision && read === current.read) {
      current.initialSuperseded = true;
      unavailable();
    }
  }).finally(() => { if (pending === work) pending = null; });
  pending = work;
  return work;
}
