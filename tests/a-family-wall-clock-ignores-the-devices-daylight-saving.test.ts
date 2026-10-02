// Review 5370711559 on #688: the family clock's wall readings were built from
// the DEVICE's local Date fields, so the device's own daylight-saving rules
// rewrote a family wall time before `toInstant` turned it back:
//
//   device America/Los_Angeles, family UTC, 2026-03-08T02:30Z
//     -> read back as 03:30Z (02:30 does not exist in Los Angeles that morning)
//   device America/Santiago, family UTC, the family's day 2026-09-06
//     -> the day started at 01:00Z (Santiago skips its midnight that day), so
//        an event at 00:30Z fell outside "today" for Assistant, Focus and Health
//
// Wall readings are now Dates whose UTC fields hold the family's civil time
// (lib/time/wall-clock.ts), which no device's DST can move. These tests switch
// the process's zone to play the phone — Node re-reads TZ on assignment — so
// they hold whatever zone the suite itself runs in (CI: UTC, Los Angeles,
// Tokyo). The first three groups use only the clock API the old implementation
// also had, so the same assertions fail against it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { at, between, bodyOf } from './helpers/source-order';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { FamilyTimeZoneProvider, LocaleProvider } from '@/components/i18n/locale-provider';
import { calendarDayOfKey, useFamilyClock, type FamilyClock } from '@/components/i18n/use-format';
import { localeOrDefault } from '@/lib/i18n/locales';
import { detectRoutines, materializeRoutine, templateFromSuggestion } from '@/lib/routines/detect';
import { wallFromKey, wallMonthStart, wallWeekStart, wallKey } from '@/lib/time/wall-clock';
import { addDays as addPracticeDays } from '@/lib/language/practice';
import { sessionStreak, weeklyPlan } from '@/lib/declutter/missions';
import { streaksByMember } from '@/lib/chores/dashboard';
import { upcomingRides } from '@/lib/rides/schedule';
import { dosesForDay } from '@/lib/medications/adherence';
import { daysUntil as tripDaysUntil, isActive as tripIsActive } from '@/lib/vacations/dates';
import { fromLocalInput } from '@/lib/time/local-input';
import { routineAdherence, consistencyScore } from '@/lib/sleep/coach';
import { positiveStreakDays, trendByWeek } from '@/lib/behavior/insights';

const HOST_ZONE = process.env.TZ;
afterEach(() => { process.env.TZ = HOST_ZONE; });

/** Hold the phone in `zone`: every local Date field from here on is read there. */
function onDevice(zone: string) { process.env.TZ = zone; }

/** The clock a component under the (app) layout's providers gets for a family in `familyZone`. */
function clockFor(familyZone: string): FamilyClock {
  let clock: FamilyClock | undefined;
  const Probe = () => { clock = useFamilyClock(); return null; };
  renderToString(createElement(LocaleProvider, {
    locale: localeOrDefault('en-US'), source: 'default', messages: {},
    children: createElement(FamilyTimeZoneProvider, { timeZone: familyZone, children: createElement(Probe) }),
  }));
  return clock!;
}

const iso = (d: Date) => d.toISOString();

describe('a Los Angeles phone, a UTC family, the morning Los Angeles springs forward', () => {
  const HALF_TWO = new Date('2026-03-08T02:30:00Z');

  it('the family\'s 02:30 reads, and round-trips, as 02:30 — not 03:30', () => {
    onDevice('America/Los_Angeles');
    const clock = clockFor('UTC');
    expect(iso(clock.toInstant(clock.wallOf(HALF_TWO)))).toBe('2026-03-08T02:30:00.000Z');
    expect(iso(clock.toInstant(clock.wallNow(HALF_TWO)))).toBe('2026-03-08T02:30:00.000Z');
    expect(clock.wallKey(clock.wallOf(HALF_TWO))).toBe('2026-03-08');
    expect(clock.hourNow(HALF_TWO)).toBe(2);
  });

  it('the family\'s day still starts at its own midnight', () => {
    onDevice('America/Los_Angeles');
    const clock = clockFor('UTC');
    expect(iso(clock.toInstant(clock.wallToday(HALF_TWO)))).toBe('2026-03-08T00:00:00.000Z');
  });

  it('control: the same reading on a UTC phone', () => {
    onDevice('UTC');
    const clock = clockFor('UTC');
    expect(iso(clock.toInstant(clock.wallOf(HALF_TWO)))).toBe('2026-03-08T02:30:00.000Z');
  });
});

