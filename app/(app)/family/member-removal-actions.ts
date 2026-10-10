'use server';

// A member who leaves a family takes their position with them.
//
// Removal is a soft delete (`family_members.is_active = false`), written from
// the family and settings screens on the manager's own session. Nothing touched
// the removed member's location rows, so the people they left — an ex-partner,
// a former caregiver's employer — could still read their last precise position
// and their whole movement history. This runs straight after a confirmed
// removal and clears it, with the service role because location_events is
// append-only for clients (0335).

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { forgetMemberLocation } from '@/lib/location/retention';

export async function forgetRemovedMemberLocationAction(memberId: string): Promise<{ ok: boolean }> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false };
  const familyId = ctx.active.familyId;
  // Only for a member of the caller's own family who really is removed: this
  // is not a way to blank an active member's location.
  const supabase = await createServer();
  const { data, error } = await supabase.from('family_members')
    .select('id, family_id, is_active').eq('id', memberId).eq('family_id', familyId).limit(1);
  if (error || !Array.isArray(data) || data.length !== 1 || data[0].family_id !== familyId || data[0].is_active !== false) {
    return { ok: false };
  }
  const forgotten = await forgetMemberLocation(createServiceClient(), familyId, memberId);
  if (!forgotten.ok) console.error('[family] removed member location was not cleared', { familyId, memberId, failures: forgotten.failures });
  return { ok: forgotten.ok };
}
