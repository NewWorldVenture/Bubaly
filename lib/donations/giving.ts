import type { DonationType } from '@/lib/database.types';

export const DONATION_TYPES: { value: DonationType; label: string; emoji: string }[] = [
  { value: 'monetary', label: 'Monetary', emoji: '💵' },
  { value: 'goods', label: 'Goods', emoji: '📦' },
  { value: 'stock', label: 'Stock', emoji: '📈' },
  { value: 'vehicle', label: 'Vehicle', emoji: '🚗' },
  { value: 'real_estate', label: 'Real Estate', emoji: '🏠' },
  { value: 'other', label: 'Other', emoji: '📋' },
];

export function donationTypeMeta(t: DonationType) {
  return DONATION_TYPES.find((x) => x.value === t) ?? DONATION_TYPES[DONATION_TYPES.length - 1];
}

export interface DonationLike {
  id: string;
  organization: string;
  donation_type: DonationType;
  amount: number | null;
  donation_date: string;
  tax_year: number;
  is_tax_deductible: boolean;
}

export function totalGiving(donations: readonly DonationLike[]): number {
  return donations.reduce((sum, d) => sum + (d.amount ?? 0), 0);
}

export function totalTaxDeductible(donations: readonly DonationLike[]): number {
  return donations.filter((d) => d.is_tax_deductible).reduce((sum, d) => sum + (d.amount ?? 0), 0);
}

export function givingByYear(donations: readonly DonationLike[]): { year: number; total: number; deductible: number }[] {
  const map = new Map<number, { total: number; deductible: number }>();
  for (const d of donations) {
    const entry = map.get(d.tax_year) ?? { total: 0, deductible: 0 };
    entry.total += d.amount ?? 0;
    if (d.is_tax_deductible) entry.deductible += d.amount ?? 0;
    map.set(d.tax_year, entry);
  }
  return [...map.entries()]
    .map(([year, v]) => ({ year, ...v }))
    .sort((a, b) => b.year - a.year);
}

export function givingByOrg(donations: readonly DonationLike[]): { org: string; total: number; count: number }[] {
  const map = new Map<string, { total: number; count: number }>();
  for (const d of donations) {
    const key = d.organization || 'Unknown';
    const entry = map.get(key) ?? { total: 0, count: 0 };
    entry.total += d.amount ?? 0;
    entry.count += 1;
    map.set(key, entry);
  }
  return [...map.entries()]
    .map(([org, v]) => ({ org, ...v }))
    .sort((a, b) => b.total - a.total);
}

export function givingByType(donations: readonly DonationLike[]): { type: DonationType; total: number }[] {
  const map = new Map<DonationType, number>();
  for (const d of donations) {
    map.set(d.donation_type, (map.get(d.donation_type) ?? 0) + (d.amount ?? 0));
  }
  return [...map.entries()]
    .map(([type, total]) => ({ type, total }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total);
}

export interface DonationSummary {
  count: number;
  totalGiving: number;
  taxDeductible: number;
  currentYearTotal: number;
  topOrg: string | null;
  text: string;
}

export function donationSummary(donations: readonly DonationLike[], currentYear: number = new Date().getFullYear()): DonationSummary {
  const total = totalGiving(donations);
  const deductible = totalTaxDeductible(donations);
  const currentYearDonations = donations.filter((d) => d.tax_year === currentYear);
  const currentYearTotal = currentYearDonations.reduce((sum, d) => sum + (d.amount ?? 0), 0);
  const byOrg = givingByOrg(donations);
  const topOrg = byOrg.length > 0 ? byOrg[0].org : null;

  const parts: string[] = [];
  if (currentYearTotal > 0) parts.push(`${fmtMoney(currentYearTotal)} this year`);
  if (deductible > 0 && deductible !== total) parts.push(`${fmtMoney(deductible)} tax-deductible`);
  if (topOrg) parts.push(`top: ${topOrg}`);
  const text = donations.length === 0
    ? 'No donations recorded yet'
    : parts.length
      ? parts.join(' · ')
      : `${fmtMoney(total)} total giving`;
  return { count: donations.length, totalGiving: total, taxDeductible: deductible, currentYearTotal, topOrg, text };
}

export function fmtMoney(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
