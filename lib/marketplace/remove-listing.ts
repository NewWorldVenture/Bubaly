// What "Remove" on a marketplace listing does, as one function the screen calls
// and the tests drive.
//
// The held 0505 refuses a seller's delete of a listing other families hold
// records of (an order, an offer, a question, a bid, a negotiation, a report),
// because the cascade would erase them; such a listing is withdrawn instead.
// Three rules follow, and each is a review finding on #999 (6101040142):
//
//   * The photo is not touched until the outcome is known. Only a listing whose
//     row the database actually removed loses its photo, and the photo removed
//     is the one the removed row named (read back from the delete), not the one
//     the screen last saw. A kept listing keeps its photo, whatever happens
//     after.
//   * Whether to withdraw is decided by the server from the row as it is now.
//     marketplace_set_listing_status (0317) locks the row and refuses a move
//     from withdrawn or completed; that refusal means the listing is already
//     kept, so a listing another tab relisted is withdrawn, and one already
//     withdrawn is not reported as changed.
//   * Before 0505 is released the refusal never comes, and Remove deletes as
//     it always has, photo last.

/** 0505's own sentence; nothing else counts as "kept for others' records". */
export const KEPT_FOR_OTHERS_RECORDS = /withdrawn, not removed/;
/** 0317's refusal of a move the row's current status does not allow. */
export const ALREADY_KEPT = /^Cannot move listing from (withdrawn|completed) to withdrawn$/;

type DbError = { code?: string; message?: string } | null;

export type RemoveListingDeps = {
  /** delete … where id and family_id, returning id and photo_url */
  deleteRow: () => Promise<{ data: { id: string; photo_url: string | null }[] | null; error: DbError }>;
  /** rpc marketplace_set_listing_status(p_status: 'withdrawn') */
  withdraw: () => Promise<{ error: DbError }>;
  /** remove the stored photo a URL names */
  removePhoto: (url: string) => Promise<{ error: string | null }>;
};

export type RemoveListingOutcome =
  | { kind: 'removed' }
  | { kind: 'removed_photo_left'; error: string }
  | { kind: 'withdrawn' }
  | { kind: 'already_kept' }
  | { kind: 'not_saved' }
  | { kind: 'error'; error: DbError };

export function keptForOthersRecords(err: DbError): boolean {
  return err?.code === '42501' && KEPT_FOR_OTHERS_RECORDS.test(err.message ?? '');
}

export async function removeListing(deps: RemoveListingDeps): Promise<RemoveListingOutcome> {
  const { data, error } = await deps.deleteRow();
  if (error && keptForOthersRecords(error)) {
    const { error: withdrawError } = await deps.withdraw();
    if (!withdrawError) return { kind: 'withdrawn' };
    if (ALREADY_KEPT.test(withdrawError.message ?? '')) return { kind: 'already_kept' };
    return { kind: 'error', error: withdrawError };
  }
  if (error) return { kind: 'error', error };
  const row = data?.[0];
  if (!row) return { kind: 'not_saved' };
  if (row.photo_url) {
    const { error: photoError } = await deps.removePhoto(row.photo_url);
    if (photoError) return { kind: 'removed_photo_left', error: photoError };
  }
  return { kind: 'removed' };
}
