import { describe, it, expect } from 'vitest';
import { imminentMomentNotices } from '@/lib/moments/notify';
import type { MomentEvent } from '@/lib/moments/prep';

const now = new Date('2026-07-04T10:00:00');

function ev(over: Partial<MomentEvent>): MomentEvent {
  return {
    id: 'e1', title: 'Soccer game', category: null, location: 'City Field',
    starts_at: '2026-07-04T15:00:00', all_day: false, description: null,
    ...over,
  };
}

describe('imminentMomentNotices', () => {
  it('notices a classified moment inside the horizon with leave-by + top steps', () => {
    const [n] = imminentMomentNotices([ev({})], [], now);
    expect(n.relatedId).toBe('moment:e1:2026-07-04');
    expect(n.title).toContain('Get ready: Soccer game');
    expect(n.body).toMatch(/^Leave by /);
    expect(n.body).toContain(' — ');
  });

  it('skips general events (plain calendar notifications already cover them)', () => {
    expect(imminentMomentNotices([ev({ title: 'Sync up', location: null })], [], now)).toEqual([]);
  });

  it('skips moments beyond the horizon and already-started timed moments', () => {
    expect(imminentMomentNotices([ev({ starts_at: '2026-07-07T15:00:00' })], [], now)).toEqual([]);
    expect(imminentMomentNotices([ev({ starts_at: '2026-07-04T09:00:00' })], [], now)).toEqual([]);
  });

  it('keeps an all-day moment live through its day', () => {
    const [n] = imminentMomentNotices([ev({ title: 'Beach picnic', starts_at: '2026-07-04T00:00:00', all_day: true })], [], now);
    expect(n).toBeTruthy();
    expect(n.title).toContain('Beach picnic');
  });

  it('merges an imminent birthday as a celebration moment', () => {
    const [n] = imminentMomentNotices([], [{ id: 'm1', display_name: 'Mia Smith', birthday: '2018-07-05' }], now);
    expect(n.relatedId).toMatch(/^moment:birthday:m1:2026-07-05$/);
    expect(n.title).toContain('Mia turns 8');
  });

  it('sorts soonest first and caps at 6', () => {
    const events = Array.from({ length: 8 }, (_, i) =>
      ev({ id: `e${i}`, starts_at: `2026-07-04T${String(22 - i).padStart(2, '0')}:00:00` }));
    const notices = imminentMomentNotices(events, [], now);
    expect(notices).toHaveLength(6);
    expect(notices[0].relatedId).toBe('moment:e7:2026-07-04');
  });

  it('dedup key embeds the calendar date so a future occurrence pings again', () => {
    const [a] = imminentMomentNotices([ev({ starts_at: '2026-07-04T15:00:00' })], [], now);
    const [b] = imminentMomentNotices([ev({ starts_at: '2026-07-05T15:00:00' })], [], now);
    expect(a.relatedId).not.toBe(b.relatedId);
  });
});

// The push notification goes out in the FAMILY's zone, not the server's.
//
// `lib/server/notifications.ts` resolves `const tz = familyRow?.timezone || 'UTC'`
// at its line 77 and spends it on `dayKeyInTz` and `zonedDayBoundsMs` — and then
// called `imminentMomentNotices` without it. The same shape as
// `app/(app)/home/page.tsx`, which picked the right events and printed the wrong
// clocks; this was the third place it turned up, and the only one that reaches a
// phone, where a wrong time cannot be re-rendered by reloading.
//
// Three things in the label are zone-sensitive and all three are asserted below:
// the clock, the Today/Tomorrow decision, and the weekday name.
describe('a "get ready" push is in the family’s zone', () => {
  const LA = 'America/Los_Angeles';
  // 18:30 Sunday 20 September in Los Angeles is already 01:30 Monday at Greenwich.
  const now = new Date('2026-09-21T01:30:00Z');
  // The game is 09:00 on MONDAY, their time.
  const game = {
    id: 'e1', title: 'Soccer', category: null as null, location: 'Field 3',
    starts_at: '2026-09-21T16:00:00Z', all_day: false,
  };

  const titleOf = (tz?: string) =>
    imminentMomentNotices([game], [], now, 36, tz).map((n) => n.title).join(' | ');

  it('says Tomorrow, with the family’s clock on it', () => {
    const title = titleOf(LA);
    expect(title).toContain('Tomorrow');
    expect(title).toContain('9:00 AM');
  });

  // The counterexample, kept as an assertion rather than a comment: this is what
  // the cron actually sent. The suite pins TZ=UTC, so an unzoned call renders
  // Greenwich — "Today" for a game the family has tomorrow morning, at a clock
  // seven hours out.
  it('and unzoned it said Today at 4:00 PM, which is what shipped', () => {
    const title = titleOf(undefined);
    expect(title).toContain('Today');
    expect(title).toContain('4:00 PM');
    expect(title).not.toBe(titleOf(LA));
  });

  it('puts the leave-by time on the family’s clock too', () => {
    // Any notice carrying a leave-by must carry it in `tz`; asserting the two
    // renderings differ is what proves the parameter reached `fmtClock`, which
    // is a SECOND local fmtClock, distinct from the one in prep.ts.
    const zoned = imminentMomentNotices([game], [], now, 36, LA);
    const plain = imminentMomentNotices([game], [], now, 36);
    expect(zoned).toHaveLength(plain.length);
    expect(zoned.length, 'no notice was produced, so nothing above was asserted').toBeGreaterThan(0);
    const withLeave = zoned.filter((n) => n.body.startsWith('Leave by'));
    for (const [i, n] of withLeave.entries()) {
      expect(n.body, `leave-by ${i} is identical in both zones`).not.toBe(
        plain.filter((p) => p.body.startsWith('Leave by'))[i]?.body,
      );
    }
  });

  // The whole notification agrees with itself.
  //
  // This is the assertion the first version of the fix did NOT have, and it is
  // why it is here. The headline "Leave by" was zoned and the prep STEP beside it
  // was not, so a real notice read:
  //
  //   "Leave by 8:25 AM — Leave by 3:25 PM · Check the forecast · Pack kit…"
  //
  // One instant, rendered twice, seven hours apart, in one push. The earlier
  // cases all passed over it, because each compared a zoned rendering against an
  // unzoned one and both halves DID differ from their unzoned twins.
  it('never states the same leave-by twice in two zones', () => {
    const notices = imminentMomentNotices([game], [], now, 36, LA);
    expect(notices.length, 'no notice was produced, so this asserts nothing').toBeGreaterThan(0);
    for (const n of notices) {
      const clocks = new Set([...`${n.title} ${n.body}`.matchAll(/Leave by (\d{1,2}:\d{2}\s?[AP]M)/g)].map((m) => m[1]));
      expect(clocks.size, `one notice names ${clocks.size} different leave-by times: ${[...clocks].join(', ')}`)
        .toBeLessThanOrEqual(1);
    }
  });

  // A weekday label further out takes the zone as well — the third of the three
  // zone-sensitive pieces, and the one a Today/Tomorrow test cannot reach.
  it('names the weekday in the family’s zone when the day is further out', () => {
    // 21:00 Tuesday in Los Angeles is 04:00 WEDNESDAY at Greenwich.
    const far = { ...game, starts_at: '2026-09-23T04:00:00Z' };
    const longHorizon = 24 * 7;
    expect(imminentMomentNotices([far], [], now, longHorizon, LA).map((n) => n.title).join(' '))
      .toMatch(/Tue/);
    expect(imminentMomentNotices([far], [], now, longHorizon).map((n) => n.title).join(' '))
      .toMatch(/Wed/);
  });
});
