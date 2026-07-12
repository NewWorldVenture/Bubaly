// lib/marketing/contact-score.ts — the transparent CRM-contact lead-scoring
// engine (pure, unit-tested). Distinct from lib/marketing/lead-score.ts (which
// scores inbound support tickets): this ranks marketing CONTACTS by the
// visitor-intelligence signals we collect (site engagement, recency,
// conversions, demo, consent, profile depth, lifecycle) into a 0–100 score with
// an itemized LEDGER — every point is attributable to a named factor, so the
// score is explainable, never a black box. No browser/DB deps.

export type ContactSignals = {
  hasEmail: boolean;
  identified: boolean;            // linked to a visitor spine (mkt_visitors)
  sessionCount: number;
  daysSinceLastSeen: number | null;
  conversions: number;            // conversion touchpoints
  startedDemo: boolean;
  marketingConsent: boolean;      // explicit marketing opt-in (high intent)
  analyticsConsent: boolean;
  profileCompleteness: number;    // 0..1 (progressive profiling)
  isCustomer: boolean;
};

export type ContactBand = 'cold' | 'warm' | 'hot' | 'qualified';

export type ContactScoreFactor = { key: string; label: string; points: number };

export type ContactScore = { score: number; band: ContactBand; factors: ContactScoreFactor[] };

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function contactBandFor(score: number): ContactBand {
  if (score >= 75) return 'qualified';
  if (score >= 50) return 'hot';
  if (score >= 25) return 'warm';
  return 'cold';
}

/**
 * Score a contact from its signals. Each rule contributes a capped, named amount
 * to the ledger; the final score is the sum, clamped to 0–100. Only non-zero
 * contributions appear in the ledger (nothing to explain otherwise).
 */
export function scoreContact(s: ContactSignals): ContactScore {
  const factors: ContactScoreFactor[] = [];
  const add = (key: string, label: string, points: number) => {
    if (points > 0) factors.push({ key, label, points });
  };

  if (s.hasEmail) add('email', 'Email captured', 6);
  if (s.identified) add('identified', 'Known visitor', 8);

  const sessionPts = clamp(s.sessionCount, 0, 10) * 2;                 // up to +20
  if (s.sessionCount > 0) add('sessions', `Site engagement (${s.sessionCount} session${s.sessionCount === 1 ? '' : 's'})`, sessionPts);

  if (s.daysSinceLastSeen != null) {
    if (s.daysSinceLastSeen <= 7) add('recency', 'Active in the last week', 12);
    else if (s.daysSinceLastSeen <= 30) add('recency', 'Active in the last month', 6);
  }

  const convPts = clamp(s.conversions, 0, 3) * 10;                     // up to +30
  if (s.conversions > 0) add('conversions', `Converted (${s.conversions})`, convPts);

  if (s.startedDemo) add('demo', 'Tried the demo', 18);
  if (s.marketingConsent) add('marketing_consent', 'Opted into marketing', 10);
  if (s.analyticsConsent) add('analytics_consent', 'Allows analytics', 3);

  const profilePts = Math.round(clamp(s.profileCompleteness, 0, 1) * 12); // up to +12
  if (profilePts > 0) add('profile', `Profile ${Math.round(s.profileCompleteness * 100)}% complete`, profilePts);

  if (s.isCustomer) add('customer', 'Became a customer', 15);

  const raw = factors.reduce((sum, f) => sum + f.points, 0);
  const score = clamp(raw, 0, 100);
  return { score, band: contactBandFor(score), factors };
}

export const CONTACT_BAND_META: Record<ContactBand, { label: string; tint: string }> = {
  cold:      { label: 'Cold',      tint: 'text-slate-300 bg-slate-500/15' },
  warm:      { label: 'Warm',      tint: 'text-amber-300 bg-amber-500/15' },
  hot:       { label: 'Hot',       tint: 'text-orange-300 bg-orange-500/15' },
  qualified: { label: 'Qualified', tint: 'text-emerald-300 bg-emerald-500/15' },
};
