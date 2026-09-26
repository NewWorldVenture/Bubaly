import { describe, it, expect } from 'vitest';
import {
  nextRunAt, decideRun, variantForOccurrence, describeSchedule,
  windowClosed, withinWindow, stoppingCondition, nextRunAfterClaim,
  zonedLocalToInstant, localPartsAt, daysInMonth, isValidTimezone,
  DEFAULT_SCHEDULE, CADENCES,
  type RecurringAdSchedule,
} from '@/lib/marketing/recurring-ads';

const NY = 'America/New_York';

function schedule(over: Partial<RecurringAdSchedule> = {}): RecurringAdSchedule {
  return { ...DEFAULT_SCHEDULE, ...over };
}

/** What an observer in `tz` sees, so assertions read as wall time. */
function localOf(instant: Date | null, tz: string): string {
  if (!instant) return 'never';
  const p = localPartsAt(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} `
    + `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

describe('local wall time survives a DST change', () => {
  // The whole reason occurrences are computed from the local CALENDAR and then
  // converted, rather than by adding 24h to an instant. "Every day at 09:00"
  // must stay 09:00 to the audience in March and in November alike.
  const daily9 = schedule({ cadence: 'daily', timesOfDay: [9 * 60], timezone: NY });

  it('keeps 09:00 local across spring forward', () => {
    // US DST 2026 begins at 02:00 on Sunday 8 March — so 09:00 ON the 8th is
    // already EDT. The pair that actually straddles the change is the 6th
    // (EST) and the 10th (EDT); picking the 8th as the "before" side would
    // have compared two post-change days and proved nothing.
    const before = nextRunAt(daily9, new Date('2026-03-05T18:00:00Z'));
    const after = nextRunAt(daily9, new Date('2026-03-09T18:00:00Z'));
    expect(localOf(before, NY)).toBe('2026-03-06 09:00');
    expect(localOf(after, NY)).toBe('2026-03-10 09:00');
    // Same wall time, DIFFERENT UTC instants — 14:00Z becomes 13:00Z.
    expect(before!.toISOString()).toBe('2026-03-06T14:00:00.000Z');
    expect(after!.toISOString()).toBe('2026-03-10T13:00:00.000Z');
  });

  it('lands on the switch day itself at the right instant', () => {
    // 09:00 on 8 March is post-switch: EDT, 13:00Z. Asserted separately so the
    // boundary day is covered rather than assumed by the pair above.
    const onTheDay = nextRunAt(daily9, new Date('2026-03-08T06:00:00Z'));
    expect(localOf(onTheDay, NY)).toBe('2026-03-08 09:00');
    expect(onTheDay!.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('keeps 09:00 local across fall back', () => {
    // US DST 2026 ends Sunday 1 November.
    const before = nextRunAt(daily9, new Date('2026-10-30T18:00:00Z'));
    const after = nextRunAt(daily9, new Date('2026-11-02T18:00:00Z'));
    expect(localOf(before, NY)).toBe('2026-10-31 09:00');
    expect(localOf(after, NY)).toBe('2026-11-03 09:00');
    expect(before!.toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(after!.toISOString()).toBe('2026-11-03T14:00:00.000Z');
  });

  it('posts at the first real moment when the chosen time does not exist', () => {
    // 02:30 never happens on 8 March 2026 in New York: 02:00 jumps to 03:00.
    // The ad must still go out that morning rather than skipping the day.
    const half2 = schedule({ cadence: 'daily', timesOfDay: [2 * 60 + 30], timezone: NY });
    const run = nextRunAt(half2, new Date('2026-03-08T04:00:00Z')); // 23:00 local on the 7th
    expect(localOf(run, NY)).toBe('2026-03-08 03:00');
    expect(zonedLocalToInstant(2026, 3, 8, 2 * 60 + 30, NY)).toBeNull();
  });

  it('posts once on the day an hour happens twice', () => {
    // 01:30 local occurs at 05:30Z (EDT) and again at 06:30Z (EST) on 1 Nov.
    const half1 = schedule({ cadence: 'daily', timesOfDay: [90], timezone: NY });
    const first = nextRunAt(half1, new Date('2026-11-01T04:00:00Z'));
    expect(first!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    // The following run is the NEXT DAY, not the repeat of the same wall time.
    const second = nextRunAt(half1, first!);
    expect(localOf(second, NY)).toBe('2026-11-02 01:30');
  });

  it('treats a zone without DST the same way', () => {
    const kolkata = schedule({ cadence: 'daily', timesOfDay: [9 * 60], timezone: 'Asia/Kolkata' });
    const run = nextRunAt(kolkata, new Date('2026-06-01T00:00:00Z'));
    expect(run!.toISOString()).toBe('2026-06-01T03:30:00.000Z'); // UTC+05:30
  });
});

describe('cadences', () => {
  it('daily fires every day', () => {
    const s = schedule({ cadence: 'daily', timesOfDay: [600], timezone: 'UTC' });
    let cursor = new Date('2026-01-01T00:00:00Z');
    const days: string[] = [];
    for (let i = 0; i < 3; i += 1) { cursor = nextRunAt(s, cursor)!; days.push(cursor.toISOString()); }
    expect(days).toEqual([
      '2026-01-01T10:00:00.000Z', '2026-01-02T10:00:00.000Z', '2026-01-03T10:00:00.000Z',
    ]);
  });

  it('weekdays skips the weekend', () => {
    const s = schedule({ cadence: 'weekdays', timesOfDay: [600], timezone: 'UTC' });
    // 2026-01-02 is a Friday.
    const friday = nextRunAt(s, new Date('2026-01-02T00:00:00Z'))!;
    expect(friday.toISOString()).toBe('2026-01-02T10:00:00.000Z');
    expect(nextRunAt(s, friday)!.toISOString()).toBe('2026-01-05T10:00:00.000Z'); // Monday
  });

  it('weekly fires on each chosen day', () => {
    const s = schedule({ cadence: 'weekly', daysOfWeek: [1, 4], timesOfDay: [600], timezone: 'UTC' });
    const mon = nextRunAt(s, new Date('2026-01-04T00:00:00Z'))!; // Sunday
    expect(mon.toISOString()).toBe('2026-01-05T10:00:00.000Z');
    expect(nextRunAt(s, mon)!.toISOString()).toBe('2026-01-08T10:00:00.000Z'); // Thursday
  });

  it('biweekly skips the alternate week', () => {
    const anchor = new Date('2026-01-05T10:00:00Z'); // Monday
    const s = schedule({ cadence: 'biweekly', daysOfWeek: [1], timesOfDay: [600], timezone: 'UTC' });
    const first = nextRunAt(s, new Date('2026-01-04T00:00:00Z'), anchor)!;
    expect(first.toISOString()).toBe('2026-01-05T10:00:00.000Z');
    expect(nextRunAt(s, first, anchor)!.toISOString()).toBe('2026-01-19T10:00:00.000Z');
  });

  it('keeps the biweekly rhythm when the campaign is paused and resumed', () => {
    // Phased off the anchor, not off the last run: a pause must not re-phase a
    // campaign onto the wrong week when it comes back.
    const anchor = new Date('2026-01-05T10:00:00Z');
    const s = schedule({ cadence: 'biweekly', daysOfWeek: [1], timesOfDay: [600], timezone: 'UTC' });
    const afterLongPause = nextRunAt(s, new Date('2026-02-10T00:00:00Z'), anchor)!;
    expect(afterLongPause.toISOString()).toBe('2026-02-16T10:00:00.000Z');
    expect(Math.round((afterLongPause.getTime() - anchor.getTime()) / 86_400_000) % 14).toBe(0);
  });

  it('monthly clamps a day the month does not have', () => {
    const s = schedule({ cadence: 'monthly', dayOfMonth: 31, timesOfDay: [600], timezone: 'UTC' });
    const jan = nextRunAt(s, new Date('2026-01-01T00:00:00Z'))!;
    expect(jan.toISOString()).toBe('2026-01-31T10:00:00.000Z');
    expect(nextRunAt(s, jan)!.toISOString()).toBe('2026-02-28T10:00:00.000Z'); // not a 31 February
    expect(daysInMonth(2028, 2)).toBe(29); // and a leap year is 29, not 28
    const leap = nextRunAt(s, new Date('2028-02-01T00:00:00Z'))!;
    expect(leap.toISOString()).toBe('2028-02-29T10:00:00.000Z');
  });

  it('fires several times a day when several times are set', () => {
    const s = schedule({ cadence: 'daily', timesOfDay: [9 * 60, 17 * 60], timezone: 'UTC' });
    const morning = nextRunAt(s, new Date('2026-01-01T00:00:00Z'))!;
    const evening = nextRunAt(s, morning)!;
    expect([morning.toISOString(), evening.toISOString()])
      .toEqual(['2026-01-01T09:00:00.000Z', '2026-01-01T17:00:00.000Z']);
    expect(nextRunAt(s, evening)!.toISOString()).toBe('2026-01-02T09:00:00.000Z');
  });
});

describe('a schedule can never look backwards', () => {
  // The property that makes "set once" safe to leave running. If this breaks,
  // an outage becomes a burst of posts at real followers.
  it('always returns an instant strictly after the one asked about', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    for (const cadence of CADENCES) {
      const s = schedule({ cadence, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], dayOfMonth: 1, timesOfDay: [600], timezone: NY });
      const run = nextRunAt(s, now);
      expect(run, cadence).not.toBeNull();
      expect(run!.getTime(), cadence).toBeGreaterThan(now.getTime());
    }
  });

  it('does not replay a week of missed posts after an outage', () => {
    const s = schedule({ cadence: 'daily', timesOfDay: [600], timezone: 'UTC' });
    const missedSince = new Date('2026-01-01T10:00:00Z');
    const now = new Date('2026-01-08T11:00:00Z'); // a week later, seven slots missed
    const decision = decideRun(
      s, { startsAt: missedSince, occurrences: 3 }, missedSince, now, true,
    );
    expect(decision.run).toBe(true);
    // Exactly one post now, and the NEXT one is tomorrow — not the six others.
    if (decision.run) expect(decision.nextAfter?.toISOString()).toBe('2026-01-09T10:00:00.000Z');
  });
});

describe('why an ad is not posting is an answer, not silence', () => {
  const s = schedule({ cadence: 'daily', timesOfDay: [600], timezone: 'UTC' });
  const startsAt = new Date('2026-01-01T00:00:00Z');
  const due = new Date('2026-01-02T10:00:00Z');
  const now = new Date('2026-01-02T10:05:00Z');

  it('runs when due', () => {
    expect(decideRun(s, { startsAt, occurrences: 0 }, due, now, true)).toMatchObject({ run: true });
  });

  it('names a pause', () => {
    expect(decideRun(s, { startsAt, occurrences: 0 }, due, now, false))
      .toEqual({ run: false, reason: 'paused' });
  });

  it('names a finished campaign rather than looking idle', () => {
    expect(decideRun(s, { startsAt, occurrences: 12, maxOccurrences: 12 }, due, now, true))
      .toEqual({ run: false, reason: 'occurrence_cap' });
  });

  it('names an expired window', () => {
    expect(decideRun(s, { startsAt, occurrences: 1, endsAt: new Date('2026-01-02T00:00:00Z') }, due, now, true))
      .toEqual({ run: false, reason: 'window_closed' });
  });

  it('names a schedule that can never fire', () => {
    const impossible = schedule({ cadence: 'weekly', daysOfWeek: [], timesOfDay: [600] });
    expect(nextRunAt(impossible, now)).toBeNull();
    expect(decideRun(impossible, { startsAt, occurrences: 0 }, null, now, true))
      .toEqual({ run: false, reason: 'no_schedule' });
  });

  it('is simply not due yet when it is early', () => {
    expect(decideRun(s, { startsAt, occurrences: 0 }, due, new Date('2026-01-02T09:00:00Z'), true))
      .toEqual({ run: false, reason: 'not_due' });
  });

  it('checks the cap before the clock, so a finished campaign never posts again', () => {
    const longAgo = new Date('2020-01-01T00:00:00Z');
    expect(decideRun(s, { startsAt, occurrences: 5, maxOccurrences: 5 }, longAgo, now, true))
      .toEqual({ run: false, reason: 'occurrence_cap' });
  });
});

describe('the stopping rule is stated once, and every caller gets the same answer', () => {
  // decideRun (the cron), the admin "Post now" and "Resume" actions and the
  // admin list's "Finished" badge all ask these. Four hand-copied versions of
  // the window check is how "Post now" came to honour the cap and not the end
  // date, so the rule is pinned here, at its one definition.
  const s = schedule({ cadence: 'daily', timesOfDay: [600], timezone: 'UTC' });
  const startsAt = new Date('2026-01-01T00:00:00Z');
  const endsAt = new Date('2026-01-05T12:00:00Z');

  it('counts the end instant itself as inside the window', () => {
    expect(windowClosed(endsAt, new Date(endsAt.getTime()))).toBe(false);
    expect(windowClosed(endsAt, new Date(endsAt.getTime() + 1))).toBe(true);
    expect(windowClosed(null, new Date('2099-01-01T00:00:00Z'))).toBe(false);
    expect(withinWindow(endsAt, endsAt)).toBe(endsAt);
    expect(withinWindow(new Date(endsAt.getTime() + 1), endsAt)).toBeNull();
    expect(withinWindow(null, endsAt)).toBeNull();
  });

  it('treats an end date that will not parse as closed, not as absent', () => {
    // `now > NaN` is false: the obvious comparison waves it through.
    const unreadable = new Date('not-a-date');
    expect(windowClosed(unreadable, startsAt)).toBe(true);
    expect(stoppingCondition({ endsAt: unreadable, occurrences: 0 }, startsAt)).toBe('window_closed');
  });

  it('names both halves, the cap first', () => {
    const now = new Date('2026-01-06T00:00:00Z');
    expect(stoppingCondition({ endsAt, maxOccurrences: 3, occurrences: 3 }, now)).toBe('occurrence_cap');
    expect(stoppingCondition({ endsAt, maxOccurrences: 9, occurrences: 3 }, now)).toBe('window_closed');
    expect(stoppingCondition({ endsAt, maxOccurrences: 9, occurrences: 3 }, startsAt)).toBeNull();
  });

  it('refuses an unreadable end date on the cron path too, as Post now does', () => {
    // The two halves used to disagree here: the action failed closed and
    // decideRun waved the row through to publish.
    const due = new Date('2026-01-02T10:00:00Z');
    const now = new Date('2026-01-02T10:05:00Z');
    expect(decideRun(s, { startsAt, occurrences: 1, endsAt: new Date('garbage') }, due, now, true))
      .toEqual({ run: false, reason: 'window_closed' });
  });

  it('re-arms the next slot while it is still inside the window', () => {
    const now = new Date('2026-01-03T10:05:00Z');
    expect(nextRunAfterClaim(s, { startsAt, endsAt, occurrences: 1 }, now)?.toISOString())
      .toBe('2026-01-04T10:00:00.000Z');
  });

  it('arms nothing after the last slot inside the window', () => {
    // The next daily slot is 6 Jan 10:00; the window shut at 5 Jan 12:00. The
    // raw slot is what the admin list used to show as a "Next post".
    const now = new Date('2026-01-05T10:05:00Z');
    expect(nextRunAfterClaim(s, { startsAt, endsAt, occurrences: 4 }, now)).toBeNull();
    const decision = decideRun(s, { startsAt, endsAt, occurrences: 4 }, new Date('2026-01-05T10:00:00Z'), now, true);
    expect(decision).toMatchObject({ run: true, nextAfter: null });
  });

  it('arms nothing after the claim that uses the last occurrence the cap allows', () => {
    const now = new Date('2026-01-03T10:05:00Z');
    expect(nextRunAfterClaim(s, { startsAt, maxOccurrences: 3, occurrences: 2 }, now)).toBeNull();
    expect(nextRunAfterClaim(s, { startsAt, maxOccurrences: 3, occurrences: 1 }, now)?.toISOString())
      .toBe('2026-01-04T10:00:00.000Z');
  });
});

describe('message rotation', () => {
  it('cycles the pool so a follower does not see one sentence forever', () => {
    const pool = ['A', 'B', 'C'];
    expect([0, 1, 2, 3, 4].map((n) => variantForOccurrence(pool, n))).toEqual(['A', 'B', 'C', 'A', 'B']);
  });

  it('is deterministic, so re-running an occurrence reproduces its text', () => {
    expect(variantForOccurrence(['A', 'B'], 7)).toBe(variantForOccurrence(['A', 'B'], 7));
  });

  it('ignores blank entries rather than posting an empty ad', () => {
    expect(variantForOccurrence(['  ', 'Real', ''], 0)).toBe('Real');
    expect(variantForOccurrence(['  ', ''], 0)).toBeNull();
    expect(variantForOccurrence([], 3)).toBeNull();
  });
});

describe('input the admin form can actually produce', () => {
  it('rejects an unknown timezone instead of silently drifting', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
  });

  it('falls back to UTC rather than throwing on a bad stored zone', () => {
    const s = schedule({ cadence: 'daily', timesOfDay: [600], timezone: 'Nope/Nowhere' });
    expect(nextRunAt(s, new Date('2026-01-01T00:00:00Z'))!.toISOString()).toBe('2026-01-01T10:00:00.000Z');
  });

  it('drops out-of-range and duplicate times', () => {
    const s = schedule({ cadence: 'daily', timesOfDay: [600, 600, -5, 1440, 99999], timezone: 'UTC' });
    const first = nextRunAt(s, new Date('2026-01-01T00:00:00Z'))!;
    expect(first.toISOString()).toBe('2026-01-01T10:00:00.000Z');
    expect(nextRunAt(s, first)!.toISOString()).toBe('2026-01-02T10:00:00.000Z');
  });

  it('returns null when no time of day survives validation', () => {
    expect(nextRunAt(schedule({ timesOfDay: [-1, 1440] }), new Date())).toBeNull();
  });

  it('describes each cadence in one readable line', () => {
    expect(describeSchedule(schedule({ cadence: 'weekly', daysOfWeek: [2], timesOfDay: [540], timezone: NY })))
      .toBe('Weekly on Tue at 09:00 (America/New_York)');
    expect(describeSchedule(schedule({ cadence: 'weekdays', timesOfDay: [540, 1020], timezone: 'UTC' })))
      .toBe('Weekdays at 09:00, 17:00 (UTC)');
    expect(describeSchedule(schedule({ cadence: 'monthly', dayOfMonth: 15, timesOfDay: [0], timezone: 'UTC' })))
      .toBe('Monthly on day 15 at 00:00 (UTC)');
  });
});
