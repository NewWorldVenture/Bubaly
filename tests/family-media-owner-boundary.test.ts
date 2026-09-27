import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureBrowserSessionSnapshot } from '@/lib/auth/browser-session-storage';
import { clearAllCache, getCacheGeneration } from '@/lib/offline/cache';
import { __resetFamilyMediaUrlCache, ensureFamilyMediaUrls, lookupFamilyMediaUrl } from '@/lib/storage/use-family-media';

const storage = vi.hoisted(() => ({ createSignedUrls: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  storage: { from: () => ({ createSignedUrls: storage.createSignedUrls }) },
}) }));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FAMILY = '33333333-3333-4333-8333-333333333333';
const PATH = `${FAMILY}/photos/synthetic.png`;
const REF = `https://synthetic.supabase.invalid/storage/v1/object/public/family-media/${PATH}`;
const EXTERNAL = 'https://images.example.invalid/synthetic.png';
let cookieJar = '';
let unreadable = false;

function setSession(userId = A, sessionId = SESSION_A, generation = '', version = 'one') {
  const claims = Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId, version })).toString('base64url');
  const session = { user: { id: userId }, access_token: `fixture.${claims}.signature` };
  cookieJar = `sb-synthetic-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
    + (generation ? `; sb-synthetic-auth-token-logout-generation=${generation}` : '');
}

function owner() {
  const current = captureBrowserSessionSnapshot();
  return `${current?.userId}/${current?.sessionId}/${current?.generation}`;
}

function signed(path: string, signedOwner = owner()) {
  return `https://synthetic.supabase.invalid/storage/v1/object/sign/family-media/${path}?token=synthetic-${encodeURIComponent(signedOwner)}`;
}

function reply(paths: string[], signedOwner = owner()) {
  return { data: paths.map(path => ({ path, signedUrl: signed(path, signedOwner), error: null })), error: null };
}

function holdSignings() {
  const held: Array<{ owner: string; release: () => void }> = [];
  storage.createSignedUrls.mockImplementation((paths: string[]) => {
    const signedOwner = owner();
    return new Promise(resolve => held.push({ owner: signedOwner, release: () => resolve(reply(paths, signedOwner)) }));
  });
  return held;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic.supabase.invalid');
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', { get cookie() {
    if (unreadable) throw new Error('Synthetic cookie access denied');
    return cookieJar;
  } });
  unreadable = false;
  setSession();
  storage.createSignedUrls.mockReset();
  storage.createSignedUrls.mockImplementation(async (paths: string[]) => reply(paths));
  __resetFamilyMediaUrlCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('signed media compares the actual synchronous cookie owner', () => {
  it('refuses A at lookup immediately after a silent B cookie switch and signs independently for B', async () => {
    await ensureFamilyMediaUrls([REF]);
    const aUrl = lookupFamilyMediaUrl(REF);
    expect(aUrl).toBe(signed(PATH));
    const before = getCacheGeneration();
    setSession(B, SESSION_B);
    expect(getCacheGeneration()).toBe(before);
    expect(lookupFamilyMediaUrl(REF)).toBeUndefined();
    await ensureFamilyMediaUrls([REF]);
    expect(lookupFamilyMediaUrl(REF)).toBe(signed(PATH));
    expect(lookupFamilyMediaUrl(REF)).not.toBe(aUrl);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(2);
  });

  it('requires a fresh signature for a new session belonging to the same user', async () => {
    await ensureFamilyMediaUrls([REF]);
    const aUrl = lookupFamilyMediaUrl(REF);
    setSession(A, SESSION_B);
    expect(lookupFamilyMediaUrl(REF)).toBeUndefined();
    await ensureFamilyMediaUrls([REF]);
    expect(lookupFamilyMediaUrl(REF)).toBe(signed(PATH));
    expect(lookupFamilyMediaUrl(REF)).not.toBe(aUrl);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(2);
  });

  it('treats a changed logout generation as an ownership boundary even if old session bytes reappear', async () => {
    await ensureFamilyMediaUrls([REF]);
    const aUrl = lookupFamilyMediaUrl(REF);
    setSession(A, SESSION_A, 'new-synthetic-logout-generation');
    expect(lookupFamilyMediaUrl(REF)).toBeUndefined();
    await ensureFamilyMediaUrls([REF]);
    expect(lookupFamilyMediaUrl(REF)).not.toBe(aUrl);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(2);
  });

  it('keeps a cached signature through access-token rotation of the same session', async () => {
    await ensureFamilyMediaUrls([REF]);
    const aUrl = lookupFamilyMediaUrl(REF);
    setSession(A, SESSION_A, '', 'rotated');
    expect(lookupFamilyMediaUrl(REF)).toBe(aUrl);
    await ensureFamilyMediaUrls([REF]);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);
  });

  it.each(['absent', 'malformed', 'missing-session-id', 'wrong-sub', 'unreadable'] as const)(
    'returns no private URL and makes no signing request when ownership is %s', async kind => {
      await ensureFamilyMediaUrls([REF]);
      if (kind === 'absent') cookieJar = '';
      if (kind === 'malformed') cookieJar = 'sb-synthetic-auth-token=not-json';
      if (kind === 'missing-session-id') setSession(A, '');
      if (kind === 'wrong-sub') {
        const claims = Buffer.from(JSON.stringify({ sub: B, session_id: SESSION_A })).toString('base64url');
        cookieJar = `sb-synthetic-auth-token=${JSON.stringify({ user: { id: A }, access_token: `fixture.${claims}.signature` })}`;
      }
      if (kind === 'unreadable') unreadable = true;
      expect(lookupFamilyMediaUrl(REF)).toBeNull();
      expect(lookupFamilyMediaUrl(EXTERNAL)).toBe(EXTERNAL);
      await ensureFamilyMediaUrls([REF, EXTERNAL]);
      expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);
    },
  );

  it('can sign after an initially unavailable owner becomes readable', async () => {
    cookieJar = '';
    await ensureFamilyMediaUrls([REF]);
    expect(storage.createSignedUrls).not.toHaveBeenCalled();
    setSession();
    await ensureFamilyMediaUrls([REF]);
    expect(lookupFamilyMediaUrl(REF)).toBe(signed(PATH));
  });
});

