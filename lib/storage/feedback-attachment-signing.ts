import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FEEDBACK_ATTACHMENTS_BUCKET, feedbackAttachmentPath } from '@/lib/storage/feedback-attachments';

// The idea board's attachments, resolved for the one surface that shows them.
//
// `feedback-attachments` was a PUBLIC bucket carrying an unscoped
// `for select using (bucket_id = 'feedback-attachments')` policy, so every
// object was readable by the public path AND the authenticated path, by anyone
// who ever saw the URL. These are screenshots taken at the moment something in
// the product went wrong, which is to say screenshots of a real family's
// calendar, children's names and balances (F-E05).
//
// What made this cheap to close is that exactly one place renders them:
// components/admin/feedback-admin.tsx, behind the super-admin gate. The public
// board selects image_url and never draws it — so the fix is a private bucket
// plus a signed URL minted here, for that one page, rather than the
// store-the-path-and-resolve-everywhere migration family-media needs.
//
// Signed rather than served through an authenticated read because an <img src>
// cannot carry an Authorization header. The TTL is short: the console is a
// working session, not a link to keep.
const DEFAULT_TTL_SECONDS = 600;

type WithImage = { image_url: string | null };

/**
 * Replace each row's stored attachment value with a short-lived signed URL.
 *
 * A row whose value cannot be resolved to an object in this bucket comes back
 * with `image_url: null` — not with the original string. Passing the original
 * through would put a dead public URL into an `<img src>` and make a private
 * bucket look like a broken one, and would be the only way an external URL
 * could reach that tag.
 */
export async function signFeedbackAttachments<T extends WithImage>(
  supabase: SupabaseClient<never>,
  rows: T[],
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<T[]> {
  const paths = new Map<string, string | null>();
  for (const row of rows) {
    const path = row.image_url ? feedbackAttachmentPath(row.image_url) : null;
    if (path && !paths.has(path)) paths.set(path, null);
  }
  if (paths.size === 0) return rows.map((row) => (row.image_url ? { ...row, image_url: null } : row));

  // One round trip for the page, rather than one per idea.
  const { data, error } = await supabase.storage
    .from(FEEDBACK_ATTACHMENTS_BUCKET)
    .createSignedUrls([...paths.keys()], ttlSeconds);
  if (error) {
    // A failure to sign is a failure to show the screenshot, and nothing more.
    // The triage console still lists every idea; it must not 500 because one
    // bucket is unavailable.
    console.error('[feedback] could not sign attachment URLs', error);
    return rows.map((row) => (row.image_url ? { ...row, image_url: null } : row));
  }
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl && !entry.error) paths.set(entry.path, entry.signedUrl);
  }

  return rows.map((row) => {
    if (!row.image_url) return row;
    const path = feedbackAttachmentPath(row.image_url);
    return { ...row, image_url: (path && paths.get(path)) || null };
  });
}