describe('a Santiago phone, a UTC family, the day Santiago skips its midnight', () => {
  // Santiago moves 00:00 -> 01:00 on Sunday 6 September 2026.
  const NOON = new Date('2026-09-06T12:00:00Z');
  const EVENT = new Date('2026-09-06T00:30:00Z');

  it('the family\'s day starts at 00:00Z, not 01:00Z', () => {
    onDevice('America/Santiago');
    const clock = clockFor('UTC');
    expect(iso(clock.toInstant(clock.wallToday(NOON)))).toBe('2026-09-06T00:00:00.000Z');
  });

  it('an event at 00:30Z is inside the family\'s today', () => {
    onDevice('America/Santiago');
    const clock = clockFor('UTC');
    const start = clock.toInstant(clock.wallToday(NOON));
    expect(EVENT >= start).toBe(true);
    expect(clock.dayKeyOf(EVENT)).toBe('2026-09-06');
  });

  it('the 00:30 reading round-trips', () => {
    onDevice('America/Santiago');
    const clock = clockFor('UTC');
    expect(iso(clock.toInstant(clock.wallOf(EVENT)))).toBe('2026-09-06T00:30:00.000Z');
  });

  it('control: the same day on a UTC phone', () => {
    onDevice('UTC');
    const clock = clockFor('UTC');
    expect(iso(clock.toInstant(clock.wallToday(NOON)))).toBe('2026-09-06T00:00:00.000Z');
    expect(EVENT >= clock.toInstant(clock.wallToday(NOON))).toBe(true);
  });
});

describe('hydration: the server and the phone compute the same family clock', () => {
  // The server renders on a UTC host; the browser hydrates on the phone. Every
  // value a family surface derives from the clock must come out the same on
  // both, or the first client render disagrees with the HTML.
  const cases = [
    { family: 'UTC', device: 'America/Los_Angeles', at: '2026-03-08T02:30:00Z' },
    { family: 'UTC', device: 'America/Santiago', at: '2026-09-06T00:30:00Z' },
    { family: 'America/Los_Angeles', device: 'Asia/Tokyo', at: '2026-11-01T09:30:00Z' },
    { family: 'Asia/Tokyo', device: 'America/Santiago', at: '2026-09-05T15:10:00Z' },
  ];
  it.each(cases)('family $family, phone $device', ({ family, device, at }) => {
    const read = () => {
      const clock = clockFor(family);
      const now = new Date(at);
      return [
        clock.todayKey(now), clock.hourNow(now), clock.wallKey(clock.wallToday(now)),
        iso(clock.toInstant(clock.wallToday(now))), iso(clock.toInstant(clock.wallNow(now))),
        iso(clock.toInstant(clock.wallOf(at))), clock.dayKeyOf('2026-09-06'),
      ].join(' | ');
    };
    onDevice('UTC');
    const server = read();
    onDevice(device);
    expect(read()).toBe(server);
  });
});

