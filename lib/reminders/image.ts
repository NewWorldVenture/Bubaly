// lib/reminders/image.ts — when a reminder's photo leaves the bucket.
//
// A reminder's image is uploaded to the PUBLIC `family-media` bucket the
// moment it is picked, under `<family>/reminders/`, and the row keeps its
// public URL. Nothing ever removed one: not a photo replaced or cleared before
// saving, not the upload of a form closed unsaved or refused, not the old
// photo an edit replaced, and not the photo of a deleted reminder. Each stayed
// readable at its URL by anyone holding it, for good, with nothing left in the
// product pointing at it — the H2 / SEC-015 defect closet, inventory and
// photos already fixed. A deleted reminder's URL had been sent to every
// member's client, a member removed since included.
//
// One photo can belong to several rows: completing a recurring reminder
// spawns the next occurrence with the same `image_url`, and the completed one
// stays as history. So a photo goes only when NO reminder of the family points
// at it any more, and a failed check keeps it: a stray object is the lesser
// harm than a reminder whose photo is gone.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { releaseFamilyMedia } from '@/lib/storage/family-media';
import { describeDbError } from '@/lib/supabase/errors';

export const REMINDER_IMAGE_FOLDER = 'reminders';

/**
 * Remove a reminder photo that no reminder of the family points at. Only an
 * object under `<familyId>/reminders/` is ever removed (releaseFamilyMedia);
 * an external URL, another folder or another family's object is left alone.
 */
export async function releaseReminderImage(
  client: SupabaseClient<Database>,
  familyId: string,
  ref: string | null | undefined,
): Promise<{ error: string | null }> {
  if (!ref || !familyId) return { error: null };
  const { data, error } = await client.from('family_reminders').select('id')
    .eq('family_id', familyId).eq('image_url', ref).limit(1);
  if (error) return { error: describeDbError(error, 'Could not check whether the photo is still in use.') };
  if (data?.length) return { error: null };
  return releaseFamilyMedia(client, ref, { familyId, folder: REMINDER_IMAGE_FOLDER });
}
