import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { feedbackAttachmentPath } from '@/lib/storage/feedback-attachments';

// 0450 made the `feedback-attachments` bucket private, and the uploader began
// recording the object's PATH instead of a public URL. Its preview kept
// rendering `<img src={value}>`, so after every upload the family saw a broken
// image: a bare path like `355a…/b329….png` resolves against /feedback/ and
// 404s. Found by driving the feedback form in a browser against a local
// production build (the B14 retest of MAIN-F-E05). The preview now shows a
// short-lived signed URL for whatever path the value names.

const SRC = readFileSync('app/(app)/feedback/feedback-attachment-upload.tsx', 'utf8');

describe('the feedback screenshot preview is signed, not the raw stored value', () => {
  it('never renders the stored value as an image source', () => {
    expect(SRC).not.toMatch(/src=\{\s*value/);
  });

  it('signs the path the value names before showing it', () => {
    expect(SRC).toMatch(/createSignedUrl\(\s*path/);
    expect(SRC).toMatch(/feedbackAttachmentPath\(value/);
    expect(SRC).toMatch(/src=\{previewUrl\}/);
  });

  it('the value it signs is the path, for a new upload and for a row written before 0450', () => {
    const path = '355a3467-0be1-4e5a-86cb-ffe025639dc8/b329f01a-9f4d-4dfe-9192-9f758ba07128.png';
    expect(feedbackAttachmentPath(path)).toBe(path);
    expect(feedbackAttachmentPath(`https://x.supabase.co/storage/v1/object/public/feedback-attachments/${path}`, 'https://x.supabase.co')).toBe(path);
    expect(feedbackAttachmentPath('https://example.com/elsewhere.png', 'https://x.supabase.co')).toBeNull();
  });
});
