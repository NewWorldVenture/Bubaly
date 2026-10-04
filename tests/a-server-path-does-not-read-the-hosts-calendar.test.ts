// A SERVER PATH DOES NOT READ THE HOST'S CALENDAR.
//
// `d.getFullYear()`, `.getMonth()`, `.getDate()`, `.getDay()`, `.getHours()`
// answer in the zone of the machine running the code. In a browser that is the
// reader's own day. On the UTC host that renders a server component, answers a
// service call or runs a cron it is Greenwich's day — tomorrow's, from 5pm in
// California. Four units closed the sites this class had grown
// (tests/a-server-today-is-the-familys-day, a-server-page-renders-the-familys-date,
// an-admin-page-renders-an-explicit-zone, a-server-side-age-and-days-ago-read-
// the-familys-day); this file keeps it closed, and fixed the eleven more the
// scan below found on the way: an admin ticket's date stamp and "new this
// month", the family COO's weekday column, the memories year counts, the
// moments signals' hour and weekday, both dashboards' event badges and clocks,
// the admin growth chart's day cutoffs, the maintenance season, the vacation
// countdown, and six copyright years.
//
// WHAT IS SCANNED. Not every file with a local getter: a module imported only
// by 'use client' components runs in the browser, where the local calendar is
// right, and listing fifty of those would bury the dozen that matter. The scan
// walks the import graph from every server entry point (each non-client file
// under app/), stops at a 'use client' boundary, and looks at what it reached.
//
// WHAT IS DECLARED. Like tests/a-server-day-is-the-familys-day.test.ts: every
// reachable file that still reads a local calendar part is listed with the
// reason it is still there, so the list is a claim a reviewer can check. A new
// one fails; a removed one fails too, which is the moment to delete its line.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const ROOTS = ['app', 'lib', 'components'];
const GETTER = /\.get(?:FullYear|Month|Date|Day|Hours)\(\)/;

