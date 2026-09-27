import type { SupabaseBrowser } from '@/lib/supabase/types';
import { removeConfirmed } from '@/lib/storage/confirm-removal';

import { FEEDBACK_ATTACHMENTS_BUCKET, feedbackAttachmentPathFromUrl } from './feedback-attachment-url';

export { FEEDBACK_ATTACHMENTS_BUCKET, feedbackAttachmentPathFromUrl } from './feedback-attachment-url';
export const FEEDBACK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The storage path for a stored attachment value, whether it is a bare path or
 * one of the public URLs this bucket used to hand out.
 *
 * The bucket is private as of 0450, so `getPublicUrl` no longer produces
 * anything that resolves and new uploads record the path itself. Rows written
 * before that still hold the full `/storage/v1/object/public/...` URL, and they
 * are not rewritten: this reads either, and the admin console signs whatever
 * comes back. A value that is neither — an external link, a malformed string,
 * a path that escapes its folder — returns null rather than something to sign.
 */
export function feedbackAttachmentPath(value: string, expectedOrigin?: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (raw.includes('://')) return feedbackAttachmentPathFromUrl(raw, expectedOrigin);
  const parts = raw.split('/');
  if (parts.length < 2 || !UUID.test(parts[0])) return null;
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return raw;
}
export async function removeFeedbackAttachmentPath(
  supabase: SupabaseBrowser,
  path: string,
): Promise<{ error: string | null }> {
  // SEC-015: `error === null` is not evidence the object is gone.
  return removeConfirmed(supabase.storage.from(FEEDBACK_ATTACHMENTS_BUCKET), path);
}
