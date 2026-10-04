// A SERVER PAGE RENDERS THE FAMILY'S DATE, NOT THE HOST'S.
//
// `toLocaleDateString(locale, { month, day })` with no `timeZone` renders in
// the zone of the machine running it. In a browser that is the reader's own
// clock. On the UTC host that renders a server component or runs a cron it is
// Greenwich's, and from 5pm in California Greenwich is already on tomorrow.
//
// tests/a-server-label-reads-the-familys-clock.test.ts ratchets the API routes
// and the server libraries. This one covers the two roots it does not: the
// family-facing server PAGES and server actions under app/(app), and the email
// templates under lib/emails, which a cron renders for a family it is not in
// the same zone as. Twenty-four renders across thirteen page files, and the
// three emails' "today" / "due" lines, read the host's clock:
//
//   - home: the Coming Up badge's month and DAY (`d.getDate()`), a task's due
//     day, a photo's day; memories: album and event dates; planning and food:
//     every day label; conflicts: both ends of a conflict AND its "same day"
//     decision (`toDateString()`); concierge run history: when a run finished;
//     the playbook's "every <month>" tradition; sync history, a sync account's
//     "last synced", a social post's attempts — bare `toLocaleString()`, so the
//     host's LOCALE too; the treasury's monthly trend, which also BUCKETED by
//     the host's months; the display's birthday (built and rendered in the
//     same zone, so right by accident — now explicit).
//   - weekly digest "Week of …", notification digest's weekday line, chore
//     reminder's "Due …": a cron, UTC host, family elsewhere.
//
// The pages already know the family's zone and most already hold a formatter
// bound to it (`getFormat(tz)` / `createFormat(…, tz)`), whose `fmtDate` also
// renders a DATE column (`due_date`, `plan_date`) in no zone at all — the
// contract the first case below pins. The emails take a `timeZone` prop from
// the callers, which read `families.timezone` already or do so now.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFormat } from '@/lib/utils/format';
import { WeeklyDigestEmail } from '@/lib/emails/weekly-digest';
import { NotificationDigestEmail } from '@/lib/emails/notification-digest';
import { ChoreReminderEmail } from '@/lib/emails/chore-reminder';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
// The source with its comments blanked: a negative pin must not be satisfied or
// failed by the sentence that explains it.
const code = (rel: string) => stripComments(read(rel));
const LA = 'America/Los_Angeles';
// Saturday 3 October, 5:30pm in Los Angeles; Sunday 4 October in Greenwich.
const NOW = '2026-10-04T00:30:00.000Z';
const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");

describe('the shared formatter the pages bind: an instant in the family\'s zone, a DATE in none', () => {
  const { fmtDate } = createFormat('en-US', undefined, LA);
  it('renders an instant on the family\'s day', () => {
    // 02:00Z on the 5th is 7pm on the 4th in Los Angeles.
    expect(fmtDate('2026-10-05T02:00:00.000Z', 'MMM d')).toBe('Oct 4');
    expect(fmtDate('2026-10-05T02:00:00.000Z', 'd')).toBe('4');
    expect(fmtDate('2026-10-05T02:00:00.000Z', 'MMM d, yyyy h:mm a')).toBe('Oct 4, 2026, 7:00 PM');
  });
  it('renders a DATE column as the day it names, in every zone', () => {
    expect(fmtDate('2026-10-05', 'MMM d')).toBe('Oct 5');
    expect(createFormat('en-US', undefined, 'Pacific/Kiritimati').fmtDate('2026-10-05', 'MMM d')).toBe('Oct 5');
    expect(createFormat('en-US', undefined, 'UTC').fmtDate('2026-10-05', 'MMM')).toBe('Oct');
  });
});

describe('the emails date themselves in the family\'s zone', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  const digest = (timeZone: string) => html(React.createElement(WeeklyDigestEmail, {
    familyName: 'Hughen', adminName: 'Daniel', openChores: 0, mealsPlanned: 0, memberCount: 3, timeZone,
    events: [{ title: 'Soccer', date: '2026-10-05' }],
  }));
  it('the weekly digest\'s "Week of" is the family\'s date, and an event\'s DAY KEY is that day in every zone', () => {
    expect(digest(LA)).toContain('October 3');
    expect(digest('UTC')).toContain('October 4');
    // The day key is the family's already (the route resolves it in `tz`), so
    // it must not move again when rendered: the 5th is Monday in both.
    expect(digest(LA)).toContain('Mon, Oct 5');
    expect(digest('Pacific/Kiritimati')).toContain('Mon, Oct 5');
  });

  it('the notification digest\'s weekday line is the family\'s', () => {
    const items = [{ title: 'Soccer moved', body: null, icon: '📅' }];
    expect(html(React.createElement(NotificationDigestEmail, { name: 'Daniel', items, timeZone: LA }))).toContain('Saturday, October 3');
    expect(html(React.createElement(NotificationDigestEmail, { name: 'Daniel', items, timeZone: 'UTC' }))).toContain('Sunday, October 4');
  });

  it('a chore due Sunday evening in California is due Sunday, not Monday', () => {
    // 02:00Z Monday the 5th is 7pm Sunday the 4th in Los Angeles.
    const chores = [{ title: 'Dishes', points: 5, dueAt: '2026-10-05T02:00:00.000Z' }];
    expect(html(React.createElement(ChoreReminderEmail, { memberName: 'Mia', familyName: 'Hughen', chores, timeZone: LA }))).toContain('Due Oct 4');
    expect(html(React.createElement(ChoreReminderEmail, { memberName: 'Mia', familyName: 'Hughen', chores, timeZone: 'UTC' }))).toContain('Due Oct 5');
  });
});

