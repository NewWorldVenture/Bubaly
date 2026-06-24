import type { RelocationStatus, RelocationTaskStatus } from '@/lib/database.types';

export const RELOCATION_STATUSES: { value: RelocationStatus; label: string; emoji: string }[] = [
  { value: 'researching', label: 'Researching', emoji: '🔍' },
  { value: 'planning', label: 'Planning', emoji: '📋' },
  { value: 'in_progress', label: 'In Progress', emoji: '📦' },
  { value: 'completed', label: 'Completed', emoji: '✅' },
  { value: 'cancelled', label: 'Cancelled', emoji: '❌' },
];

export const TASK_STATUSES: { value: RelocationTaskStatus; label: string }[] = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
  { value: 'skipped', label: 'Skipped' },
];

export const TASK_CATEGORIES = [
  'Housing', 'Packing', 'Utilities', 'School', 'Work',
  'Legal', 'Medical', 'Pets', 'Financial', 'Other',
] as const;

export function relocationStatusMeta(s: RelocationStatus) {
  return RELOCATION_STATUSES.find((x) => x.value === s) ?? RELOCATION_STATUSES[0];
}

export interface RelocationLike {
  id: string;
  title: string;
  from_location: string;
  to_location: string;
  status: RelocationStatus;
  target_date: string | null;
  budget: number | null;
}

export interface TaskLike {
  id: string;
  relocation_id: string;
  title: string;
  status: RelocationTaskStatus;
  category: string;
  due_date: string | null;
}

export function taskProgress(tasks: readonly TaskLike[]): { total: number; done: number; pct: number } {
  const total = tasks.filter((t) => t.status !== 'skipped').length;
  const done = tasks.filter((t) => t.status === 'done').length;
  return { total, done, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

export function tasksByCategory(tasks: readonly TaskLike[]): { category: string; total: number; done: number }[] {
  const map = new Map<string, { total: number; done: number }>();
  for (const t of tasks) {
    if (t.status === 'skipped') continue;
    const cat = t.category || 'Other';
    const entry = map.get(cat) ?? { total: 0, done: 0 };
    entry.total++;
    if (t.status === 'done') entry.done++;
    map.set(cat, entry);
  }
  return [...map.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

export function dayDiff(a: string | Date, b: string | Date): number {
  const da = typeof a === 'string' ? new Date(`${a.slice(0, 10)}T00:00:00`) : new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = typeof b === 'string' ? new Date(`${b.slice(0, 10)}T00:00:00`) : new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

export function daysUntilMove(targetDate: string | null, today: Date = new Date()): number | null {
  if (!targetDate) return null;
  return dayDiff(today, targetDate);
}

export interface RelocationSummary {
  count: number;
  active: number;
  text: string;
}

export function relocationSummary(relocations: readonly RelocationLike[], today: Date = new Date()): RelocationSummary {
  const active = relocations.filter((r) => r.status === 'in_progress' || r.status === 'planning').length;
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  const upcoming = relocations.filter((r) => r.target_date && r.status !== 'completed' && r.status !== 'cancelled');
  if (upcoming.length > 0) {
    const soonest = upcoming.sort((a, b) => dayDiff(today, a.target_date!) - dayDiff(today, b.target_date!))[0];
    const d = daysUntilMove(soonest.target_date, today);
    if (d != null && d >= 0) parts.push(`${d}d until next move`);
  }
  const text = relocations.length === 0
    ? 'No relocations planned'
    : parts.length
      ? parts.join(' · ')
      : `${relocations.length} relocation${relocations.length === 1 ? '' : 's'}`;
  return { count: relocations.length, active, text };
}

export function fmtMoney(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
