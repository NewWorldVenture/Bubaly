// AN ADMIN PAGE RENDERS AN EXPLICIT ZONE.
//
// The admin surfaces serve operators, not a family, so there is no family zone
// to read — and what they had grown instead was the HOST's. Four pages built a
// six-month trend from `new Date(y, m - i, 1)` and labelled each month with
// `toLocaleDateString(locale, { month: 'short' })`; the reports page bucketed
// a fortnight of activity into rolling 24-hour windows and labelled each with
// the day-of-month its START fell on in the host's zone; the overview counted
// "new this month" from the host's first of the month; and three pages wrote
// a bare `toLocaleString()` / `toLocaleDateString()` — the host's zone in the
// host's LOCALE — for a survey response, a marketplace report and "Checked at".
//
// On Vercel the host is UTC and all of that reads like a convention. It is not
// one until it is written down: the same page rendered elsewhere bucketed a
// 23:30-on-the-31st subscription into a different month and labelled a 1 May
// row "Apr". lib/admin/clock.ts makes the zone explicit (UTC, as the admin
// digest's date already was) and these pages name it on every label.
//
// The companion ratchet (tests/a-server-page-renders-the-familys-date.test.ts)
// now covers the admin tree too, so this file holds the helpers' behaviour and
// each page's wiring.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_ZONE, inWindow, lastUtcDays, lastUtcMonths, utcMonthStartIso } from '@/lib/admin/clock';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
// 02:00Z on 1 November is still Hallowe'en evening in Los Angeles: a host there
// is on October, the admin zone is on November.
const NOW = new Date('2026-11-01T02:00:00.000Z');
const label = (ms: number, options: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleDateString('en-US', { ...options, timeZone: ADMIN_ZONE });

describe('the admin clock', () => {
  it('names one explicit zone, and reads only that zone\'s calendar parts', () => {
    expect(ADMIN_ZONE).toBe('UTC');
    // Under a UTC runtime `new Date(y, m, 1)` and `Date.UTC(y, m, 1)` agree, so no
    // behavioural case here can tell the host's calendar from the explicit one —
    // the TZ=America/Los_Angeles rerun in CI can, and this pin does in both.
    const src = read('lib/admin/clock.ts').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(src, 'the clock read a LOCAL calendar part').not.toMatch(/\.get(?:FullYear|Month|Date|Day|Hours)\(\)/);
    expect(src.match(/Date\.UTC\(/g)?.length).toBeGreaterThanOrEqual(5);
    expect(src.match(/getUTC(?:FullYear|Month|Date)\(\)/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it('the last six months end with the month the admin zone is in, whatever the host is on', () => {
    const months = lastUtcMonths(6, NOW);
    expect(months.map((w) => label(w.start, { month: 'short' }))).toEqual(['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov']);
    expect(months.map((w) => new Date(w.start).toISOString())).toEqual([
      '2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
    ]);
    // Each window ends where the next begins, and the last one is open-ended into
    // the future only as far as the first of next month.
    for (let i = 1; i < months.length; i += 1) expect(months[i].start).toBe(months[i - 1].end);
    expect(new Date(months[5].end).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    // Crossing a year boundary: five months back from February is September.
    expect(label(lastUtcMonths(6, new Date('2027-02-15T12:00:00.000Z'))[0].start, { month: 'short', year: 'numeric' })).toBe('Sep 2026');
  });

  it('a subscription created late on the 31st is October\'s in the admin zone, and in the admin zone only', () => {
    const [, , , , october, november] = lastUtcMonths(6, NOW);
    // 23:30Z on 31 October: October in UTC; already 1 November in Asia/Tokyo and
    // still 31 October in Los Angeles — only the explicit zone gives one answer.
    expect(inWindow('2026-10-31T23:30:00.000Z', october)).toBe(true);
    expect(inWindow('2026-10-31T23:30:00.000Z', november)).toBe(false);
    expect(inWindow('2026-11-01T00:00:00.000Z', november)).toBe(true);
    // A window is half-open: its end instant belongs to the NEXT window only.
    expect(inWindow('2026-11-01T00:00:00.000Z', october)).toBe(false);
    expect(inWindow('2026-10-01T00:00:00.000Z', october)).toBe(true);
    expect(inWindow('not a date', october)).toBe(false);
  });

  it('the last fourteen days are whole admin-zone days ending today, labelled by the day they are', () => {
    const days = lastUtcDays(14, NOW);
    expect(days).toHaveLength(14);
    expect(new Date(days[0].start).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(new Date(days[13].start).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(new Date(days[13].end).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(days.map((w) => label(w.start, { day: 'numeric' }))).toEqual(['19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '1']);
    // The windows tile: an instant is in exactly one of them.
    const at = '2026-10-25T23:59:59.000Z';
    expect(days.filter((w) => inWindow(at, w)).map((w) => label(w.start, { day: 'numeric' }))).toEqual(['25']);
    // Including an instant that sits exactly on a boundary: midnight is the 26th's.
    expect(days.filter((w) => inWindow('2026-10-26T00:00:00.000Z', w)).map((w) => label(w.start, { day: 'numeric' }))).toEqual(['26']);
  });

  it('"this month" starts at the admin zone\'s first of the month', () => {
    expect(utcMonthStartIso(NOW)).toBe('2026-11-01T00:00:00.000Z');
    expect(utcMonthStartIso(new Date('2026-10-04T00:30:00.000Z'))).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('each admin page answers in the admin zone', () => {
  const stripComments = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[^\S\n]*\/\/.*$/gm, '')
    .replace(/(?<=[ \t])\/\/[^\n]*/g, '');
  const code = (rel: string) => stripComments(read(rel));
  const MONTH_LABEL = "new Date(w.start).toLocaleDateString(locale, { month: 'short', timeZone: ADMIN_ZONE })";

  it('billing, marketing analytics, the overview and reports bucket and label their trends by admin-zone months', () => {
    for (const rel of ['app/(app)/admin/billing/page.tsx', 'app/(app)/admin/marketing/analytics/page.tsx', 'app/(app)/admin/page.tsx', 'app/(app)/admin/reports/page.tsx']) {
      const src = code(rel);
      expect(src, rel).toContain('lastUtcMonths(6).map((w) =>');
      expect(src, rel).toContain(MONTH_LABEL);
      expect(src, `${rel} still builds a month from the host's calendar`).not.toMatch(/new Date\(new Date\(\)\.getFullYear\(\)/);
    }
  });

  it('the overview counts "new this month" from the admin zone\'s first', () => {
    expect(code('app/(app)/admin/page.tsx')).toContain('const monthStart = utcMonthStartIso();');
  });

  it('reports buckets a fortnight into whole admin-zone days and labels each by its own day', () => {
    const src = code('app/(app)/admin/reports/page.tsx');
    expect(src).toContain('const activityByDay = lastUtcDays(14).map((w) => ({');
    expect(src).toContain("label: new Date(w.start).toLocaleDateString(locale, { day: 'numeric', timeZone: ADMIN_ZONE }),");
    expect(src).not.toContain('Date.now() - (13 - i) * MS_DAY');
  });

  it('a survey response, a marketplace report and "Checked at" name the zone instead of the host\'s clock and locale', () => {
    for (const [rel, call] of [
      ['app/(app)/admin/marketing/surveys/[id]/page.tsx', "fmtDate(r.submitted_at, 'MMM d, yyyy h:mm:ss a z')"],
      ['app/(app)/admin/marketplace/reports/page.tsx', "fmtDate(r.created_at, 'MMM d, yyyy')"],
      ['app/(app)/admin/system/page.tsx', "fmtDate(new Date(), 'MMM d, yyyy h:mm:ss a z')"],
    ] as const) {
      const src = code(rel);
      expect(src, rel).toContain('await getFormat(ADMIN_ZONE)');
      expect(src, rel).toContain(call);
      // A DATE's bare render; a count's `toLocaleString()` is a number and is not this.
      expect(src, rel).not.toMatch(/new Date\([^)]*\)\.toLocale(?:Date)?String\(\)/);
    }
  });
});
