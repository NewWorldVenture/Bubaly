// lib/insurance/policies.ts — pure, deterministic insurance-awareness engine.
//
// The AI-first differentiator for the Insurance Hub is "AI-managed insurance
// awareness": one place that knows every household policy and proactively
// surfaces upcoming renewals, total annualized premium spend, lapsed coverage,
// and which essential coverage types the family has NONE of. Every figure is
// derived from the family's own policies — nothing is invented.

import type { InsurancePolicyType, PremiumFrequency } from '@/lib/database.types';

export const POLICY_TYPES: { value: InsurancePolicyType; label: string; emoji: string }[] = [
  { value: 'health', label: 'Health', emoji: '🩺' },
  { value: 'dental', label: 'Dental', emoji: '🦷' },
  { value: 'vision', label: 'Vision', emoji: '👓' },
  { value: 'auto', label: 'Auto', emoji: '🚗' },
  { value: 'home', label: 'Home', emoji: '🏠' },
  { value: 'renters', label: 'Renters', emoji: '🔑' },
  { value: 'life', label: 'Life', emoji: '🛡️' },
  { value: 'disability', label: 'Disability', emoji: '♿' },
  { value: 'umbrella', label: 'Umbrella', emoji: '☂️' },
  { value: 'pet', label: 'Pet', emoji: '🐾' },
  { value: 'travel', label: 'Travel', emoji: '✈️' },
  { value: 'other', label: 'Other', emoji: '📄' },
];

export const PREMIUM_FREQUENCIES: { value: PremiumFrequency; label: string; perYear: number }[] = [
  { value: 'monthly', label: 'Monthly', perYear: 12 },
  { value: 'quarterly', label: 'Quarterly', perYear: 4 },
  { value: 'semiannual', label: 'Every 6 months', perYear: 2 },
  { value: 'annual', label: 'Annual', perYear: 1 },
];

export function policyTypeMeta(t: InsurancePolicyType) {
  return POLICY_TYPES.find((x) => x.value === t) ?? POLICY_TYPES[POLICY_TYPES.length - 1];
}

export function frequencyMeta(f: PremiumFrequency) {
  return PREMIUM_FREQUENCIES.find((x) => x.value === f) ?? PREMIUM_FREQUENCIES[0];
}

/** Annualize a premium given its billing frequency. Returns 0 when unknown. */
export function annualPremium(amount: number | null | undefined, frequency: PremiumFrequency): number {
  if (!amount || amount < 0) return 0;
  return amount * frequencyMeta(frequency).perYear;
}

/** Whole-day difference (b - a) on date-only values. */
export function dayDiff(a: string | Date, b: string | Date): number {
  const da = typeof a === 'string' ? new Date(`${a.slice(0, 10)}T00:00:00`) : new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = typeof b === 'string' ? new Date(`${b.slice(0, 10)}T00:00:00`) : new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

export type RenewalUrgency = 'lapsed' | 'due_soon' | 'upcoming' | 'none';

/** Classify a renewal date. due_soon = within `soonDays` (default 30). */
export function renewalUrgency(renewalDate: string | null | undefined, today: Date = new Date(), soonDays = 30): RenewalUrgency {
  if (!renewalDate) return 'none';
  const d = dayDiff(today, renewalDate);
  if (d < 0) return 'lapsed';
  if (d <= soonDays) return 'due_soon';
  return 'upcoming';
}

export interface PolicyLike {
  id: string;
  policy_type: InsurancePolicyType;
  insurer: string;
  premium_amount: number | null;
  premium_frequency: PremiumFrequency;
  renewal_date: string | null;
}

export interface RenewalItem {
  id: string;
  policyType: InsurancePolicyType;
  insurer: string;
  renewalDate: string;
  urgency: RenewalUrgency;
  daysUntil: number;
}

/** Policies with a renewal date, soonest-first, tagged with urgency. */
export function upcomingRenewals(policies: readonly PolicyLike[], today: Date = new Date()): RenewalItem[] {
  return policies
    .filter((p) => p.renewal_date)
    .map((p) => ({
      id: p.id, policyType: p.policy_type, insurer: p.insurer,
      renewalDate: p.renewal_date as string,
      urgency: renewalUrgency(p.renewal_date, today),
      daysUntil: dayDiff(today, p.renewal_date as string),
    }))
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

/** Total annualized premium spend across all policies. */
export function totalAnnualPremium(policies: readonly PolicyLike[]): number {
  return policies.reduce((sum, p) => sum + annualPremium(p.premium_amount, p.premium_frequency), 0);
}

/** Premium spend rolled up by policy type, annualized, largest first. */
export function premiumByType(policies: readonly PolicyLike[]): { type: InsurancePolicyType; annual: number }[] {
  const map = new Map<InsurancePolicyType, number>();
  for (const p of policies) {
    map.set(p.policy_type, (map.get(p.policy_type) ?? 0) + annualPremium(p.premium_amount, p.premium_frequency));
  }
  return [...map.entries()]
    .map(([type, annual]) => ({ type, annual }))
    .filter((x) => x.annual > 0)
    .sort((a, b) => b.annual - a.annual);
}

/** The coverage types most households should carry, for gap detection. */
export const ESSENTIAL_COVERAGE: InsurancePolicyType[] = ['health', 'auto', 'home', 'life'];

/**
 * Essential coverage the family carries NO active policy for. Honest gap signal —
 * it only ever reports the absence of a standard type, never prescribes amounts.
 */
export function coverageGaps(policies: readonly PolicyLike[]): InsurancePolicyType[] {
  const have = new Set(policies.map((p) => p.policy_type));
  return ESSENTIAL_COVERAGE.filter((t) => !have.has(t));
}

export interface InsuranceSummary {
  count: number;
  annualPremium: number;
  monthlyPremium: number;
  lapsed: number;
  dueSoon: number;
  gaps: InsurancePolicyType[];
  text: string;
}

/** A single rollup for the hub header + awareness card. */
export function insuranceSummary(policies: readonly PolicyLike[], today: Date = new Date()): InsuranceSummary {
  const renewals = upcomingRenewals(policies, today);
  const lapsed = renewals.filter((r) => r.urgency === 'lapsed').length;
  const dueSoon = renewals.filter((r) => r.urgency === 'due_soon').length;
  const annual = totalAnnualPremium(policies);
  const gaps = coverageGaps(policies);
  const parts: string[] = [];
  if (lapsed > 0) parts.push(`${lapsed} lapsed`);
  if (dueSoon > 0) parts.push(`${dueSoon} renewing soon`);
  if (gaps.length > 0) parts.push(`${gaps.length} coverage gap${gaps.length === 1 ? '' : 's'}`);
  const text = policies.length === 0
    ? 'No policies yet'
    : parts.length
      ? parts.join(' · ')
      : 'All policies active';
  return {
    count: policies.length,
    annualPremium: annual,
    monthlyPremium: Math.round((annual / 12) * 100) / 100,
    lapsed, dueSoon, gaps, text,
  };
}

/** Format cents-free currency for display (whole dollars). */
export function fmtMoney(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}
