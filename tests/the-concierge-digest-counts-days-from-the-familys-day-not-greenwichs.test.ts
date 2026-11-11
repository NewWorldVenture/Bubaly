// The concierge digest labels a bill, a pantry item, a warranty, a trip and a
// maintenance task "today / tomorrow / overdue". Those are DATE columns (and
// one timestamp), and "today" is the family's day. The digest took the UTC
// calendar day of the real instant instead, so from 5pm in Los Angeles (UTC
// already tomorrow) a bill due today read "yesterday / overdue" and one due
// tomorrow read "today" — beside a brief whose every other line used the
// family's day (LIBRARY-51AAEED4F287).
import { describe, expect, it } from 'vitest';
import { buildConciergeDigest, dayOffset } from '@/lib/concierge/digest';
import { buildBrief } from '@/lib/briefing/build';

// 2026-06-23 18:30 in Los Angeles (PDT, UTC-7) is 2026-06-24 01:30 UTC.
const LA_EVENING = new Date('2026-06-24T01:30:00.000Z');
// 2026-06-24 08:00 in Tokyo (UTC+9) is 2026-06-23 23:00 UTC.
const TOKYO_MORNING = new Date('2026-06-23T23:00:00.000Z');

describe("the concierge digest counts days from the family's day, not Greenwich's", () => {
  it('reads a DATE column against the family-local date of now', () => {
    expect(dayOffset('2026-06-23', LA_EVENING, 'America/Los_Angeles')).toBe(0);
    expect(dayOffset('2026-06-24', LA_EVENING, 'America/Los_Angeles')).toBe(1);
    expect(dayOffset('2026-06-24', TOKYO_MORNING, 'Asia/Tokyo')).toBe(0);
    expect(dayOffset('2026-06-23', TOKYO_MORNING, 'Asia/Tokyo')).toBe(-1);
  });

  it("reads a timestamp on the family's wall, not Greenwich's", () => {
    // A maintenance task due 9pm on the 23rd in Los Angeles is 04:00Z on the 24th.
    expect(dayOffset('2026-06-24T04:00:00.000Z', LA_EVENING, 'America/Los_Angeles')).toBe(0);
    // ...and one due 7am on the 24th in Tokyo is 22:00Z on the 23rd.
    expect(dayOffset('2026-06-23T22:00:00.000Z', TOKYO_MORNING, 'Asia/Tokyo')).toBe(0);
  });

  it('labels a Los Angeles evening the way the family reads the calendar', () => {
    const digest = buildConciergeDigest({
      now: LA_EVENING,
      timezone: 'America/Los_Angeles',
      bills: [
        { name: 'Water', amount: 40, dueDate: '2026-06-23' },
        { name: 'Internet', amount: 70, dueDate: '2026-06-24' },
      ],
      pantry: [{ name: 'Milk', expiresAt: '2026-06-23' }],
      warranties: [{ name: 'Dishwasher', expiresOn: '2026-06-23' }],
      trips: [{ title: 'Lake', startDate: '2026-06-24', endDate: '2026-06-26' }],
    });
    const by = (title: string) => digest.items.find(i => i.title === title);
    expect(by('Water')).toMatchObject({ urgency: 'today', detail: '$40.00 due today' });
    expect(by('Internet')).toMatchObject({ urgency: 'soon', detail: '$70.00 due tomorrow' });
    expect(by('Milk')).toMatchObject({ urgency: 'today', detail: 'Expires today' });
    // A warranty on its last day is still surfaced; read at Greenwich it had "run out".
    expect(by('Dishwasher warranty')).toMatchObject({ urgency: 'today', detail: 'Expires today' });
    expect(by('Lake')).toMatchObject({ urgency: 'soon', detail: 'Departs tomorrow' });
    expect(digest.counts.overdue).toBe(0);
  });

  it('labels a Tokyo morning the way the family reads the calendar', () => {
    const digest = buildConciergeDigest({
      now: TOKYO_MORNING,
      timezone: 'Asia/Tokyo',
      bills: [
        { name: 'Water', amount: 40, dueDate: '2026-06-23' },
        { name: 'Internet', amount: 70, dueDate: '2026-06-24' },
      ],
    });
    const by = (title: string) => digest.items.find(i => i.title === title);
    expect(by('Water')).toMatchObject({ urgency: 'overdue', detail: '$40.00 due yesterday' });
    expect(by('Internet')).toMatchObject({ urgency: 'today', detail: '$70.00 due today' });
  });

  it("the composed brief hands the digest the family's zone", () => {
    const brief = buildBrief({
      kind: 'daily',
      now: LA_EVENING,
      events: [],
      snapshot: { bills: [{ name: 'Water', amount: 40, dueDate: '2026-06-23' }] },
      completedRuns: [],
      activity: [],
    }, 'America/Los_Angeles');
    expect(brief.asOfDate).toBe('2026-06-23');
    expect(brief.digest.counts).toMatchObject({ overdue: 0, today: 1 });
    expect(brief.digest.items[0]).toMatchObject({ title: 'Water', urgency: 'today' });
  });

  it('keeps Greenwich as the day when no zone is given', () => {
    expect(dayOffset('2026-06-24', LA_EVENING)).toBe(0);
    expect(dayOffset('2026-06-23T23:00:00.000Z', '2026-06-23T12:00:00.000Z')).toBe(0);
  });
});
