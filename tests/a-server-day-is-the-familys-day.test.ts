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
 * There were two larger groups here: relative-day helpers shared with the
 * client (dueLabel, daysUntil and friends) and four AI daily-quota buckets.
 * Both moved to family day keys on the audit branch before it met main, so the
 * three that remain are each deliberate for the reason given on its line.
 */
const DECLARED: Record<string, string> = {
  // ── one half of an explicit LOCAL/UTC pair, and a history bucketer ───────
  'lib/capture/parse.ts': 'LOCAL_OPS, one half of an explicit LOCAL/UTC ops pair the caller chooses between (opsFor). Deliberate, and named.',
  'lib/routines/detect.ts': 'day bucketing while detecting a repeating routine from history.',
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
    // A `'use client'` file runs in the browser. It used to be assumed that the
    // host IS the family there; the owner decided otherwise (TIME-003), and
    // client files are now held to the family's clock by
    // tests/a-client-clock-reads-the-familys-zone.test.ts, not here.
    (/^\s*['"]use client['"]/m.test(raw) ? client : server).push(file.split('\\').join('/'));
  }
  return { client, server };
}

describe('a day boundary computed on the server is the family\'s day', () => {
  const { client, server } = scan();

  it('finds both kinds of file (non-vacuity)', () => {
    // A scan that silently stopped matching would satisfy every case below.
    // It is proved on the server side, which is what this file governs: the
    // client count is falling to zero on purpose (TIME-003).
    // Three, not more: the relative-day helpers and the four AI quota buckets
    // that were declared here moved to family day keys on the audit branch
    // (tests/server-midnight-is-not-the-familys-midnight.test.ts tracks the
    // same set), and came off this list when the two met on main.
    expect(server.length).toBeGreaterThanOrEqual(3);
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