describe('the day bounds Assistant, Focus, Health, Chores and School query with', () => {
  it('dayStart / addDays are the family\'s midnights on any phone', () => {
    for (const device of ['UTC', 'America/Los_Angeles', 'America/Santiago', 'Asia/Tokyo']) {
      onDevice(device);
      const clock = clockFor('UTC');
      const now = new Date('2026-09-06T12:00:00Z');
      expect([iso(clock.dayStart(0, now)), iso(clock.dayStart(1, now)), iso(clock.dayStart(-7, now))], device)
        .toEqual(['2026-09-06T00:00:00.000Z', '2026-09-07T00:00:00.000Z', '2026-08-30T00:00:00.000Z']);
      expect(clock.wallKey(clock.addDays(clock.wallToday(now), 1)), device).toBe('2026-09-07');
    }
  });

  it('where the FAMILY skips its midnight, its day starts at the first minute it has', () => {
    // Family in Santiago, phone in UTC: the family's 6 September begins 01:00 -03.
    onDevice('UTC');
    const clock = clockFor('America/Santiago');
    expect(iso(clock.dayStart(0, new Date('2026-09-06T15:00:00Z')))).toBe('2026-09-06T04:00:00.000Z');
  });

  it('a week of family days has seven distinct dates across the phone\'s fall-back', () => {
    onDevice('America/Los_Angeles'); // falls back on 1 November 2026
    const clock = clockFor('UTC');
    const today = clock.wallToday(new Date('2026-10-31T12:00:00Z'));
    const keys = Array.from({ length: 7 }, (_, i) => clock.wallKey(clock.addDays(today, i)));
    expect(keys).toEqual(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
  });
});

describe('date-only values stay dates', () => {
  it('a DATE is its own day on every phone', () => {
    for (const device of ['America/Los_Angeles', 'America/Santiago', 'Asia/Tokyo']) {
      onDevice(device);
      expect(clockFor('UTC').dayKeyOf('2026-09-06'), device).toBe('2026-09-06');
    }
  });

  it('calendarToday hands the date-only helpers the family\'s day, even on the Santiago phone\'s skipped midnight', () => {
    onDevice('America/Santiago');
    const day = clockFor('UTC').calendarToday(new Date('2026-09-06T00:30:00Z'));
    expect([day.getFullYear(), day.getMonth() + 1, day.getDate()]).toEqual([2026, 9, 6]);
  });
});

describe('the callers do their arithmetic on the wall reading, not on device fields', () => {
  // Every consumer of the family clock. A wall reading is read and moved only
  // with the wall-clock helpers; a local constructor or local getter on one
  // reads the device's fields and brings the defect back.
  const ROOT = join(__dirname, '..');
  const CONSUMERS = [
    'components/modules/assistant-module.tsx', 'components/modules/focus-module.tsx',
    'components/modules/health-module.tsx', 'components/modules/chores-module.tsx',
    'components/modules/school-module.tsx', 'components/modules/security-module.tsx',
    'components/modules/photos-module.tsx', 'components/modules/next-actions-module.tsx',
    'components/modules/messages-module.tsx', 'components/modules/todos-module.tsx',
    'components/modules/family-module.tsx', 'components/modules/calendar-module.tsx',
    'components/modules/dining-module.tsx', 'components/app/quick-capture.tsx',
  ];

  it.each(CONSUMERS)('%s', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    // A device-local Date handed back to the clock as if it were a reading.
    expect(src).not.toMatch(/clock\.(toInstant|wallKey|addDays)\(\s*new Date\(/);
    // A reading taken apart with local getters, or moved with local setters.
    const readings = [...src.matchAll(/const (\w+) = clock\.wall(?:Now|Today|Of)\(/g)].map((m) => m[1]);
    for (const name of readings) {
      expect(src, `${name} in ${file}`).not.toMatch(new RegExp(`\\b${name}\\.(get|set)(FullYear|Month|Date|Day|Hours|Minutes)\\(`));
    }
    expect(src).not.toMatch(/clock\.wall(?:Now|Today|Of)\([^)]*\)\.(get|set)(FullYear|Month|Date|Day|Hours|Minutes)\(/);
    // The date-only handoff never becomes a wall reading or an instant.
    expect(src).not.toMatch(/clock\.(toInstant|wallKey|addDays)\(\s*clock\.calendarToday\(/);
  });
});

describe('the calendar grid and the routines applied from it', () => {
  it('week and month starts are the family\'s, on any phone', () => {
    for (const device of ['America/Los_Angeles', 'America/Santiago', 'Asia/Tokyo']) {
      onDevice(device);
      const sunday = wallFromKey('2026-09-06');
      expect([wallKey(wallWeekStart(sunday)), wallKey(wallWeekStart(sunday, 1)), wallKey(wallMonthStart(sunday)), wallKey(wallMonthStart(sunday, -1))], device)
        .toEqual(['2026-08-31', '2026-09-07', '2026-09-01', '2026-08-01']);
    }
  });

  it('a routine applied to the family\'s week lands at the family\'s wall-clock times, on any phone', () => {
    const template = { weekday_mask: 0b1000001, items: [{ title: 'Early run', category: 'sports' as const, start_minutes: 2 * 60 + 30, duration_minutes: 30, assignee_id: null }] };
    for (const device of ['America/Los_Angeles', 'America/Santiago', 'Asia/Tokyo']) {
      onDevice(device);
      // A UTC family: 02:30 every Monday and Sunday of the week of 2 March.
      const utc = materializeRoutine(template, wallFromKey('2026-03-02'), 1, 'UTC').map((r) => r.starts_at);
      expect(utc, device).toEqual(['2026-03-02T02:30:00.000Z', '2026-03-08T02:30:00.000Z']);
      // A Los Angeles family: its own 02:30 on 8 March does not exist, so the first minute that does.
      const la = materializeRoutine(template, wallFromKey('2026-03-02'), 1, 'America/Los_Angeles').map((r) => r.starts_at);
      expect(la, device).toEqual(['2026-03-02T10:30:00.000Z', '2026-03-08T10:00:00.000Z']);
    }
  });
});

describe('a routine seen, saved and applied on the family\'s clock (review 5371688966)', () => {
  // detectRoutines -> the template the panel saves (templateFromSuggestion) ->
  // materializeRoutine, as the routines panel runs them. Detection used to read
  // the PHONE's weekday and hour while application read the FAMILY's, so on a
  // phone in another zone a Monday 21:00 routine came back Tuesday 06:00.
  const PHONES = ['UTC', 'America/Los_Angeles', 'America/Santiago', 'Asia/Tokyo'];
  const roundTrip = (starts: string[], familyZone: string, applyMonday: string) => {
    const events = starts.map((starts_at, i) => ({
      id: `e${i}`, title: 'School run', category: 'school' as const, starts_at, ends_at: null, all_day: false, assignee_id: null,
    }));
    const [found] = detectRoutines(events, { timeZone: familyZone });
    expect(found, 'a routine is detected').toBeDefined();
    return materializeRoutine(templateFromSuggestion(found), wallFromKey(applyMonday), 1, familyZone).map((r) => r.starts_at);
  };

  it.each(PHONES)('UTC family, Mondays 21:00 (crosses into Tuesday in Tokyo), on a %s phone', (phone) => {
    onDevice(phone);
    expect(roundTrip(['2026-09-07T21:00:00Z', '2026-09-14T21:00:00Z', '2026-09-21T21:00:00Z'], 'UTC', '2026-09-28'))
      .toEqual(['2026-09-28T21:00:00.000Z']);
  });

  it.each(PHONES)('Los Angeles family, Mondays 07:30, on a %s phone', (phone) => {
    onDevice(phone);
    expect(roundTrip(['2026-09-07T14:30:00Z', '2026-09-14T14:30:00Z', '2026-09-21T14:30:00Z'], 'America/Los_Angeles', '2026-09-28'))
      .toEqual(['2026-09-28T14:30:00.000Z']);
  });

  it.each(PHONES)('UTC family, Mondays 15:00 in January, on a %s phone', (phone) => {
    onDevice(phone);
    expect(roundTrip(['2026-01-05T15:00:00Z', '2026-01-12T15:00:00Z', '2026-01-19T15:00:00Z'], 'UTC', '2026-01-26'))
      .toEqual(['2026-01-26T15:00:00.000Z']);
  });

  it('the panel detects and saves on the family\'s clock, through the shared mapping', () => {
    const src = readFileSync(join(__dirname, '..', 'components/modules/routines-panel.tsx'), 'utf8');
    expect(src).toMatch(/detectRoutines\(events, \{[^}]*\btimeZone\b[^}]*\}\)/);
    expect(src).toContain('templateFromSuggestion(s)');
    expect(src).toMatch(/materializeRoutine\([\s\S]{0,400}?weekStartMonday, 1, timeZone,/);
  });
});

describe('rides and chore streaks read the family\'s day (#688 review comments 5920088211, 5920088767)', () => {
  const member = { id: 'm1', display_name: 'Kid', color: null };
  const approved = (at: string) => ({ id: at, chore_id: 'c', member_id: 'm1', status: 'approved', approved_at: at, submitted_at: at, points_awarded: 1 }) as never;

  it('a Los Angeles phone keeps a UTC family\'s two-day chore streak alive', () => {
    onDevice('America/Los_Angeles');
    const clock = clockFor('UTC');
    const now = new Date('2026-10-01T02:30:00Z');
    const rows = [approved('2026-09-29T00:30:00Z'), approved('2026-09-30T00:30:00Z')];
    expect(streaksByMember([member], rows, clock.todayKey(now), clock.timeZone).map((r) => r.days)).toEqual([2]);
  });

  it('a UTC phone keeps a Tokyo family\'s two-day chore streak alive', () => {
    onDevice('UTC');
    const clock = clockFor('Asia/Tokyo');
    const now = new Date('2026-09-30T16:30:00Z');
    const rows = [approved('2026-09-28T16:00:00Z'), approved('2026-09-29T16:00:00Z')];
    expect(streaksByMember([member], rows, clock.todayKey(now), clock.timeZone).map((r) => r.days)).toEqual([2]);
  });

  it('upcoming rides are the family\'s today and later, on any phone', () => {
    const ride = (id: string, ride_date: string) => ({ id, title: id, ride_date, pickup_time: null, dropoff_time: null, driver_id: null, rider_ids: [], status: 'planned' }) as never;
    const rides = [ride('yesterday', '2026-09-29'), ride('today', '2026-09-30'), ride('tomorrow', '2026-10-01')];
    // A UTC family at 22:30Z on 30 September, seen from Tokyo (already 1 October there).
    onDevice('Asia/Tokyo');
    expect(upcomingRides(rides, clockFor('UTC').todayKey(new Date('2026-09-30T22:30:00Z'))).map((r: { id: string }) => r.id)).toEqual(['today', 'tomorrow']);
    // A UTC family at 02:30Z on 1 October, seen from Los Angeles (still 30 September there).
    onDevice('America/Los_Angeles');
    expect(upcomingRides(rides, clockFor('UTC').todayKey(new Date('2026-10-01T02:30:00Z'))).map((r: { id: string }) => r.id)).toEqual(['tomorrow']);
  });

  it.each(['rides', 'renewals', 'signups', 'trips'])('%s selects on the family\'s today, with no device todayKey left', (name) => {
    const src = readFileSync(join(__dirname, '..', `components/modules/${name}-module.tsx`), 'utf8');
    expect(src).toContain('const tk = clock.todayKey();');
    expect(src).not.toMatch(/function todayKey\(/);
  });

  it('the chores sidebar buckets completions in the family\'s zone', () => {
    const src = readFileSync(join(__dirname, '..', 'components/modules/chores-module.tsx'), 'utf8');
    expect(src).toContain('streaksByMember(members, asgLike(data), clock.todayKey(), clock.timeZone)');
  });
});

describe('a dose shown on the family\'s day can be logged on it (#688 comment 5921999453)', () => {
  const daily = { id: 's1', medication_id: 'm1', time_of_day: '00:15', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-01-01', ends_on: null };
  /** The medicines list: slots for the family's day key, as the module builds them. */
  const listed = (clock: FamilyClock, now: Date) =>
    dosesForDay([daily], [], new Date(`${clock.todayKey(now)}T12:00:00`), clock.timeZone).map((d) => d.slotKey);
  /** logDose's fresh check: the same schedule, re-read on the family's calendar day. */
  const rechecked = (clock: FamilyClock, now: Date) =>
    dosesForDay([daily], [], clock.calendarToday(now), clock.timeZone).map((d) => d.slotKey);

  it.each([
    ['America/Los_Angeles', 'UTC', '2026-10-01T02:30:00Z', '2026-10-01T00:15'],
    ['Asia/Tokyo', 'UTC', '2026-09-30T16:30:00Z', '2026-09-30T00:15'],
    ['UTC', 'UTC', '2026-10-01T02:30:00Z', '2026-10-01T00:15'],
    ['Asia/Tokyo', 'Asia/Tokyo', '2026-09-30T16:30:00Z', '2026-10-01T00:15'],
  ])('a %s phone, a %s family, at %s: the listed slot passes the re-check', (device, family, at, slot) => {
    onDevice(device);
    const clock = clockFor(family);
    const now = new Date(at);
    expect(listed(clock, now)).toEqual([slot]);
    expect(rechecked(clock, now)).toEqual([slot]);
    // What the re-check used to read: the device's day, a different slot whenever the dates differ.
    const deviceDay = dosesForDay([daily], [], now, clock.timeZone).map((d) => d.slotKey);
    if (device !== family) expect(deviceDay).not.toEqual([slot]);
  });

  it('logDose re-checks on the family\'s calendar day, not the device\'s', () => {
    const src = readFileSync(join(__dirname, '..', 'components/modules/medications-module.tsx'), 'utf8');
    const logDose = between(src, 'async function logDose(', 'await mutate(`dose:');
    expect(logDose).toContain('dosesForDay([schedule], [], clock.calendarToday(), familyZone)');
    expect(logDose).not.toMatch(/dosesForDay\([^)]*new Date\(\)/);
  });
});

describe('ages, renewals, trips and due dates count from the family\'s calendar day, not the device\'s', () => {
  // ageOn and insuranceSummary read a Date's local date fields; a Date passed
  // in from the device clock would give the phone's day, not the family's.
  it.each([
    ['components/modules/family-module.tsx', 'memberAge(m.birthday, now)'],
    ['components/modules/billing-module.tsx', 'memberAge(m?.birthday ?? null, familyDay)'],
    ['components/medical/print-sheet.tsx', 'ageFrom(member.birthday, clock.calendarToday())'],
    ['components/modules/insurance-module.tsx', 'insuranceSummary(policies.data, today)'],
  ])('%s', (file, call) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(src).toContain(call);
    expect(src).not.toMatch(/(ageOn|insuranceSummary)\([^)]*new Date\(\)\)/);
  });

  it.each([
    ['components/vacations/vacations-list.tsx', ['daysUntil(a.start_date, familyToday)', 'isActive(t.start_date, t.end_date, familyToday)', 'isActive(current.start_date, current.end_date, familyToday)', 'countdownLabel(tr, current.start_date, familyToday)', 'countdownLabel(tr, t.start_date, familyToday)', '[trips, familyToday]']],
    ['components/vacations/vacations-reports.tsx', ['daysUntil(t.start_date, familyToday)']],
    ['components/vacations/trip-overview.tsx', ['countdownLabel(tr, trip?.start_date, familyToday)']],
    ['components/modules/immunizations-module.tsx', ['daysUntilDue(s, familyToday)', 'dueStatus(s, familyToday)']],
    ['components/modules/health-visits-module.tsx', ['daysUntilFollowUp(v, familyToday)']],
    ['components/modules/pets-module.tsx', ['upcomingCare(records.data, familyToday)', 'petAgeLabel(pet.birthday, familyToday)', 'upcomingCare(petRecords, familyToday)', 'careUrgency(r.next_due, familyToday)']],
    ['components/modules/insurance-module.tsx', ['upcomingRenewals(policies.data, today)', 'renewalUrgency(p.renewal_date, today)', 'renewalUrgency(policy.renewal_date, today)']],
    ['components/finance/bills-view.tsx', ['billDueStatus(b, familyToday)', '[visible, mode, familyToday]']],
    ['components/finance/budgets-view.tsx', ['budgetSpent(allTxns, b.category, b.period as Period, familyToday)']],
  ])('%s passes the family\'s day to its date-only helpers (#688 comment 5922119441 and the sweep after it)', (file, calls) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    for (const call of calls) expect(src).toContain(call);
  });

  it.each([
    ['Asia/Tokyo', 'UTC', '2026-09-30T22:30:00Z', '2026-09-30'],
    ['America/Los_Angeles', 'UTC', '2026-10-01T02:30:00Z', '2026-10-01'],
    ['UTC', 'UTC', '2026-10-01T02:30:00Z', '2026-10-01'],
  ])('a trip on the family\'s day is today\'s trip: a %s phone, a %s family, at %s', (device, family, at, tripDay) => {
    onDevice(device);
    const clock = clockFor(family);
    const now = new Date(at);
    expect(tripDaysUntil(tripDay, clock.calendarToday(now))).toBe(0);
    expect(tripIsActive(tripDay, tripDay, clock.calendarToday(now))).toBe(true);
    // What the device's day gave when the dates differ: yesterday's or tomorrow's trip.
    if (device !== family) expect(tripIsActive(tripDay, tripDay, now)).toBe(false);
  });

  it('a birthday turns over on the family\'s day: a Tokyo family, a Los Angeles phone', async () => {
    const { ageOn } = await import('@/lib/utils/birthday');
    onDevice('America/Los_Angeles');
    const clock = clockFor('Asia/Tokyo');
    const now = new Date('2026-10-01T01:00:00Z'); // 1 October in Tokyo, still 30 September in Los Angeles
    expect(ageOn('2016-10-01', clock.calendarToday(now))).toBe(10);
    expect(ageOn('2016-10-01', now)).toBe(9); // what the device's day gave
  });
});

describe('the calendar form compares the times it will save (#688 comment 5922125002)', () => {
  it('a UTC family\'s 02:30–03:15 on the day a Los Angeles phone springs forward is a valid event', () => {
    onDevice('America/Los_Angeles');
    const start = fromLocalInput('2026-03-08T02:30', 'UTC')!;
    const end = fromLocalInput('2026-03-08T03:15', 'UTC')!;
    expect([start, end].map((v) => new Date(v).toISOString())).toEqual(['2026-03-08T02:30:00.000Z', '2026-03-08T03:15:00.000Z']);
    expect(new Date(end) > new Date(start)).toBe(true);
    // The old check read the naive text on the phone's clock, where 02:30 is skipped to 03:30.
    expect(new Date('2026-03-08T03:15') <= new Date('2026-03-08T02:30')).toBe(true);
  });

  it('an end before or equal to the start is still refused', () => {
    onDevice('America/Los_Angeles');
    const start = fromLocalInput('2026-03-08T03:15', 'UTC')!;
    expect(new Date(fromLocalInput('2026-03-08T03:15', 'UTC')!) <= new Date(start)).toBe(true);
    expect(new Date(fromLocalInput('2026-03-08T02:30', 'UTC')!) <= new Date(start)).toBe(true);
  });

  it('NewEventModal resolves both boxes on the family\'s clock before comparing them, and saves those', () => {
    const src = readFileSync(join(__dirname, '..', 'components/modules/calendar-module.tsx'), 'utf8');
    const submit = between(src, 'const parsed = eventSchema.safeParse(input);', 'const result = existing');
    expect(submit).toContain('const startsAt = fromLocalInput(parsed.data.starts_at, timeZone)');
    expect(submit).toContain('if (endsAt && new Date(endsAt) <= new Date(startsAt))');
    expect(submit).not.toMatch(/new Date\(parsed\.data\./);
    expect(at(submit, 'const startsAt')).toBeLessThan(at(submit, 'new Date(endsAt)'));
  });
});

describe('sleep adherence reads bedtimes on the family\'s clock (#688 comment 5922150055)', () => {
  const log = (bedtime: string) => ({ id: bedtime, member_id: 'm', sleep_date: bedtime.slice(0, 10), bedtime, wake_time: bedtime, duration_min: 480, quality: null }) as never;
  const routine = { target_bedtime: '21:30', days_of_week: [0, 1, 2, 3, 4, 5, 6] } as never;

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])('a UTC family\'s 21:30 bedtime meets its 21:30 routine on a %s phone', (device) => {
    onDevice(device);
    expect(routineAdherence(routine, [log('2026-09-30T21:30:00Z')], 'UTC')).toBe(100);
    expect(consistencyScore([log('2026-09-29T21:30:00Z'), log('2026-09-30T21:30:00Z')], 'UTC')).toBe(100);
  });

  it('a New York family\'s 21:30 bedtime either side of its fall-back is perfectly consistent (#688 comment 5922824315)', () => {
    // 21:30 EDT on 31 Oct is 01:30Z; 21:30 EST on 1 Nov is 02:30Z. Read on a
    // UTC or Tokyo clock they are an hour apart; on the family's, identical.
    const nights = [log('2026-11-01T01:30:00Z'), log('2026-11-02T02:30:00Z')];
    for (const device of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      onDevice(device);
      expect(consistencyScore(nights, 'America/New_York')).toBe(100);
    }
    onDevice('UTC');
    expect(consistencyScore(nights)).toBeLessThan(100); // the zone-less answer
  });

  it('without the zone it read the phone\'s clock (the old answer on a Los Angeles phone)', () => {
    onDevice('America/Los_Angeles');
    expect(routineAdherence(routine, [log('2026-09-30T21:30:00Z')])).toBe(0);
  });

  it('the Sleep page passes the family\'s zone', () => {
    const src = readFileSync(join(__dirname, '..', 'components/modules/sleep-module.tsx'), 'utf8');
    expect(src).toContain('sleepSummary(memberLogs, routine, age, today, memberId, clock.timeZone)');
  });
});

describe('behaviour streaks and weekly trends count the family\'s days (#688 comment 5922251129)', () => {
  const pos = (occurred_at: string) => ({ kind: 'positive', category: 'kindness', points: 1, occurred_at, member_id: 'm' }) as never;
  const weekly = (zone: string, at: string, now: string) =>
    trendByWeek([pos(at)], 2, new Date(now), zone).map((w) => `${w.weekStart}:${w.positive}`);

  it.each([
    ['Asia/Tokyo', ['2026-09-29T15:30:00Z', '2026-10-01T03:00:00Z'], '2026-10-01T04:00:00Z'], // 30 Sep and 1 Oct in Tokyo
    ['America/Los_Angeles', ['2026-09-29T15:00:00Z', '2026-10-01T01:00:00Z'], '2026-10-01T02:30:00Z'], // 29 and 30 Sep in LA
    ['UTC', ['2026-09-30T00:30:00Z', '2026-10-01T12:00:00Z'], '2026-10-01T13:00:00Z'], // control
  ])('a %s family\'s two consecutive days are a two-day streak', (zone, ats, now) => {
    for (const device of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      onDevice(device);
      expect(positiveStreakDays(ats.map(pos), new Date(now), zone)).toBe(2);
    }
  });

  it('a log on the family\'s Monday is in that Monday\'s week; one on its Sunday is in the week before', () => {
    for (const device of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      onDevice(device);
      expect(weekly('Asia/Tokyo', '2026-10-04T15:15:00Z', '2026-10-04T15:30:00Z')).toEqual(['2026-09-28:0', '2026-10-05:1']);
      expect(weekly('America/Los_Angeles', '2026-10-05T06:30:00Z', '2026-10-05T07:30:00Z')).toEqual(['2026-09-28:1', '2026-10-05:0']);
      expect(weekly('UTC', '2026-10-05T00:15:00Z', '2026-10-05T00:30:00Z')).toEqual(['2026-09-28:0', '2026-10-05:1']); // control
    }
  });

  it('without a zone the old UTC calendar is unchanged (the reviewer\'s "actual" values)', () => {
    expect(positiveStreakDays(['2026-09-29T15:30:00Z', '2026-10-01T03:00:00Z'].map(pos), new Date('2026-10-01T04:00:00Z'))).toBe(1);
    expect(trendByWeek([pos('2026-10-04T15:15:00Z')], 2, new Date('2026-10-04T15:30:00Z')).map((w) => `${w.weekStart}:${w.positive}`)).toEqual(['2026-09-21:0', '2026-09-28:1']);
  });

  it('the Behavior page passes the family\'s zone to both', () => {
    const src = readFileSync(join(__dirname, '..', 'components/modules/behavior-module.tsx'), 'utf8');
    expect(src).toContain('positiveStreakDays(mlogs, new Date(), clock.timeZone)');
    expect(src).toContain('trendByWeek(mlogs, 6, new Date(), clock.timeZone)');
  });
});

describe('a screen left open past the family\'s midnight moves to the new day (#688 comment 5922833445)', () => {
  it('the family\'s calendar day is derived from its day key alone, on every device', () => {
    for (const device of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'America/Santiago']) {
      onDevice(device);
      const d = calendarDayOfKey('2026-09-06'); // Santiago skips this midnight
      expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 9, 6]);
      const clock = clockFor('UTC');
      for (const at of ['2026-09-30T23:59:00Z', '2026-10-01T00:01:00Z']) {
        const now = new Date(at);
        expect(clock.calendarToday(now).getTime()).toBe(calendarDayOfKey(clock.todayKey(now)).getTime());
      }
    }
  });

  it('useFamilyCalendarToday recomputes when the family\'s day key changes, not only with the zone', () => {
    const src = readFileSync(join(__dirname, '..', 'components/i18n/use-format.ts'), 'utf8');
    const hook = bodyOf(src, 'export function useFamilyCalendarToday(): Date {', '\n}\n');
    expect(hook).toContain('const key = useFamilyClock().todayKey();');
    expect(hook).toContain('return useMemo(() => calendarDayOfKey(key), [key]);');
  });

  it('no client file memoizes calendarToday() on the clock object, which froze the date at mount', () => {
    const roots = ['components', 'app'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p); continue; }
        if (!/\.tsx?$/.test(name)) continue;
        // Code only: a comment may name the pattern it warns against.
        const code = readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
        if (/useMemo\(\s*\(\)\s*=>\s*\w+\.calendarToday\(\)/.test(code)) offenders.push(p);
      }
    };
    for (const r of roots) walk(join(__dirname, '..', r));
    expect(offenders).toEqual([]);
  });
});

