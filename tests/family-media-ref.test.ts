import { describe, expect, it, vi } from 'vitest';
import {
  familyMediaObjectPath,
  parseFamilyMediaRef,
  signFamilyMediaRefs,
  type FamilyMediaSigner,
} from '@/lib/storage/family-media-ref';

// SEC-001. Every reader of family media resolves the stored value through
// these two functions. The parser decides what a stored value IS; the signer
// decides what an <img> may load. The rules that matter are the ones a
// shortcut would break: a reference to this bucket that cannot be signed
// becomes nothing (never the stored public URL), and only http(s) passes
// through as external media.

const ORIGIN = 'https://abcd1234.supabase.co';
const FAMILY = '0f8b7c1e-2d3a-4b5c-8d6e-7f8091a2b3c4';
const PATH = `${FAMILY}/photos/9d1e6b0a-1111-4222-8333-944455556666.jpg`;
const PUBLIC_URL = `${ORIGIN}/storage/v1/object/public/family-media/${PATH}`;

describe('parseFamilyMediaRef', () => {
  it('reads a stored public URL of this bucket as the object it names', () => {
    expect(parseFamilyMediaRef(PUBLIC_URL, ORIGIN)).toEqual({ kind: 'object', path: PATH });
  });

  it('reads a bare path, a signed URL and a percent-encoded name the same way', () => {
    expect(parseFamilyMediaRef(PATH, ORIGIN)).toEqual({ kind: 'object', path: PATH });
    expect(parseFamilyMediaRef(`${ORIGIN}/storage/v1/object/sign/family-media/${PATH}?token=abc`, ORIGIN))
      .toEqual({ kind: 'object', path: PATH });
    const spaced = `${FAMILY}/messages/my photo.png`;
    expect(parseFamilyMediaRef(`${ORIGIN}/storage/v1/object/public/family-media/${encodeURI(spaced)}`, ORIGIN))
      .toEqual({ kind: 'object', path: spaced });
  });

  it('passes external http(s) media through untouched', () => {
    const gif = 'https://media.giphy.com/media/abc/giphy.gif';
    expect(parseFamilyMediaRef(gif, ORIGIN)).toEqual({ kind: 'external', url: gif });
    // Another bucket of our own project is public by design (avatars,
    // marketplace photos) and is not this module's to sign.
    const avatar = `${ORIGIN}/storage/v1/object/public/avatars/${FAMILY}/a.png`;
    expect(parseFamilyMediaRef(avatar, ORIGIN)).toEqual({ kind: 'external', url: avatar });
  });

  it('refuses what is not an image reference at all', () => {
    for (const value of [
      '', '   ', null, undefined,
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'not-a-uuid/photos/x.jpg',
      `${FAMILY}`,
      `${FAMILY}/../other/x.jpg`,
      `${FAMILY}//x.jpg`,
      `${ORIGIN}/storage/v1/object/public/family-media/not-a-uuid/x.jpg`,
      `${ORIGIN}/storage/v1/object/public/family-media/${FAMILY}/%2e%2e/x.jpg`,
      `${ORIGIN}/storage/v1/object/public/family-media/%E0%A4%A`,
    ]) {
      expect(parseFamilyMediaRef(value as string, ORIGIN), String(value)).toEqual({ kind: 'none' });
    }
  });

  it('fails closed with no configured origin: a family-media URL is still ours to sign', () => {
    expect(parseFamilyMediaRef(PUBLIC_URL, null)).toEqual({ kind: 'object', path: PATH });
    expect(familyMediaObjectPath(PUBLIC_URL, null)).toBe(PATH);
  });
});

function signer(result: Awaited<ReturnType<ReturnType<FamilyMediaSigner['storage']['from']>['createSignedUrls']>>) {
  const createSignedUrls = vi.fn(async () => result);
  const from = vi.fn(() => ({ createSignedUrls }));
  return { client: { storage: { from } } as FamilyMediaSigner, from, createSignedUrls };
}

describe('signFamilyMediaRefs', () => {
  it('signs every distinct object in one round trip, against this bucket', async () => {
    const other = `${FAMILY}/photos/second.jpg`;
    const { client, from, createSignedUrls } = signer({
      data: [
        { path: PATH, signedUrl: `${ORIGIN}/storage/v1/object/sign/family-media/${PATH}?token=t1`, error: null },
        { path: other, signedUrl: `${ORIGIN}/storage/v1/object/sign/family-media/${other}?token=t2`, error: null },
      ],
      error: null,
    });
    const gif = 'https://media.giphy.com/media/abc/giphy.gif';
    const map = await signFamilyMediaRefs(client, [PUBLIC_URL, PATH, other, gif, PUBLIC_URL, null], 120, ORIGIN);

    expect(from).toHaveBeenCalledWith('family-media');
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls).toHaveBeenCalledWith([PATH, other], 120);
    expect(map.get(PUBLIC_URL)).toMatch(/token=t1$/);
    expect(map.get(PATH)).toMatch(/token=t1$/);
    expect(map.get(other)).toMatch(/token=t2$/);
    expect(map.get(gif)).toBe(gif);
  });

  it('never falls back to the stored public URL', async () => {
    // Refused per object (not a member of that family) ...
    const refused = signer({ data: [{ path: PATH, signedUrl: '', error: 'Object not found' }], error: null });
    expect((await signFamilyMediaRefs(refused.client, [PUBLIC_URL], 60, ORIGIN)).get(PUBLIC_URL)).toBeNull();
    // ... a failed call ...
    const failed = signer({ data: null, error: { message: 'boom' } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await signFamilyMediaRefs(failed.client, [PUBLIC_URL], 60, ORIGIN)).get(PUBLIC_URL)).toBeNull();
    // ... and a thrown one.
    const thrown = { storage: { from: () => ({ createSignedUrls: async () => { throw new Error('network'); } }) } } as unknown as FamilyMediaSigner;
    expect((await signFamilyMediaRefs(thrown, [PUBLIC_URL], 60, ORIGIN)).get(PUBLIC_URL)).toBeNull();
    err.mockRestore();
  });

  it('does not call Storage when nothing needs signing', async () => {
    const { client, createSignedUrls } = signer({ data: [], error: null });
    const map = await signFamilyMediaRefs(client, ['https://example.com/a.png', 'javascript:x', ''], 60, ORIGIN);
    expect(createSignedUrls).not.toHaveBeenCalled();
    expect(map.get('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(map.get('javascript:x')).toBeNull();
  });
});
