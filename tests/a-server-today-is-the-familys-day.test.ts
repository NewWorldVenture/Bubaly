// A server-side "today" is the family's day, not the host's.
//
// Four helpers answered "how far is this date from today?" by reading `now`'s
// LOCAL calendar parts — `getFullYear()/getMonth()/getDate()` — which is the
// reader's own day in a browser and GREENWICH's day on the UTC host that
// renders a server page or runs a cron. From 5pm in California, Greenwich is
// already on tomorrow. So:
//
//   - the home, agents, moments and outcomes pages counted a child's birthday
//     TODAY as "in 364 days" (`nextBirthdayDate` + `daysUntil`), and the 14-day
//     "birthdays soon" count missed the one that mattered;
//   - the Moments notifier's "get ready" birthday ping (via
//     `upcomingBirthdayEvents` in lib/moments/notify.ts) was a day early;
//   - the grandparent portal's countdowns (`daysUntilNext`) did the same;
//   - the memories page and the notification engine's "On this day" ping
//     (`pickOnThisDay` / `onThisDayNotice`) resurfaced TOMORROW's photos
//     tonight and today's never, and keyed the dedup to the wrong day.
//
// The fix is the one lib/planning/prep-server.ts already used for its own
// birthdays (`nextBirthdayDayKey`): day keys in, day keys out, no instant
// anywhere, with `dayKeyInTz(now, family.timezone)` supplied by the caller.
// `birthdayCountdown`, `daysUntilNextOn`, and a `timeZone` on
// `upcomingBirthdayEvents`, `pickOnThisDay` and `onThisDayNotice`. The
// browser-side callers keep the local-parts path: there the reader's day IS
// the right one.
//
// The instant below is the whole story: 2026-10-04T00:30Z is Saturday 3 October,
// 5:30pm in Los Angeles, and Sunday 4 October in Greenwich.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dayKeyIn } from '@/lib/time/zoned';
import { birthdayCountdown, daysBetweenDayKeys, daysUntil, nextBirthdayDate, upcomingBirthdayEvents } from '@/lib/moments/birthdays';
import { daysUntilNext, daysUntilNextOn } from '@/lib/celebrations/dates';
import { onThisDayNotice, pickOnThisDay } from '@/lib/memories/on-this-day';
import { imminentMomentNotices } from '@/lib/moments/notify';

const ROOT = join(__dirname, '..');
const NOW = new Date('2026-10-04T00:30:00.000Z');
const LA = 'America/Los_Angeles';
const LA_TODAY = '2026-10-03';
const UTC_TODAY = '2026-10-04';
// The RUNTIME's own day at that instant. Vitest pins TZ to UTC unless the
// environment says otherwise, and CI reruns the suite under
// TZ=America/Los_Angeles; the "host read" controls below are therefore stated
// against the runtime's day rather than pinned to Greenwich's. Under UTC they
// show the unzoned path answering a day late (364, tomorrow's photo); under
// Los Angeles they show it agreeing with the family — the same statement
// either way: no zone means the RUNTIME's day, which is only right when the
// runtime is the reader.
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HOST_TODAY = dayKeyIn(NOW, HOST_ZONE);
const hostOnGreenwichDay = HOST_TODAY === UTC_TODAY;

describe('the instant under test', () => {
  it('is 3 October in Los Angeles and 4 October in Greenwich', () => {
    expect(dayKeyIn(NOW, LA)).toBe(LA_TODAY);
    expect(dayKeyIn(NOW, 'UTC')).toBe(UTC_TODAY);
  });

  it('the runtime is on one of those two days, so every control below is decided', () => {
    expect([LA_TODAY, UTC_TODAY]).toContain(HOST_TODAY);
  });
});

