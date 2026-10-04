import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { buildPantryChefPrompt } from '@/lib/meals/pantry-chef';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { bodyOf } from './helpers/source-order';

/**
 * A SERVER-SIDE LABEL READS THE FAMILY'S CLOCK, NOT THE HOST'S.
 *
 * `toLocaleDateString` / `toLocaleTimeString` / `toLocaleString` with no
 * `timeZone` render in the zone of the machine running the code. In a browser
 * that is the person's own clock and is right. On a server it is the host's,
 * and this repository's servers are not where its families live. Nine sites
 * in server-reachable code still did it:
 *
 *  - the notification engine's document body ("Expires Oct 7" about a passport
 *    expiring on the 8th — `documents.expires_at` is a DATE, UTC midnight when
 *    parsed, rendered on a US host as the day before);
 *  - the conflict resolver's two event descriptions, the chef's busy evenings
 *    (`getHours() >= 16` on the host — a 6pm Californian practice was 1am and
 *    never busy), the flyer's and Magic Import's "Today is" and item summaries,
 *    the weekly brief's "generated" stamp, the fridge chef's "Today is";
 *  - the admin digest's date label (no family: now explicitly UTC, so the
 *    subject does not depend on which host ran the cron).
 *
 * The flyer went one step further: its INSTANTS were built on the host's clock
 * (`new Date('2026-10-08T18:00:00')`), so the event itself landed at the wrong
 * hour; it now resolves the family's wall time with `instantForLocalTime`.
 *
 * The scan at the end is a ratchet over server-reachable roots: a Date render
 * without a zone is a failure, so the class does not come back one site at a
 * time. Client components have their own guard
 * (tests/a-client-clock-reads-the-familys-zone.test.ts).
 */

type DB = SupabaseClient<Database>;
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const FAMILY = 'fam-clock';

describe('the engine names a document\'s expiry as the date it is', () => {
  let db: ReturnType<typeof createInMemorySupabase<DB>>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-10-03T08:00:00.000Z');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db = createInMemorySupabase<DB>();
    db.seed('families', [{ id: FAMILY, timezone: 'America/Los_Angeles' }]);
    db.seed('family_members', [{ id: 'm-parent', family_id: FAMILY, user_id: 'u-parent', role: 'parent', is_active: true, display_name: 'Parent', birthday: null }]);
    db.seed('documents', [{ id: 'doc-1', family_id: FAMILY, title: 'Passport', expires_at: '2026-10-08', is_secure: false, category: 'identity' }]);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('says Oct 8 about a passport that expires on the 8th, whatever zone the host runs in', async () => {
    expect(await generateFamilyNotifications(db as unknown as DB, FAMILY)).toBe(1);
    const [row] = db.table('notifications').filter((n) => n.related_type === 'documents');
    expect(row.body).toBe('Expires Oct 8');
  });
});

describe('the fridge chef\'s "today" is the family\'s', () => {
  // 03:00Z on Saturday the 3rd is still Friday evening in California.
  const now = new Date('2026-10-03T03:00:00.000Z');
  it('names the family\'s weekday and date', () => {
    expect(buildPantryChefPrompt([], now, 'America/Los_Angeles')).toContain('Today is Friday, October 2.');
    expect(buildPantryChefPrompt([], now, 'UTC')).toContain('Today is Saturday, October 3.');
  });
});

describe('each repaired site carries the zone', () => {
  it('the conflict resolver describes both events in the family\'s zone', () => {
    const src = read('app/api/ai/resolve-conflict/route.ts');
    const fmt = bodyOf(src, 'function fmt(e: EventLite, tz: string): string {', "const where = e.location");
    expect(fmt.match(/timeZone: tz/g)).toHaveLength(2);
    expect(src).toContain("const tz = ctx.active.family.timezone || 'UTC';");
    expect(src).toContain('fmt(a, tz)');
    expect(src).toContain('fmt(b, tz)');
  });
  it('the chef counts busy evenings on the family\'s clock', () => {
    const src = read('app/api/ai/chef/route.ts');
    expect(src).toContain('hourInTz(new Date(e.starts_at), tz) >= 16');
    expect(src).not.toContain('new Date(e.starts_at).getHours()');
    expect(src).toContain("{ weekday: 'short', timeZone: tz }");
  });
  it('the flyer builds the family\'s instants and labels them in its zone', () => {
    const src = read('app/api/ai/flyer/route.ts');
    const toIso = bodyOf(src, 'function toIso(date: string, time: string | null, tz: string)', 'allDay: !time };');
    expect(toIso).toContain('instantForLocalTime(');
    expect(toIso).not.toContain('new Date(`${date}');
    expect(src).toContain('toIso(date, textOrNull(r.time), tz)');
    expect(src).toContain('fmtSummary(r.title as string, iso, allDay, location, tz)');
    expect(src).toContain("weekday: 'short', month: 'short', day: 'numeric', timeZone: tz,");
  });
  it('Magic Import summarises and dates in the family\'s zone', () => {
    const src = read('app/api/ai/import/route.ts');
    expect(src).toContain("...(hasTime ? { hour: 'numeric', minute: '2-digit', timeZone: tz } : { timeZone: 'UTC' })");
    expect(src).toContain('summary: summarize(c.name, c.args, tz)');
    expect(src).toContain('frontDeskItem(text, now, tz)');
    expect(src).toContain('(${dayKeyInTz(now, tz)})');
    expect(src).not.toContain('now.toISOString().slice(0, 10)');
  });
  it('the weekly brief stamps its generation in the family\'s zone', () => {
    expect(read('app/api/ai/weekly-briefing/route.ts')).toContain("(generated ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz })})");
  });
  it('the admin digest names its day in an explicit zone', () => {
    expect(read('app/api/cron/admin-digest/route.ts')).toContain("{ month: 'short', day: 'numeric', timeZone: 'UTC' }");
  });
});

// ── The ratchet ─────────────────────────────────────────────────────────────
// Server-reachable roots. `lib/marketplace/handoff.ts` renders `meetSummary`
// for a CLIENT panel only and is outside these roots on purpose.
const ROOTS = ['app/api', 'lib/server', 'lib/notifications', 'lib/meals', 'lib/briefing', 'lib/admin'];
const DATE_RENDER = /\.toLocale(?:Date|Time)?String\(\s*(?:'[^']*'|undefined|[A-Za-z_.]+)\s*,\s*\{/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [full] : [];
  });
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('no server-reachable Date render is left to the host\'s zone', () => {
  it('every toLocale*String call with date/time options names a timeZone', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(ROOT, root))) {
        const src = stripComments(readFileSync(file, 'utf8'));
        for (const m of src.matchAll(DATE_RENDER)) {
          // The option object: from the brace to its matching close.
          let depth = 0; let end = m.index! + m[0].length - 1;
          for (; end < src.length; end += 1) {
            if (src[end] === '{') depth += 1;
            else if (src[end] === '}') { depth -= 1; if (depth === 0) break; }
          }
          const options = src.slice(m.index!, end + 1);
          if (!/weekday|month|day|hour|minute|dateStyle|timeStyle/.test(options)) continue; // a number format
          if (!/timeZone\s*:/.test(options)) offenders.push(`${file.slice(ROOT.length + 1)}: ${options.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }
    expect(offenders, 'pass the family zone (ctx.active.family.timezone, scope.tz) or an explicit UTC for a date-only value').toEqual([]);
  });
});
