'use client';

// Fire-and-forget activation telemetry (T10). Records the FIRST time a family
// reaches a value milestone (viewed first outcome / saw first briefing / …),
// deduped per (family, milestone) in localStorage so "first value" is captured
// once. Errors are swallowed — telemetry must never block or break a page.
import { createClient } from '@/lib/supabase/client';
import { sessionIndexFromMs, type ActivationMilestone } from '@/lib/analytics/activation';

const flagKey = (familyId: string, milestone: string) => `bubaly.activation.${familyId}.${milestone}`;

export function trackActivationOnce(opts: {
  milestone: ActivationMilestone;
  familyId: string;
  userId?: string | null;
  /** The family's sign-up time (ISO). Used to compute the TTFV clock. */
  signupAtIso?: string | null;
}): void {
  try {
    if (typeof window === 'undefined' || !opts.familyId) return;
    const key = flagKey(opts.familyId, opts.milestone);
    if (localStorage.getItem(key)) return; // first value only
    localStorage.setItem(key, '1');
    const ms = opts.signupAtIso ? Math.max(0, Date.now() - Date.parse(opts.signupAtIso)) : null;
    void createClient()
      .from('activation_events')
      .insert({
        user_id: opts.userId ?? null,
        family_id: opts.familyId,
        session_id: opts.familyId,            // one cohort per family
        milestone: opts.milestone,
        session_index: sessionIndexFromMs(ms),
        ms_since_signup: ms,
      })
      .then(() => {}, () => {}); // swallow
  } catch {
    /* never throw from telemetry */
  }
}
