import { describe, expect, it } from 'vitest';
import { extractActions, extractDates, triagePaperwork } from '@/lib/paperwork/triage';

// LIBRARY-EEF2EDD5B054. extractDates took any day 1..31 for any month, so
// "Sept 31", "4/31" or a fraction like "2/30" became the day key '2026-09-31',
// '2026-04-31' or '2027-02-30'. The earliest date is the item's due_on, a
// Postgres date column, which refuses a day that does not exist: the capture
// failed as "unavailable", and failed the same way on every retry.

const TODAY = '2026-03-01';

/** A day key names a real day when the calendar gives the same key back. */
const isRealDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
};

describe('paperwork never gets a due date the calendar does not have', () => {
  it.each([
    ['Picture day is Sept 31'],
    ['Forms due September 31st, 2026'],
    ['Return by 4/31'],
    ['Return by 6/31/26'],
    ['Use 2/30 of a cup of flour'],
    ['Due Feb 30'],
    ['Due February 29, 2027'],
    ['Due 2/29/2027'],
    ['Due Nov 31, 2026'],
  ])('%s names no day', (text) => {
    expect(extractDates(text, TODAY)).toEqual([]);
  });

  it('February 29 with no year is no day when the year it would land in is not a leap year', () => {
    // Read on 2026-03-01 a bare "2/29" lands in 2026 or 2027, and neither has one.
    expect(extractDates('Leap day party on 2/29', TODAY)).toEqual([]);
    expect(extractDates('Leap day party on Feb 29', TODAY)).toEqual([]);
    // Read in January 2026 it would be this year, which has none either.
    expect(extractDates('Leap day party on Feb 29', '2026-01-10')).toEqual([]);
  });

  it('February 29 is kept in a leap year, stated or inferred', () => {
    expect(extractDates('Due Feb 29, 2028', TODAY)).toEqual(['2028-02-29']);
    expect(extractDates('Due 2/29/28', TODAY)).toEqual(['2028-02-29']);
    // Read on 2027-06-01, a bare Feb 29 rolls to 2028, a leap year.
    expect(extractDates('Due Feb 29', '2027-06-01')).toEqual(['2028-02-29']);
    expect(extractDates('Due 2/29', '2027-06-01')).toEqual(['2028-02-29']);
  });

  it('the last real day of each month is still read', () => {
    expect(extractDates('Sept 30, Apr 30, June 30, Nov 30, Feb 28 and 12/31', TODAY)).toEqual([
      '2026-04-30', '2026-06-30', '2026-09-30', '2026-11-30', '2026-12-31', '2027-02-28',
    ]);
  });

  it('an impossible day beside a real one leaves the real one as the due date', () => {
    const text = 'Please sign and return the permission slip. Picture day is Sept 31; forms are due October 13.';
    expect(extractDates(text, TODAY)).toEqual(['2026-10-13']);
    expect(extractActions(text, TODAY).map((a) => a.due_on)).toEqual(['2026-10-13']);
    expect(triagePaperwork(text, TODAY).due_on).toBe('2026-10-13');
  });

  it('paperwork whose only date is impossible has no due date, rather than one the database refuses', () => {
    const triaged = triagePaperwork('Please sign and return this permission slip by Sept 31.', TODAY);
    expect(triaged.due_on).toBeNull();
    expect(triaged.actions.every((a) => a.due_on === null)).toBe(true);
  });

  it('every date read from a page of awkward text is a real day', () => {
    const text = [
      'Jan 31, Feb 31, Mar 31, Apr 31, May 31, Jun 31, Jul 31, Aug 31, Sep 31, Oct 31, Nov 31, Dec 31',
      '1/31 2/31 3/31 4/31 5/31 6/31 7/31 8/31 9/31 10/31 11/31 12/31 2/29 2/30',
    ].join('\n');
    const dates = extractDates(text, TODAY);
    expect(dates.filter((d) => !isRealDay(d))).toEqual([]);
    // The seven 31-day months, once each; the two spellings agree.
    expect(dates).toEqual(['2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31', '2026-10-31', '2026-12-31', '2027-01-31']);
  });
});