describe('birthday countdowns are counted from the family\'s day', () => {
  it('a child whose birthday is today, in Los Angeles, is 0 days away — the old host read said 364', () => {
    const mia = birthdayCountdown('2018-10-03', dayKeyIn(NOW, LA));
    expect(mia).toEqual({ dayKey: '2026-10-03', days: 0, turning: 8 });
    // The local-parts path answers for the runtime's zone: on the UTC host
    // that renders the pages that is Greenwich's answer — tomorrow's today, and
    // the birthday a year away.
    const hostNext = nextBirthdayDate('2018-10-03', NOW)!;
    expect(daysUntil(hostNext, NOW)).toBe(hostOnGreenwichDay ? 364 : 0);
  });

  it('counts whole days between day keys with no zone anywhere, and rolls to next year', () => {
    expect(daysBetweenDayKeys('2026-10-03', '2026-10-17')).toBe(14);
    expect(daysBetweenDayKeys('2026-10-03', '2026-10-03')).toBe(0);
    expect(daysBetweenDayKeys('2026-10-03', 'junk')).toBeNull();
    expect(birthdayCountdown('2018-10-02', LA_TODAY)).toMatchObject({ dayKey: '2027-10-02', days: 364, turning: 9 });
    expect(birthdayCountdown('10-02', LA_TODAY)).toBeNull(); // the stored format is YYYY-MM-DD
    expect(birthdayCountdown('2018-10-03', 'not a day')).toBeNull();
  });

  it('a birthday without a known year has no turning age', () => {
    expect(birthdayCountdown('0000-10-05', LA_TODAY)).toEqual({ dayKey: '2026-10-05', days: 2, turning: null });
  });

  it('upcomingBirthdayEvents, given the family zone, emits today\'s birthday on the family\'s day', () => {
    const members = [{ id: 'm1', display_name: 'Mia Hughen', birthday: '2018-10-03', is_active: true }];
    const inLa = upcomingBirthdayEvents(members, NOW, 1, LA);
    expect(inLa).toHaveLength(1);
    expect(inLa[0]).toMatchObject({ id: 'birthday:m1', title: 'Mia turns 8', starts_at: '2026-10-03T00:00:00', all_day: true });
    // Without a zone the local-parts path stands — the browser callers' day.
    // On a UTC runtime that is Greenwich's 4 October, and 3 October has passed.
    expect(upcomingBirthdayEvents(members, NOW, 1)).toEqual(hostOnGreenwichDay ? [] : inLa);
  });

  it('the Moments notifier hands its zone to the birthdays, so the "get ready" ping is on the family\'s day', () => {
    const notices = imminentMomentNotices([], [{ id: 'm1', display_name: 'Mia Hughen', birthday: '2018-10-03', is_active: true }], NOW, 36, LA);
    expect(notices.map((n) => n.relatedId)).toContain('moment:birthday:m1:2026-10-03');
    const src = readFileSync(join(ROOT, 'lib/moments/notify.ts'), 'utf8');
    expect(src).toContain('upcomingBirthdayEvents(members ?? [], now, 1, timeZone)');
  });
});

describe('celebration countdowns on the grandparent portal', () => {
  it('today\'s birthday is 0 days away on the family\'s day; the host read said 364', () => {
    expect(daysUntilNextOn('2018-10-03', LA_TODAY)).toBe(0);
    expect(daysUntilNextOn('10-03', LA_TODAY)).toBe(0);
    expect(daysUntilNextOn('2018-10-03', UTC_TODAY)).toBe(364);
    expect(daysUntilNext('2018-10-03', NOW), 'the local-parts path answers for the runtime').toBe(hostOnGreenwichDay ? 364 : 0);
  });

  it('normalises an impossible date forward the way the Date constructor always has, and rejects junk', () => {
    // 29 Feb 2027 does not exist: counted as 1 Mar 2027.
    expect(daysUntilNextOn('02-29', '2027-02-27')).toBe(2);
    expect(daysUntilNextOn('junk', LA_TODAY)).toBeNull();
    expect(daysUntilNextOn('10-03', '2026/10/03')).toBeNull();
  });
});

