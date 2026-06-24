import type { VolunteerCategory, VolunteerStatus } from '@/lib/database.types';

export const CATEGORIES: { value: VolunteerCategory; label: string; emoji: string }[] = [
  { value: 'community', label: 'Community', emoji: '🏘️' },
  { value: 'school', label: 'School', emoji: '🎓' },
  { value: 'church', label: 'Church', emoji: '⛪' },
  { value: 'sports', label: 'Sports', emoji: '⚽' },
  { value: 'environment', label: 'Environment', emoji: '🌿' },
  { value: 'animal', label: 'Animal', emoji: '🐾' },
  { value: 'health', label: 'Health', emoji: '🩺' },
  { value: 'elderly', label: 'Elderly', emoji: '👴' },
  { value: 'youth', label: 'Youth', emoji: '👦' },
  { value: 'disaster', label: 'Disaster Relief', emoji: '🆘' },
  { value: 'other', label: 'Other', emoji: '📋' },
];

export const STATUSES: { value: VolunteerStatus; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function categoryMeta(c: VolunteerCategory) {
  return CATEGORIES.find((x) => x.value === c) ?? CATEGORIES[CATEGORIES.length - 1];
}

export function statusMeta(s: VolunteerStatus) {
  return STATUSES.find((x) => x.value === s) ?? STATUSES[0];
}

export function dayDiff(a: string | Date, b: string | Date): number {
  const da = typeof a === 'string' ? new Date(`${a.slice(0, 10)}T00:00:00`) : new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = typeof b === 'string' ? new Date(`${b.slice(0, 10)}T00:00:00`) : new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

export interface OpportunityLike {
  id: string;
  title: string;
  organization: string;
  category: VolunteerCategory;
  status: VolunteerStatus;
  start_date: string | null;
  end_date: string | null;
}

export interface HourLog {
  id: string;
  opportunity_id: string | null;
  member_id: string | null;
  hours: number;
  log_date: string;
}

export function totalHours(logs: readonly HourLog[]): number {
  return logs.reduce((sum, l) => sum + (l.hours || 0), 0);
}

export function hoursByMember(logs: readonly HourLog[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of logs) {
    const key = l.member_id ?? 'unassigned';
    map.set(key, (map.get(key) ?? 0) + (l.hours || 0));
  }
  return map;
}

export function hoursByCategory(
  logs: readonly HourLog[],
  opps: readonly OpportunityLike[],
): { category: VolunteerCategory; hours: number }[] {
  const oppMap = new Map(opps.map((o) => [o.id, o]));
  const catMap = new Map<VolunteerCategory, number>();
  for (const l of logs) {
    const opp = l.opportunity_id ? oppMap.get(l.opportunity_id) : null;
    const cat = opp?.category ?? 'other';
    catMap.set(cat, (catMap.get(cat) ?? 0) + (l.hours || 0));
  }
  return [...catMap.entries()]
    .map(([category, hours]) => ({ category, hours }))
    .sort((a, b) => b.hours - a.hours);
}

export function upcomingOpportunities(opps: readonly OpportunityLike[], today: Date = new Date()): OpportunityLike[] {
  return opps
    .filter((o) => o.status === 'upcoming' || o.status === 'active')
    .filter((o) => !o.end_date || dayDiff(today, o.end_date) >= 0)
    .sort((a, b) => {
      const da = a.start_date ? dayDiff(today, a.start_date) : 9999;
      const db = b.start_date ? dayDiff(today, b.start_date) : 9999;
      return da - db;
    });
}

export interface VolunteerSummary {
  totalOpportunities: number;
  activeCount: number;
  upcomingCount: number;
  totalHours: number;
  text: string;
}

export function volunteerSummary(opps: readonly OpportunityLike[], logs: readonly HourLog[]): VolunteerSummary {
  const active = opps.filter((o) => o.status === 'active').length;
  const upcoming = opps.filter((o) => o.status === 'upcoming').length;
  const hours = totalHours(logs);
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  if (upcoming > 0) parts.push(`${upcoming} upcoming`);
  if (hours > 0) parts.push(`${hours.toFixed(1)}h logged`);
  const text = opps.length === 0
    ? 'No volunteer activities yet'
    : parts.length
      ? parts.join(' · ')
      : 'All activities completed';
  return { totalOpportunities: opps.length, activeCount: active, upcomingCount: upcoming, totalHours: hours, text };
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
