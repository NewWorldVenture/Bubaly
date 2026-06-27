// AI-free family conflict detection over the itinerary. Pure + unit-tested.
// Flags scheduling overlaps, overbooked days, missing meals, late-night plans
// with young kids, and skipped child nap windows.
import type { VacItemKind, VacDayPart } from '@/lib/database.types';

export type ItemLike = {
  id: string;
  day_id: string | null;
  day_date?: string | null;     // resolved date for the item's day
  kind: VacItemKind;
  day_part: VacDayPart;
  title: string;
  start_time: string | null;    // "HH:MM[:SS]"
  end_time: string | null;
};

export type Conflict = {
  id: string;
  severity: 1 | 2 | 3;
  kind: 'overlap' | 'overbooked' | 'no_meals' | 'late_night' | 'nap';
  title: string;
  detail: string;
  dayKey: string;
};

const toMin = (t: string | null): number | null => {
  if (!t) return null;
  const [h, m] = t.split(':');
  const hh = Number(h), mm = Number(m);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
};

const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;

export type ConflictOptions = {
  hasYoungChildren?: boolean;   // enables nap + late-night checks
  overbookedThreshold?: number; // items/day before flagged (default 7)
};

/** Detect scheduling and family-logistics conflicts across itinerary items. */
export function detectConflicts(items: ItemLike[], opts: ConflictOptions = {}): Conflict[] {
  const threshold = opts.overbookedThreshold ?? 7;
  const conflicts: Conflict[] = [];

  // group by day
  const byDay = new Map<string, ItemLike[]>();
  for (const it of items) {
    const key = it.day_id ?? it.day_date ?? 'unscheduled';
    if (key === 'unscheduled') continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(it);
  }

  for (const [dayKey, dayItems] of byDay) {
    const label = dayItems[0]?.day_date ?? 'this day';

    // 1. time overlaps
    const timed = dayItems
      .map((it) => ({ it, s: toMin(it.start_time), e: toMin(it.end_time) }))
      .filter((x): x is { it: ItemLike; s: number; e: number } => x.s !== null && x.e !== null && x.e > x.s)
      .sort((a, b) => a.s - b.s);
    for (let i = 1; i < timed.length; i++) {
      const prev = timed[i - 1], cur = timed[i];
      if (overlaps(prev.s, prev.e, cur.s, cur.e)) {
        conflicts.push({
          id: `overlap-${cur.it.id}`, severity: 2, kind: 'overlap', dayKey,
          title: 'Overlapping plans',
          detail: `"${prev.it.title}" and "${cur.it.title}" overlap on ${label}.`,
        });
      }
    }

    // 2. overbooked day
    if (dayItems.length > threshold) {
      conflicts.push({
        id: `overbooked-${dayKey}`, severity: 1, kind: 'overbooked', dayKey,
        title: 'Packed day',
        detail: `${dayItems.length} plans on ${label} — consider trimming or adding downtime.`,
      });
    }

    // 3. no meals on a busy day
    const hasMeal = dayItems.some((it) => it.kind === 'meal');
    if (!hasMeal && dayItems.length >= 3) {
      conflicts.push({
        id: `meals-${dayKey}`, severity: 1, kind: 'no_meals', dayKey,
        title: 'No meals planned',
        detail: `${label} has plans but no meals — add breakfast/lunch/dinner blocks.`,
      });
    }

    if (opts.hasYoungChildren) {
      // 4. late-night plans
      const late = dayItems.find((it) => { const s = toMin(it.start_time); return s !== null && s >= 21 * 60; });
      if (late) {
        conflicts.push({
          id: `late-${late.id}`, severity: 1, kind: 'late_night', dayKey,
          title: 'Late night with kids',
          detail: `"${late.title}" starts late on ${label} — may be tough for young children.`,
        });
      }
      // 5. no afternoon nap window (lots of early/late, nothing flagged as free_time in the afternoon)
      const afternoonItems = dayItems.filter((it) => it.day_part === 'afternoon');
      const hasDowntime = dayItems.some((it) => it.kind === 'free_time');
      if (afternoonItems.length >= 2 && !hasDowntime) {
        conflicts.push({
          id: `nap-${dayKey}`, severity: 1, kind: 'nap', dayKey,
          title: 'No nap window',
          detail: `Back-to-back afternoon plans on ${label} leave no rest time for little ones.`,
        });
      }
    }
  }

  return conflicts.sort((a, b) => b.severity - a.severity);
}
