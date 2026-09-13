// Client-side size guard for the `family-media` Storage bucket (Photos,
// Create Memory, Messages attachments). Matches the bucket's 25 MB
// file_size_limit so oversize files fail fast with a friendly message instead
// of a raw storage error mid-upload.

export const FAMILY_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const FAMILY_MEDIA_MAX_LABEL = '25 MB';

/** Split files into those within the bucket limit and those that are too large. */
export function partitionBySize<T extends { size: number }>(files: T[]): { ok: T[]; tooBig: T[] } {
  const ok: T[] = [];
  const tooBig: T[] = [];
  for (const f of files) (f.size > FAMILY_MEDIA_MAX_BYTES ? tooBig : ok).push(f);
  return { ok, tooBig };
}

/** A ready-made "N skipped — over 25 MB" message, or null when nothing was too big. */
export function oversizeMessage(count: number): string | null {
  if (count <= 0) return null;
  return `${count} file${count === 1 ? '' : 's'} skipped — over the ${FAMILY_MEDIA_MAX_LABEL} limit.`;
}

/**
 * Build the object path for a family-media upload.
 *
 * The path is the only thing protecting these objects, so it may not be
 * guessable. `0216_family_media_bucket.sql` sets `public = true` deliberately —
 * consumers resolve attachments with `getPublicUrl` and existing rows already
 * store public URLs, so flipping the bucket to private would break every stored
 * link, and hardening reads to signed URLs is tracked separately. That decision
 * is what makes this function load-bearing: a public bucket serves
 * `/storage/v1/object/public/family-media/<path>` to anyone, with no session and
 * no RLS in the way. The family-scoped SELECT policy in that migration governs
 * authenticated Storage-API reads only.
 *
 * Four of the six upload sites used `${familyId}/<kind>/${Date.now()}.${ext}`.
 * A millisecond timestamp is not a secret: given a family id — which every
 * current AND FORMER member knows — a day is 86.4M values over three or four
 * plausible extensions, and uploads cluster in time, so a narrow window finds
 * them. Removing someone from a family did not remove their ability to read its
 * closet, inventory, message and reminder attachments, or to discover new ones.
 * Photos and Create-Memory already did this correctly; this is their approach,
 * in one place, for everyone.
 *
 * Existing objects keep their stored paths, so nothing already uploaded breaks.
 */
export function familyMediaPath(familyId: string, kind: string, fileName: string): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop() : undefined;
  // randomUUID needs a secure context; the fallback still has to be unguessable,
  // so it draws from the crypto RNG rather than Date.now() + Math.random().
  const unique = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${familyId}/${kind}/${unique}${ext ? `.${ext}` : ''}`;
}