describe('"On this day" is the family\'s day', () => {
  // 3 October 2024, 7pm in Los Angeles: a photo from the family's day, two
  // years ago — which Greenwich files under 4 October.
  const twoYearsAgoToday = { id: 'p1', taken_at: '2024-10-04T02:00:00.000Z', url: 'u1' };
  // 4 October 2024, 1pm in Los Angeles: tomorrow's memory, for this family.
  const tomorrowsMemory = { id: 'p2', taken_at: '2024-10-04T20:00:00.000Z', url: 'u2' };
  // 3 October 2025, 10am in Los Angeles: last year's, same day.
  const lastYear = { id: 'p3', taken_at: '2025-10-03T17:00:00.000Z', url: 'u3' };

  it('surfaces the photos taken on the family\'s 3 October, newest year first, and not tomorrow\'s', () => {
    const picked = pickOnThisDay([twoYearsAgoToday, tomorrowsMemory, lastYear], NOW, 8, LA);
    expect(picked.map((p) => [p.id, p.yearsAgo, p.label])).toEqual([['p3', 1, '1 year ago'], ['p1', 2, '2 years ago']]);
  });

  it('the host\'s read surfaced tomorrow\'s photo tonight, filed this evening\'s under tomorrow, and missed last year\'s', () => {
    // No zone: the runtime's own calendar, UTC on the host. Greenwich is on
    // 4 October, so p2 (4 Oct) matches, p1 (3 Oct 7pm in Los Angeles, which is
    // 4 Oct 02:00Z) matches as a 4 October photo, and p3 (3 Oct, 10am) does
    // not — the family's own day is the one that goes missing.
    const all = [twoYearsAgoToday, tomorrowsMemory, lastYear];
    const hostRead = pickOnThisDay(all, NOW, 8).map((p) => p.id);
    // No zone means the runtime's zone — in every zone, not just the two the
    // suite runs under. A photo's day depends on the zone's OFFSET, not only on
    // which day the runtime is on (east of +04:00 the 20:00Z photo is already
    // the 5th), so the concrete lists are pinned for the two zones CI runs and
    // the equivalence carries the rest.
    expect(hostRead).toEqual(pickOnThisDay(all, NOW, 8, HOST_ZONE).map((p) => p.id));
    const concretely: Record<string, string[]> = { UTC: ['p2', 'p1'], [LA]: ['p3', 'p1'] };
    expect(hostRead).toEqual(concretely[HOST_ZONE] ?? hostRead);
  });

  it('the notice is keyed to the family\'s day, so the once-a-day dedup fires on that day', () => {
    const notice = onThisDayNotice([twoYearsAgoToday, lastYear], NOW, LA);
    expect(notice).toMatchObject({ relatedId: 'onthisday:2026-10-03', title: '📸 On this day 1 year ago' });
    expect(onThisDayNotice([tomorrowsMemory], NOW, LA), 'tomorrow\'s photo is not today\'s memory').toBeNull();
    // With all three photos one of them is on the runtime's own day in every
    // zone, so the key the unzoned read picks is that day's.
    expect(onThisDayNotice([twoYearsAgoToday, tomorrowsMemory, lastYear], NOW)?.relatedId, 'the host read keys it to the runtime\'s day').toBe(`onthisday:${HOST_TODAY}`);
  });
});

describe('every server caller hands in the family\'s day', () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

  it('the four pages count birthdays with birthdayCountdown on their family day key, and none reads the host\'s', () => {
    for (const [rel, key] of [
      ['app/(app)/home/page.tsx', 'todayKey'],
      ['app/(app)/dashboard/agents/page.tsx', 'todayKey'],
      ['app/(app)/dashboard/outcomes/page.tsx', 'todayKey'],
      ['app/(app)/dashboard/moments/page.tsx', 'todayIso'],
    ] as const) {
      const src = read(rel);
      expect(src, rel).toContain(`birthdayCountdown(m${rel.includes('home') ? 'ember' : ''}.birthday, ${key})`);
      expect(src, `${rel} still reads the host's day`).not.toMatch(/nextBirthdayDate\(|daysUntil\(/);
      expect(src, `${rel} derives ${key} from the family zone`).toMatch(new RegExp(`const ${key} = dayKeyInTz\\(now, tz\\)`));
    }
  });

  it('the grandparent portal counts from the family day key', () => {
    const src = read('app/(app)/dashboard/grandparent-portal/page.tsx');
    expect(src).toContain("daysUntilNextOn(m.birthday as string, todayKey)");
    expect(src).toContain('daysUntilNextOn(d.event_date, todayKey)');
    expect(src).not.toMatch(/daysUntilNext\(/);
    expect(src).toMatch(/const todayKey = dayKeyInTz\(/);
  });

  it('the memories page and the notification engine pass the family zone to "On this day"', () => {
    expect(read('app/(app)/dashboard/memories/page.tsx')).toContain("pickOnThisDay(photos.filter((p) => p.url), now, 6, ctx.active.family.timezone || 'UTC')");
    expect(read('lib/server/notifications.ts')).toContain('onThisDayNotice(datedPhotos ?? [], now, tz)');
  });
});
