import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeIdea } from '@/lib/feedback/board';

/**
 * A feedback idea's `image_url` is rendered as an <img> in the SUPER ADMIN's
 * browser. It was free text, so any signed-in user could make that browser
 * fetch a URL of their choosing — a beacon reporting when an admin looked at the
 * idea, and from what address. The uploader only ever produces this project's
 * own feedback-attachments URL; that is now the only thing accepted, at submit
 * AND at render (RLS lets a row be inserted without passing through the action).
 */

const OWN = 'https://abcd.supabase.co/storage/v1/object/public/feedback-attachments/11111111-2222-4333-8444-555555555555/0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b.png';
const draft = (imageUrl: string) => ({ title: 'Dark mode please', category: 'other', impact: 'helpful', audience: 'me', kind: 'idea', imageUrl });

describe('a feedback screenshot is not a beacon', () => {
  it('accepts the uploader\'s own attachment URL, and no attachment', () => {
    const own = normalizeIdea(draft(OWN) as never);
    expect(own.ok && own.value.imageUrl).toBe(OWN);
    const none = normalizeIdea(draft('') as never);
    expect(none.ok && none.value.imageUrl).toBeNull();
  });

  it('refuses any other URL', () => {
    for (const bad of [
      'https://tracker.example/pixel.gif?who=admin',
      'https://abcd.supabase.co/storage/v1/object/public/family-media/x/y.png',
      'https://abcd.supabase.co/storage/v1/object/public/feedback-attachments/not-a-user/x.png',
      'https://abcd.supabase.co/storage/v1/object/public/feedback-attachments/11111111-2222-4333-8444-555555555555/../x.png',
      'javascript:alert(1)',
    ]) expect(normalizeIdea(draft(bad) as never).ok, bad).toBe(false);
  });

  it('the admin view re-checks before fetching', () => {
    const src = readFileSync(join(__dirname, '..', 'components/admin/feedback-admin.tsx'), 'utf8');
    expect(src).toMatch(/idea\.image_url && feedbackAttachmentPathFromUrl\(idea\.image_url, process\.env\.NEXT_PUBLIC_SUPABASE_URL\) && \(/);
  });
});
