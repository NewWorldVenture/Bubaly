import type { CollegeAppStatus, ScholarshipStatus } from '@/lib/database.types';

export const APP_STATUSES: { value: CollegeAppStatus; label: string; emoji: string }[] = [
  { value: 'researching', label: 'Researching', emoji: '🔍' },
  { value: 'applying', label: 'Applying', emoji: '✍️' },
  { value: 'submitted', label: 'Submitted', emoji: '📨' },
  { value: 'accepted', label: 'Accepted', emoji: '🎉' },
  { value: 'waitlisted', label: 'Waitlisted', emoji: '⏳' },
  { value: 'rejected', label: 'Rejected', emoji: '❌' },
  { value: 'enrolled', label: 'Enrolled', emoji: '🎓' },
  { value: 'declined', label: 'Declined', emoji: '🚫' },
];

export const SCHOLARSHIP_STATUSES: { value: ScholarshipStatus; label: string; emoji: string }[] = [
  { value: 'researching', label: 'Researching', emoji: '🔍' },
  { value: 'applying', label: 'Applying', emoji: '✍️' },
  { value: 'submitted', label: 'Submitted', emoji: '📨' },
  { value: 'awarded', label: 'Awarded', emoji: '🏆' },
  { value: 'denied', label: 'Denied', emoji: '❌' },
  { value: 'accepted', label: 'Accepted', emoji: '✅' },
  { value: 'declined', label: 'Declined', emoji: '🚫' },
];

export function appStatusMeta(s: CollegeAppStatus) {
  return APP_STATUSES.find((x) => x.value === s) ?? APP_STATUSES[0];
}

export function scholarshipStatusMeta(s: ScholarshipStatus) {
  return SCHOLARSHIP_STATUSES.find((x) => x.value === s) ?? SCHOLARSHIP_STATUSES[0];
}

export function dayDiff(a: string | Date, b: string | Date): number {
  const da = typeof a === 'string' ? new Date(`${a.slice(0, 10)}T00:00:00`) : new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = typeof b === 'string' ? new Date(`${b.slice(0, 10)}T00:00:00`) : new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

export type DeadlineUrgency = 'past' | 'urgent' | 'upcoming' | 'none';

export function deadlineUrgency(deadline: string | null | undefined, today: Date = new Date(), urgentDays = 14): DeadlineUrgency {
  if (!deadline) return 'none';
  const d = dayDiff(today, deadline);
  if (d < 0) return 'past';
  if (d <= urgentDays) return 'urgent';
  return 'upcoming';
}

export interface AppLike {
  id: string;
  school_name: string;
  status: CollegeAppStatus;
  deadline: string | null;
  tuition: number | null;
  financial_aid: number | null;
}

export interface ScholarshipLike {
  id: string;
  name: string;
  amount: number | null;
  status: ScholarshipStatus;
  deadline: string | null;
}

export function upcomingDeadlines(apps: readonly AppLike[], today: Date = new Date()): { id: string; name: string; deadline: string; daysUntil: number; urgency: DeadlineUrgency }[] {
  return apps
    .filter((a) => a.deadline && (a.status === 'researching' || a.status === 'applying'))
    .map((a) => ({
      id: a.id,
      name: a.school_name,
      deadline: a.deadline as string,
      daysUntil: dayDiff(today, a.deadline as string),
      urgency: deadlineUrgency(a.deadline, today),
    }))
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

export function netCost(app: AppLike): number | null {
  if (app.tuition == null) return null;
  return app.tuition - (app.financial_aid ?? 0);
}

export function totalScholarships(scholarships: readonly ScholarshipLike[]): number {
  return scholarships
    .filter((s) => s.status === 'awarded' || s.status === 'accepted')
    .reduce((sum, s) => sum + (s.amount ?? 0), 0);
}

export interface CollegeSummary {
  totalApps: number;
  accepted: number;
  pending: number;
  scholarshipTotal: number;
  upcomingDeadlines: number;
  text: string;
}

export function collegeSummary(apps: readonly AppLike[], scholarships: readonly ScholarshipLike[], today: Date = new Date()): CollegeSummary {
  const accepted = apps.filter((a) => a.status === 'accepted' || a.status === 'enrolled').length;
  const pending = apps.filter((a) => a.status === 'submitted' || a.status === 'applying' || a.status === 'waitlisted').length;
  const scholarshipTotal = totalScholarships(scholarships);
  const deadlines = upcomingDeadlines(apps, today);
  const urgent = deadlines.filter((d) => d.urgency === 'urgent').length;

  const parts: string[] = [];
  if (accepted > 0) parts.push(`${accepted} accepted`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (urgent > 0) parts.push(`${urgent} urgent deadline${urgent === 1 ? '' : 's'}`);
  if (scholarshipTotal > 0) parts.push(`${fmtMoney(scholarshipTotal)} in scholarships`);
  const text = apps.length === 0
    ? 'No college applications yet'
    : parts.length
      ? parts.join(' · ')
      : `${apps.length} application${apps.length === 1 ? '' : 's'}`;
  return { totalApps: apps.length, accepted, pending, scholarshipTotal, upcomingDeadlines: deadlines.length, text };
}

export function fmtMoney(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
