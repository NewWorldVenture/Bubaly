'use client';

// The browser side of lib/storage/family-media-ref.ts: resolve stored
// family-media references to signed URLs, reusing one URL per object for most
// of its lifetime.
//
// Reuse matters more than it looks. A fresh signature is a fresh URL, and a
// fresh URL is a browser-cache miss — so signing on every render would
// re-download every photo on every visit, and the kiosk, which re-renders every
// 120 seconds, would re-download its whole slideshow each time and remount
// every <img> keyed by it. One URL per object per hour keeps the HTTP cache
// useful and the slideshow still.
//
// The cache is MEMORY ONLY, and it belongs to one session. Signed URLs are
// bearer credentials (family-media-ref.ts, rule 2), so they are never written to
// localStorage or the offline row cache, and the same purge that clears the
// offline cache on sign-out or an identity change clears this map too. An entry
// also records the browser session and purge generation it was signed under.
// Check cookie ownership synchronously too: a peer can change the session while
// this document has no auth observer. Neither a cached URL nor a signing call
// already in flight may cross that boundary. Token renewal within the same
// session keeps its owner, so the URL remains reusable.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createClient } from '@/lib/supabase/client';
import { captureBrowserSessionSnapshot } from '@/lib/auth/browser-session-storage';
import { getCacheGeneration, subscribeCacheInvalidation } from '@/lib/offline/cache';
import { FAMILY_MEDIA_SIGNED_TTL_SECONDS, parseFamilyMediaRef, signFamilyMediaRefs } from './family-media-ref';

type Entry = {
  url: string | null;
  /** Stop handing the URL out after this — a little before Storage stops honouring it. */
  validUntil: number;
  /** Re-sign in the background from this point, while the old URL still works. */
  refreshAt: number;
  generation: number;
  owner: string;
};

const TTL_MS = FAMILY_MEDIA_SIGNED_TTL_SECONDS * 1000;
const EXPIRY_SKEW_MS = 60_000;
const REFRESH_AHEAD_MS = 5 * 60_000;
/** A denied or failed signing is retried on the next mount after this, never in a loop. */
const FAILURE_HOLD_MS = 30_000;
const MAX_ENTRIES = 2000;

const cache = new Map<string, Entry>();
const inflight = new Map<string, { owner: string; generation: number; work: Promise<void> }>();
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;

/** A cache discriminator only; Storage still authorizes each signing request. */
function currentOwner(): string | null {
  try {
    const session = captureBrowserSessionSnapshot();
    if (!session?.userId || !session.sessionId) return null;
    return JSON.stringify([session.storageKey, session.userId, session.sessionId, session.generation]);
  } catch { return null; }
}

let subscribed = false;
function ensurePurgeSubscription() {
  if (subscribed || typeof window === 'undefined') return;
  subscribed = true;
  subscribeCacheInvalidation(() => { cache.clear(); inflight.clear(); });
}

function current(ref: string, owner = currentOwner()): Entry | null {
  const entry = cache.get(ref);
  return owner && entry?.owner === owner && entry.generation === getCacheGeneration() ? entry : null;
}

/**
 * What to render for a stored reference right now: a URL, `null` for "nothing
 * to render" (malformed, denied, failed), or `undefined` while it is being
 * signed.
 */
export function lookupFamilyMediaUrl(ref: string | null | undefined, now = Date.now()): string | null | undefined {
  const parsed = parseFamilyMediaRef(ref);
  if (!parsed) return null;
  if (parsed.kind === 'external') return parsed.url;
  const owner = currentOwner();
  if (!owner) return null;
  const entry = current(ref as string, owner);
  if (!entry) return undefined;
  if (entry.url === null) return now < entry.validUntil ? null : undefined;
  return now < entry.validUntil ? entry.url : undefined;
}

function store(ref: string, entry: Entry) {
  cache.delete(ref);
  cache.set(ref, entry);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Sign whatever in `refs` is missing or due, sharing any request already in flight. */
export async function ensureFamilyMediaUrls(refs: readonly string[]): Promise<void> {
  ensurePurgeSubscription();
  const owner = currentOwner();
  if (!owner) return;
  const generation = getCacheGeneration();
  const started = Date.now();
  const need: string[] = [];
  const waits: Promise<void>[] = [];
  for (const ref of refs) {
    if (parseFamilyMediaRef(ref)?.kind !== 'family-media') continue;
    const pending = inflight.get(ref);
    if (pending?.owner === owner && pending.generation === generation) { waits.push(pending.work); continue; }
    const entry = current(ref, owner);
    if (entry && started < entry.refreshAt) continue;
    need.push(ref);
  }
  if (need.length) {
    const work = signFamilyMediaRefs(createClient(), need)
      .then((signed) => {
        // Signed for a session that has since ended or changed: discard.
        if (getCacheGeneration() !== generation || currentOwner() !== owner) return;
        for (const ref of need) {
          const url = signed.get(ref) ?? null;
          store(ref, url
            ? { url, validUntil: started + TTL_MS - EXPIRY_SKEW_MS, refreshAt: started + TTL_MS - REFRESH_AHEAD_MS, generation, owner }
            : { url: null, validUntil: started + FAILURE_HOLD_MS, refreshAt: started + FAILURE_HOLD_MS, generation, owner });
        }
      })
      .finally(() => { for (const ref of need) if (inflight.get(ref)?.work === work) inflight.delete(ref); });
    for (const ref of need) inflight.set(ref, { owner, generation, work });
    waits.push(work);
  }
  await Promise.all(waits);
}

/**
 * Resolve many references at once. Returns a lookup: a URL, `null` for nothing
 * to render, or `undefined` while signing. External URLs resolve immediately.
 */
export function useFamilyMediaUrls(refs: readonly (string | null | undefined)[]): (ref: string | null | undefined) => string | null | undefined {
  const key = useMemo(
    () => [...new Set(refs.filter((r): r is string => typeof r === 'string' && r.length > 0))].sort().join('\n'),
    [refs],
  );
  const [, setTick] = useState(0);
  // Match the server's private-media placeholder during hydration. A later
  // client mount can use its cached URL immediately; denied browser owners
  // still settle to null rather than remaining in a loading state.
  const hydrated = useSyncExternalStore(subscribeHydration, clientHydrated, serverHydrated);

  useEffect(() => {
    ensurePurgeSubscription();
    const list = key ? key.split('\n') : [];
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      void ensureFamilyMediaUrls(list).catch(() => {}).then(() => {
        if (!alive) return;
        setTick((t) => t + 1);
        // Re-sign ahead of expiry for as long as this view is mounted.
        const now = Date.now();
        let next = Infinity;
        for (const ref of list) {
          const entry = current(ref);
          if (entry?.url) next = Math.min(next, entry.refreshAt);
        }
        if (Number.isFinite(next)) timer = setTimeout(run, Math.max(1000, next - now));
      });
    };
    run();
    const stop = subscribeCacheInvalidation(() => { if (alive) { setTick((t) => t + 1); run(); } });
    return () => { alive = false; if (timer) clearTimeout(timer); stop(); };
  }, [key]);

  return (ref) => !hydrated && parseFamilyMediaRef(ref)?.kind === 'family-media'
    ? undefined
    : lookupFamilyMediaUrl(ref);
}

/** The single-reference form of useFamilyMediaUrls. */
export function useFamilyMediaUrl(ref: string | null | undefined): string | null | undefined {
  const refs = useMemo(() => [ref], [ref]);
  return useFamilyMediaUrls(refs)(ref);
}

/** Test seam: forget everything. */
export function __resetFamilyMediaUrlCache(): void {
  cache.clear();
  inflight.clear();
}
