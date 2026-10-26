'use client';

// Fire-and-forget activation telemetry (T10). Records the FIRST time a person
// reaches a value milestone in a family (viewed first outcome / saw first
// briefing / …), deduped per (user, family, milestone) in localStorage so
// "first value" is captured once. Errors are swallowed — telemetry must never
// block or break a page.
import { createClient } from '@/lib/supabase/client';
import { recordableMsSinceSignup, sessionIndexFromMs, type ActivationMilestone } from '@/lib/analytics/activation';

/**
 * Per person, not per family. /home reads the milestone per person (its
 * "Do one thing now" card asks whether THIS user reached first value), and
 * the flag used to be the family's: on a shared tablet the first parent to
 * open Outcomes set it, and nobody after them was ever recorded from that
 * browser, so their Home kept treating them as brand new.
 */
const flagKey = (userId: string, familyId: string, milestone: string) => `bubaly.activation.${userId}.${familyId}.${milestone}`;
const inFlight = new Set<string>();

export async function trackActivationOnce(opts: {
  milestone: ActivationMilestone;
  familyId: string;
  userId?: string | null;
  /** The family's sign-up time (ISO). Used to compute the TTFV clock. */
  signupAtIso?: string | null;
}): Promise<void> {
  try {
    // A row with no user is never counted (lib/analytics/activation-attestation)
    // and cannot answer the per-person read on Home, so none is written.
    if (typeof window === 'undefined' || !opts.familyId || !opts.userId) return;
    const key = flagKey(opts.userId, opts.familyId, opts.milestone);
    if (localStorage.getItem(key) || inFlight.has(key)) return; // first value only
    inFlight.add(key);
    try {
      const ms = opts.signupAtIso ? Math.max(0, Date.now() - Date.parse(opts.signupAtIso)) : null;
      const { data, error } = await createClient()
        .from('activation_events')
        .insert({
          user_id: opts.userId,
          family_id: opts.familyId,
          session_id: opts.familyId,            // one cohort per family
          milestone: opts.milestone,
          session_index: sessionIndexFromMs(ms),
          ms_since_signup: recordableMsSinceSignup(ms),
        })
        .select('id');
      // The flag follows the write, never precedes it: set first, a refused or
      // dropped insert (an expired session, a network error) was never retried
      // from this browser. 23505 is "already recorded" once a unique key exists.
      if (error?.code === '23505' || (!error && data?.length)) localStorage.setItem(key, '1');
    } finally {
      inFlight.delete(key);
    }
  } catch {
    /* never throw from telemetry */
  }
}
