import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE CLIENT MODULES SEE EVERY WEEK OF A SERIES.
 *
 * Sixteen reads of `calendar_events` in the browser-side modules, the three
 * dashboard components and two more pages (trip intelligence's located events,
 * the Family COO's week) filtered `starts_at` — a series' FIRST start — by
 * their window: the assistant's rail (today, next fortnight), the family
 * module's next four, the kitchen screen's window, the focus list, the next
 * actions' 46 days, the moments view and the Home moment card, the personal
 * dashboard's today and fortnight, the AI Home's today, week and assigned
 * fortnight, and the family dashboard's today and fortnight. A weekly lesson
 * created in August was on none of them from September.
 *
 * All fourteen read through `readCalendarOccurrences` now. The behaviour is
 * proved where a dashboard renders (tests/home-calendar-readers.test.ts: the
 * lesson is on Today, Coming up and in the clash detector four weeks on, and
 * the transport shape of the two-query read); this file pins every module to
 * the shared read and to the family's zone — the clock's on the client, the
 * session's on the server.
 */

const ROOT = join(__dirname, '..');
const CLIENT = [
  ['components/modules/assistant-module.tsx', 2, 'clock.timeZone'],
  ['components/modules/family-module.tsx', 1, 'clock.timeZone'],
  ['components/modules/briefing-module.tsx', 1, 'familyClock.timeZone'],
  ['components/modules/focus-module.tsx', 1, 'clock.timeZone'],
  ['components/modules/next-actions-module.tsx', 1, 'clock.timeZone'],
  ['components/moments/moments-view.tsx', 1, 'clock.timeZone'],
  ['components/moments/home-moment-card.tsx', 1, 'clock.timeZone'],
] as const;
const SERVER = [
  ['components/dashboard/personal-dashboard.tsx', 2],
  ['components/dashboard/ai-home-dashboard.tsx', 3],
  ['components/dashboard/family-dashboard.tsx', 2],
  // Two pages the final sweep found after the dashboard-pages unit.
  ['app/(app)/dashboard/trip-intel/page.tsx', 1],
  ['app/(app)/dashboard/family-coo/page.tsx', 1],
] as const;

describe('every client module reads the calendar through the shared read', () => {
  it.each(CLIENT)('%s: %i read(s), expanded in the family clock\'s zone', (file, reads, zone) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src.match(/readCalendarOccurrences\(/g) ?? []).toHaveLength(reads);
    expect(src).not.toContain(".from('calendar_events')");
    expect(src).toContain(zone);
  });

  it.each(SERVER)('%s: %i read(s), expanded in the session family\'s zone', (file, reads) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src.match(/readCalendarOccurrences\(/g) ?? []).toHaveLength(reads);
    expect(src).not.toContain(".from('calendar_events')");
    expect(src).toContain("ctx.active.family.timezone || 'UTC'");
  });

  it('the sports hub reads its fortnight through the shared sports read, in the family clock\'s zone', () => {
    const src = readFileSync(join(ROOT, 'components/modules/sports-module.tsx'), 'utf8');
    expect(src.match(/readSportsOccurrences\(/g) ?? []).toHaveLength(1);
    expect(src).toContain('clock.timeZone');
    // The inserts and the delete stay; no read of the table by its first start remains.
    expect(src).not.toContain(".from('sports_events').select(");
  });

  it('the open-ended lists keep their one-offs open-ended and bound only the series', () => {
    for (const file of ['components/modules/family-module.tsx', 'components/moments/moments-view.tsx', 'components/moments/home-moment-card.tsx']) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src, file).toContain('calendarOpenWindowFilter(aheadBounds)');
      expect(src, file).toContain('366 * 86_400_000');
    }
  });

  it('a caller\'s own visibility filter rides on both reads', () => {
    const occurrences = readFileSync(join(ROOT, 'lib/calendar/occurrences.ts'), 'utf8');
    expect(occurrences).toContain('or(filter: string): OccurrenceFilters;');
    const personal = readFileSync(join(ROOT, 'components/dashboard/personal-dashboard.tsx'), 'utf8');
    expect(personal.match(/refine: \(query\) => query\.or\(mineOrShared\)/g) ?? []).toHaveLength(2);
    const aiHome = readFileSync(join(ROOT, 'components/dashboard/ai-home-dashboard.tsx'), 'utf8');
    expect(aiHome.match(/refine: \(query\) => query\.or\(`assignee_id\.eq\.\$\{myMemberId\},assignee_id\.is\.null`\)/g) ?? []).toHaveLength(2);
    expect(aiHome).toContain("refine: (query) => query.not('assignee_id', 'is', null)");
  });
});
