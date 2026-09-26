// lib/marketing/identity-core.ts — the pure identity-stitch decision (unit-tested).
// Kept free of server/DB deps so the "what should happen" rule is testable in
// isolation from the Supabase writes in identity.ts.

export type StitchDecision =
  | 'link'     // visitor exists, unlinked → attach it to this contact
  | 'noop'     // nothing to attach, or already attached to THIS contact (idempotent)
  | 'fork'     // visitor is attached to a DIFFERENT contact → shared device, new user
  | 'unknown'; // a read the decision depends on FAILED → no device decision: nothing linked or carried

// 'unknown' exists because a failed read is not an answer. The contact lookup
// and the visitor lookup are the only evidence for "same person" vs "someone
// else on this device"; when either did not come back, 'noop' would claim the
// first and carry consent to whoever is signing in. 'unknown' links no visitor
// row and carries no consent. It is not "nothing written": when it is the
// VISITOR read that failed, identity.ts step 1 has already found-or-created and
// patched the signing-in person's own contact by their verified email, which
// does not depend on whose device this is. And — unlike 'fork' — it does not
// rotate the anonymous id: a rotation cannot be undone, and on the ordinary
// single-person device it would orphan a spine that the next sign-in, with a
// working read, can still decide.

/**
 * Decide how to stitch an anonymous visitor to a now-known contact.
 *
 * The safety rule is the `fork`: if this device's visitor spine is already tied
 * to a different contact (e.g. a second person signs in on a shared laptop), we
 * must NOT re-point it — that would merge two unrelated people's histories.
 * Instead the caller rotates the anonymous id so the new person starts clean.
 */
export function decideStitch(input: {
  visitorFound: boolean;
  visitorContactId: string | null;
  targetContactId: string;
}): StitchDecision {
  if (input.visitorContactId && input.visitorContactId !== input.targetContactId) return 'fork';
  if (!input.visitorFound) return 'noop';
  if (!input.visitorContactId) return 'link';
  return 'noop'; // already linked to this same contact
}

/**
 * Consent may be carried forward only for an outcome that ESTABLISHED the same
 * person. Named, not "anything but fork": an undecided stitch ('unknown') must
 * not attribute a browser's consent rows to whoever happens to be signing in.
 */
export function shouldCarryConsent(decision: StitchDecision): boolean {
  return decision === 'link' || decision === 'noop';
}
