import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `new Date(); d.setHours(0, 0, 0, 0)` means midnight WHERE THE PROCESS RUNS.
//
// In a browser that is right: the browser is the family. On a server it is the
// host's zone, so on a UTC deployment a Californian family's "today" runs 17:00
// to 17:00 — last night's events on this morning's list, tonight's missing from
// it (F-017, and F-F02 when the same bug was found still live afterwards).
//
// This is a DECLARATION, not a ban. Every remaining server-side occurrence is
// listed below with the reason it is still there, so the list is a claim a
// reviewer can check rather than a number nobody can interpret. Two things
// follow: a NEW one fails on the next run, and removing one fails too, which is
// the moment to delete its line here.
const SET_HOURS_MIDNIGHT = /\.setHours\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/;

/**
 * Server-side files that still compute a day boundary in the host's zone.
 *
 * The first group is pure relative-day arithmetic: each takes `now` as a
 * parameter, subtracts two midnights and answers a whole number of days, and
 * each is shared with client components where the host IS the family. The
 * correction for those belongs at the server call sites that hand them a
 * host-zone `now` — changing the helper would break every browser caller.
 *
 * The second group is a daily rate-limit bucket, where "today" decides when an
 * AI quota resets. Moving it to the family's zone is a quota-behaviour change
 * rather than a display correction, so it is a decision, not a fix.
 */
const DECLARED: Record<string, string> = {
  // ── relative-day helpers, parameterised on `now`, shared with the client ──
  'lib/chores/dashboard.ts': 'dueLabel: subtracts two midnights for Overdue/Today/Tomorrow; both sides share a zone, so the difference is stable. Fix belongs at the server callers.',
  'lib/marketplace/returns.ts': 'daysUntilDue: whole-day difference to a return date. Same shape.',
  'lib/pantry/logic.ts': 'daysUntil: whole-day difference to a best-by date. Same shape.',
  'lib/relationship/dates.ts': 'whole-day difference to an anniversary. Same shape.',
  'lib/routines/detect.ts': 'day bucketing while detecting a repeating routine from history.',
  'lib/family/signals.ts': 'day bucketing for signal windows.',
  'lib/home/home-data.ts': 'the home surface\'s day window.',
  'lib/calendar/scheduling.ts': 'free-slot search: day bounds for the gaps it proposes.',
  'lib/capture/parse.ts': 'LOCAL_OPS, one half of an explicit LOCAL/UTC ops pair the caller chooses between (opsFor). Deliberate, and named.',
  // ── a daily quota bucket, not a display of a day ─────────────────────────
  'app/api/ai/invest/route.ts': 'start of the day an AI daily limit counts from.',
  'app/api/ai/relationship/route.ts': 'start of the day an AI daily limit counts from.',
  'app/api/ai/wallet/route.ts': 'start of the day an AI daily limit counts from.',
  'app/api/ai/wallet/child/[childId]/route.ts': 'start of the day an AI daily limit counts from.',
  // ── the replacement's own fallback ───────────────────────────────────────
  'lib/time/zoned.ts': 'startOfLocalDay\'s fallback for an unusable zone — it must land exactly on the old behaviour rather than throw.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !full.includes('.test.')) out.push(full);
  }
  return out;
}

const blankComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

function scan() {
  const client: string[] = [];
  const server: string[] = [];
  for (const file of [...walk('app'), ...walk('lib'), ...walk('components')]) {
    const raw = readFileSync(file, 'utf8');
    if (!SET_HOURS_MIDNIGHT.test(blankComments(raw))) continue;
    // A `'use client'` file runs in the browser, where the host IS the family.
    (/^\s*['"]use client['"]/m.test(raw) ? client : server).push(file.split('\\').join('/'));
  }
  return { client, server };
}

describe('a day boundary computed on the server is the family\'s day', () => {
  const { client, server } = scan();

  it('finds both kinds of file (non-vacuity)', () => {
    // A scan that silently stopped matching would satisfy every case below.
    expect(client.length).toBeGreaterThan(4);
    expect(server.length).toBeGreaterThan(4);
  });

  it('has no undeclared server-side host-zone day boundary', () => {
    const undeclared = server.filter((f) => !(f in DECLARED));
    expect(
      undeclared,
      'These compute midnight where the PROCESS runs, which on a UTC host is not the family\'s day.\n'
      + 'Use startOfLocalDay / startOfNextLocalDay from lib/time/zoned.ts with the family timezone,\n'
      + 'or add the file to DECLARED above with the reason it is correct as it stands:\n'
      + undeclared.join('\n'),
    ).toEqual([]);
  });

  it('has no stale declaration', () => {
    const stale = Object.keys(DECLARED).filter((f) => !server.includes(f));
    expect(
      stale,
      'Declared as still using a host-zone day, but no longer does. Delete these lines — the list is\n'
      + 'only worth reading if it is exactly the set:\n' + stale.join('\n'),
    ).toEqual([]);
  });

  it('keeps the surfaces that were fixed on the family\'s day', () => {
    // Named individually, because these are the ones a refactor would quietly
    // put back: each decides what a person is told "today" means.
    for (const file of [
      'app/(app)/kids/page.tsx',
      'app/(app)/guardian/page.tsx',
      'app/(app)/dashboard/moments/page.tsx',
      'components/dashboard/family-dashboard.tsx',
      'components/dashboard/personal-dashboard.tsx',
    ]) {
      const src = blankComments(readFileSync(file, 'utf8'));
      expect(SET_HOURS_MIDNIGHT.test(src), `${file} is back on the host's midnight`).toBe(false);
      expect(src, `${file} does not read the family timezone`).toMatch(/family\.timezone/);
    }
    // The notification copy F-F02 names: the day AND the clock in one zone.
    const notifications = blankComments(readFileSync('lib/server/notifications.ts', 'utf8'));
    expect(notifications).toMatch(/function timeLabel\(iso: string, tz: string/);
    expect(notifications).not.toMatch(/toLocaleTimeString\('en-US', \{ hour: 'numeric', minute: '2-digit' \}\)/);
  });
});
