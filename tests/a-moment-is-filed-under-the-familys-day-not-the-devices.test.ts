// The Moments page files each moment under Today / Tomorrow / This week /
// Later. The bucket took its day from the DEVICE's getFullYear/getMonth/getDate
// and knew no zone. An all-day calendar row is stored at UTC midnight
// (lib/calendar/day.ts), so anywhere west of Greenwich TOMORROW's all-day
// moment sat under the "Today" header while its own card, labelled in the
// family's zone by momentWhen, said "Tomorrow"; and a phone outside the
// family's zone shifted timed moments the same way. The header was also the
// hard-coded English BUCKET_LABEL (LIBRARY-C00514B83470).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupMoments, momentBucket } from '@/lib/moments/grouping';
import { momentWhen } from '@/lib/moments/prep';

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';
// 10am on Saturday 2026-07-04 in Los Angeles.
const LA_MORNING = new Date('2026-07-04T17:00:00.000Z');
// 6:30pm on 2026-07-04 in Los Angeles: already 01:30 on the 5th at Greenwich.
const LA_EVENING = new Date('2026-07-05T01:30:00.000Z');
// 8am on 2026-07-05 in Tokyo: still 23:00 on the 4th at Greenwich.
const TOKYO_MORNING = new Date('2026-07-04T23:00:00.000Z');

describe("a moment is filed under the family's day, not the device's", () => {
  it("files an all-day row under the date it names, on the family's today", () => {
    // Stored at UTC midnight: 5pm on the 4th in Los Angeles, 9am on the 5th in Tokyo.
    const tomorrowAllDay = '2026-07-05T00:00:00.000Z';
    expect(momentBucket(tomorrowAllDay, LA_MORNING, { allDay: true, timeZone: LA })).toBe('tomorrow');
    expect(momentBucket('2026-07-04T00:00:00.000Z', LA_MORNING, { allDay: true, timeZone: LA })).toBe('today');
    // In the Los Angeles evening Greenwich has moved on; the family has not.
    expect(momentBucket(tomorrowAllDay, LA_EVENING, { allDay: true, timeZone: LA })).toBe('tomorrow');
    // In Tokyo the family's day is already the 5th.
    expect(momentBucket(tomorrowAllDay, TOKYO_MORNING, { allDay: true, timeZone: TOKYO })).toBe('today');
    expect(momentBucket('2026-07-06T00:00:00.000Z', TOKYO_MORNING, { allDay: true, timeZone: TOKYO })).toBe('tomorrow');
  });

  it('files a synthetic birthday (a zone-less date at midnight) under its own date', () => {
    expect(momentBucket('2026-07-05T00:00:00', LA_EVENING, { allDay: true, timeZone: LA })).toBe('tomorrow');
    expect(momentBucket('2026-07-05T00:00:00', TOKYO_MORNING, { allDay: true, timeZone: TOKYO })).toBe('today');
  });

  it("files a timed moment by the family's wall clock, whatever zone the device is in", () => {
    // 9pm on the 4th in Los Angeles is 04:00Z on the 5th.
    expect(momentBucket('2026-07-05T04:00:00.000Z', LA_MORNING, { allDay: false, timeZone: LA })).toBe('today');
    // 12:30am on the 5th in Los Angeles is 07:30Z on the 5th.
    expect(momentBucket('2026-07-05T07:30:00.000Z', LA_MORNING, { allDay: false, timeZone: LA })).toBe('tomorrow');
    // 7am on the 6th in Tokyo is 22:00Z on the 5th.
    expect(momentBucket('2026-07-05T22:00:00.000Z', TOKYO_MORNING, { allDay: false, timeZone: TOKYO })).toBe('tomorrow');
    // Seven family days out is this week; eight is later.
    expect(momentBucket('2026-07-12T04:00:00.000Z', LA_MORNING, { allDay: false, timeZone: LA })).toBe('this-week');
    expect(momentBucket('2026-07-13T04:00:00.000Z', LA_MORNING, { allDay: false, timeZone: LA })).toBe('later');
  });

  it('the header a card sits under agrees with the label on the card', () => {
    const rows = [
      { id: 'allday', starts_at: '2026-07-05T00:00:00.000Z', all_day: true },
      { id: 'late', starts_at: '2026-07-05T04:00:00.000Z', all_day: false },
    ];
    for (const [now, zone] of [[LA_MORNING, LA], [LA_EVENING, LA]] as const) {
      const groups = groupMoments(rows, (r) => r.starts_at, now, { timeZone: zone, allDay: (r) => r.all_day });
      expect(groups.map((g) => [g.bucket, g.items.map((r) => r.id)])).toEqual([['today', ['late']], ['tomorrow', ['allday']]]);
      expect(momentWhen('2026-07-05T00:00:00.000Z', true, now, 'en-US', undefined, zone)).toBe('Tomorrow');
    }
  });

  it("the Moments page buckets in the family's zone and translates the header", () => {
    const view = readFileSync('components/moments/moments-view.tsx', 'utf8');
    const call = /groupMoments\(([^;]*?)\)\.map\(/s.exec(view)?.[1] ?? '';
    expect(call, 'the page hands groupMoments the family zone').toContain('timeZone: clock.timeZone');
    expect(call, 'the page tells groupMoments which rows are all-day').toContain('event.all_day');
    expect(view, 'the header is not the hard-coded English label').not.toContain('{group.label}');
    expect(view).toContain('{bucketLabel[group.bucket]}');
    for (const key of ['calendar.today', 'quickCapture.tomorrow', 'care.thisWeek', 'registerSw.later']) {
      expect(view, `the header reads ${key} from the catalogue`).toContain(`t('${key}')`);
    }
  });
});
