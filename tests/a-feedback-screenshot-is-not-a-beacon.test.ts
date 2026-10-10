import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeIdea } from '@/lib/feedback/board';
import { feedbackAttachmentPathFromSignedUrl } from '@/lib/storage/feedback-attachment-url';
import { signFeedbackAttachments } from '@/lib/storage/feedback-attachment-signing';

/**
 * A feedback idea's `image_url` is rendered as an <img> in the SUPER ADMIN's
 * browser. It was free text, so any signed-in user could make that browser
 * fetch a URL of their choosing — a beacon reporting when an admin looked at the
 * idea, and from what address. The uploader only ever produces this project's
 * own feedback-attachments URL; that is now the only thing accepted, at submit
 * AND at render (RLS lets a row be inserted without passing through the action).
 *
 * The bucket then went private (0450, F-E05): the uploader records a bare
 * `<user>/<object>` path and the console is handed a signed URL. The checks
 * were not moved with it, so every screenshot was refused at submit and none
 * rendered (tests/e2e/a-feedback-image-is-not-a-beacon.spec.ts reproduces
 * both on main). The submit check now reads either stored form, in the
 * submitter's own folder; the render check reads the signed form.
 *
 * The folder binding is the submit action's alone. 0197's insert policy lets
 * an author write any image_url directly, and the console's signer (which
 * predates this) resolves any value naming an object in this bucket, from any
 * origin and in any member's folder. What reaches the console's <img> is still
 * only this project's signed URL, and only the super admin sees it; the last
 * describe pins both halves.
 */

const ORIGIN = 'https://abcd.supabase.co';
const USER = '11111111-2222-4333-8444-555555555555';
const PATH = `${USER}/0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b.png`;
const OWN = `${ORIGIN}/storage/v1/object/public/feedback-attachments/${PATH}`;
const SIGNED = `${ORIGIN}/storage/v1/object/sign/feedback-attachments/${PATH}?token=eyJ.payload.sig`;
const draft = (imageUrl: string) => ({ title: 'Dark mode please', category: 'other', impact: 'helpful', audience: 'me', kind: 'idea', imageUrl });

