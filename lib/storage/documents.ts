// Client-side helpers for the private "documents" Storage bucket.
// Path convention: {family_id}/{folder}/{timestamp}-{safe filename} — the family_id
// folder segment is what storage RLS checks via is_family_member(), so every upload
// must go through buildFamilyPath() to stay inside the caller's own family folder.
import { removeConfirmed } from '@/lib/storage/confirm-removal';
import type { SupabaseBrowser } from '@/lib/supabase/types';
import { describeActionError } from '@/lib/supabase/errors';

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

function hasSafeDocumentSegments(path: unknown): path is string {
  return typeof path === 'string' &&
    !/[\\?#%\u0000-\u001f\u007f]/.test(path) &&
    path.split('/').every(segment => !!segment && segment !== '.' && segment !== '..');
}

/** PostgreSQL accepts braces and optional hyphens after each four hex digits. */
function documentFamilyIdentity(value: string): string | null {
  return /^(?:\{[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}\}|[0-9a-f]{4}(?:-?[0-9a-f]{4}){7})$/i.test(value)
    ? value.replace(/[{}-]/g, '').toLowerCase()
    : null;
}

/**
 * Bind a stored object name to the family whose document row was authorized.
 * Background reads may hold a service client, so Storage RLS is not this check.
 * UUID aliases compare by identity, but the caller must sign the ORIGINAL path:
 * changing its spelling would request a different object. A terminal space is
 * refused because URL parsing strips it (and can then normalize a dot segment).
 */
export function isFamilyDocumentPath(familyId: string, path: unknown): path is string {
  if (!hasSafeDocumentSegments(path) || path.endsWith(' ')) return false;
  const segments = path.split('/');
  if (segments.length < 2) return false;
  if (segments[0] === familyId) return true;
  const expected = documentFamilyIdentity(familyId);
  return expected !== null && documentFamilyIdentity(segments[0]) === expected;
}

/** A preallocated upload keeps its exact family/folder prefix, without alias normalization. */
export function isReservedDocumentPath(familyId: string, folder: string, path: string): boolean {
  return path.startsWith(`${familyId}/${folder}/`) && hasSafeDocumentSegments(path);
}

export async function uploadFamilyDocument(
  supabase: SupabaseBrowser,
  { familyId, folder, file, reservedPath }: { familyId: string; folder: string; file: File; reservedPath?: string },
): Promise<{ path: string | null; error: string | null }> {
  if (file.size > MAX_BYTES) {
    return { path: null, error: 'File is too large (25 MB limit).' };
  }
  // FilesHub reserves its protective documents row before bytes move. A retry
  // may replace only that same reservation's bytes, after rechecking the row.
  // All other callers retain their existing new-object-only upload behavior.
  if (reservedPath !== undefined && !isReservedDocumentPath(familyId, folder, reservedPath)) {
    return { path: null, error: 'The upload destination is invalid.' };
  }
  const path = reservedPath ?? buildFamilyPath(familyId, folder, file.name);
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: reservedPath !== undefined,
  });
  if (error) return { path: null, error: describeActionError(error) };
  return { path, error: null };
}

export async function getDocumentSignedUrl(
  supabase: SupabaseBrowser,
  path: string,
  expiresInSeconds = 120,
): Promise<{ url: string | null; error: string | null }> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data) return { url: null, error: describeActionError(error, 'Could not create a link') };
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
  return removeConfirmed(supabase.storage.from(BUCKET), path);
}
