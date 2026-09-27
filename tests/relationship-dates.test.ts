import { describe, it, expect } from 'vitest';
import {
  nextOccurrence, daysUntil, ordinal, formatCountdown, upcomingDates, isReminderDue, milestoneLabel,
  upcomingRelationship, type RelDate,
} from '@/lib/relationship/dates';
import { dayKeyIn } from '@/lib/time/zoned';

// Reference "today": Friday 2026-06-26. A day KEY — the old fixture built it
// with `new Date(2026, 5, 26, 9, 0, 0)`, a LOCAL instant, so what every
// assertion below meant depended on the TZ the suite ran under.
const TODAY = '2026-06-26';

describe('nextOccurrence', () => {
  it('rolls a recurring date forward when this year has passed', () => {
    expect(nextOccurrence('2010-03-14', true, TODAY)).toBe('2027-03-14');
  });
  it('keeps a recurring date later this year', () => {
    expect(nextOccurrence('2010-12-25', true, TODAY)).toBe('2026-12-25');
  });
  it('returns today when the recurring date is today', () => {
    expect(nextOccurrence('2000-06-26', true, TODAY)).toBe('2026-06-26');
  });
  it('returns the literal date for one-offs', () => {
    expect(nextOccurrence('2026-07-04', false, TODAY)).toBe('2026-07-04');
  });
  it('returns null for bad input', () => {
    expect(nextOccurrence('not-a-date', true, TODAY)).toBeNull();
  });
});

describe('daysUntil', () => {
  it('counts whole days', () => {
    expect(daysUntil('2026-06-29', TODAY)).toBe(3);
    expect(daysUntil('2026-06-26', TODAY)).toBe(0);
    expect(daysUntil('2026-06-24', TODAY)).toBe(-2);
  });
});

describe('ordinal', () => {
  it('handles common and teen cases', () => {
    expect(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '23rd'])
      .toEqual([1, 2, 3, 4, 11, 12, 13, 21, 23].map(ordinal));
  });
});

describe('formatCountdown', () => {
  it('labels near-term and longer ranges', () => {
    expect(formatCountdown(0)).toBe('Today');
    expect(formatCountdown(1)).toBe('Tomorrow');
    expect(formatCountdown(3)).toBe('in 3 days');
    expect(formatCountdown(10)).toBe('in 1 week');
    expect(formatCountdown(21)).toBe('in 3 weeks');
    expect(formatCountdown(45)).toBe('in 1 month');
    expect(formatCountdown(-2)).toBe('Passed');
  });
});

const D = (over: Partial<RelDate>): RelDate => ({
  id: 'x', kind: 'custom', title: 't', eventDate: '2026-07-01', recursAnnually: true, reminderDaysBefore: 14, ...over,
});

describe('upcomingDates', () => {
  it('sorts soonest-first, drops past one-offs, computes years', () => {
    const list = upcomingDates([
      D({ id: 'anniv', kind: 'anniversary', eventDate: '2018-07-01' }),
      D({ id: 'past', kind: 'date_night', eventDate: '2026-06-01', recursAnnually: false }),
      D({ id: 'bday', kind: 'birthday', eventDate: '1990-06-29' }),
    ], TODAY);
    expect(list.map((d) => d.id)).toEqual(['bday', 'anniv']); // past one-off dropped
    expect(list[0].days).toBe(3);
    expect(list.find((d) => d.id === 'anniv')!.years).toBe(8);
    expect(list.find((d) => d.id === 'bday')!.years).toBe(36);
  });
  it('respects the withinDays window', () => {
    const list = upcomingDates([
      D({ id: 'soon', eventDate: '2026-06-30' }),
      D({ id: 'far', eventDate: '2026-12-30' }),
    ], TODAY, { withinDays: 30 });
    expect(list.map((d) => d.id)).toEqual(['soon']);
  });
});

describe('isReminderDue', () => {
  it('is true inside the reminder window only', () => {
    expect(isReminderDue(D({ eventDate: '2026-06-29', reminderDaysBefore: 14 }), TODAY)).toBe(true);
    expect(isReminderDue(D({ eventDate: '2026-12-30', reminderDaysBefore: 14 }), TODAY)).toBe(false);
  });
});

