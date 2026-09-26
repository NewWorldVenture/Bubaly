import { describe, it, expect, afterEach } from 'vitest';
import { nextBirthdayDate, daysUntil, upcomingBirthdayEvents, type BirthdayMember } from '@/lib/moments/birthdays';
import { imminentMomentNotices } from '@/lib/moments/notify';
import { localDayKeyOf } from '@/lib/time/local-day';

// A birthday has a month and a day and no instant. `lib/moments/birthdays.ts`
// built one from LOCAL parts and emitted `next.toISOString()`, which re-expresses
// local midnight at GREENWICH: midnight 5 July in Asia/Tokyo is 4 July 15:00Z, so
// `lib/moments/notify.ts`'s `starts_at.slice(0, 10)` dedup key named the 4th.
//
// Nothing below asserts a literal that is only true at one offset — that is the
// whole claim: the emitted day is the SAME string in every zone. Zones are named
// explicitly and set around each call, so these hold under both CI runs (TZ=UTC
// and TZ=America/Los_Angeles) and under any developer's machine.

const HOST_TZ = process.env.TZ;
afterEach(() => {
  if (HOST_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = HOST_TZ;
});

/** Named zones straddling Greenwich in both directions, plus the two CI runs. */
const ZONES = [
  'UTC',
  'America/Los_Angeles', // UTC-7/-8, and DST
  'Etc/GMT+12', //           UTC-12, the far west edge
  'Europe/Amsterdam', //     UTC+1/+2, and DST
  'Asia/Tokyo', //           UTC+9, no DST — where the old code lost the day
  'Pacific/Kiritimati', //   UTC+14, the far east edge
] as const;

/** Run `fn` with the process bound to `tz`, then put the host's zone back. */
function inZone<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

const MIA: BirthdayMember = { id: 'm1', display_name: 'Mia Smith', birthday: '2018-07-05' };
/** Zone-less, so `now` is 10:00 on 4 July in whichever zone is bound. */
const NOW_ISO = '2026-07-04T10:00:00';

describe('a birthday is a date, not an instant', () => {
  it('emits the same day — the birthday\'s own month/day — in every zone', () => {
    for (const tz of ZONES) {
      const startsAt = inZone(tz, () => {
        const [e] = upcomingBirthdayEvents([MIA], new Date(NOW_ISO), 30);
        return e.starts_at;
      });
      expect(startsAt, tz).toBe('2026-07-05T00:00:00');
    }
  });

  it('never stamps a Greenwich offset onto a date that has none', () => {
    for (const tz of ZONES) {
      const startsAt = inZone(tz, () => upcomingBirthdayEvents([MIA], new Date(NOW_ISO), 30)[0].starts_at);
      expect(startsAt.endsWith('Z'), tz).toBe(false);
    }
  });

  // Trap 1: a key is only right if PRODUCER and CONSUMER agree. The browser
  // surfaces (moments-view, home-moment-card, weather's `dayKey`) re-read this
  // value with the reader's own local parts, so that reading must land on the
  // same day the string advertises.
  it('the day a reader derives from the value is the day the value names', () => {
    for (const tz of ZONES) {
      const { sliced, readerKey } = inZone(tz, () => {
        const [e] = upcomingBirthdayEvents([MIA], new Date(NOW_ISO), 30);
        return { sliced: e.starts_at.slice(0, 10), readerKey: localDayKeyOf(e.starts_at) };
      });
      expect(readerKey, tz).toBe(sliced);
    }
  });

  // The regression the whole thing is for: tests/moments-notify.test.ts's
  // "merges an imminent birthday as a celebration moment" failed under Tokyo.
  it('the notification dedup key names the birthday in every zone', () => {
    for (const tz of ZONES) {
      const notice = inZone(tz, () => imminentMomentNotices([], [MIA], new Date(NOW_ISO))[0]);
      expect(notice?.relatedId, tz).toBe('moment:birthday:m1:2026-07-05');
      expect(notice?.title, tz).toContain('Mia turns 8');
    }
  });

  it('counts today as zero and tomorrow as one, wherever it runs', () => {
    for (const tz of ZONES) {
      const { today, tomorrow } = inZone(tz, () => {
        const now = new Date(NOW_ISO);
        return {
          today: daysUntil(nextBirthdayDate('2010-07-04', now)!, now),
          tomorrow: daysUntil(nextBirthdayDate('2010-07-05', now)!, now),
        };
      });
      expect(today, tz).toBe(0);
      expect(tomorrow, tz).toBe(1);
    }
  });

  // A day is 23 or 25 hours twice a year, so `daysUntil` counts CALENDAR days
  // (day index minus day index) rather than dividing a millisecond gap by
  // 86_400_000. A standing guard, not a mutation-killer: the arithmetic it
  // replaced was `Math.round(ms / 86_400_000)`, and a search over ten zones
  // (including Antarctica/Troll's two-hour shift, Australia/Lord_Howe's
  // half-hour one and America/Santiago, where local midnight does not exist on
  // the transition day) x 400 days x 4 hours-of-day x 5 spans found ZERO inputs
  // where the two disagree — one or two hours out of twenty-four always rounds
  // back. So this locks the behaviour in; it does not prove the rewrite changed
  // it. The four zone tests above are what fail when the fix is reverted.
  it('loses exactly one day per calendar day, across both DST transitions', () => {
    for (const tz of ['America/Los_Angeles', 'Europe/Amsterdam', 'Asia/Tokyo']) {
      inZone(tz, () => {
        const target = nextBirthdayDate('2015-12-25', new Date('2026-01-01T12:00:00'))!;
        let prev: number | null = null;
        for (let i = 0; i < 360; i++) {
          // Noon, so the instant exists even where local midnight does not.
          const d = daysUntil(target, new Date(2026, 0, 1 + i, 12));
          if (prev !== null) expect(d, `${tz} +${i}d`).toBe(prev - 1);
          prev = d;
        }
      });
    }
  });
});

