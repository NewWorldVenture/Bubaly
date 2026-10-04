// A SERVER-SIDE AGE, "DAYS AGO" AND "WHICH YEAR" READ THE FAMILY'S DAY.
//
// Three more server surfaces asked "what day is it?" with `now`'s LOCAL
// calendar parts, which on the UTC host that renders a page or answers a
// service call is Greenwich's day — tomorrow's, from 5pm in California:
//
//   - a member's age (`ageOn(birthday, new Date())` in the family service and
//     under the home page's avatars): a child whose birthday is today turned a
//     year older at Greenwich's midnight, seven hours before her own;
//   - the memories timeline's "Today" / "Yesterday" / "Last Thursday"
//     (`calendarDaysAgo` on local midnights, and the weekday rendered with no
//     zone): this evening's album was "Yesterday" and last Wednesday's party
//     was "Last Thursday";
//   - the playbook's traditions: the YEAR an event fell in (`getFullYear()` on
//     the host — a New Year's Eve party at 9pm in California counted for next
//     year) and the SEASON of a trip (`new Date('YYYY-MM-DD').getMonth()`,
//     which west of Greenwich is the month before on every 1st);
//   - the home page's "this month" transactions read from `isoDate(monthStart)`,
//     the family's midnight re-read on the host's calendar — the last day of the
//     previous month east of Greenwich.
//
// Same fix as tests/a-server-today-is-the-familys-day.test.ts: day keys in,
// numbers out. `ageOnDay(birthday, todayKey)` beside the browser-side `ageOn`;
// `relativeDay` / `buildTimeline` take the zone and count day keys in it; the
// playbook reads the year off `dayKeyInTz` and the month off the date's own
// digits; the home page reads `${todayKey.slice(0, 7)}-01`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dayKeyIn } from '@/lib/time/zoned';
import { ageOn, ageOnDay } from '@/lib/members/age';
import { ageFromBirthday, memberTagline } from '@/lib/home/home-data';
import { buildTimeline, relativeDay } from '@/lib/memories/memories';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^[^\S\n]*\/\/.*$/gm, '')
  .replace(/(?<=[ \t])\/\/[^\n]*/g, '');
const LA = 'America/Los_Angeles';
// Saturday 3 October, 5:30pm in Los Angeles; Sunday 4 October in Greenwich.
const NOW = new Date('2026-10-04T00:30:00.000Z');
// The runtime's own day at that instant (vitest pins UTC; CI reruns under
// TZ=America/Los_Angeles), for the local-parts controls.
const HOST_TODAY = dayKeyIn(NOW, Intl.DateTimeFormat().resolvedOptions().timeZone);