describe('a feedback screenshot is not a beacon', () => {
  it('accepts what the uploader records — the bare path (0450) — and the older public URL, storing the path; and no attachment', () => {
    const bare = normalizeIdea(draft(PATH) as never, { authorId: USER });
    expect(bare.ok && bare.value.imageUrl).toBe(PATH);
    const own = normalizeIdea(draft(OWN) as never, { authorId: USER });
    expect(own.ok && own.value.imageUrl).toBe(PATH);
    const none = normalizeIdea(draft('') as never, { authorId: USER });
    expect(none.ok && none.value.imageUrl).toBeNull();
  });

  it('refuses an attachment in another member\'s folder', () => {
    const other = '99999999-8888-4777-8666-555555555555';
    expect(normalizeIdea(draft(PATH) as never, { authorId: other }).ok).toBe(false);
    expect(normalizeIdea(draft(OWN) as never, { authorId: other }).ok).toBe(false);
  });

  it('refuses any other URL', () => {
    for (const bad of [
      'https://tracker.example/pixel.gif?who=admin',
      'https://abcd.supabase.co/storage/v1/object/public/family-media/x/y.png',
      'https://abcd.supabase.co/storage/v1/object/public/feedback-attachments/not-a-user/x.png',
      'https://abcd.supabase.co/storage/v1/object/public/feedback-attachments/11111111-2222-4333-8444-555555555555/../x.png',
      'javascript:alert(1)',
      `${USER}/../x.png`, `${USER}//x.png`, 'not-a-user/x.png', 'x.png', SIGNED,
    ]) expect(normalizeIdea(draft(bad) as never, { authorId: USER }).ok, bad).toBe(false);
  });

  it('the admin view re-checks the signed URL it is handed before fetching', () => {
    const src = readFileSync(join(__dirname, '..', 'components/admin/feedback-admin.tsx'), 'utf8');
    expect(src).toMatch(/idea\.image_url && feedbackAttachmentPathFromSignedUrl\(idea\.image_url, process\.env\.NEXT_PUBLIC_SUPABASE_URL\) && \(/);
  });
});

describe('the console renders only a signed URL for an object of this bucket', () => {
  it('accepts one, with its token, from this project', () => {
    expect(feedbackAttachmentPathFromSignedUrl(SIGNED, ORIGIN)).toBe(PATH);
  });

  it('refuses the rest', () => {
    for (const bad of [
      OWN, // the public form, which a private bucket does not serve
      SIGNED.replace('?token=eyJ.payload.sig', ''),
      SIGNED.replace('feedback-attachments', 'family-media'),
      SIGNED.replace(ORIGIN, 'https://other.supabase.co'),
      `${ORIGIN}/storage/v1/object/sign/feedback-attachments/${USER}/../x.png?token=t`,
      `${ORIGIN}/storage/v1/object/sign/feedback-attachments/not-a-user/x.png?token=t`,
      'https://tracker.example/pixel.gif?token=t', 'javascript:alert(1)', '',
    ]) expect(feedbackAttachmentPathFromSignedUrl(bad, ORIGIN), bad).toBeNull();
  });

  it('every value the page hands over passes it, and nothing planted does (the signer, then the render check)', async () => {
    // What Storage answers to createSignedUrls, in its own shape.
    const createSignedUrls = vi.fn(async (paths: string[]) => ({
      data: paths.map((path) => ({ path, error: null, signedUrl: `${ORIGIN}/storage/v1/object/sign/feedback-attachments/${path}?token=eyJ.${path.length}.sig` })),
      error: null,
    }));
    const client = { storage: { from: () => ({ createSignedUrls }) } };
    const rows = [PATH, OWN, 'https://tracker.example/pixel.gif', `${ORIGIN}/storage/v1/object/public/family-media/${PATH}`, 'javascript:alert(1)']
      .map((image_url) => ({ image_url }));
    const signed = await signFeedbackAttachments(client as never, rows);
    const rendered = signed.map((r) => (r.image_url && feedbackAttachmentPathFromSignedUrl(r.image_url, ORIGIN)) || null);
    expect(rendered).toEqual([PATH, PATH, null, null, null]);
  });
});

describe('where the submitter-folder binding holds: at submit, not in the console', () => {
  const OTHER = '99999999-8888-4777-8666-555555555555';
  const OTHERS_OBJECT = `${OTHER}/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.png`;
  const signer = () => {
    const createSignedUrls = vi.fn(async (paths: string[]) => ({
      data: paths.map((path) => ({ path, error: null, signedUrl: `${ORIGIN}/storage/v1/object/sign/feedback-attachments/${path}?token=eyJ.t.sig` })),
      error: null,
    }));
    return { client: { storage: { from: () => ({ createSignedUrls }) } }, createSignedUrls };
  };

  it('the action refuses another member\'s object, and a foreign host naming this bucket\'s path', () => {
    // The action checks the origin against the configured project URL.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
    try {
      expect(normalizeIdea(draft(OTHERS_OBJECT) as never, { authorId: USER }).ok).toBe(false);
      expect(normalizeIdea(draft(`https://tracker.example/storage/v1/object/public/feedback-attachments/${PATH}`) as never, { authorId: USER }).ok).toBe(false);
      expect(normalizeIdea(draft(OWN) as never, { authorId: USER }).ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a row written past the action that names another member\'s object is still signed: the console does not bind authorship', async () => {
    const { client, createSignedUrls } = signer();
    const [row] = await signFeedbackAttachments(client as never, [{ image_url: OTHERS_OBJECT, author_id: USER }]);
    expect(createSignedUrls).toHaveBeenCalledWith([OTHERS_OBJECT], expect.any(Number));
    expect(row.image_url && feedbackAttachmentPathFromSignedUrl(row.image_url, ORIGIN)).toBe(OTHERS_OBJECT);
  });

  it('a row naming this bucket\'s path on a foreign host is read as the local object: the <img> gets this project\'s signed URL, never that host', async () => {
    const { client } = signer();
    const [row] = await signFeedbackAttachments(client as never, [{ image_url: `https://tracker.example/storage/v1/object/public/feedback-attachments/${PATH}` }]);
    expect(row.image_url).toMatch(new RegExp(`^${ORIGIN.replace(/[.]/g, '\\.')}/storage/v1/object/sign/feedback-attachments/`));
    expect(row.image_url).not.toContain('tracker.example');
    expect(row.image_url && feedbackAttachmentPathFromSignedUrl(row.image_url, ORIGIN)).toBe(PATH);
  });
});
