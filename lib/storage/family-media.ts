import { unguessableObjectName } from './object-name';
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
 * A storage path for an object in the `family-media` bucket.
 *
 * The object NAME must be unguessable, because this is the one bucket created
 * with `public = true` (0216: reads stay public so the stored getPublicUrl links
 * keep working; hardening them to signed URLs needs a data migration and is
 * tracked as the LB-009 follow-up). Until that lands, the only thing standing
 * between a stored object and anyone on the internet is that they cannot guess
 * its URL — and the first path segment, the family id, is not secret: it appears
 * in every public URL the family already shares.
 *
 * Four modules built this path as `${familyId}/${folder}/${Date.now()}.${ext}`.
 * A millisecond timestamp is enumerable: a day is 86.4 million values and the
 * extension set is tiny, but nobody has to sweep a whole day — a single shared
 * link reveals the family id AND the naming scheme, and a batch of uploads lands
 * in adjacent milliseconds. `messages` and `reminders` are the pointed cases:
 * those attachments are private conversations.
 *
 * `Date.now()` also collides. Two uploads inside one millisecond produce the
 * same path, and every caller passes `upsert: false`, so the second fails with a
 * storage error that reads like a bug rather than a name clash.
 *
 * randomUUID is 122 random bits. The fallback covers browsers without it (it is
 * unavailable on insecure origins) and still mixes in randomness rather than
 * leaning on the clock alone.
 *
 * The uploaded file's OWN extension rides along — `<uuid>.webp`, `<uuid>.HEIC` —
 * because the public URL is what an <img>, a download and the operating system
 * read the type from. A file that arrives without one keeps none: an invented
 * `.jpg` would label a PDF or a video as a photo, and unguessable does not mean
 * untyped. Both properties hold at once, which is the whole point of the helper.
 */
export function familyMediaPath(familyId: string, folder: string, fileName: string): string {
  return `${familyId}/${folder}/${unguessableObjectName(fileName)}`;
}
