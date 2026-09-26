// Pure memory-timeline logic — unit tested, no dependencies.
// The timeline is derived at read time from milestones, past trips, and
// captioned/favorite photos, then grouped into months newest-first.

import { DEFAULT_LOCALE, type LocaleCode } from '@/lib/i18n/locales';

export type MemoryKind = 'milestone' | 'trip' | 'photo';

export type MemoryItem = {
  id: string;
  kind: MemoryKind;
  title: string;
  subtitle?: string | null;
  /** ISO date (yyyy-mm-dd or full timestamp). */
  date: string;
  imageUrl?: string | null;
  memberId?: string | null;
};

export type MemoryMonth = { key: string; label: string; items: MemoryItem[] };

function monthKey(date: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Group memories into months, newest month first, newest item first. */
export function groupByMonth(items: MemoryItem[], locale: LocaleCode = DEFAULT_LOCALE): MemoryMonth[] {
  // "July 2026" for the reader — and the ORDER matters as much as the words:
  // several locales put the year first.
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
  const byKey = new Map<string, MemoryItem[]>();
  for (const it of items) {
    const k = monthKey(it.date);
    if (!k) continue;
    const arr = byKey.get(k) ?? [];
    arr.push(it);
    byKey.set(k, arr);
  }
  return [...byKey.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, list]) => ({
      key,
      label: monthLabel.format(new Date(`${key}-01T00:00:00`)),
      items: list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    }));
}

/** Total memory count, for headers/empty states. */
export function countMemories(months: MemoryMonth[]): number {
  return months.reduce((n, m) => n + m.items.length, 0);
}
