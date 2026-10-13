import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dueBucket, groupByDue, type HomeworkLike } from '@/lib/homework/board';
import { bodyOf } from './helpers/source-order';

/**
 * The Homework board's "Due today" heading was decided on the DEVICE's
 * calendar (`getFullYear/getMonth/getDate`), while the due time printed under
 * it, the due-date input and every other day on the page are on the FAMILY's
 * clock (TIME-003). A parent checking from a trip, or a laptop left on another
 * zone, saw tonight's worksheet under "Upcoming" and tomorrow morning's under
 * "Due today" — the one heading a child is meant to act on.
 *
 * Both cases below are chosen so that at least one of them disagrees with the
 * host clock under TZ=UTC and under TZ=America/Los_Angeles, the two zones CI
 * runs this suite in.
 */

const hw = (due_at: string): HomeworkLike => ({ id: 'hw-1', due_at, status: 'assigned' });

describe('homework due today is the family\'s today', () => {
  it('a worksheet due this evening in Auckland is due today for an Auckland family', () => {
    const now = new Date('2026-06-20T13:00:00Z'); // 01:00 on 21 June in Auckland
    const due = hw('2026-06-21T05:00:00Z');       // 17:00 on 21 June in Auckland
    expect(dueBucket(due, now, 'Pacific/Auckland')).toBe('today');
    expect(groupByDue([due], now, 'Pacific/Auckland').today.map((h) => h.id)).toEqual(['hw-1']);
  });

  it('a worksheet due after midnight in Honolulu is upcoming for a Honolulu family', () => {
    const now = new Date('2026-06-20T09:00:00Z'); // 23:00 on 19 June in Honolulu
    const due = hw('2026-06-20T11:00:00Z');       // 01:00 on 20 June in Honolulu
    expect(dueBucket(due, now, 'Pacific/Honolulu')).toBe('upcoming');
    expect(groupByDue([due], now, 'Pacific/Honolulu').upcoming.map((h) => h.id)).toEqual(['hw-1']);
  });

  it('overdue, done and undated work is bucketed the same whatever the zone', () => {
    const now = new Date('2026-06-20T13:00:00Z');
    expect(dueBucket(hw('2026-06-20T12:59:00Z'), now, 'Pacific/Auckland')).toBe('overdue');
    expect(dueBucket({ id: 'x', due_at: null, status: 'assigned' }, now, 'Pacific/Auckland')).toBe('no_date');
    expect(dueBucket({ id: 'x', due_at: '2026-06-21T05:00:00Z', status: 'submitted' }, now, 'Pacific/Auckland')).toBe('done');
  });

  it('the Homework page buckets on the family clock it already holds', () => {
    const src = readFileSync('components/modules/homework-module.tsx', 'utf8');
    const grouped = bodyOf(src, 'const grouped = useMemo(', ');');
    expect(grouped).toContain('groupByDue(visible as HomeworkLike[], now, clock.timeZone)');
  });
});
