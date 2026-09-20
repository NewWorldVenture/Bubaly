import { describe, expect, it, vi } from 'vitest';
import { feedbackAttachmentPath, feedbackAttachmentPathFromUrl } from '@/lib/storage/feedback-attachments';
import { signFeedbackAttachments } from '@/lib/storage/feedback-attachment-signing';

// F-E05. `feedback-attachments` was a public bucket carrying an unscoped read
// policy, so every object was readable by the public path AND the authenticated
// path, by anyone who ever saw the URL. These are screenshots of a real
// family's calendar, children's names and balances, taken at the moment
// something went wrong.
//
// 0325 makes the bucket private. That turns every stored value into something
// an `<img src>` cannot load, so the one surface that draws them — the
// super-admin triage console — resolves each to a short-lived signed URL. This
// covers the resolver, and the two properties that stop the fix becoming its
// own bug: an old public URL still resolves, and a value that resolves to
// nothing comes back NULL rather than being passed through.

const ORIGIN = 'https://abcdefghijklmnop.supabase.co';
const OWNER = '7f000000-0000-4000-8000-00000000fe11';
const PATH = `${OWNER}/2f8a1c44-1111-4222-8333-444455556666.png`;
const PUBLIC_URL = `${ORIGIN}/storage/v1/object/public/feedback-attachments/${PATH}`;

describe('reading the stored attachment value', () => {
  it('accepts a bare path — what an upload records as of 0325', () => {
    expect(feedbackAttachmentPath(PATH)).toBe(PATH);
    expect(feedbackAttachmentPath(`  ${PATH}  `)).toBe(PATH);
  });

  it('still accepts the public URL rows written before 0325 hold', () => {
    // Those rows are deliberately not rewritten, so this is the only thing
    // keeping their screenshots visible in triage.
    expect(feedbackAttachmentPath(PUBLIC_URL)).toBe(PATH);
    expect(feedbackAttachmentPath(PUBLIC_URL, ORIGIN)).toBe(PATH);
    expect(feedbackAttachmentPathFromUrl(PUBLIC_URL)).toBe(PATH);
  });

  it('refuses anything that is not an object in this bucket', () => {
    expect(feedbackAttachmentPath('')).toBeNull();
    expect(feedbackAttachmentPath('   ')).toBeNull();
    expect(feedbackAttachmentPath('https://evil.test/whatever.png')).toBeNull();
    expect(feedbackAttachmentPath(`${ORIGIN}/storage/v1/object/public/documents/${PATH}`)).toBeNull();
    // A first segment that is not a user id is not one of ours.
    expect(feedbackAttachmentPath('not-a-uuid/shot.png')).toBeNull();
    // No folder at all, and traversal out of one.
    expect(feedbackAttachmentPath('shot.png')).toBeNull();
    expect(feedbackAttachmentPath(`${OWNER}/../documents/secret.pdf`)).toBeNull();
    expect(feedbackAttachmentPath(`${OWNER}//shot.png`)).toBeNull();
    // A URL from another project, when the origin is pinned.
    expect(feedbackAttachmentPath(PUBLIC_URL, 'https://other.supabase.co')).toBeNull();
  });
});

type SignedEntry = { path: string; signedUrl: string; error?: string | null };

function storage(result: { data?: SignedEntry[] | null; error?: unknown }) {
  const createSignedUrls = vi.fn(
    async (paths: string[], _ttl: number) => ({ data: result.data ?? null, error: result.error ?? null }),
  );
  return { client: { storage: { from: () => ({ createSignedUrls }) } }, createSignedUrls };
}

describe('resolving them for the one surface that shows them', () => {
  it('signs each distinct object once, whatever form the row stored it in', async () => {
    const { client, createSignedUrls } = storage({
      data: [{ path: PATH, signedUrl: `${ORIGIN}/storage/v1/object/sign/feedback-attachments/${PATH}?token=t`, error: null }],
    });
    const rows = [
      { id: 'a', image_url: PATH },
      { id: 'b', image_url: PUBLIC_URL },   // the same object, stored the old way
      { id: 'c', image_url: null },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await signFeedbackAttachments(client as any, rows);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls.mock.calls[0][0]).toEqual([PATH]);
    expect(out[0].image_url).toContain('/object/sign/');
    expect(out[1].image_url).toBe(out[0].image_url);
    expect(out[2].image_url).toBeNull();
  });

  it('returns null for a value it cannot resolve, rather than the original', async () => {
    // Passing the original through would put a dead public URL into an <img
    // src> and make a private bucket look like a broken one — and it is the
    // only way an external URL could reach that tag.
    const { client, createSignedUrls } = storage({ data: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await signFeedbackAttachments(client as any, [{ id: 'a', image_url: 'https://evil.test/track.png' }]);
    expect(out[0].image_url).toBeNull();
    expect(createSignedUrls).not.toHaveBeenCalled();
  });

  it('does not hand back an unsigned URL when signing fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = storage({ data: null, error: { message: 'storage down' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await signFeedbackAttachments(client as any, [{ id: 'a', image_url: PATH }]);
    expect(out[0].image_url).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('drops an entry the storage API reported an error for', async () => {
    const { client } = storage({
      data: [{ path: PATH, signedUrl: '', error: 'Object not found' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await signFeedbackAttachments(client as any, [{ id: 'a', image_url: PATH }]);
    expect(out[0].image_url).toBeNull();
  });

  it('asks for nothing when no row carries an attachment', async () => {
    const { client, createSignedUrls } = storage({ data: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await signFeedbackAttachments(client as any, [{ id: 'a', image_url: null }]);
    expect(createSignedUrls).not.toHaveBeenCalled();
    expect(out[0].image_url).toBeNull();
  });
});

describe('the board does not carry what it does not draw', () => {
  it('the public feedback page no longer selects image_url', async () => {
    const { readFileSync } = await import('node:fs');
    const page = readFileSync('app/(app)/feedback/page.tsx', 'utf8');
    const select = /\.select\('([^']*feedback[^']*|[^']*title[^']*)'\)/.exec(page)?.[1] ?? page;
    expect(select).not.toContain('image_url');
    // …and the admin console, which does draw them, signs them.
    expect(readFileSync('app/(app)/admin/feedback/page.tsx', 'utf8')).toContain('signFeedbackAttachments');
  });
});