describe('every caller hands the email its family\'s zone', () => {
  it('the weekly digest route passes the zone it already resolved', () => {
    const src = read('app/api/cron/weekly-digest/route.ts');
    expect(src).toContain("const tz = family.timezone || 'UTC';");
    expect(src).toContain('timeZone: tz,');
  });
  it('the notification digest reads each family\'s zone once per batch and dates each recipient\'s digest in it', () => {
    const src = read('lib/server/notification-emails.ts');
    expect(src).toContain("supabase.from('families').select('id, timezone').in('id', chunk)");
    expect(src).toContain("timeZone: zoneByFamily.get(notifs[0].family_id) ?? 'UTC'");
    // A failed zone read dates in UTC and says so; it does not hold the digests.
    expect(src).toContain("dating digests in UTC");
  });
  it('the chore reminder reads the zone with the family name and passes it per recipient', () => {
    const src = read('app/api/cron/chore-reminders/route.ts');
    expect(src).toContain("supabase.from('families').select('id, name, timezone').in('id', chunk)");
    expect(src).toContain("timeZone: familyZoneById.get(familyId) ?? 'UTC'");
  });
});

describe('each page renders through the formatter bound to the family\'s zone', () => {
  it('home: the Coming Up badge, a due day and a photo day', () => {
    const src = code('app/(app)/home/page.tsx');
    expect(src).toContain("const { fmtTime, fmtDate, fmtMoney } = createFormat(locale.code, (key, params) => translate(catalogue, key, params), tz);");
    expect(src).toContain("fmtDate(e.starts_at, 'MMM')");
    expect(src).toContain("fmtDate(e.starts_at, 'd')");
    expect(src, 'the badge day number read the host\'s calendar').not.toContain('d.getDate()');
    expect(src).toContain("fmtDate(t.due_date, 'MMM d')");
    expect(src).toContain("fmtDate(p.taken_at || p.created_at, 'MMM d')");
  });
  it('conflicts: both ends and the same-day decision', () => {
    const src = code('app/(app)/dashboard/conflicts/page.tsx');
    expect(src).toContain('function whenLabel(startsAt: string, endsAt: string | null, locale: LocaleCode, tz: string): string {');
    expect(src.match(/timeZone: tz/g)).toHaveLength(3);
    expect(src).toContain('const sameDay = dayKeyInTz(s, tz) === dayKeyInTz(e, tz);');
    expect(src).not.toContain('toDateString()');
    expect(src.match(/whenLabel\([^)]*, locale\.code, tz\)/g)).toHaveLength(2);
  });
  it('planning, food and memories: day labels through fmtDate', () => {
    for (const rel of ['app/(app)/dashboard/planning/page.tsx', 'app/(app)/dashboard/food/page.tsx', 'app/(app)/dashboard/memories/page.tsx']) {
      const src = code(rel);
      expect(src, rel).toMatch(/const \{ (fmtTime, )?fmtDate \} = await getFormat\(tz\);/);
      expect(src, rel).not.toMatch(/toLocaleDateString\(/);
    }
  });
  it('concierge run history, the playbook\'s tradition month, the treasury trend, the display birthday', () => {
    expect(read('app/(app)/dashboard/concierge/runs/page.tsx')).toContain("minute: '2-digit', timeZone: tz });");
    expect(read('app/(app)/dashboard/playbook/playbook-actions.ts')).toContain('{ ...MONTH_FMT, timeZone: tz }');
    const treasury = code('app/(app)/wallet/treasury/page.tsx');
    expect(treasury).toContain('const monthKeyOf = (iso: string) => dayKeyInTz(new Date(iso), tz).slice(0, 7);');
    expect(treasury).toContain("trend.push({ label: fmtDate(`${key}-01`, 'MMM'), credits, debits });");
    expect(treasury, 'the month boundary was the host\'s').not.toContain('new Date(now.getFullYear(), now.getMonth(), 1)');
    expect(read('app/(app)/display/page.tsx')).toContain("d.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })");
  });
  it('sync history, a sync account and a social post: a bound clock instead of the host\'s locale and zone', () => {
    for (const rel of ['app/(app)/dashboard/sync/history/page.tsx', 'app/(app)/dashboard/sync/accounts/[provider]/page.tsx', 'app/(app)/dashboard/social/posts/[id]/page.tsx']) {
      const src = code(rel);
      expect(src, rel).toContain("await getFormat(ctx.active.family.timezone || 'UTC')");
      expect(src, rel).toContain("'MMM d, yyyy h:mm a')");
      expect(src, rel).not.toContain('.toLocaleString()');
    }
  });
});

