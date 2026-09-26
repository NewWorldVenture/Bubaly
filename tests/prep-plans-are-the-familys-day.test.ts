import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runPrepGeneration } from '@/lib/planning/prep-server';
import { generatePrepPlans } from '@/lib/planning/prep';
import { nextBirthdayDayKey } from '@/lib/moments/birthdays';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Prep generation opened with `now.toISOString().slice(0, 10)` — the day at
// GREENWICH — and spent that one key four ways: the lower bound of two DATE
// columns, the two upper bounds (via `+ N * 86_400_000` on an instant), the
// birthday signal's date, and the pure engine's "today". Every one of those is
// the FAMILY's day now, and they all come from the same value.
//
// EVERY CASE BELOW FIXES BOTH THE INSTANT AND THE ZONE. "Unbound" is not a
// zone — it is whatever the host happens to be set to, and a suite that leaves
// it unbound passes on a laptop in London and proves nothing. Each zone is
// named, and for the ones that matter there is an instant at which the
// family's day and Greenwich's day are DIFFERENT DAYS, which is the only
// situation in which the defect is visible at all.
//
// The five zones span the whole inhabited range so the defect is caught with
// BOTH signs. West of Greenwich the Greenwich day runs AHEAD of the family's,
// so "on or after today" silently dropped a trip departing today. East of it
// the Greenwich day runs BEHIND, so the same trip was a day further off than
// it is and its late steps had not opened yet.

/** The test's own ruler: the day in `tz` for an instant, straight from Intl. */
function familyDayOf(instant: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(instant));
}

/**
 * Whole calendar days off a day key, as the test's own expectation.
 *
 * `Date.UTC` is zone-free calendar arithmetic here, not "this is UTC": the
 * fields go in and the same fields come back out on every host. This is
 * deliberately NOT the helper the module under test uses, so a defect in that
 * helper cannot make the expectation agree with it.
 */
