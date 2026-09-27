import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Actual production cache-session, media resolver and offline invalidation
// modules. Provider receipts and browser cookie snapshots are controlled.
// This proves which URL the lookup hands out, not fetched/rendered image bytes.
const provider = vi.hoisted(() => ({
  session: null as Session | null,
  callbacks: new Set<(event: AuthChangeEvent, session: Session | null) => void>(),
  signedFor: [] as string[],
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  auth: {
    getSession: async () => ({ data: { session: provider.session }, error: null }),
    onAuthStateChange: (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
      provider.callbacks.add(callback);
      return { data: { subscription: { unsubscribe: () => provider.callbacks.delete(callback) } } };
    },
  },
  storage: { from: () => ({ createSignedUrls: async (paths: string[]) => {
    const owner = provider.session?.user.id ?? 'signed-out';
    provider.signedFor.push(owner);
    return { data: paths.map(path => ({ path,
      signedUrl: owner === '11111111-1111-4111-8111-111111111111' ? SIGNED_A : null,
      error: owner === '11111111-1111-4111-8111-111111111111' ? null : 'not authorized',
    })), error: null };
  } }) },
}) }));
vi.mock('@/lib/auth/browser-session-storage', () => ({ captureBrowserSessionSnapshot: () => provider.session
  ? { accessToken: provider.session.access_token, userId: provider.session.user.id,
    sessionId: JSON.parse(Buffer.from(provider.session.access_token.split('.')[1], 'base64url').toString()).session_id,
    storageKey: 'sb-synthetic-auth-token', generation: '' }
  : null,
}));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FAMILY = '33333333-3333-4333-8333-333333333333';
const REF = `https://synthetic.supabase.invalid/storage/v1/object/public/family-media/${FAMILY}/photos/synthetic.png`;
const SIGNED_A = `https://synthetic.supabase.invalid/storage/v1/object/sign/family-media/${FAMILY}/photos/synthetic.png?token=synthetic-owner-a`;
function session(userId: string): Session {
  const sessionId = userId === A ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  return { access_token: `fixture.${Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId })).toString('base64url')}.signature`,
    refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
    user: { id: userId, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-27T00:00:00Z' },
  };
}
const stops: Array<() => void> = [];
beforeEach(() => {
  vi.resetModules();
  provider.session = session(A);
  provider.callbacks.clear();
  provider.signedFor = [];
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  stops.splice(0).forEach(stop => stop());
  vi.unstubAllGlobals();
});
async function boot() {
  const auth = await import('@/lib/auth/cache-session');
  const media = await import('@/lib/storage/use-family-media');
  const cache = await import('@/lib/offline/cache');
  const stop = auth.subscribeCacheSession(() => {});
  stops.push(stop);
  await auth.refreshCacheSession();
  expect(auth.getCacheSessionSnapshot().identity?.userId).toBe(A);
  await media.ensureFamilyMediaUrls([REF]);
  expect(media.lookupFamilyMediaUrl(REF)).toBe(SIGNED_A);
  expect(provider.signedFor).toEqual([A]);
  return { auth, media, cache, stop };
}

it('actively observed A-to-B switch clears A capability and asks Storage as B', async () => {
  const { auth, media, cache } = await boot();
  const before = cache.getCacheGeneration();
  provider.session = session(B);
  for (const callback of provider.callbacks) callback('SIGNED_IN', provider.session);
  expect(auth.getCacheSessionSnapshot().identity?.userId).toBe(B);
  expect(cache.getCacheGeneration()).toBeGreaterThan(before);
  await media.ensureFamilyMediaUrls([REF]);
  expect(provider.signedFor).toEqual([A, B]);
  expect(media.lookupFamilyMediaUrl(REF)).toBeNull();
});

it('does not reuse A capability after observer gap and successful B bootstrap', async () => {
  const { auth, media, cache, stop } = await boot();
  const before = cache.getCacheGeneration();
  stop();
  expect(provider.callbacks.size).toBe(0);
  expect(auth.getCacheSessionSnapshot()).toMatchObject({ status: 'restoring', identity: null });
  // While this document has no authenticated-layout observer, a peer changes
  // the shared cookie jar to B. Only provider receipt delivery is controlled.
  provider.session = session(B);
  stops.push(auth.subscribeCacheSession(() => {}));
  await auth.refreshCacheSession();
  expect(auth.getCacheSessionSnapshot()).toMatchObject({ status: 'ready', identity: { userId: B } });
  await media.ensureFamilyMediaUrls([REF]);
  const result = { beforeGeneration: before, afterGeneration: cache.getCacheGeneration(),
    observedUser: auth.getCacheSessionSnapshot().identity?.userId,
    signingOwners: provider.signedFor, returnedACapability: media.lookupFamilyMediaUrl(REF) === SIGNED_A };
  console.log('CONTROLLED_MEDIA_SESSION_GAP', JSON.stringify(result));
  expect(media.lookupFamilyMediaUrl(REF)).not.toBe(SIGNED_A);
  expect(provider.signedFor).toEqual([A, B]);
  expect(media.lookupFamilyMediaUrl(REF)).toBeNull();
});
