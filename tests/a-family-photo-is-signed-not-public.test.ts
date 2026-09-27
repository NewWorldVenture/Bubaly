import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SEC-001: a family's photos, message attachments and reminder images are read
 * through a URL signed with the VIEWER's session, never through the stored
 * public URL — so the bucket can be made private without breaking a single
 * consumer, and so a reference nobody may read renders nothing.
 */

const createSignedUrls = vi.fn();
const from = vi.fn(() => ({ createSignedUrls }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ storage: { from } }) }));

import {
  FAMILY_MEDIA_BUCKET,
  parseFamilyMediaRef,
  signFamilyMediaRefs,
} from '@/lib/storage/family-media-ref';
import {
  __resetFamilyMediaUrlCache,
  ensureFamilyMediaUrls,
  lookupFamilyMediaUrl,
} from '@/lib/storage/use-family-media';
import { clearAllCache } from '@/lib/offline/cache';

const FAMILY = '11111111-2222-4333-8444-555555555555';
const OTHER_FAMILY = '99999999-2222-4333-8444-555555555555';
const PATH = `${FAMILY}/photos/0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b.jpg`;
const PUBLIC = `https://abcd.supabase.co/storage/v1/object/public/family-media/${PATH}`;
const signedFor = (p: string) => `https://abcd.supabase.co/storage/v1/object/sign/family-media/${p}?token=t-${p.length}`;

function client() {
  return { storage: { from } } as never;
}

beforeEach(() => {
  // A readable browser owner is required before reusing a signed capability.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcd.supabase.co');
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: userId, session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).toString('base64url')}.signature`;
  const session = { user: { id: userId }, access_token: token };
  vi.stubGlobal('document', { cookie: `sb-abcd-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}` });
  createSignedUrls.mockReset();
  from.mockClear();
  __resetFamilyMediaUrlCache();
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('a stored reference is classified before anything renders it', () => {
  it('recognises every shape Storage serves this bucket under, and a bare path', () => {
    for (const ref of [
      PUBLIC,
      `https://abcd.supabase.co/storage/v1/object/sign/family-media/${PATH}?token=old`,
      `https://abcd.supabase.co/storage/v1/object/authenticated/family-media/${PATH}`,
      `https://abcd.supabase.co/storage/v1/render/image/public/family-media/${PATH}?width=200`,
      PATH,
    ]) {
      expect(parseFamilyMediaRef(ref), ref).toEqual({ kind: 'family-media', path: PATH });
    }
  });

  it('treats a lookalike URL on another host as this bucket, so it is signed rather than rendered', () => {
    // Rendering it directly would be a public read by another route; signing a
    // path the viewer cannot read simply fails.
    expect(parseFamilyMediaRef(`https://evil.example/storage/v1/object/public/family-media/${PATH}`))
      .toEqual({ kind: 'family-media', path: PATH });
  });

  it.each([
    'object/public', 'object/sign', 'object/authenticated',
    'render/image/public', 'render/image/sign', 'render/image/authenticated',
  ])('recognises an encoded bucket on the %s route', (route) => {
    for (const bucket of ['family%2Dmedia', 'family%2dmedia', '%66amily-media']) {
      const ref = `https://abcd.supabase.co/storage/v1/${route}/${bucket}/${PATH}?token=old&width=200`;
      expect(parseFamilyMediaRef(ref)).toEqual({ kind: 'family-media', path: PATH });
    }
  });

  it('recognises encoded route segments on either host without decoding the object twice', () => {
    for (const prefix of [
      '%73torage/v%31/%6Fbject/s%69gn',
      '%73torage/v%31/r%65nder/im%61ge/p%75blic',
    ]) {
      const ref = `https://other.example/${prefix}/family%2Dmedia/${FAMILY}/photos/my%2520photo%252F.jpg`;
      expect(parseFamilyMediaRef(ref)).toEqual({ kind: 'family-media', path: `${FAMILY}/photos/my%20photo%2F.jpg` });
    }
  });

  it('keeps other buckets and external URLs external, including encoded names', () => {
    for (const ref of [
      'https://media.example/photos/family%2Dmedia/a%20b.jpg',
      `https://abcd.supabase.co/storage/v1/object/public/marketplace%2Dphotos/${PATH}`,
      `https://abcd.supabase.co/storage/v1/object/public/family%252Dmedia/${PATH}`,
    ]) {
      expect(parseFamilyMediaRef(ref)).toEqual({ kind: 'external', url: ref });
    }
  });

  it('applies the same object-path validation after decoding the bucket', () => {
    for (const path of [
      FAMILY, `${FAMILY}/`, `${FAMILY}//a.jpg`, `not-a-uuid/a.jpg`,
      `${FAMILY}/a%2Fb.jpg`, `${FAMILY}/a%5Cb.jpg`, `${FAMILY}/bad%E0%A4%A.jpg`,
    ]) {
      expect(parseFamilyMediaRef(`https://abcd.supabase.co/storage/v1/object/sign/family%2Dmedia/${path}?token=old`)).toBeNull();
    }
  });

  it('passes a genuinely external image through, over http(s) only', () => {
    const giphy = 'https://media.giphy.com/media/abc/giphy.gif';
    expect(parseFamilyMediaRef(giphy)).toEqual({ kind: 'external', url: giphy });
    expect(parseFamilyMediaRef('https://abcd.supabase.co/storage/v1/object/public/marketplace-photos/x/y.jpg'))
      .toEqual({ kind: 'external', url: 'https://abcd.supabase.co/storage/v1/object/public/marketplace-photos/x/y.jpg' });
    expect(parseFamilyMediaRef('javascript:alert(1)')).toBeNull();
    expect(parseFamilyMediaRef('data:image/png;base64,AAAA')).toBeNull();
    expect(parseFamilyMediaRef('//evil.example/a.jpg')).toBeNull();
  });

  it('refuses a malformed or traversing path instead of guessing', () => {
    for (const ref of [
      '', '   ', null, undefined,
      'photo.jpg',
      `not-a-uuid/photos/a.jpg`,
      `${FAMILY}`,
      `${FAMILY}/../${OTHER_FAMILY}/a.jpg`,
      `${FAMILY}/photos/%2e%2e/a.jpg`,
      `https://abcd.supabase.co/storage/v1/object/public/family-media/${FAMILY}/a%2Fb.jpg`,
      `https://abcd.supabase.co/storage/v1/object/public/family-media/${FAMILY}/bad%E0%A4%A.jpg`,
    ]) {
      expect(parseFamilyMediaRef(ref as string), String(ref)).toBeNull();
    }
  });
});

