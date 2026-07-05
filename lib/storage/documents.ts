// Client-side helpers for the private "documents" Storage bucket.
// Path convention: {family_id}/{folder}/{timestamp}-{safe filename} — the family_id
// folder segment is what storage RLS checks via is_family_member(), so every upload
// must go through buildFamilyPath() to stay inside the caller's own family folder.
import type { SupabaseBrowser } from '@/lib/supabase/types';

const BUCKET = 'documents';

/** Upload ceiling — matches the bucket's file_size_limit. Exported so UIs can
 *  pre-check on file select and show the limit, instead of failing post-upload. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const UPLOAD_LIMIT_LABEL = '25 MB';
/** Pure guard so the check is identical on the client and inside the uploader. */
export function isOverUploadLimit(size: number): boolean { return size > MAX_UPLOAD_BYTES; }
const MAX_BYTES = MAX_UPLOAD_BYTES;

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

export async function removeFamilyDocument(
  supabase: SupabaseBrowser,
  path: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  return { error: error?.message ?? null };
}
