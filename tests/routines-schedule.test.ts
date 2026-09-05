// "Every Sunday at 5pm" → a cron a worker can fire, and "two days before every
// trip" → an anchor that MOVES when the trip moves (§19, §58).
//
// The parser's most important behaviour is what it refuses. A schedule the
// family did not mean fires at 3am or every day instead of every Sunday, and
// then they stop trusting routines altogether — so `null` (ask them) has to be
// the answer for anything unclear, and there is a test for that.
import { describe, expect, it } from 'vitest';
import { ROUTINE_ANCHORS, anchorByKey } from '@/lib/services/routines/anchors';
import { nextCronRun, nextRelativeRun, parseClockTime, parseSchedule, type RelativeSchedule } from '@/lib/services/routines/schedule';

const TZ = 'America/New_York';
const NOW = new Date('2026-09-05T15:00:00Z'); // Saturday 11:00 in New York

const cron = (text: string) => {
  const s = parseSchedule(text, ROUTINE_ANCHORS);
  return s?.kind === 'cron' ? s.expr : null;
};

describe('parseClockTime', () => {
  it('reads the ways a person writes a time', () => {
    expect(parseClockTime('at 5pm')).toEqual({ hour: 17, minute: 0 });
    expect(parseClockTime('5:30pm')).toEqual({ hour: 17, minute: 30 });
    expect(parseClockTime('at 7:15am')).toEqual({ hour: 7, minute: 15 });
    expect(parseClockTime('17:00')).toEqual({ hour: 17, minute: 0 });
    expect(parseClockTime('at 12am')).toEqual({ hour: 0, minute: 0 });
    expect(parseClockTime('at 12pm')).toEqual({ hour: 12, minute: 0 });
  });

  it('reads the parts of a day a family names instead of a clock', () => {
    expect(parseClockTime('every morning')).toEqual({ hour: 8, minute: 0 });
    expect(parseClockTime('in the evening')).toEqual({ hour: 18, minute: 0 });
    expect(parseClockTime('at bedtime')).toEqual({ hour: 20, minute: 0 });
  });

  it('reads a bare hour the way a family means it', () => {
    // "at 6" is the evening; "at 18" is unambiguous.
    expect(parseClockTime('at 6')).toEqual({ hour: 18, minute: 0 });
    expect(parseClockTime('at 10')).toEqual({ hour: 10, minute: 0 });
    expect(parseClockTime('two days before')).toBeNull();
  });
});

describe('parseSchedule — the wall-clock repeats', () => {
  it('turns a named day into a weekly cron', () => {
    expect(cron('every Sunday at 5pm')).toBe('0 17 * * 0');
    expect(cron('on Mondays at 7:30am')).toBe('30 7 * * 1');
    expect(cron('every Tuesday and Thursday at 4pm')).toBe('0 16 * * 2,4');
  });

  it('understands weekdays, weekends and every day', () => {
    expect(cron('every weekday morning')).toBe('0 8 * * 1-5');
    expect(cron('every weekend at 10am')).toBe('0 10 * * 0,6');
    expect(cron('every day at 6pm')).toBe('0 18 * * *');
    expect(cron('daily')).toBe('0 9 * * *');
  });

  it('understands monthly, with and without a day', () => {
    expect(cron('every month on the 15th at 9am')).toBe('0 9 15 * *');
    expect(cron('monthly at 8am')).toBe('0 8 1 * *');
  });

  it('defaults the hour only when the family gave none', () => {
    expect(cron('every Sunday')).toBe('0 9 * * 0');
    expect(cron('every Sunday at 5pm')).toBe('0 17 * * 0');
  });

  it('asks rather than guesses when it cannot tell', () => {
    for (const unclear of ['sometimes', 'when the kids are at school', 'often', 'before things get busy', '']) {
      expect(parseSchedule(unclear, ROUTINE_ANCHORS), unclear).toBeNull();
    }
  });
});

