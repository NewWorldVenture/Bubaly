// Client-side helpers for the public "avatars" Storage bucket.
// Bucket setup required: create a PUBLIC bucket named "avatars" in Supabase
// Storage with a 5 MB file size limit and RLS policy:
//   INSERT: auth.uid() = (storage.foldername(name))[1]::uuid
//   SELECT: true (public read)
import type { SupabaseBrowser } from '@/lib/supabase/types';
import { unguessableObjectName } from './object-name';
import { describeActionError } from '@/lib/supabase/errors';

const BUCKET = 'avatars';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

export async function uploadAvatar(
  supabase: SupabaseBrowser,
  userId: string,
  file: File,
): Promise<{ url: string | null; error: string | null }> {
  if (file.size > MAX_BYTES) return { url: null, error: 'Max file size is 5 MB' };
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { url: null, error: 'Only JPEG, PNG, WebP, GIF, and AVIF images are allowed' };
  }

  // Public bucket: the object name carries the entropy, not the folder. A
  // timestamp name left every avatar a user ever uploaded enumerable, and they
  // are never deleted.
  const path = `${userId}/${unguessableObjectName(file.name.toLowerCase())}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: true,
  });
  if (error) return { url: null, error: describeActionError(error) };

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { url: publicUrl, error: null };
}