describe('the date-only helpers step calendar days, not 24-hour blocks', () => {
  // They now receive the family's day at its (device-local) midnight, where a
  // 24-hour step lands on the wrong date across the phone's DST change.
  it('a week plan has seven dates across the phone\'s fall-back', () => {
    onDevice('America/Los_Angeles');
    const zones = Array.from({ length: 7 }, (_, i) => ({ id: `z${i}`, name: `Zone ${i}`, room: null, kind: 'surface' as const, clutter_score: 5, last_reset_at: null, is_active: true }));
    const plan = weeklyPlan(zones, [], [], new Date(2026, 9, 31), 1);
    expect(plan.map((p) => p.day)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
  });

  it('a streak counts back across the phone\'s spring-forward', () => {
    onDevice('America/Los_Angeles');
    const sessions = ['2026-03-07', '2026-03-08', '2026-03-09'].map((d) => ({ started_at: `${d}T18:00:00`, minutes: 10, items_removed: 1, member_id: null }));
    expect(sessionStreak(sessions, new Date(2026, 2, 9))).toBe(3);
  });

  it('the next review date is a calendar day on', () => {
    onDevice('America/Los_Angeles');
    expect(addPracticeDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addPracticeDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addPracticeDays('2026-03-08', 1)).toBe('2026-03-09');
  });
});