describe('upcomingRelationship', () => {
  it('returns only dates inside their reminder window, soonest first', () => {
    const list = upcomingRelationship([
      D({ id: 'soon', eventDate: '2026-07-02', reminderDaysBefore: 14 }),   // 6 days out → in window
      D({ id: 'far', eventDate: '2026-07-20', reminderDaysBefore: 7 }),     // 24 days out → not yet
      D({ id: 'today', eventDate: '2026-06-26', reminderDaysBefore: 3 }),   // today → in window
    ], TODAY);
    expect(list.map((d) => d.id)).toEqual(['today', 'soon']);
  });
});

describe('milestoneLabel', () => {
  it('labels anniversaries and birthdays', () => {
    const [anniv] = upcomingDates([D({ kind: 'anniversary', eventDate: '2018-06-29' })], TODAY);
    const [bday] = upcomingDates([D({ kind: 'birthday', eventDate: '1990-06-29' })], TODAY);
    expect(milestoneLabel(anniv)).toBe('8th anniversary');
    expect(milestoneLabel(bday)).toBe('turns 36');
  });
});

/**
 * The defect this module was changed for, stated where it can fail.
 *
 * Every assertion above passes just as happily against the old
 * `setHours(0, 0, 0, 0)` implementation, because none of them names an instant
 * where the host's day and the family's day disagree. These do — and the
 * failure is worse than a wrong label, which the mutation is what established.
 * I expected "dropped from the list" (`upcomingDates` filters `days < 0`); what
 * the revert actually prints is `expected 364 to be +0`. For a RECURRING date
 * the host having already rolled over means this year's occurrence reads as
 * passed, so `nextOccurrence` rolls it forward A FULL YEAR: on the morning of
 * their anniversary the family is told it is in 12 months. Dropping is what
 * happens to a one-off.
 */
describe('an anniversary tomorrow is not "Today", and today’s is not "Passed"', () => {
  // 2026-06-25T20:00 in Los Angeles === 2026-06-26T03:00Z.
  const EVENING_IN_LA = new Date('2026-06-26T03:00:00Z');
  const laToday = dayKeyIn(EVENING_IN_LA, 'America/Los_Angeles');
  const D = (over: Partial<RelDate>): RelDate => ({
    id: 'x', kind: 'anniversary', title: 't', eventDate: '2018-06-26',
    recursAnnually: true, reminderDaysBefore: 14, ...over,
  });

  it('the family is still on the 25th while the host has rolled to the 26th', () => {
    expect(laToday).toBe('2026-06-25');
    expect(EVENING_IN_LA.toISOString().slice(0, 10)).toBe('2026-06-26');
  });

  it('counts tomorrow as tomorrow', () => {
    expect(daysUntil('2026-06-26', laToday)).toBe(1);
    expect(formatCountdown(daysUntil('2026-06-26', laToday))).toBe('Tomorrow');
  });

  it('an anniversary falling today reads Today, not a year out', () => {
    const list = upcomingDates([D({ id: 'anniv', eventDate: '2018-06-25' })], laToday);
    expect(list.map((d) => d.id)).toEqual(['anniv']);
    expect(list[0].days).toBe(0);
    expect(formatCountdown(list[0].days)).toBe('Today');
    expect(milestoneLabel(list[0])).toBe('8th anniversary');
  });

  it('rolls a recurring date forward on the family’s day, not the host’s', () => {
    // The 25th has NOT passed for this family, so this year's is still ahead.
    expect(nextOccurrence('2018-06-25', true, laToday)).toBe('2026-06-25');
  });

  /**
   * The notification dedup is keyed by occurrence YEAR and is permanent, so a
   * reminder sent against the wrong day is the only one that will ever be sent
   * for that occurrence — the real day arrives with nothing. `nextKey` is the
   * string the key is built from, which is why it is a key and not a `Date`:
   * `new Date(Date.UTC(2027, 0, 1)).getFullYear()` is 2026 in California.
   */
  it('keys the occurrence by the year the family is actually in', () => {
    const newYearEve = dayKeyIn(new Date('2027-01-01T03:00:00Z'), 'America/Los_Angeles');
    expect(newYearEve).toBe('2026-12-31');
    const [d] = upcomingDates([D({ id: 'ny', eventDate: '2020-01-01' })], newYearEve);
    expect(d.nextKey).toBe('2027-01-01');
    expect(d.nextKey.slice(0, 4)).toBe('2027');
    expect(d.days).toBe(1);
  });
});
