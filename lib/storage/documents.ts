// Client-side helpers for the private "documents" Storage bucket.
// Path convention: {family_id}/{folder}/{timestamp}-{safe filename} — the family_id
// folder segment is what storage RLS checks via is_family_member(), so every upload
// must go through buildFamilyPath() to stay inside the caller's own family folder.
import type { SupabaseBrowser } from '@/lib/supabase/types';

const BUCKET = 'documents';
/** The "documents" bucket's file_size_limit (migration 0007 = 26214400). Exported
 *  so UI can pre-check + display the real limit instead of guessing. */
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
export const DOCUMENT_MAX_MB = 25;
const MAX_BYTES = DOCUMENT_MAX_BYTES;

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-120);
}

export function buildFamilyPath(familyId: string, folder: string, fileName: string): string {
  return `${familyId}/${folder}/${Date.now()}-${sanitizeFileName(fileName)}`;
}

export async function uploadFamilyDocument(
  supabase: SupabaseBrowser,
  { familyId, folder, file }: { familyId: string; folder: string; file: File },
): Promise<{ path: string | null; error: string | null }> {
  if (file.size > MAX_BYTES) {
    return { path: null, error: 'File is too large (25 MB limit).' };
  }
  const path = buildFamilyPath(familyId, folder, file.name);
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) return { path: null, error: error.message };
  return { path, error: null };
}

export async function getDocumentSignedUrl(
  supabase: SupabaseBrowser,
  path: string,
  expiresInSeconds = 120,
): Promise<{ url: string | null; error: string | null }> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data) return { url: null, error: error?.message ?? 'Could not create a link' };
  return { url: data.signedUrl, error: null };
}

/**
 * Remove one document object and CONFIRM it is gone.
 *
 * SEC-015. Storage reports a delete the policy refused exactly as it reports a
 * delete of something that was never there: `error: null`, `data: []`. Measured
 * against the local stack:
 *
 *   removed       -> error null, data ['<key>']
 *   refused       -> error null, data []
 *   never existed -> error null, data []
 *
 * So `error === null` is not evidence the object is gone, and the callers all
 * deleted the `documents` row next. That matters because
 * `document_object_is_restricted(name)` — the storage policy that hides a
 * secure-vault file from a child — works by finding the row. With the row gone
 * and the object still there, the guard finds nothing, returns false, and every
 * family member can list and download the file. Proven on the local stack: a
 * child got `DENIED (Object not found)` with the row present and
 * `ALLOWED — "THE FAMILY WILL — private"` with the row deleted.
 *
 * An empty result is therefore checked rather than trusted: if the object is
 * still listed, this reports a failure so the caller keeps the row. If it is
 * genuinely absent — a retry after a partial delete — the caller may proceed,
 * so a half-finished delete does not strand a row forever.
 */
export async function removeFamilyDocument(
  supabase: SupabaseBrowser,
  path: string,
): Promise<{ error: string | null }> {
  const { data, error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) return { error: error.message };
  if (data?.some((object) => object.name === path)) return { error: null };

  const cut = path.lastIndexOf('/');
  const folder = cut > 0 ? path.slice(0, cut) : '';
  const name = path.slice(cut + 1);
  const listed = await supabase.storage.from(BUCKET).list(folder, { search: name, limit: 100 });
  if (listed.error) return { error: listed.error.message };
  // `search` is a prefix match, so the name is compared exactly.
  return listed.data?.some((object) => object.name === name)
    ? { error: 'The file could not be removed.' }
    : { error: null };
}
