// "What if Emma joins travel soccer?" judges the first session's hour and
// weekday: a school-night evening squeezes homework, a 5-7pm session overlaps
// dinner. Both were read with getUTCHours()/getUTCDay(), and the projection was
// never told the family's zone, so a 6pm weekday practice in New York (22:00
// UTC) got neither caution, a 1pm session (17:00 UTC) was told it overlaps
// dinner, and a Sunday-evening session in Tokyo counted in the wrong week
// (LIBRARY-16120E6CFAB6).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectActivity, simulateDecision, type ActivityDecision, type SimContext } from '@/lib/twin/simulate';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';

function activity(startsAt: string): ActivityDecision {
  return { memberName: 'Emma', activityName: 'Travel Soccer', startsAt, durationMin: 90, sessionsPerWeek: 2, weeks: 10 };
}
const ctx = (timeZone?: string, o: Partial<SimContext> = {}): SimContext => ({ memberEvents: [], budgets: [], timeZone, ...o });
const keys = (startsAt: string, timeZone?: string) => projectActivity(activity(startsAt), ctx(timeZone)).dimensions.map((d) => d.key);

describe("an activity is projected on the family's clock, not Greenwich's", () => {
  it('a 6pm Wednesday practice in New York lands on a school night and over dinner', () => {
    // Wed 2026-07-08 18:00 EDT is 22:00Z.
    const dims = keys('2026-07-08T22:00:00.000Z', NY);
    expect(dims).toContain('homework');
    expect(dims).toContain('meals');
  });

  it('a 1pm Wednesday session in New York touches neither homework nor dinner', () => {
    // Wed 2026-07-08 13:00 EDT is 17:00Z, Greenwich's dinnertime.
    const dims = keys('2026-07-08T17:00:00.000Z', NY);
    expect(dims).not.toContain('homework');
    expect(dims).not.toContain('meals');
  });

  it("the weekday is the family's: Thursday 6pm in Los Angeles is Friday at Greenwich", () => {
    // Thu 2026-07-09 18:00 PDT is Fri 01:00Z. A school night, over dinner.
    const dims = keys('2026-07-10T01:00:00.000Z', LA);
    expect(dims).toContain('homework');
    expect(dims).toContain('meals');
    // Sun 2026-07-05 18:00 PDT is Mon 01:00Z: dinner, but not a school night.
    const sunday = keys('2026-07-06T01:00:00.000Z', LA);
    expect(sunday).toContain('meals');
    expect(sunday).not.toContain('homework');
  });

  it('a Monday 6pm practice in Tokyo is a school night though Greenwich reads 9am', () => {
    // Mon 2026-07-06 18:00 JST is 09:00Z.
    const dims = keys('2026-07-06T09:00:00.000Z', TOKYO);
    expect(dims).toContain('homework');
    expect(dims).toContain('meals');
  });

  it("counts the week's load in the family's week", () => {
    // Seven events on Mon 2026-07-06 morning, Tokyo time (Sun 5 July at Greenwich
    // for the early ones would be the week before).
    const memberEvents = Array.from({ length: 7 }, (_, i) => ({
      id: `e${i}`, title: `Class ${i}`, allDay: false,
      // Mon 2026-07-06 06:00..06:30 JST = Sun 2026-07-05 21:00Z onward, 5 minutes apart, 4 minutes long.
      startsAt: new Date(Date.parse('2026-07-05T21:00:00.000Z') + i * 5 * 60_000).toISOString(),
      endsAt: new Date(Date.parse('2026-07-05T21:04:00.000Z') + i * 5 * 60_000).toISOString(),
    }));
    // The new session: Wed 2026-07-08 10:00 JST, the same family week.
    const r = projectActivity({ ...activity('2026-07-08T01:00:00.000Z'), sessionsPerWeek: 1 }, ctx(TOKYO, { memberEvents }));
    expect(r.dimensions.find((d) => d.key === 'schedule')).toMatchObject({ severity: 'caution', headline: "Emma's week would hit 8 commitments" });
    const one = simulateDecision(
      { kind: 'commitment', memberName: 'Emma', title: 'Travel Soccer', startsAt: '2026-07-08T01:00:00.000Z', durationMin: 90 },
      ctx(TOKYO, { memberEvents }),
    );
    expect(one.impacts.map((i) => i.title)).toContain("Emma's week would hit 8 commitments");
  });

  it('with no zone the reading stays Greenwich (a caller with no family)', () => {
    const dims = keys('2026-07-08T17:30:00.000Z');
    expect(dims).toContain('homework');
    expect(dims).toContain('meals');
  });

  it("the projection action hands the simulation the family's zone", () => {
    const src = readFileSync('app/(app)/dashboard/family-digital-twin/actions.ts', 'utf8');
    const call = /projectActivity\(decision, \{([^}]*)\}\)/.exec(src)?.[1] ?? '';
    expect(call, 'runActivityProjection passes the family zone to projectActivity').toContain('timeZone: tz');
  });
});
