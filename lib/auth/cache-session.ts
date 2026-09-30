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
// A peer tab's SDK broadcast can arrive a few milliseconds before this tab can
// see the cookie write it announces (Chromium: the event names B while this
// tab's cookie jar still reads A). The immediate reread then finds consistent,
// stale evidence, and without another read A's private rows would stay on
// screen. Reread after the jar has had time to settle; each read is still bound
// to current cookies, so it cannot adopt the event's session on its own.
//
// Conflicting events are claims to verify, never sessions to adopt. A claim is
// read against cookies in an episode of at most three reads (now, +50 ms,
// +500 ms) and is refuted only by the episode's last read, never by one inside
// the cookie-lag window. Then:
//  - a reread's own echo of a claim current cookies already refuted is ignored,
//    so settled state stays quiet however often the SDK repeats it;
//  - a claim not seen before, arriving from outside our reads, starts or
//    extends an episode at once: a genuine new owner never inherits a cooldown;
//  - a claim naming a different user stops authorizing the current owner's
//    cached UI immediately (nothing is purged: the claim may be stale) until a
//    cookie-bound read adopts that user or the claim is refuted;
//  - a receipt read before the cookies changed restores nothing: if no read
//    has verified the owner current cookies name when the episode ends, the
//    view stays unavailable and up to five spaced single reads (on the backoff
//    below) retry; after that, lifecycle reads remain the recovery path;
//  - other repeats wait out a backoff (2 s, doubling to 30 s).
const CROSS_TAB_SETTLE_MS = [0, 50, 500] as const;
const CONFLICT_BACKOFF_MS = 2_000;
const CONFLICT_BACKOFF_MAX_MS = 30_000;
const MAX_EPISODE_EXTENSIONS = 3;
const MAX_REFUTED_CLAIMS = 32;
const MAX_RECOVERY_READS = 5;
const SIGNED_OUT_CLAIM = '(signed out)';
type ConflictEpisode = {
  timer: ReturnType<typeof setTimeout> | null; active: boolean; plan: number[]; extensions: number; lastReadAt: number;
  busy: boolean; backoff: number; notBefore: number; recovery: number;
  claims: Map<string, number>; refuted: Map<string, string>; hold: Set<string>; held: { session: Session | null } | null;
};
const claimKey = (session: Session | null) => session?.access_token ?? SIGNED_OUT_CLAIM;
function cookieClaimKey(): string | undefined {
  try { return captureBrowserSessionSnapshot()?.accessToken ?? SIGNED_OUT_CLAIM; } catch { return undefined; }
}
let snapshot = INITIAL;
let connection: { client: ReturnType<typeof createClient>; unsubscribe: () => void; revision: number; read: number; storageRevision: number; initialSuperseded: boolean; reading: number; conflict: ConflictEpisode } | null = null;
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
    const current = { client, unsubscribe: () => {}, revision: 0, read: 0, storageRevision: getSessionStorageChangeRevision(), initialSuperseded: false, reading: 0, conflict: { timer: null, active: false, plan: [], extensions: 0, lastReadAt: 0, busy: false, backoff: 0, notBefore: 0, recovery: 0, claims: new Map(), refuted: new Map(), hold: new Set(), held: null } as ConflictEpisode };
    connection = current;
    const episode = current.conflict;
    const read = () => {
      if (connection !== current) return;
      episode.timer = null;
      episode.lastReadAt = Date.now();
      // Never read inside an SDK callback, which may hold the session lock.
      void Promise.resolve().then(() => {
        if (connection !== current) return;
        notifySessionStorageChanged({ broadcast: false });
        return refreshCacheSession();
      }).catch(() => { /* Lifecycle recovery remains available if a reader fails. */ })
        .finally(() => {
          if (connection !== current) return;
          const gap = episode.plan.shift();
          if (gap !== undefined) { episode.timer = setTimeout(read, gap); return; }
          endEpisode();
        });
    };
    const runEpisode = (plan: readonly number[] = CROSS_TAB_SETTLE_MS) => {
      episode.active = true;
      episode.busy = false;
      episode.extensions = 0;
      episode.plan = plan.slice(1).map((at, i) => at - plan[i]);
      read();
    };
    const endEpisode = () => {
      episode.active = false;
      const final = cookieClaimKey();
      // The last read verified every claim seen before it started.
      for (const [key, seen] of episode.claims) {
        if (seen > episode.lastReadAt) continue;
        episode.claims.delete(key);
        if (final === undefined || key === final) continue;
        episode.refuted.delete(key);
        episode.refuted.set(key, final);
        if (episode.refuted.size > MAX_REFUTED_CLAIMS) episode.refuted.delete(episode.refuted.keys().next().value!);
      }
      if (episode.hold.size && ![...episode.hold].some(key => episode.claims.has(key))) {
        // Every claimed new owner has been read against cookies. A receipt held
        // from before then restores the view only while current cookies still
        // carry that exact session; after a change (to a claimed owner whose
        // reads failed or came back stale, or anyone else) it authorizes nothing.
        episode.hold.clear();
        const held = episode.held;
        episode.held = null;
        if (held && final !== undefined && claimKey(held.session) === final) {
          episode.recovery = 0;
          acceptSession(held.session, true);
          reconcileRealtime(current.client, held.session);
        } else episode.recovery = MAX_RECOVERY_READS;
      }
      const wait = Math.min(CONFLICT_BACKOFF_MS * 2 ** episode.backoff, CONFLICT_BACKOFF_MAX_MS);
      if (!episode.busy && !episode.claims.size && !episode.recovery) { episode.backoff = 0; episode.notBefore = 0; return; }
      episode.backoff += 1;
      episode.notBefore = Date.now() + wait;
      // Unverified claims remain: one more episode, later each time, except a
      // claimed new owner, which is not left withheld behind a backoff.
      // Otherwise quiet.
      const withheld = [...episode.hold].some(key => episode.claims.has(key));
      if (episode.claims.size) episode.timer = setTimeout(runEpisode, withheld ? CROSS_TAB_SETTLE_MS[1] : wait);
      else if (episode.recovery) {
        // Unverified and unavailable: one cookie-bound read per backoff step.
        episode.recovery -= 1;
        episode.timer = setTimeout(() => runEpisode([0]), wait);
      }
    };
    const reconcileCurrentCookies = (session: Session | null) => {
      const key = claimKey(session);
      const now = Date.now();
      const echo = current.reading > 0;
      const refutedBy = episode.refuted.get(key);
      const settled = refutedBy !== undefined && refutedBy === cookieClaimKey();
      // A reread's own echo of a claim that current cookies already refuted.
      if (echo && settled) return;
      const fresh = !echo && !episode.claims.has(key) && (!settled || key === SIGNED_OUT_CLAIM);
      if (fresh && session && !settled && session.user?.id !== snapshot.identity?.userId) {
        // Someone else may have signed in here. Stop authorizing the current
        // owner's cached UI now; adopt nobody until cookies name them.
        episode.hold.add(key);
        if (snapshot.status === 'ready') publish('unavailable', snapshot.identity, UNAVAILABLE, snapshot.observedUserId);
      }
      episode.claims.set(key, now);
      if (episode.active) {
        episode.busy = true;
        if (fresh && episode.timer && episode.extensions < MAX_EPISODE_EXTENSIONS) {
          // Read again 50 ms and 500 ms after this claim.
          episode.extensions += 1;
          clearTimeout(episode.timer);
          episode.plan = CROSS_TAB_SETTLE_MS.slice(2).map((at, i) => at - CROSS_TAB_SETTLE_MS[i + 1]);
          episode.timer = setTimeout(read, CROSS_TAB_SETTLE_MS[1]);
        }
        return;
      }
      if (episode.timer) {
        if (!fresh) return; // coalesced into the pending episode
        clearTimeout(episode.timer);
        episode.timer = null;
      } else if (!fresh && episode.notBefore > now) {
        episode.timer = setTimeout(runEpisode, episode.notBefore - now);
        return;
      }
      runEpisode();
    };
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (connection !== current) return;
      // SDK INITIAL_SESSION can finish an old storage read after SIGNED_IN or
      // a newer explicit read. It cannot revive that older owner/session.
      if (event === 'INITIAL_SESSION' && current.initialSuperseded) return;
      if (session) {
        let matchesCurrentCookies = false;
        try {
          const saved = captureBrowserSessionSnapshot();
          matchesCurrentCookies = saved?.accessToken === session.access_token;
        } catch { /* A failed cookie read cannot establish this event's owner. */ }
        if (!matchesCurrentCookies) {
          // Visibility recovery and cross-tab SDK events can carry a session
          // read before a newer login or logout. Do not let that stale event
          // supersede a pending current-cookie read or reach the server tree.
          reconcileCurrentCookies(session);
          return;
        }
      }
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
          reconcileCurrentCookies(null);
          return;
        }
      }
      if (session && episode.hold.size) {
        // Withheld for a claimed new owner: only that owner's cookie ends it.
        if (!episode.hold.has(claimKey(session))) { episode.held = { session }; return; }
        episode.hold.clear();
        episode.held = null;
      }
      if (session || event === 'SIGNED_OUT') episode.recovery = 0;
      // An INITIAL_SESSION null can follow a transient bootstrap error. Only
      // an explicit sign-out or successful stored-session read proves null.
      acceptSession(session, event === 'SIGNED_OUT');
      for (const listener of authListeners) listener(event, session?.user?.id ?? null);
    });
    const stopStorageChanges = subscribeSessionStorageChanges(() => { void refreshCacheSession(); });
    current.unsubscribe = () => { subscription.unsubscribe(); stopStorageChanges(); if (episode.timer) clearTimeout(episode.timer); episode.timer = null; };
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
    // Cookie changes in another tab can precede its SDK broadcast. Bind both
    // positive and empty receipts to current cookies before accepting them.
    // Retry that race once, outside an SDK event callback or session lock.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Events the SDK emits during this read are this read's echoes.
      current.reading += 1;
      let result: Awaited<ReturnType<typeof current.client.auth.getSession>>;
      try { result = await current.client.auth.getSession(); } finally { current.reading -= 1; }
      const { data, error } = result;
      if (connection !== current || revision !== current.revision || read !== current.read) return;
      current.initialSuperseded = true;
      if (error) { unavailable(); return; }
      const saved = captureBrowserSessionSnapshot();
      if (data.session ? saved?.accessToken !== data.session.access_token : saved !== null) {
        if (attempt === 0) continue;
        // Conflicting evidence is stronger than an ordinary network outage:
        // retain the known identity without authorizing its cached UI to act.
        publish('unavailable', snapshot.identity, UNAVAILABLE, snapshot.observedUserId);
        return;
      }
      const episode = current.conflict;
      if (episode.hold.size) {
        if (!episode.hold.has(claimKey(data.session))) {
          // Still withheld for a claimed new owner; keep what cookies say for
          // when that claim is refuted.
          episode.held = { session: data.session };
          if (snapshot.status === 'ready') publish('unavailable', snapshot.identity, UNAVAILABLE, snapshot.observedUserId);
          return;
        }
        episode.hold.clear();
        episode.held = null;
      }
      episode.recovery = 0;
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
