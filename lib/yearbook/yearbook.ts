export const ENTRY_CATEGORIES = [
  'Milestone', 'Achievement', 'Travel', 'Holiday', 'Birthday',
  'School', 'Sports', 'Family', 'Funny', 'Growth', 'Other',
] as const;

export type EntryCategory = (typeof ENTRY_CATEGORIES)[number];

export interface YearbookLike {
  id: string;
  title: string;
  year: number;
  is_published: boolean;
}

export interface EntryLike {
  id: string;
  yearbook_id: string;
  title: string;
  category: string;
  entry_date: string | null;
  member_id: string | null;
}

export function entriesByCategory(entries: readonly EntryLike[]): { category: string; count: number }[] {
  const map = new Map<string, number>();
  for (const e of entries) {
    const cat = e.category || 'Other';
    map.set(cat, (map.get(cat) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

export function entriesByMonth(entries: readonly EntryLike[]): { month: string; count: number }[] {
  const map = new Map<string, number>();
  for (const e of entries) {
    if (!e.entry_date) continue;
    const m = new Date(`${e.entry_date.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short' });
    map.set(m, (map.get(m) ?? 0) + 1);
  }
  return [...map.entries()].map(([month, count]) => ({ month, count }));
}

export interface YearbookSummary {
  totalYearbooks: number;
  totalEntries: number;
  published: number;
  text: string;
}

export function yearbookSummary(yearbooks: readonly YearbookLike[], entries: readonly EntryLike[]): YearbookSummary {
  const published = yearbooks.filter((y) => y.is_published).length;
  const parts: string[] = [];
  if (entries.length > 0) parts.push(`${entries.length} memor${entries.length === 1 ? 'y' : 'ies'}`);
  if (published > 0) parts.push(`${published} published`);
  const text = yearbooks.length === 0
    ? 'No yearbooks yet'
    : parts.length
      ? parts.join(' · ')
      : `${yearbooks.length} yearbook${yearbooks.length === 1 ? '' : 's'}`;
  return { totalYearbooks: yearbooks.length, totalEntries: entries.length, published, text };
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
