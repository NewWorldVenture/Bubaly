// lib/wishlists/release-claims.ts — a removed member's gift claims go back to the list.
//
// Removal is a soft delete (REMOVED_MEMBER_PATCH: is_active = false), so the
// ON DELETE SET NULL on wishlist_items.claimed_by never fires. And 0481's
// wishlist_item_write_guard lets only the claimer change a claim, through
// is_self_member, which a removed member no longer passes. A gift they had
// claimed stayed "Claimed" for every remaining giver (lib/wishlists/gifts.ts:
// claimed_by_other, never toggleable), and no member, a parent included, could
// free it. Both removal paths now release the claims with the service role
// (the guard admits it), as the hard delete's SET NULL would have: the claimer
// is cleared (with the time of the claim) and is_purchased is kept. A gift the
// removed member already bought still reads "Bought" (claimState 'purchased')
// and is not offered to be bought a second time; an unbought claim goes back
// on the list. Claims of a member removed before this existed are the owner's
// guard change and repair to free.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describeActionError } from '@/lib/supabase/errors';

export type GiftClaimRelease = { ok: true; released: number } | { ok: false };

/** Release every claim on a wish in `familyId` that `memberId` held; a gift they bought stays bought. */
export async function releaseRemovedMembersGiftClaims(
  service: SupabaseClient,
  familyId: string,
  memberId: string,
): Promise<GiftClaimRelease> {
  // Zero rows is the ordinary answer (most members claimed nothing); the
  // select reports what was released, and the error is what is checked.
  const { data, error } = await service.from('wishlist_items')
    .update({ claimed_by: null, claimed_at: null })
    .eq('family_id', familyId).eq('claimed_by', memberId)
    .select('id');
  if (error) {
    console.error('[family] removed member gift claims were not released', {
      familyId, memberId, error: describeActionError(error, 'The gift claims could not be released.'),
    });
    return { ok: false };
  }
  return { ok: true, released: Array.isArray(data) ? data.length : 0 };
}