const DECLARED: Record<string, string> = {
  // ── browser-side paths kept beside the zoned ones (the server callers pass the zone or a day key) ──
  'lib/moments/birthdays.ts': 'nextBirthdayDate/daysUntil for browser callers; server callers use birthdayCountdown(todayKey) (a-server-today-is-the-familys-day).',
  'lib/celebrations/dates.ts': 'daysUntilNext for browser callers; the portal uses daysUntilNextOn(todayKey).',
  'lib/memories/on-this-day.ts': 'calendarKey without a zone for browser callers; the page and the engine pass the family zone.',
  'lib/memories/memories.ts': 'calendarDaysAgo without a zone for browser callers; the memories page passes tz (a-server-side-age-and-days-ago…).',
  'lib/members/age.ts': 'ageOn(Date) for browser callers; the family service and the home page use ageOnDay(todayKey).',
  'lib/moments/prep.ts': 'the local-parts fallback when no zone is given, beside dayIndexInZone; every server caller passes the zone.',
  'lib/vacations/dates.ts': 'daysUntil(Date) for browser callers; the trip layout passes the family day key.',
  'lib/home/maintenance.ts': 'currentSeason(Date) for browser callers; the maintenance page passes the family day key.',
  'lib/home/time-of-day.ts': 'dayPhase\'s fallback when no zone is given; every server caller passes the family zone.',
  'lib/display/ambient.ts': 'the fallback when the display has no zone; the display page passes the family\'s.',
  'lib/capture/parse.ts': 'LOCAL_OPS, one half of an explicit LOCAL/UTC ops pair; the server bridge (parseEventInZone) chooses UTC_OPS on a zone-shifted wall clock.',
  // ── correct as it stands ──
  'lib/guardian/rules.ts': 'the weekday is read IN the family zone, via the locale-string shift; indirect, but the family\'s.',
  'lib/medications/adherence.ts': 'receives a wall-clock `now` already shifted into the family zone by its caller (asWallClockIn), by contract.',
  'lib/moving/planner.ts': 'dateOnly/isoDate/addDays are local-in, local-out on date strings (the zone cancels); the Date form is fed the family\'s noon by the moving service.',
  'lib/reminders/details.ts': 'rolls a recurrence forward by whole days/months/years on an instant with local setters; on a UTC host a day is 24 hours.',
  'lib/home/home-data.ts': 'isoDate(Date): local YYYY-MM-DD for the client-only projects and declutter modules; the home page no longer calls it.',
  // ── reachable, but the local-reading function is only called from the browser ──
  'lib/inventory/finder.ts': 'lentOut/warrantyAlerts(items, today) take the inventory module\'s (client) today; the server imports only search/location helpers.',
  'lib/marketplace/handoff.ts': 'suggestedMeetTimes(now) is called only by components/marketplace/handoff-panel.tsx (client); the server imports the code helpers.',
  'lib/trips/departure.ts': 'trafficFactorForTime\'s dow/hour defaults are used only by components/modules/trip-intel-module.tsx (client).',
  // ── fixes in flight ──
  'lib/ai/insights.ts': 'the celebration planner\'s 60-day window takes the host\'s year; a day off only around New Year\'s midnight on the host. The data bundle does not carry the zone yet; tracked.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}
const blank = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const rel = (f: string) => f.slice(ROOT.length + 1).split('\\').join('/');
const source = new Map(files.map((f) => [rel(f), readFileSync(f, 'utf8')]));
const isClient = (r: string) => /^\s*['"]use client['"]/m.test(source.get(r) ?? '');
const EXT = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Resolve an import specifier to a repo-relative file, or null for a package. */
function resolveSpec(fromRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = resolve(dirname(join(ROOT, fromRel)), spec).slice(ROOT.length + 1).split('\\').join('/');
  else return null;
  if (source.has(base)) return base;
  for (const e of EXT) if (source.has(base + e)) return base + e;
  return null;
}
function importsOf(r: string): Set<string> {
  const out = new Set<string>();
  for (const m of blank(source.get(r)!).matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
    const t = resolveSpec(r, m[1]);
    if (t) out.add(t);
  }
  return out;
}

/** Every file a server entry point reaches without crossing into a client file. */
function serverReachable(): Set<string> {
  const entries = [...source.keys()].filter((r) => r.startsWith('app/') && !isClient(r));
  const reach = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    const r = queue.pop()!;
    for (const t of importsOf(r)) {
      if (isClient(t) || reach.has(t)) continue;
      reach.add(t);
      queue.push(t);
    }
  }
  return reach;
}

const reachable = serverReachable();
const offenders = [...reachable].filter((r) => GETTER.test(blank(source.get(r)!))).sort();

describe('a server path does not read the host\'s calendar', () => {
  it('walks a real graph (non-vacuity)', () => {
    // Entry points, reach, a module reached THROUGH another, and a client file kept out.
    expect(reachable.size).toBeGreaterThan(1000);
    expect(reachable.has('app/(app)/home/page.tsx')).toBe(true);
    expect(reachable.has('lib/members/age.ts')).toBe(true); // via lib/home/home-data.ts and lib/services/family
    expect([...reachable].some(isClient)).toBe(false);
    // And the getter it looks for is seen on a planted line but not in a comment.
    expect(GETTER.test('const y = d.getFullYear();')).toBe(true);
    expect(GETTER.test('const y = d.getUTCFullYear();')).toBe(false);
    expect(GETTER.test(blank('// d.getFullYear()\nconst y = 1;'))).toBe(false);
    expect(offenders.length).toBeGreaterThanOrEqual(15);
  });

  it('resolves imports the way the app does', () => {
    expect(resolveSpec('app/(app)/home/page.tsx', '@/lib/moments/birthdays')).toBe('lib/moments/birthdays.ts');
    expect(resolveSpec('lib/services/family/index.ts', '../scope')).toBe('lib/services/scope.ts');
    expect(resolveSpec('lib/services/family/index.ts', 'react')).toBeNull();
  });

  it('has no undeclared server-reachable read of a local calendar part', () => {
    const undeclared = offenders.filter((f) => !(f in DECLARED));
    expect(
      undeclared,
      'These read the calendar where the PROCESS runs, which on a UTC host is not the family\'s day.\n'
      + 'Count on a day key (dayKeyInTz / dayKeyIn) or in the family zone (localPartsAt, a formatter bound\n'
      + 'to it), use the admin zone (lib/admin/clock.ts) on an admin surface, or add the file to DECLARED\n'
      + 'with the reason it is correct as it stands:\n' + undeclared.join('\n'),
    ).toEqual([]);
  });

  it('has no stale declaration', () => {
    const stale = Object.keys(DECLARED).filter((f) => !offenders.includes(f));
    expect(
      stale,
      'Declared as still reading the host\'s calendar on a server path, but no longer does. Delete these lines:\n' + stale.join('\n'),
    ).toEqual([]);
  });
});

describe('the sites the scan found are on the family\'s (or the admin\'s) calendar now', () => {
  const code = (r: string) => blank(readFileSync(join(ROOT, r), 'utf8'));
  it('admin: the ticket stamp, "new this month" and the growth chart use the admin zone', () => {
    expect(code('app/(app)/admin/support-tickets/actions.ts')).toContain('const day = dayKeyIn(new Date(), ADMIN_ZONE);');
    expect(code('app/(app)/admin/users/page.tsx')).toContain('const monthStart = new Date(utcMonthStartIso());');
    expect(code('components/admin/growth-chart.tsx')).toContain('lastUtcDays(days).map((w) => dates.filter((t) => t < w.end).length)');
  });
  it('family pages: the COO weekday, the memories year, the moments signals, the trip countdown, the season', () => {
    expect(code('app/(app)/dashboard/family-coo/page.tsx')).toContain("fmtDate(e.starts_at, 'EEE')");
    expect(code('app/(app)/dashboard/memories/page.tsx')).toContain('const yearStart = new Date(zonedDayBoundsMs(`${dayKeyInTz(now, tz).slice(0, 4)}-01-01`, tz).start).toISOString();');
    expect(code('app/(app)/dashboard/moments/page.tsx')).toContain('hour: localPartsAt(now, tz).hour, dow: new Date(`${todayIso}T00:00:00Z`).getUTCDay(),');
    expect(code('app/(app)/dashboard/vacations/[id]/layout.tsx')).toContain('countdownLabel(t, trip.start_date, todayKey)');
    expect(code('app/(app)/dashboard/home/maintenance/page.tsx')).toContain("currentSeason(dayKeyInTz(new Date(), ctx.active.family.timezone || 'UTC'))");
  });
  it('both dashboards render an event\'s badge and clock through a formatter bound to the family zone', () => {
    for (const r of ['components/dashboard/family-dashboard.tsx', 'components/dashboard/personal-dashboard.tsx']) {
      const src = code(r);
      expect(src, r).toContain("const { fmtTime, fmtDate } = createFormat(locale.code, undefined, ctx.active.family.timezone || 'UTC');");
      expect(src, r).toContain("fmtDate(e.starts_at, 'MMM')");
      expect(src, r).toContain("fmtDate(e.starts_at, 'd')");
      expect(src, r).not.toMatch(/import \{[^}]*\bfmtTime\b[^}]*\} from '@\/lib\/utils\/format'/);
    }
  });
  it('a copyright year is read in an explicit zone', () => {
    for (const r of ['lib/emails/chore-reminder.tsx', 'lib/emails/invite.tsx', 'lib/emails/referral.tsx', 'lib/emails/weekly-digest.tsx', 'lib/emails/welcome.tsx', 'components/marketing/site-footer.tsx']) {
      expect(code(r), r).toMatch(/getUTCFullYear\(\)/);
    }
  });
});