describe('signing', () => {
  it('re-signs encoded and canonical references in one viewer-authorized request', async () => {
    const encoded = `https://abcd.supabase.co/storage/v1/object/sign/family%2Dmedia/${PATH}?token=another-session`;
    createSignedUrls.mockResolvedValue({ data: [{ path: PATH, signedUrl: signedFor(PATH), error: null }], error: null });
    const out = await signFamilyMediaRefs(client(), [PUBLIC, encoded]);
    expect(from).toHaveBeenCalledWith(FAMILY_MEDIA_BUCKET);
    expect(createSignedUrls).toHaveBeenCalledExactlyOnceWith([PATH], 3600);
    expect(out.get(encoded)).toBe(signedFor(PATH));
    expect(out.get(PUBLIC)).toBe(signedFor(PATH));
  });

  it('never returns an encoded stored capability when viewer signing is denied', async () => {
    const encoded = `https://abcd.supabase.co/storage/v1/object/sign/family%2Dmedia/${PATH}?token=another-session`;
    createSignedUrls.mockResolvedValue({ data: [{ path: PATH, signedUrl: null, error: 'not authorized' }], error: null });
    const out = await signFamilyMediaRefs(client(), [encoded]);
    expect(createSignedUrls).toHaveBeenCalledExactlyOnceWith([PATH], 3600);
    expect(out.get(encoded)).toBeNull();
  });

  it('sends a once-decoded literal percent object name to Storage unchanged', async () => {
    const encoded = `https://abcd.supabase.co/storage/v1/object/public/family%2Dmedia/${FAMILY}/photos/100%25%2520ready.jpg`;
    const path = `${FAMILY}/photos/100%%20ready.jpg`;
    createSignedUrls.mockResolvedValue({ data: [{ path, signedUrl: signedFor(path), error: null }], error: null });
    const out = await signFamilyMediaRefs(client(), [encoded]);
    expect(createSignedUrls).toHaveBeenCalledExactlyOnceWith([path], 3600);
    expect(out.get(encoded)).toBe(signedFor(path));
  });

  it('signs every family reference in ONE call, and never touches Storage for an external one', async () => {
    createSignedUrls.mockImplementation(async (paths: string[]) => ({
      data: paths.map((p) => ({ path: p, signedUrl: signedFor(p), error: null })), error: null,
    }));
    const other = `${FAMILY}/messages/b.png`;
    const giphy = 'https://media.giphy.com/media/abc/giphy.gif';
    const out = await signFamilyMediaRefs(client(), [PUBLIC, PATH, other, giphy, null, '']);
    expect(from).toHaveBeenCalledWith(FAMILY_MEDIA_BUCKET);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    // The public URL and the bare path name one object: signed once.
    expect(createSignedUrls.mock.calls[0][0]).toEqual([PATH, other]);
    expect(out.get(PUBLIC)).toBe(signedFor(PATH));
    expect(out.get(PATH)).toBe(signedFor(PATH));
    expect(out.get(other)).toBe(signedFor(other));
    expect(out.get(giphy)).toBe(giphy);
  });

  it('a path the viewer may not read resolves to null — not to the stored URL', async () => {
    const foreign = `https://abcd.supabase.co/storage/v1/object/public/family-media/${OTHER_FAMILY}/photos/a.jpg`;
    createSignedUrls.mockResolvedValue({
      data: [
        { path: PATH, signedUrl: signedFor(PATH), error: null },
        { path: `${OTHER_FAMILY}/photos/a.jpg`, signedUrl: null, error: 'Either the object does not exist or you do not have access to it' },
      ],
      error: null,
    });
    const out = await signFamilyMediaRefs(client(), [PUBLIC, foreign]);
    expect(out.get(PUBLIC)).toBe(signedFor(PATH));
    expect(out.get(foreign)).toBeNull();
  });

  it('a failed or thrown signing call renders nothing, and never falls back to the public URL', async () => {
    createSignedUrls.mockResolvedValueOnce({ data: null, error: { message: 'storage down' } });
    let out = await signFamilyMediaRefs(client(), [PUBLIC]);
    expect(out.get(PUBLIC)).toBeNull();

    createSignedUrls.mockRejectedValueOnce(new TypeError('fetch failed'));
    out = await signFamilyMediaRefs(client(), [PUBLIC]);
    expect(out.get(PUBLIC)).toBeNull();

    // And a success whose item names a DIFFERENT path does not sign this one.
    createSignedUrls.mockResolvedValueOnce({ data: [{ path: `${FAMILY}/x/y.jpg`, signedUrl: 'https://s/other', error: null }], error: null });
    out = await signFamilyMediaRefs(client(), [PUBLIC]);
    expect(out.get(PUBLIC)).toBeNull();
    for (const value of out.values()) expect(value).not.toBe(PUBLIC);
  });
});

