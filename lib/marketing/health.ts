// Pure customer-health / churn-risk scoring — unit tested, no dependencies.
// Derived from the normalized MarketingCustomer view (no new schema).

import type { Lifecycle } from '@/lib/marketing/customers';

export type HealthBand = 'healthy' | 'monitor' | 'at_risk';

export type HealthInput = {
  lifecycle: Lifecycle;
  memberCount: number;
  lastActivityAt: string;
};

export type Health = {
  score: number;        // 0–100
  band: HealthBand;
  churnRisk: boolean;
  inactiveDays: number;
};

const DAY = 86_400_000;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

const LIFECYCLE_BASE: Record<Lifecycle, number> = {
  active: 75, new: 70, free: 50, lapsed: 30, churned: 10,
};

export function bandFor(score: number): HealthBand {
  if (score >= 70) return 'healthy';
  if (score >= 40) return 'monitor';
  return 'at_risk';
}

export const HEALTH_BAND_LABEL: Record<HealthBand, string> = {
  healthy: 'Healthy', monitor: 'Monitor', at_risk: 'At risk',
};

export function customerHealth(input: HealthInput, now: number = Date.now()): Health {
  const t = new Date(input.lastActivityAt).getTime();
  const inactiveDays = Number.isNaN(t) ? 999 : Math.max(0, Math.floor((now - t) / DAY));

  let score = LIFECYCLE_BASE[input.lifecycle] ?? 50;

  // Recency: fresh activity lifts, long silence drags.
  if (inactiveDays <= 3) score += 15;
  else if (inactiveDays <= 7) score += 8;
  else if (inactiveDays <= 14) score += 0;
  else if (inactiveDays <= 30) score -= 10;
  else score -= 25;

  // Stickiness: more engaged members = harder to churn.
  score += Math.min(input.memberCount, 5) * 2;

  score = clamp(Math.round(score));
  const band = bandFor(score);
  const churnRisk = input.lifecycle === 'churned' || input.lifecycle === 'lapsed' || score < 40 || inactiveDays > 30;
  return { score, band, churnRisk, inactiveDays };
}

export type HealthSummary = { healthy: number; monitor: number; atRisk: number; churnRisk: number; avgScore: number | null };

export function summarizeHealth(healths: Health[]): HealthSummary {
  if (healths.length === 0) return { healthy: 0, monitor: 0, atRisk: 0, churnRisk: 0, avgScore: null };
  let healthy = 0, monitor = 0, atRisk = 0, churnRisk = 0, total = 0;
  for (const h of healths) {
    if (h.band === 'healthy') healthy++; else if (h.band === 'monitor') monitor++; else atRisk++;
    if (h.churnRisk) churnRisk++;
    total += h.score;
  }
  return { healthy, monitor, atRisk, churnRisk, avgScore: Math.round(total / healths.length) };
}
