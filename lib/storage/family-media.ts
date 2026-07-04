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