describe('the browser cache of signed URLs', () => {
  it('does not expose an encoded reference before signing or after a viewer denial', async () => {
    const encoded = `https://abcd.supabase.co/storage/v1/object/sign/family%2Dmedia/${PATH}?token=another-session`;
    expect(lookupFamilyMediaUrl(encoded)).toBeUndefined();
    createSignedUrls.mockResolvedValue({ data: [{ path: PATH, signedUrl: null, error: 'not authorized' }], error: null });
    await ensureFamilyMediaUrls([encoded]);
    expect(lookupFamilyMediaUrl(encoded)).toBeNull();
    expect(createSignedUrls).toHaveBeenCalledExactlyOnceWith([PATH], 3600);
    vi.stubGlobal('document', { cookie: '' });
    expect(lookupFamilyMediaUrl(encoded)).toBeNull();
  });

  it('is undefined while signing, then reuses one URL instead of re-signing on every render', async () => {
    createSignedUrls.mockImplementation(async (paths: string[]) => ({
      data: paths.map((p) => ({ path: p, signedUrl: signedFor(p), error: null })), error: null,
    }));
    expect(lookupFamilyMediaUrl(PUBLIC)).toBeUndefined();
    await ensureFamilyMediaUrls([PUBLIC]);
    expect(lookupFamilyMediaUrl(PUBLIC)).toBe(signedFor(PATH));
    await ensureFamilyMediaUrls([PUBLIC]);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
  });

  it('shares one request between two views asking at once', async () => {
    let release!: () => void;
    createSignedUrls.mockImplementation((paths: string[]) => new Promise((resolve) => {
      release = () => resolve({ data: paths.map((p) => ({ path: p, signedUrl: signedFor(p), error: null })), error: null });
    }));
    const a = ensureFamilyMediaUrls([PUBLIC]);
    const b = ensureFamilyMediaUrls([PUBLIC]);
    release();
    await Promise.all([a, b]);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
  });

  it('forgets every signed URL when the session is purged', async () => {
    createSignedUrls.mockImplementation(async (paths: string[]) => ({
      data: paths.map((p) => ({ path: p, signedUrl: signedFor(p), error: null })), error: null,
    }));
    await ensureFamilyMediaUrls([PUBLIC]);
    expect(lookupFamilyMediaUrl(PUBLIC)).toBe(signedFor(PATH));
    clearAllCache({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
    expect(lookupFamilyMediaUrl(PUBLIC)).toBeUndefined();
  });

  it('discards a URL that finishes signing AFTER a sign-out, so the next user cannot be handed it', async () => {
    let release!: () => void;
    createSignedUrls.mockImplementation((paths: string[]) => new Promise((resolve) => {
      release = () => resolve({ data: paths.map((p) => ({ path: p, signedUrl: signedFor(p), error: null })), error: null });
    }));
    const pending = ensureFamilyMediaUrls([PUBLIC]);
    clearAllCache({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
    release();
    await pending;
    expect(lookupFamilyMediaUrl(PUBLIC)).toBeUndefined();
  });

  it('holds a denied reference as null rather than retrying it in a loop', async () => {
    createSignedUrls.mockResolvedValue({ data: [{ path: PATH, signedUrl: null, error: 'not found' }], error: null });
    await ensureFamilyMediaUrls([PUBLIC]);
    expect(lookupFamilyMediaUrl(PUBLIC)).toBeNull();
    await ensureFamilyMediaUrls([PUBLIC]);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
  });
});