describe('parseSchedule — anchored to things that move', () => {
  it('reads "two days before every trip" as an anchor, not a date', () => {
    const s = parseSchedule('two days before every trip, make sure we are ready', ROUTINE_ANCHORS);
    expect(s?.kind).toBe('relative');
    if (s?.kind !== 'relative') return;
    expect(s.anchor.table).toBe('vacations');
    expect(s.anchor.dateField).toBe('start_date');
    expect(s.offsetDays).toBe(-2);
  });

  it('handles weeks, "after", and the night before', () => {
    const week = parseSchedule('a week before every trip', ROUTINE_ANCHORS);
    expect(week?.kind === 'relative' && week.offsetDays).toBe(-7);

    const after = parseSchedule('three days after each trip', ROUTINE_ANCHORS);
    expect(after?.kind === 'relative' && after.offsetDays).toBe(3);

    const night = parseSchedule('the night before every game', ROUTINE_ANCHORS);
    expect(night?.kind === 'relative' && night.anchor.table).toBe('sports_events');
    // "the night before" carries its own hour: 8pm, not the default morning.
    expect(night?.kind === 'relative' && night.atHour).toBe(20);
  });

  it('refuses an anchor that is not on the allow-list', () => {
    // The anchor names a table; letting a sentence choose one would point a
    // query builder at the whole database.
    expect(parseSchedule('two days before every audit_log', ROUTINE_ANCHORS)).toBeNull();
    expect(parseSchedule('two days before every trip', [])).toBeNull();
  });

  it('keeps what the family said, so the UI can show it back', () => {
    const s = parseSchedule('Every Sunday at 5pm', ROUTINE_ANCHORS);
    expect(s?.said).toBe('Every Sunday at 5pm');
  });
});

describe('nextCronRun', () => {
  it('finds the next Sunday 5pm in the family’s zone, not the server’s', () => {
    const next = nextCronRun('0 17 * * 0', NOW, TZ);
    expect(next).toBeTruthy();
    if (!next) return;
    // Sunday 2026-09-06 at 17:00 New York = 21:00 UTC.
    expect(next.toISOString()).toBe('2026-09-06T21:00:00.000Z');
  });

  it('never fires twice in the same minute it was asked from', () => {
    const at5pm = new Date('2026-09-06T21:00:00.000Z');
    const next = nextCronRun('0 17 * * 0', at5pm, TZ);
    expect(next?.toISOString()).toBe('2026-09-13T21:00:00.000Z');
  });

  it('respects the zone: the same expression differs by household', () => {
    const ny = nextCronRun('0 17 * * 0', NOW, 'America/New_York');
    const london = nextCronRun('0 17 * * 0', NOW, 'Europe/London');
    expect(ny?.toISOString()).not.toBe(london?.toISOString());
  });

  it('answers null for an expression that can never match, instead of hanging', () => {
    expect(nextCronRun('0 17 30 2 *', NOW, TZ)).toBeNull();
    expect(nextCronRun('bad expr', NOW, TZ)).toBeNull();
  });
});

describe('nextRelativeRun', () => {
  const schedule: RelativeSchedule = {
    kind: 'relative', anchor: anchorByKey('trip')!, offsetDays: -2, atHour: 9, said: 'two days before every trip',
  };

  it('fires two days before the trip, at the local hour', () => {
    const fires = nextRelativeRun(schedule, '2026-10-24', NOW, TZ);
    // 2026-10-22 at 09:00 New York = 13:00 UTC (EDT).
    expect(fires?.toISOString()).toBe('2026-10-22T13:00:00.000Z');
  });

  it('moves when the trip moves — the whole point of an anchor', () => {
    const before = nextRelativeRun(schedule, '2026-10-24', NOW, TZ);
    const after = nextRelativeRun(schedule, '2026-10-31', NOW, TZ);
    expect(after!.getTime() - before!.getTime()).toBe(7 * 86_400_000);
  });

  it('says null rather than firing about something already too close', () => {
    // A trip the day after tomorrow cannot have a "two days before" moment left.
    expect(nextRelativeRun(schedule, '2026-09-06', NOW, TZ)).toBeNull();
    expect(nextRelativeRun(schedule, 'not-a-date', NOW, TZ)).toBeNull();
  });
});

describe('the anchor allow-list', () => {
  it('names only tables with the date column it measures from', () => {
    for (const anchor of ROUTINE_ANCHORS) {
      expect(anchor.matches.length).toBeGreaterThan(0);
      expect(anchor.dateField).toMatch(/^(start_date|starts_at|due_date)$/);
      expect(anchor.label).toBeTruthy();
    }
    expect(new Set(ROUTINE_ANCHORS.map((a) => a.key)).size).toBe(ROUTINE_ANCHORS.length);
    expect(anchorByKey('nope')).toBeNull();
  });
});
