// lib/marketing/visitor-funnel.ts — pure funnel math for the Visitor Intelligence
// dashboard (unit-tested). Turns raw stage counts into a funnel with safe
// conversion percentages (share of the top of funnel, and step-over-step), so
// the admin view stays a thin renderer. No browser/DB deps.

export type FunnelCounts = {
  visitors: number;    // anonymous CDP spine (mkt_visitors)
  identified: number;  // linked to a contact (mkt_visitors.contact_id)
  profiled: number;    // has ≥1 progressive-profile field (crm_contact_profile)
  scored: number;      // has a lead score (crm_lead_scores)
  engaged: number;     // scored contacts in the hot / qualified bands
};

export type FunnelStage = {
  key: keyof FunnelCounts;
  label: string;
  count: number;
  pctOfTop: number;   // 0..100, share of `visitors`
  pctOfPrev: number;  // 0..100, step conversion from the previous stage
};

const STAGES: { key: keyof FunnelCounts; label: string }[] = [
  { key: 'visitors', label: 'Anonymous visitors' },
  { key: 'identified', label: 'Identified' },
  { key: 'profiled', label: 'Profiled' },
  { key: 'scored', label: 'Scored' },
  { key: 'engaged', label: 'Hot / Qualified' },
];

/** Safe percentage (0 when the denominator is 0), rounded to a tenth. */
export function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function buildFunnel(counts: FunnelCounts): FunnelStage[] {
  const top = counts.visitors;
  let prev = top;
  return STAGES.map((s) => {
    const count = Math.max(0, counts[s.key] ?? 0);
    const stage: FunnelStage = {
      key: s.key, label: s.label, count,
      pctOfTop: pct(count, top),
      pctOfPrev: pct(count, prev),
    };
    prev = count;
    return stage;
  });
}