describe('a member\'s age turns over at the family\'s midnight', () => {
  it('a child born 3 October 2018 is 8 on the family\'s 3 October and 7 the day before', () => {
    expect(ageOnDay('2018-10-03', '2026-10-03')).toBe(8);
    expect(ageOnDay('2018-10-03', '2026-10-02')).toBe(7);
    expect(ageOnDay('2018-10-03', '2027-10-03')).toBe(9);
    // 29 February: the birthday is "reached" on 1 March in a common year.
    expect(ageOnDay('2016-02-29', '2026-02-28')).toBe(9);
    expect(ageOnDay('2016-02-29', '2026-03-01')).toBe(10);
  });
  it('rejects what it cannot read, and never goes negative', () => {
    expect(ageOnDay(null, '2026-10-03')).toBeNull();
    expect(ageOnDay('nope', '2026-10-03')).toBeNull();
    expect(ageOnDay('2018-10-03', 'today')).toBeNull();
    expect(ageOnDay('2018-13-03', '2026-10-03')).toBeNull();
    expect(ageOnDay('2030-01-01', '2026-10-03')).toBe(0);
    // A full timestamp birthday is read for its date.
    expect(ageOnDay('2018-10-03T12:00:00Z', '2026-10-03')).toBe(8);
  });
  it('the local-parts `ageOn` answers for the runtime\'s day — right in a browser, the host\'s on a server', () => {
    // At 00:30Z on the 4th the runtime is on the 3rd or the 4th; either way the
    // instant-based answer is the day-key answer for the RUNTIME's day, and in
    // Los Angeles at that instant it is still 7 while Greenwich says 8.
    expect(ageOn('2018-10-04', NOW)).toBe(ageOnDay('2018-10-04', HOST_TODAY));
    expect(ageOnDay('2018-10-04', dayKeyIn(NOW, LA))).toBe(7);
    expect(ageOnDay('2018-10-04', dayKeyIn(NOW, 'UTC'))).toBe(8);
  });
  it('the home avatars and the family service count from the family\'s day key', () => {
    expect(ageFromBirthday('2018-10-03', '2026-10-03')).toBe(8);
    expect(memberTagline({ user_id: null, role: 'child', birthday: '2018-10-04' }, 'u1', '2026-10-03')).toBe('7 yrs');
    expect(memberTagline({ user_id: null, role: 'child', birthday: '2018-10-04' }, 'u1', '2026-10-04')).toBe('8 yrs');
    const home = code('app/(app)/home/page.tsx');
    expect(home).toContain('memberTagline(m, ctx.user.id, todayKey)');
    expect(home, 'the month filter re-read the family\'s midnight on the host\'s calendar').not.toContain('isoDate(monthStart)');
    expect(home).toContain("gte('date', `${todayKey.slice(0, 7)}-01`)");
    const service = code('lib/services/family/index.ts');
    expect(service).toContain('age: ageOnDay(row.birthday, todayKey),');
    expect(service.match(/dayKeyInTz\(scopeNow\(scope\), scope\.tz\)/g)).toHaveLength(2);
    expect(service).not.toMatch(/\bageOn\(/);
  });
});

describe('the memories timeline\'s day words are the family\'s', () => {
  // 4pm Saturday in Los Angeles — the family's today; Greenwich is on Sunday.
  const thisAfternoon = '2026-10-03T23:00:00.000Z';
  // 7pm Wednesday 30 September in Los Angeles; Thursday 1 October in Greenwich.
  const lastWednesday = '2026-10-01T02:00:00.000Z';

  it('this afternoon\'s album is "Today" on the family\'s day, and "Yesterday" on Greenwich\'s', () => {
    expect(relativeDay(thisAfternoon, NOW, 'en-US', undefined, LA)).toBe('Today');
    expect(relativeDay(thisAfternoon, NOW, 'en-US', undefined, 'UTC')).toBe('Yesterday');
  });
  it('last Wednesday\'s party is "Last Wednesday", not "Last Thursday"', () => {
    expect(relativeDay(lastWednesday, NOW, 'en-US', undefined, LA)).toBe('Last Wednesday');
    expect(relativeDay(lastWednesday, NOW, 'en-US', undefined, 'UTC')).toBe('Last Thursday');
    // Older than a week: the full date, on the family's calendar.
    expect(relativeDay('2026-09-20T02:00:00.000Z', NOW, 'en-US', undefined, LA)).toBe('Sep 19, 2026');
    expect(relativeDay('2026-09-20T02:00:00.000Z', NOW, 'en-US', undefined, 'UTC')).toBe('Sep 20, 2026');
  });
  it('without a zone the local-parts path stands for the browser, answering for the runtime\'s day', () => {
    expect(relativeDay(thisAfternoon, NOW)).toBe(relativeDay(thisAfternoon, NOW, 'en-US', undefined, Intl.DateTimeFormat().resolvedOptions().timeZone));
  });
  it('the timeline hands the zone to every row, and the memories page hands it the family\'s', () => {
    const album = (id: string, created_at: string) => ({ id, created_at, title: id, cover_url: null, family_id: 'f', description: null }) as unknown as Parameters<typeof buildTimeline>[0][number];
    const rows = buildTimeline([album('a', thisAfternoon), album('b', lastWednesday)], NOW, 12, 'en-US', undefined, LA);
    expect(rows.map((r) => r.relative)).toEqual(['Today', 'Last Wednesday']);
    expect(code('app/(app)/dashboard/memories/page.tsx')).toContain('buildTimeline(highlights, now, 12, locale.code, tr, tz)');
  });
});

describe('the playbook dates a tradition on the family\'s calendar', () => {
  it('reads the year off the family\'s day key and the season off the date\'s own digits', () => {
    const src = code('app/(app)/dashboard/playbook/playbook-actions.ts');
    expect(src).toContain('const yr = Number(dayKeyInTz(new Date(e.starts_at), tz).slice(0, 4));');
    expect(src).toContain('const m = Number(date.slice(5, 7)) - 1;');
    expect(src, 'a host-calendar read came back').not.toMatch(/\.get(?:FullYear|Month)\(\)/);
  });
});
