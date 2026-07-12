// lib/marketing/journey-recovery.ts — pure selection for abandoned-journey
// recovery (unit-tested). Extends abandoned-checkout recovery to the OTHER
// first-run journeys: someone who started onboarding but stalled, and someone
// who tried the demo but never started their own family. Each journey is only
// eligible inside a bounded [grace, maxAge] window, so the cron re-fires a
// deduped enrollment at most a few times before the record ages out. No DB deps.

const HOUR = 3_600_000;

export type AbandonOpts = { graceHours?: number; maxAgeHours?: number };

// ── Onboarding ───────────────────────────────────────────────────────────────
export type OnboardingJourney = {
  user_id: string;
  status: string;
  completed_at: string | null;
  reset_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Onboarding runs that stalled: still in progress (never completed, not reset),
 * last touched between `graceHours` and `maxAgeHours` ago. The grace avoids
 * nagging someone who's actively mid-setup; the max-age stops chasing cold runs.
 */
export function selectAbandonedOnboarding(
  rows: OnboardingJourney[], now: number = Date.now(), opts: AbandonOpts = {},
): OnboardingJourney[] {
  const grace = (opts.graceHours ?? 2) * HOUR;
  const maxAge = (opts.maxAgeHours ?? 72) * HOUR;
  return rows.filter((r) => {
    if (r.completed_at || r.reset_at) return false;
    if (r.status === 'completed' || r.status === 'reset') return false;
    const last = new Date(r.updated_at || r.created_at).getTime();
    if (Number.isNaN(last)) return false;
    const age = now - last;
    return age >= grace && age <= maxAge;
  });
}

// ── Demo ─────────────────────────────────────────────────────────────────────
export type DemoLead = {
  email: string | null;
  lead_source: string | null;
  lifecycle_stage: string;
  created_at: string;
};

/**
 * Demo leads that didn't convert: captured from the demo (`lead_source: 'demo'`),
 * not yet a customer, with a real email, created inside the [grace, maxAge]
 * window. (A demo lead becomes a `customer` via the identity stitch on signup —
 * so `lifecycle_stage !== 'customer'` means they never started their own family.)
 */
export function selectAbandonedDemoLeads(
  leads: DemoLead[], now: number = Date.now(), opts: AbandonOpts = {},
): DemoLead[] {
  const grace = (opts.graceHours ?? 1) * HOUR;
  const maxAge = (opts.maxAgeHours ?? 72) * HOUR;
  return leads.filter((l) => {
    if (!l.email || !l.email.includes('@')) return false;
    if (l.lead_source !== 'demo') return false;
    if (l.lifecycle_stage === 'customer') return false;
    const t = new Date(l.created_at).getTime();
    if (Number.isNaN(t)) return false;
    const age = now - t;
    return age >= grace && age <= maxAge;
  });
}