function plusDays(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split('-').map((p) => Number.parseInt(p, 10));
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return `${String(at.getUTCFullYear()).padStart(4, '0')}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
}

type Case = {
  tz: string;
  /** The instant the generation runs at. */
  now: string;
  /** What this case is for, in one line. */
  why: string;
};

const CASES: Case[] = [
  {
    tz: 'UTC', now: '2026-09-21T06:00:00Z',
    why: 'the control — the contract must hold unchanged where the two days agree',
  },
  {
    // 23:00 on the 20th, PDT (UTC-7). Greenwich is already on the 21st.
    tz: 'America/Los_Angeles', now: '2026-09-21T06:00:00Z',
    why: 'west of Greenwich, and a DST-observing zone',
  },
  {
    // 18:00 on the 20th (UTC-12) — the westernmost inhabited offset there is.
    tz: 'Etc/GMT+12', now: '2026-09-21T06:00:00Z',
    why: 'the extreme west; POSIX sign inversion means Etc/GMT+12 is UTC-12',
  },
  {
    // 05:00 on the 22nd, JST (UTC+9). Greenwich is still on the 21st.
    tz: 'Asia/Tokyo', now: '2026-09-21T20:00:00Z',
    why: 'east of Greenwich, and no DST, so a failure here is about the SIGN',
  },
  {
    // 10:00 on the 22nd (UTC+14) — the easternmost offset there is.
    tz: 'Pacific/Kiritimati', now: '2026-09-21T20:00:00Z',
    why: 'the extreme east',
  },
  {
    // 13:00 on the 21st, PDT. The two days AGREE at this instant, so a "fix"
    // that merely shifted everything by a day cannot pass this file.
    tz: 'America/Los_Angeles', now: '2026-09-21T20:00:00Z',
    why: 'the same zone at an instant where it agrees with Greenwich',
  },
  {
    // 12:00 on 20 Feb 2027, PST. The 60-day document horizon from here runs to
    // 21 April and CROSSES the 14 March spring-forward. A horizon built by
    // adding 60 x 86_400_000 to a local midnight lands at 23:00 on the 20th and
    // formats as the 59th day, so the document on the 60th falls out.
    tz: 'America/Los_Angeles', now: '2027-02-20T20:00:00Z',
    why: 'a horizon that spans a spring-forward: 60 local days is not 60 x 24h',
  },
  {
    // 23:30 on 13 March 2027, PST — the evening before the spring-forward, at
    // an hour where Greenwich has already turned over. Both halves of the bug
    // are live at once here.
    tz: 'America/Los_Angeles', now: '2027-03-14T07:30:00Z',
    why: 'the eve of a spring-forward, at an hour where the two days disagree',
  },
];

/** Seeds a family's horizon relative to `familyToday` and runs generation. */
async function generateFor(c: Case) {
  const familyToday = familyDayOf(c.now, c.tz);
  const db = createInMemorySupabase<SupabaseClient<Database>>({
    uniques: {
      prep_plans: [['family_id', 'signal_kind', 'signal_id']],
      prep_plan_steps: [['family_id', 'plan_id', 'label']],
    },
  });

  db.seed('vacations', [
    // `vacations.start_date` is a DATE column (0070_vacations.sql:35): it holds
    // the day on the family's wall and is bounded by a bare day key.
    { id: 'v-yesterday', family_id: 'f1', title: 'Gone Trip', start_date: plusDays(familyToday, -1) },
    { id: 'v-today', family_id: 'f1', title: 'Beach Trip', start_date: familyToday },
    { id: 'v-edge', family_id: 'f1', title: 'Far Trip', start_date: plusDays(familyToday, 120) },
    { id: 'v-past-edge', family_id: 'f1', title: 'Too Far Trip', start_date: plusDays(familyToday, 121) },
  ]);
  db.seed('documents', [
    // `documents.expires_at` is a DATE column (0002_tables.sql:349).
    { id: 'd-today', family_id: 'f1', title: 'Passport', storage_path: 'p/1', expires_at: familyToday },
    { id: 'd-60', family_id: 'f1', title: 'Visa', storage_path: 'p/2', expires_at: plusDays(familyToday, 60) },
    { id: 'd-61', family_id: 'f1', title: 'Licence', storage_path: 'p/3', expires_at: plusDays(familyToday, 61) },
    { id: 'd-yesterday', family_id: 'f1', title: 'Expired Card', storage_path: 'p/4', expires_at: plusDays(familyToday, -1) },
  ]);
  db.seed('family_members', [
    // `family_members.birthday` is a DATE column (0002_tables.sql:39). This
    // member's birthday falls on the family's own today, some years back.
    { id: 'm-today', family_id: 'f1', display_name: 'Mia', birthday: `2015${familyToday.slice(4)}` },
    { id: 'm-none', family_id: 'f1', display_name: 'Sam', birthday: null },
  ]);

  const result = await runPrepGeneration(db, 'f1', null, c.tz, new Date(c.now));
  const plans = db.table('prep_plans');
  return {
    familyToday,
    greenwichToday: new Date(c.now).toISOString().slice(0, 10),
    result,
    plans,
    bySignal: new Map(plans.map((row) => [String(row.signal_id), row])),
    steps: db.table('prep_plan_steps'),
  };
}

describe.each(CASES)('prep generation answers the family\'s day in $tz ($why)', (c) => {
  it('bounds both DATE columns by the family\'s own today, not Greenwich\'s', async () => {
    const { familyToday, plans, bySignal } = await generateFor(c);

    // A trip departing TODAY is the case the whole feature exists for, and it
    // is exactly the one a Greenwich lower bound dropped: west of Greenwich
    // that key is already tomorrow for the last hours of every day.
    expect([...bySignal.keys()].sort()).toEqual(['d-60', 'd-today', 'm-today', 'v-edge', 'v-today']);
    expect(bySignal.get('v-today')?.target_date).toBe(familyToday);

    // Yesterday's rows never entered the window, and the day past each horizon
    // never entered it either. Both edges move with the family's day.
    expect(plans.some((row) => row.signal_id === 'v-yesterday')).toBe(false);
    expect(plans.some((row) => row.signal_id === 'd-yesterday')).toBe(false);
    expect(plans.some((row) => row.signal_id === 'v-past-edge')).toBe(false);
    expect(plans.some((row) => row.signal_id === 'd-61')).toBe(false);
  });

  it('measures each horizon in whole CALENDAR days off that day', async () => {
    const { familyToday, bySignal } = await generateFor(c);

    // 120 family days for trips and 60 for documents — counted as calendar
    // days, so a span containing a 23-hour day is still 120 or 60 days long.
    expect(bySignal.get('v-edge')?.target_date).toBe(plusDays(familyToday, 120));
    expect(bySignal.get('d-60')?.target_date).toBe(plusDays(familyToday, 60));
  });

  it('measures urgency and step due dates from the family\'s day', async () => {
    const { familyToday, bySignal, steps } = await generateFor(c);

    // Departing today: every lead window is open, so the plan is urgent. Read
    // against a Greenwich "today" one day ahead this signal was gone entirely;
    // one day behind, "pack the night before" had not opened yet.
    expect(bySignal.get('v-today')?.urgency).toBe('now');

    const planId = bySignal.get('v-today')?.id;
    const tripSteps = steps.filter((row) => row.plan_id === planId);
    const dueByLead = new Map(tripSteps.map((row) => [Number(row.lead_days), String(row.due_date)]));
    // `prep_plan_steps.due_date` is a DATE column (0131_prep_plans.sql): the
    // day the step opens, target minus lead days, as whole calendar days.
    expect(dueByLead.get(1)).toBe(plusDays(familyToday, -1));
    expect(dueByLead.get(30)).toBe(plusDays(familyToday, -30));
  });

  it('dates a birthday on the family\'s calendar, never re-expressed at Greenwich', async () => {
    const { familyToday, greenwichToday, bySignal } = await generateFor(c);

    // The member's birthday is this month-day, so their next one is today.
    // The old path built a Date from the RUNTIME's local parts and emitted
    // `toISOString().slice(0, 10)`, which re-expresses local midnight at
    // Greenwich and walks the day backwards east of it.
    expect(bySignal.get('m-today')?.target_date).toBe(familyToday);
    if (familyToday !== greenwichToday) {
      expect(bySignal.get('m-today')?.target_date).not.toBe(greenwichToday);
    }
    // A member with no birthday contributes no signal.
    expect(bySignal.has('m-none')).toBe(false);
  });

  it('reports the plans it actually wrote', async () => {
    const { result, plans } = await generateFor(c);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.plans).toBe(plans.length);
  });
});

describe('the cases themselves exercise the defect', () => {
  it('names zones whose day differs from Greenwich\'s in BOTH directions', () => {
    const verdicts = CASES.map((c) => {
      const family = familyDayOf(c.now, c.tz);
      const greenwich = new Date(c.now).toISOString().slice(0, 10);
      return family < greenwich ? 'behind' : family > greenwich ? 'ahead' : 'same';
    });
    // A suite that only ever looked from the west could not see the other sign;
    // that is the blind spot this file exists to close.
    expect(verdicts).toContain('behind');
    expect(verdicts).toContain('ahead');
    expect(verdicts).toContain('same');
  });

  it('spans a spring-forward in at least one case', () => {
    const spanning = CASES.filter((c) => {
      const start = familyDayOf(c.now, c.tz);
      return c.tz === 'America/Los_Angeles' && start < '2027-03-14' && plusDays(start, 60) > '2027-03-14';
    });
    expect(spanning.length).toBeGreaterThan(0);
  });
});

/**
 * A HOST-INDEPENDENT detector, and it exists because the first version of this
 * file was not one.
 *
 * Restoring the old birthday path — `nextBirthdayDate(m.birthday, now)` then
 * `.toISOString().slice(0, 10)` — turned the cases above red under
 * TZ=Asia/Tokyo and left them ALL GREEN under TZ=America/Los_Angeles. That is
 * the defect's signature: it is built from the HOST's local parts, so west of
 * Greenwich the re-expression is a no-op and a suite run there sees nothing.
 * A guard that only fails on some machines is not a guard.
 *
 * So this asks the question the host cannot influence: TWO families, in two
 * zones, at ONE instant, where their own days fall in DIFFERENT YEARS. The
 * correct next-birthday differs between them by a whole year. Anything that
 * derives the date from the runtime instead of from `tz` gives both families
 * the SAME answer — whatever the host is — and at most one of them can be
 * right.
 */
describe("a birthday's YEAR follows the family's day, not the host's", () => {
  // 06:00 UTC on New Year's Day. In Tokyo it is 15:00 on 1 January 2027; in
  // Los Angeles it is still 22:00 on 31 December 2026.
  const INSTANT = '2027-01-01T06:00:00Z';
  const NEW_YEARS_EVE = '2015-12-31';

  async function birthdayPlanFor(tz: string) {
    const db = createInMemorySupabase<SupabaseClient<Database>>({
      uniques: { prep_plans: [['family_id', 'signal_kind', 'signal_id']] },
    });
    db.seed('family_members', [{ id: 'm-nye', family_id: 'f1', display_name: 'Ada', birthday: NEW_YEARS_EVE }]);
    await runPrepGeneration(db, 'f1', null, tz, new Date(INSTANT));
    return db.table('prep_plans').find((row) => row.signal_id === 'm-nye');
  }

  it('puts the two families a year apart, because their days are', async () => {
    expect(familyDayOf(INSTANT, 'Asia/Tokyo')).toBe('2027-01-01');
    expect(familyDayOf(INSTANT, 'America/Los_Angeles')).toBe('2026-12-31');

    // Tokyo has already turned the year over, so 31 December is eleven months
    // AHEAD. Los Angeles has not, so it is TODAY.
    expect((await birthdayPlanFor('Asia/Tokyo'))?.target_date).toBe('2027-12-31');
    expect((await birthdayPlanFor('America/Los_Angeles'))?.target_date).toBe('2026-12-31');
  });

  it('makes that a difference in urgency the family would actually notice', async () => {
    // A birthday today is something to act on; one eleven months out is not.
    expect((await birthdayPlanFor('America/Los_Angeles'))?.urgency).toBe('now');
    expect((await birthdayPlanFor('Asia/Tokyo'))?.urgency).toBe('later');
  });
});

describe('the pure engine refuses an instant where a day key belongs', () => {
  it('throws rather than silently generating against half a conversion', () => {
    // A caller that threads the zone into the query bounds and then hands the
    // engine a `now` is the half-conversion this audit has shipped five times.
    // It cannot compile any more, and it cannot limp at runtime either.
    expect(() => generatePrepPlans([], '2026-09-21T06:00:00Z')).toThrow(TypeError);
    expect(() => generatePrepPlans([], String(new Date('2026-09-21T06:00:00Z')))).toThrow(TypeError);
    expect(() => generatePrepPlans([], '')).toThrow(TypeError);
  });

  it('accepts a day key and measures from it', () => {
    const plans = generatePrepPlans([{ id: 's', kind: 'trip', title: 'Trip', date: '2026-09-21' }], '2026-09-21');
    expect(plans[0].daysUntil).toBe(0);
    expect(plans[0].urgency).toBe('now');
  });
});

/**
 * THE CONSUMER, because changing how a day key is PRODUCED without following it
 * to where it is READ is the failure this audit has shipped five times.
 *
 * `prep_plans.target_date` and `prep_plan_steps.due_date` are now the family's
 * days. The client module that renders "in 3 days" / "2 days ago" off them was
 * deriving its own today as `new Date().toISOString().slice(0, 10)` — the day
 * at GREENWICH — so one screen held two different "today": a family-zone target
 * beside a Greenwich now. It takes the zone the page already resolved instead.
 *
 * Comments are stripped before scanning. That is not fastidiousness: the
 * comment in that module explaining the fix QUOTES the exact form it forbids,
 * so a scan that reads comments would count the explanation as the offence and
 * could be "fixed" by deleting the explanation. A guard you can satisfy by
 * removing a comment measures nothing.
 */
/**
 * EVERY CALL SITE, because a required parameter only helps if the tree actually
 * compiles — and this exact conversion was landed with one of the two callers
 * left behind.
 *
 * `runPrepGeneration` has two callers and no others: the on-demand server
 * action and the model-refresh cron. The cases above prove the function answers
 * the family's day; nothing in them looks at whether the callers pass a zone at
 * all, because every case calls the function directly. So the call sites are
 * pinned here by name. There are two of them, they are both one line, and a
 * conversion that reaches only one is the half-conversion this whole file is
 * about — a cron that runs for every household is the worse half to miss.
 *
 * Comments are stripped first, for the same reason as everywhere else here.
 */
describe('both callers hand the zone down, and neither re-reads it', () => {
  const strip = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('the on-demand action passes the zone off the context it already loaded', () => {
    const action = strip(readFileSync('app/(app)/dashboard/prep-plans/prep-actions.ts', 'utf8'));
    expect(action).toContain("runPrepGeneration(sb, ctx.active.familyId, ctx.user.id, ctx.active.family.timezone || 'UTC')");
  });

  it('the cron passes each family\'s own zone, and selects it to have one', () => {
    const cron = strip(readFileSync('app/api/cron/model-refresh/route.ts', 'utf8'));
    // A cron over every family is NOT a reason to fall back to Greenwich: it is
    // the one caller that runs without anybody watching, for every household at
    // once, so a Greenwich "today" here drops a trip departing today for the
    // whole US west coast on every single run.
    expect(cron).toContain("select('id, timezone')");
    expect(cron).toContain("runPrepGeneration(supabase, fam.id, null, fam.timezone || 'UTC', now)");
    expect(cron).not.toMatch(/runPrepGeneration\(supabase, fam\.id, null, now\)/);
  });

  it('names the complete caller set, so a third one cannot appear unnoticed', () => {
    // Both files above are asserted individually; this is the census that says
    // there are exactly those two. A new caller has to be added here, which is
    // the moment somebody decides where ITS zone comes from.
    const roots = ['app', 'lib', 'components'];
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(path)) {
          const source = strip(readFileSync(path, 'utf8'));
          // A caller IMPORTS it and CALLS it. Keyed on the import so the module
          // that defines the function is not counted as one of its callers.
          if (source.includes("from '@/lib/planning/prep-server'") && /\brunPrepGeneration\s*\(/.test(source)) {
            callers.push(path.replaceAll('\\', '/'));
          }
        }
      }
    };
    for (const root of roots) walk(root);
    expect(callers.sort()).toEqual([
      'app/(app)/dashboard/prep-plans/prep-actions.ts',
      'app/api/cron/model-refresh/route.ts',
    ]);
  });
});

describe('the client that renders these day keys counts from the same day', () => {
  const withoutComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Named `moduleSource`, not `module`: @next/next/no-assign-module-variable
  // forbids shadowing `module`, and a lint error in a guard is a guard nobody runs.
  const moduleSource = withoutComments(readFileSync('components/modules/planning-module.tsx', 'utf8'));
  const page = withoutComments(readFileSync('app/(app)/dashboard/prep-plans/page.tsx', 'utf8'));

  it('never derives a day from the browser clock at Greenwich', () => {
    expect(moduleSource).not.toMatch(/toISOString\(\)\s*\.(?:slice\(0,\s*10\)|split\('T'\)\[0\])/);
  });

  it('takes the zone as a required prop rather than defaulting one', () => {
    // Not `tz?: string` and not `tz = 'UTC'`. A default is what let the weekly
    // briefing ship Greenwich weeks for seven weeks: the caller kept compiling.
    expect(moduleSource).toContain('{ tz }: { tz: string }');
    expect(moduleSource).not.toMatch(/tz\?:\s*string/);
    expect(moduleSource).not.toMatch(/tz\s*=\s*['"]/);
    expect(moduleSource).toContain('todayInZone(tz)');
  });

  it('is handed the zone the page already resolved, not a second read', () => {
    expect(page).toContain("const tz = ctx.active.family.timezone || 'UTC';");
    expect(page).toContain('<PlanningModule tz={tz} />');
  });

  // THE ENGINE'S OWN SIGNATURE, guarded for the same reason and added because
  // the guard above did not cover it. Mutation-testing this file found the hole:
  // putting `todayKey: string = new Date().toISOString().slice(0, 10)` back on
  // `generatePrepPlans` left all 52 cases GREEN, because every current caller
  // passes the argument and a default is only reached by a caller that forgets.
  // That is precisely the defect this parameter was made required to prevent —
  // the doc comment on the function calls a default "what let the weekly
  // briefing ship Greenwich weeks for seven weeks" — and nothing was holding it.
  // A property argued for in a comment and checked by nothing is a convention,
  // not a guard.
  const engine = withoutComments(readFileSync('lib/planning/prep.ts', 'utf8'));
  const server = withoutComments(readFileSync('lib/planning/prep-server.ts', 'utf8'));

  it('the engine takes the family day as a required argument, with no default', () => {
    const fn = engine.slice(engine.indexOf('export function generatePrepPlans'));
    const signature = fn.slice(0, fn.indexOf('): PrepPlan[]'));
    expect(signature).toMatch(/\btodayKey:\s*string\b/);
    expect(signature).not.toMatch(/todayKey\?:/);
    expect(signature).not.toMatch(/todayKey[^,)]*=/);
    // and it must not quietly reach for a clock instead
    expect(signature).not.toMatch(/new Date\(\)/);
  });

  it('the engine reads no clock at all, which is what makes its date maths calendar maths', () => {
    // A blunter rule was tried first and was WRONG here: forbidding
    // `toISOString().slice(0, 10)` outright fails prep.ts, which still has
    // `isoDate(due)`. That is not the defect. `due` is `calendarAnchor(s.date)`
    // — a UTC midnight built from a day KEY — minus whole days of milliseconds,
    // and UTC has no DST, so it lands exactly on another UTC midnight and
    // slicing it reads back the day key that went in. A no-op round trip, the
    // same case `lib/sync/providers/google.ts` and `lib/services/documents`
    // are exempted for in the Greenwich-day guard.
    //
    // The defect was never the slice. It is re-expressing an INSTANT as a day.
    // So the precise rule is that no instant may enter: with no clock read, every
    // Date in this module is anchored from a day key, and the round trip cannot
    // be anything but calendar arithmetic. That is stronger than the shape rule
    // AND true, where the shape rule was neither.
    expect(engine).not.toMatch(/new Date\(\s*\)/);
  });

  it('the server half takes the zone required, and only the instant may default', () => {
    const fn = server.slice(server.indexOf('export async function runPrepGeneration'));
    const signature = fn.slice(0, fn.indexOf('): Promise<PrepGenerationResult>'));
    expect(signature).toMatch(/\btz:\s*string\b/);
    expect(signature).not.toMatch(/tz\?:/);
    expect(signature).not.toMatch(/tz[^,)]*=\s*['"]/);
    // `now: Date = new Date()` IS allowed here and the asymmetry is deliberate:
    // something has to read the clock, and an instant is unambiguous wherever it
    // is read. A ZONE is not — defaulting one answers Greenwich in a family's
    // name at every call site that forgets, silently and while compiling.
    expect(server).not.toMatch(/toISOString\(\)\s*\.(?:slice\(0,\s*10\)|split\('T'\)\[0\])/);
  });
});

describe('nextBirthdayDayKey is a calendar answer, not a clock one', () => {
  it('gives the same answer for every host zone because no instant is involved', () => {
    expect(nextBirthdayDayKey('2015-07-05', '2026-07-05')).toBe('2026-07-05');
    expect(nextBirthdayDayKey('2015-07-05', '2026-07-06')).toBe('2027-07-05');
    expect(nextBirthdayDayKey('2015-12-31', '2026-01-01')).toBe('2026-12-31');
  });

  it('normalises 29 February in a common year the way the Date form always has', () => {
    // 2027 is not a leap year; `new Date(2027, 1, 29)` has always rolled to
    // 1 March, and that behaviour is kept deliberately.
    expect(nextBirthdayDayKey('2016-02-29', '2027-01-10')).toBe('2027-03-01');
    expect(nextBirthdayDayKey('2016-02-29', '2028-01-10')).toBe('2028-02-29');
  });

  it('refuses anything that is not a day key', () => {
    expect(nextBirthdayDayKey('2015-07-05', '2026-07-05T00:00:00Z')).toBeNull();
    expect(nextBirthdayDayKey('not-a-date', '2026-07-05')).toBeNull();
  });
});