describe('inflight signing belongs to the session that started it', () => {
  it('does not let B join A, and A settlement does not erase B pending work', async () => {
    const held = holdSignings();
    const a = ensureFamilyMediaUrls([REF]);
    setSession(B, SESSION_B);
    const b = ensureFamilyMediaUrls([REF]);
    expect(held).toHaveLength(2);
    expect(held.map(request => request.owner)).toEqual([`${A}/${SESSION_A}/`, `${B}/${SESSION_B}/`]);
    held[0].release();
    await a;
    expect(lookupFamilyMediaUrl(REF)).toBeUndefined();
    const bAgain = ensureFamilyMediaUrls([REF]);
    expect(held).toHaveLength(2);
    held[1].release();
    await Promise.all([b, bAgain]);
    expect(lookupFamilyMediaUrl(REF)).toBe(signed(PATH));
  });

  it('a late A result cannot overwrite B after B has already finished', async () => {
    const held = holdSignings();
    const a = ensureFamilyMediaUrls([REF]);
    setSession(B, SESSION_B);
    const b = ensureFamilyMediaUrls([REF]);
    expect(held).toHaveLength(2);
    held[1].release();
    await b;
    const bUrl = lookupFamilyMediaUrl(REF);
    held[0].release();
    await a;
    expect(lookupFamilyMediaUrl(REF)).toBe(bUrl);
    expect(bUrl).toBe(signed(PATH));
  });

  it('shares and accepts the same pending request through same-session token rotation', async () => {
    const held = holdSignings();
    const first = ensureFamilyMediaUrls([REF]);
    setSession(A, SESSION_A, '', 'rotated');
    const second = ensureFamilyMediaUrls([REF]);
    expect(held).toHaveLength(1);
    held[0].release();
    await Promise.all([first, second]);
    expect(lookupFamilyMediaUrl(REF)).toBe(signed(PATH));
  });

  it.each(['absent', 'unreadable', 'new-session', 'logout-generation'] as const)(
    'discards a signing response if the owner becomes %s without a purge event', async kind => {
      const held = holdSignings();
      const pending = ensureFamilyMediaUrls([REF]);
      const before = getCacheGeneration();
      if (kind === 'absent') cookieJar = '';
      if (kind === 'unreadable') unreadable = true;
      if (kind === 'new-session') setSession(A, SESSION_B);
      if (kind === 'logout-generation') setSession(A, SESSION_A, 'new-generation');
      held[0].release();
      await pending;
      expect(getCacheGeneration()).toBe(before);
      // Restoring the original owner proves the result was discarded, rather
      // than merely hidden while ownership was absent or different.
      unreadable = false;
      setSession();
      expect(lookupFamilyMediaUrl(REF)).toBeUndefined();
    },
  );

  it('also keeps purge generation as a boundary within one cookie owner', async () => {
    const held = holdSignings();
    const first = ensureFamilyMediaUrls([REF]);
    clearAllCache({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const second = ensureFamilyMediaUrls([REF]);
    expect(held).toHaveLength(2);
    held[0].release();
    await first;
    expect(lookupFamilyMediaUrl(REF)).toBeUndefined();
    held[1].release();
    await second;
    expect(lookupFamilyMediaUrl(REF)).toBe(signed(PATH));
  });
});

it('preserves batching, external references, and a 30-second owner-specific failure hold', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
  storage.createSignedUrls.mockResolvedValue({ data: null, error: { message: 'synthetic denial' } });
  const second = `${FAMILY}/photos/second.png`;
  await ensureFamilyMediaUrls([REF, PATH, second, EXTERNAL]);
  expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);
  expect(storage.createSignedUrls.mock.calls[0][0]).toEqual([PATH, second]);
  expect(lookupFamilyMediaUrl(REF)).toBeNull();
  expect(lookupFamilyMediaUrl(EXTERNAL)).toBe(EXTERNAL);
  vi.setSystemTime(new Date('2026-09-27T00:00:29Z'));
  await ensureFamilyMediaUrls([REF]);
  expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date('2026-09-27T00:00:31Z'));
  await ensureFamilyMediaUrls([REF]);
  expect(storage.createSignedUrls).toHaveBeenCalledTimes(2);
  setSession(B, SESSION_B);
  await ensureFamilyMediaUrls([REF]);
  expect(storage.createSignedUrls).toHaveBeenCalledTimes(3);
});
