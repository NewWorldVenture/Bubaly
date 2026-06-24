import type { ReunionStatus, RsvpResponse } from '@/lib/database.types';

export const REUNION_STATUSES: { value: ReunionStatus; label: string; emoji: string }[] = [
  { value: 'planning', label: 'Planning', emoji: '📋' },
  { value: 'confirmed', label: 'Confirmed', emoji: '✅' },
  { value: 'active', label: 'Active', emoji: '🎉' },
  { value: 'completed', label: 'Completed', emoji: '✨' },
  { value: 'cancelled', label: 'Cancelled', emoji: '❌' },
];

export const RSVP_RESPONSES: { value: RsvpResponse; label: string; emoji: string }[] = [
  { value: 'attending', label: 'Attending', emoji: '✅' },
  { value: 'not_attending', label: 'Not Attending', emoji: '❌' },
  { value: 'maybe', label: 'Maybe', emoji: '❓' },
  { value: 'pending', label: 'Pending', emoji: '⏳' },
];

export function reunionStatusMeta(s: ReunionStatus) {
  return REUNION_STATUSES.find((x) => x.value === s) ?? REUNION_STATUSES[0];
}

export function rsvpMeta(r: RsvpResponse) {
  return RSVP_RESPONSES.find((x) => x.value === r) ?? RSVP_RESPONSES[3];
}

export function dayDiff(a: string | Date, b: string | Date): number {
  const da = typeof a === 'string' ? new Date(`${a.slice(0, 10)}T00:00:00`) : new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = typeof b === 'string' ? new Date(`${b.slice(0, 10)}T00:00:00`) : new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

export interface ReunionLike {
  id: string;
  title: string;
  status: ReunionStatus;
  start_date: string | null;
  budget: number | null;
  headcount: number;
}

export interface RsvpLike {
  id: string;
  reunion_id: string;
  response: RsvpResponse;
  party_size: number;
}

export function rsvpSummary(rsvps: readonly RsvpLike[]): { attending: number; maybe: number; pending: number; declined: number; totalGuests: number } {
  let attending = 0, maybe = 0, pending = 0, declined = 0, totalGuests = 0;
  for (const r of rsvps) {
    if (r.response === 'attending') { attending++; totalGuests += r.party_size; }
    else if (r.response === 'maybe') { maybe++; totalGuests += r.party_size; }
    else if (r.response === 'pending') pending++;
    else declined++;
  }
  return { attending, maybe, pending, declined, totalGuests };
}

export function upcomingReunions(reunions: readonly ReunionLike[], today: Date = new Date()): ReunionLike[] {
  return reunions
    .filter((r) => r.status === 'planning' || r.status === 'confirmed')
    .filter((r) => !r.start_date || dayDiff(today, r.start_date) >= 0)
    .sort((a, b) => {
      const da = a.start_date ? dayDiff(today, a.start_date) : 9999;
      const db = b.start_date ? dayDiff(today, b.start_date) : 9999;
      return da - db;
    });
}

export function totalBudget(reunions: readonly ReunionLike[]): number {
  return reunions.reduce((sum, r) => sum + (r.budget ?? 0), 0);
}

export interface ReunionSummaryResult {
  totalReunions: number;
  upcoming: number;
  text: string;
}

export function reunionSummaryResult(reunions: readonly ReunionLike[], today: Date = new Date()): ReunionSummaryResult {
  const upcoming = upcomingReunions(reunions, today).length;
  const parts: string[] = [];
  if (upcoming > 0) parts.push(`${upcoming} upcoming`);
  const completed = reunions.filter((r) => r.status === 'completed').length;
  if (completed > 0) parts.push(`${completed} completed`);
  const text = reunions.length === 0
    ? 'No reunions planned yet'
    : parts.length
      ? parts.join(' · ')
      : `${reunions.length} reunion${reunions.length === 1 ? '' : 's'}`;
  return { totalReunions: reunions.length, upcoming, text };
}

export function fmtMoney(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
