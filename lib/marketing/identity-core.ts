// lib/marketing/identity-core.ts — the pure identity-stitch decision (unit-tested).
// Kept free of server/DB deps so the "what should happen" rule is testable in
// isolation from the Supabase writes in identity.ts.

export type StitchDecision =
  | 'link'   // visitor exists, unlinked → attach it to this contact
  | 'noop'   // nothing to attach, or already attached to THIS contact (idempotent)
  | 'fork';  // visitor is attached to a DIFFERENT contact → shared device, new user

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

/** Consent may be carried forward for any non-fork outcome (same person). */
export function shouldCarryConsent(decision: StitchDecision): boolean {
  return decision !== 'fork';
}