// ── The ratchet ─────────────────────────────────────────────────────────────
// Server files (no 'use client') under the family-facing app tree and the email
// templates. The admin tree is excluded ON PURPOSE and for now: its ~8 sites are
// the next unit, and the case at the end fails the moment that exclusion stops
// excluding anything, so it cannot outlive its reason.
const ROOTS = ['app/(app)', 'lib/emails'];
const EXCLUDED = ['app/(app)/admin'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}
/** Blank comments, keeping every newline so line numbers survive. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[^\S\n]*\/\/.*$/gm, '')
    .replace(/(?<=[ \t])\/\/[^\n]*/g, '');
}
const RENDER = /\.toLocale(Date|Time)?String\(/g;

/** Every zone-less Date render in `src`: `file:line: call`. */
function hostZoneRenders(src: string, label = ''): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(RENDER)) {
    const open = m.index! + m[0].length;
    const line = src.slice(0, m.index!).split('\n').length;
    // The argument list, to its matching paren.
    let depth = 1; let end = open;
    for (; end < src.length && depth > 0; end += 1) {
      if (src[end] === '(') depth += 1; else if (src[end] === ')') depth -= 1;
    }
    const args = src.slice(open, end - 1);
    const dateMethod = Boolean(m[1]);
    const dateOptions = /weekday|month|day|hour|minute|year|dateStyle|timeStyle/.test(args);
    const onADate = /(?:new Date\([^()]*(?:\([^()]*\))?[^()]*\)|\bDate\b[^.\n]*)$/.test(src.slice(Math.max(0, m.index! - 80), m.index!));
    // `n.toLocaleString(locale)` is a NUMBER unless the receiver is a Date or the
    // options say otherwise; `toLocaleDateString` / `toLocaleTimeString` always
    // render a date.
    if (!dateMethod && !dateOptions && !onADate) continue;
    // `timeZone: tz`, `timeZone: 'UTC'`, or the shorthand `{ …, timeZone }`.
    if (/\btimeZone\b/.test(args)) continue;
    out.push(`${label}${line}: ${m[0]}${args.replace(/\s+/g, ' ').slice(0, 90)})`);
  }
  return out;
}

const serverFiles = ROOTS.flatMap((root) => walk(join(ROOT, root)))
  .map((f) => f.slice(ROOT.length + 1).split('\\').join('/'))
  .filter((rel) => !/^\s*['"]use client['"]/m.test(read(rel)));
const inScope = serverFiles.filter((rel) => !EXCLUDED.some((ex) => rel.startsWith(`${ex}/`)));
const excluded = serverFiles.filter((rel) => EXCLUDED.some((ex) => rel.startsWith(`${ex}/`)));

describe('no family-facing server page or email renders a date in the host\'s zone', () => {
  it('finds the server files (a scan that finds none proves nothing)', () => {
    expect(inScope.length).toBeGreaterThan(100);
    expect(inScope).toContain('app/(app)/home/page.tsx');
    expect(inScope).toContain('lib/emails/weekly-digest.tsx');
    expect(inScope.some((f) => f.endsWith('-actions.ts'))).toBe(true);
  });
  it('recognises every shape it claims to, and nothing it does not', () => {
    const flagged = [
      "d.toLocaleDateString(locale, { month: 'short' })",
      "new Date(iso).toLocaleTimeString(locale.code, { hour: 'numeric' })",
      "new Date(iso).toLocaleString(locale, { month: 'short', hour: 'numeric' })",
      'new Date(c.dueAt).toLocaleDateString()',
      'new Date(r.attempted_at).toLocaleString()',
      "today.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })",
    ];
    for (const s of flagged) expect(hostZoneRenders(s), s).toHaveLength(1);
    const clean = [
      "d.toLocaleDateString(locale, { month: 'short', timeZone: tz })",
      "new Date(e.date).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })",
      "today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone })",
      'value.toLocaleString(locale)',
      'mins.toLocaleString(locale.code, { maximumFractionDigits: 0 })',
      "fmtDate(e.starts_at, 'MMM d')",
    ];
    for (const s of clean) expect(hostZoneRenders(s), s).toHaveLength(0);
    // A comment does not count.
    expect(hostZoneRenders(stripComments("// d.toLocaleDateString(locale, { month: 'short' })\nconst x = 1;"))).toHaveLength(0);
  });
  it('every Date render in scope names a timeZone or goes through the bound formatter', () => {
    const offenders = inScope.flatMap((rel) => hostZoneRenders(stripComments(read(rel)), `${rel}:`));
    expect(offenders, 'bind getFormat(tz) / createFormat(…, tz) and use fmtDate, or pass timeZone: tz (an explicit UTC for a DATE-only value)').toEqual([]);
  });
  it('the admin tree is excluded on purpose, and the exclusion still excludes something — delete both when its unit lands', () => {
    const offenders = excluded.flatMap((rel) => hostZoneRenders(stripComments(read(rel)), `${rel}:`));
    expect(offenders.length).toBeGreaterThan(0);
  });
});
