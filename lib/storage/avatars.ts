// Client-side helpers for the public "avatars" Storage bucket.
// Bucket setup required: create a PUBLIC bucket named "avatars" in Supabase
// Storage with a 5 MB file size limit and RLS policy:
//   INSERT: auth.uid() = (storage.foldername(name))[1]::uuid
//   SELECT: true (public read)
import type { SupabaseBrowser } from '@/lib/supabase/types';
import { unguessableObjectName } from './object-name';
import { describeActionError } from '@/lib/supabase/errors';

/** The public bucket every profile photo lives in (saveUserProfile removes a superseded one from it). */
export const AVATAR_BUCKET = 'avatars';
const BUCKET = AVATAR_BUCKET;
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
  // timestamp name left every avatar a user ever uploaded enumerable. The
  // superseded photo leaves the bucket when the profile is saved
  // (lib/server/profiles.ts saveUserProfile, through avatarObjectPathFor below).
  const path = `${userId}/${unguessableObjectName(file.name.toLowerCase())}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: true,
  });
  if (error) return { url: null, error: describeActionError(error) };

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { url: publicUrl, error: null };
}

/**
 * The object an avatar URL names, when it is THIS user's own:
 * `…/storage/v1/object/public/avatars/<userId>/<name>` → `<userId>/<name>`.
 *
 * Null for anything else — another user's folder (a crafted row could name
 * one), a nested path, an external picture, a `data:` URI, an unreadable
 * value — none of which is this user's photo to delete. The caller
 * (saveUserProfile) removes only what this answers, the way releaseFamilyMedia
 * removes only an object under its own family's folder.
 */
export function avatarObjectPathFor(userId: string, url: string | null | undefined): string | null {
  if (!userId || !url || typeof url !== 'string') return null;
  let pathname: string;
  try {
    pathname = new URL(url, 'https://avatar-url.invalid').pathname;
  } catch {
    return null;
  }
  const match = /^\/storage\/v1\/object\/public\/avatars\/(.+)$/.exec(pathname);
  if (!match) return null;
  let objectPath: string;
  try {
    objectPath = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const prefix = `${userId}/`;
  if (!objectPath.startsWith(prefix)) return null;
  const name = objectPath.slice(prefix.length);
  if (!name || name.includes('/') || name.includes('..')) return null;
  return objectPath;
}
