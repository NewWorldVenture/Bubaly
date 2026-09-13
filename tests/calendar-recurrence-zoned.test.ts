import { describe, expect, it } from 'vitest';
import { expandEventsInZone, expandEvents, type RecurrableEvent } from '@/lib/calendar/recurrence';

// Recurrence expansion has to happen on somebody's wall clock. The first
// version used the RUNTIME's, via `setDate`/`setMonth` on a Date — correct in a
// browser, where runtime-local is the person looking at the screen, and wrong
// the moment a server asked the same question. Every test here runs in a UTC
// process, which is what a server is, and asks about a family who is not in UTC.

const NY = 'America/New_York';
// 2026: the clocks spring forward on 8 March and fall back on 1 November.
const local = (iso: string, zone = NY) => new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso));

const ev = (over: Partial<RecurrableEvent>): RecurrableEvent => ({
  id: 'e1', starts_at: '2026-10-14T22:00:00.000Z', ends_at: null,
  recurrence: 'weekly', recurrence_until: null, ...over,
});

describe('a weekly event stays at the time it was set, across a clock change', () => {
  it('keeps 6pm at 6pm through the autumn fall-back', () => {
    // 14 Oct 18:00 in New York is 22:00 UTC (EDT, UTC-4). Three weeks later New
    // York is on EST (UTC-5), so stepping by 21×24h — which is what the runtime
    // getters did on a server — lands on 17:00 and the family is told practice
    // is an hour earlier than it is.
    const out = expandEventsInZone(
      [ev({})], new Date('2026-11-04T00:00:00Z'), new Date('2026-11-06T00:00:00Z'), NY,
    );
    expect(out).toHaveLength(1);
    expect(local(out[0].starts_at)).toBe('04/11/2026, 18:00');
  });

  it('keeps 6pm at 6pm through the spring jump too', () => {
    const out = expandEventsInZone(
      // 18 Feb 18:00 EST = 23:00 UTC; 11 March is after the jump.
      [ev({ starts_at: '2026-02-18T23:00:00.000Z' })],
      new Date('2026-03-11T00:00:00Z'), new Date('2026-03-12T00:00:00Z'), NY,
    );
    expect(out).toHaveLength(1);
    expect(local(out[0].starts_at)).toBe('11/03/2026, 18:00');
  });

  it('does not let a late-night event slide into the day before', () => {
    // THE case that makes this more than cosmetic. A 00:30 Wednesday event,
    // stepped in UTC across the fall-back, reads 23:30 on TUESDAY — so a
    // "what's on Wednesday" query answers "nothing" and the event has simply
    // gone. 14 Oct 00:30 EDT is 04:30 UTC.
    const out = expandEventsInZone(
      [ev({ starts_at: '2026-10-14T04:30:00.000Z' })],
      new Date('2026-11-04T04:00:00Z'), new Date('2026-11-05T05:00:00Z'), NY,
    );
    expect(out).toHaveLength(1);
    expect(local(out[0].starts_at)).toBe('04/11/2026, 00:30');
    expect(local(out[0].starts_at)).not.toBe('03/11/2026, 23:30');
  });

  it('gives every zone its own 6pm', () => {
    for (const zone of ['UTC', NY, 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London']) {
      const seed = expandEventsInZone(
        [ev({ recurrence: 'none', starts_at: '2026-10-14T22:00:00.000Z' })],
        new Date('2026-10-14T00:00:00Z'), new Date('2026-10-15T00:00:00Z'), zone,
      );
      const at = local(seed[0].starts_at, zone).slice(-5);
      const later = expandEventsInZone(
        [ev({ starts_at: '2026-10-14T22:00:00.000Z' })],
        new Date('2026-12-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'), zone,
      );
      expect(later.length, `${zone} should still have occurrences in December`).toBeGreaterThan(0);
      for (const occurrence of later) expect(local(occurrence.starts_at, zone).slice(-5), zone).toBe(at);
    }
  });

  it('moves an occurrence forward when its local time does not exist that morning', () => {
    // 8 March 2026, New York: 02:00 becomes 03:00 and 02:30 never happens. The
    // occurrence must still occur — at the first minute that exists — rather
    // than being dropped for that week.
    const out = expandEventsInZone(
      [ev({ starts_at: '2026-03-01T07:30:00.000Z' })], // 1 March 02:30 EST
      new Date('2026-03-08T00:00:00Z'), new Date('2026-03-09T12:00:00Z'), NY,
    );
    expect(out).toHaveLength(1);
    expect(local(out[0].starts_at)).toBe('08/03/2026, 03:00');
  });
});

describe('a series that began long ago still reaches today', () => {
  it('finds a daily event started three years before the window', () => {
    // Counting occurrences from zero meant n had to pass 1,000 before the
    // window was reached — past the per-event cap — so the event vanished from
    // every distant view rather than being generated and filtered.
    const out = expandEventsInZone(
      [ev({ starts_at: '2023-01-05T13:00:00.000Z', recurrence: 'daily' })],
      new Date('2026-09-14T00:00:00Z'), new Date('2026-09-15T00:00:00Z'), NY,
    );
    expect(out).toHaveLength(1);
    // 13:00 UTC on 5 January is 08:00 in New York (EST), and 08:00 is what the
    // family set — so it is still 08:00 in September, when New York is on EDT
    // and 08:00 local is a different UTC instant.
    expect(local(out[0].starts_at)).toBe('14/09/2026, 08:00');
  });

  it('finds a weekly event started five years before the window', () => {
    const out = expandEventsInZone(
      [ev({ starts_at: '2021-09-15T13:00:00.000Z', recurrence: 'weekly' })],
      new Date('2026-09-16T00:00:00Z'), new Date('2026-09-17T00:00:00Z'), NY,
    );
    expect(out).toHaveLength(1);
  });

  it('still honours recurrence_until on an old series', () => {
    const out = expandEventsInZone(
      [ev({ starts_at: '2023-01-05T13:00:00.000Z', recurrence: 'daily', recurrence_until: '2024-01-01T00:00:00.000Z' })],
      new Date('2026-09-14T00:00:00Z'), new Date('2026-09-15T00:00:00Z'), NY,
    );
    expect(out).toHaveLength(0);
  });

  it('still skips the months that have no 31st', () => {
    const monthly = ev({ starts_at: '2024-01-31T17:00:00.000Z', recurrence: 'monthly' });
    const june = expandEventsInZone([monthly], new Date('2026-06-01T04:00:00Z'), new Date('2026-07-01T04:00:00Z'), NY);
    const july = expandEventsInZone([monthly], new Date('2026-07-01T04:00:00Z'), new Date('2026-08-01T04:00:00Z'), NY);
    expect(june).toHaveLength(0);
    expect(july).toHaveLength(1);
    expect(local(july[0].starts_at).startsWith('31/07/2026')).toBe(true);
  });

  it('skips 29 February in a common year rather than sliding to the 1st', () => {
    const out = expandEventsInZone(
      [ev({ starts_at: '2024-02-29T17:00:00.000Z', recurrence: 'yearly' })],
      new Date('2026-02-01T05:00:00Z'), new Date('2026-04-01T04:00:00Z'), NY,
    );
    expect(out).toHaveLength(0);
  });
});

describe('the zoneless entry point is the runtime zone, stated as such', () => {
  it('agrees with naming the runtime zone explicitly', () => {
    // The browser views call this one. Nothing about their behaviour changed:
    // in a browser runtime-local IS the viewer's zone, and in this UTC test
    // process it is UTC.
    const runtime = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const events = [ev({ starts_at: '2026-06-01T17:00:00.000Z' })];
    const start = new Date('2026-07-01T00:00:00Z');
    const end = new Date('2026-08-01T00:00:00Z');
    expect(expandEvents(events, start, end)).toEqual(expandEventsInZone(events, start, end, runtime));
  });
});
