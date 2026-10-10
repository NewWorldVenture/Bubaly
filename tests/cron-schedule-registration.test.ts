import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A cron *route* is only half of a scheduled job — the other half is an entry in
// vercel.json `crons`. If they drift, features fail SILENTLY in prod:
//   - a route on disk with no schedule  -> the job never fires (dead reminder/digest)
//   - a schedule with no route on disk  -> Vercel hits a 404 on every tick
// This guard keeps the two in exact 1:1 correspondence so neither can happen
// unnoticed. (Pairs with tests/cron-auth.test.ts, which proves each route is gated.)
//
// One kind of exception is allowed, by name and with a reason: a route held off
// every schedule on purpose (HELD_UNSCHEDULED). The hold is checked in both
// directions — the route must still exist and must really be unscheduled — so
// the list cannot go stale and cannot quietly become a licence.

type Cron = { path: string; schedule: string };

const crons: Cron[] = (JSON.parse(readFileSync('vercel.json', 'utf8')).crons ?? []) as Cron[];
const dispatcher = readFileSync('scripts/cron-dispatch.mjs', 'utf8');

/** Routes on disk that are deliberately not scheduled anywhere, each with why. */
const HELD_UNSCHEDULED: Record<string, string> = {
  // The route deletes location_events older than a window and clears
  // coordinates. A destructive retention sweep must not run from the deployable
  // candidate until the owner sets a retention policy, so neither vercel.json
  // nor scripts/cron-dispatch.mjs carries it; it stays reachable only by hand
  // with CRON_SECRET. Pinned from the route's side in
  // tests/a-removed-member-takes-their-location-with-them.test.ts.
  '/api/cron/location-retention': 'held, unscheduled pending a retention decision',
};
const heldPaths = new Set(Object.keys(HELD_UNSCHEDULED));

const scheduledPaths = crons.map((c) => c.path).sort();
const diskPaths = readdirSync('app/api/cron', { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `/api/cron/${e.name}`)
  .sort();

describe('cron route ↔ schedule registration', () => {
  it('has schedules (config is not empty)', () => {
    expect(crons.length).toBeGreaterThanOrEqual(19);
  });

  it('every cron route on disk is scheduled in vercel.json (no dead jobs)', () => {
    const unscheduled = diskPaths.filter((p) => !scheduledPaths.includes(p) && !heldPaths.has(p));
    expect(unscheduled, `cron routes with no schedule (never fire): ${unscheduled.join(', ')}`).toEqual([]);
  });

  it('a held route is on disk, in neither scheduler, and says why', () => {
    for (const [path, reason] of Object.entries(HELD_UNSCHEDULED)) {
      expect(diskPaths, `${path} is held but no longer exists; drop it from HELD_UNSCHEDULED`).toContain(path);
      expect(scheduledPaths, `${path} is in vercel.json; it is no longer held, drop it from HELD_UNSCHEDULED`).not.toContain(path);
      expect(dispatcher, `${path} is in the dispatcher table; it is no longer held, drop it from HELD_UNSCHEDULED`)
        .not.toMatch(new RegExp(`'${path.replace(/\//g, '\\/')}':\\s*'`));
      expect(reason, `${path} must name the decision it waits on`).toMatch(/pending .* decision/);
    }
  });

  it('every scheduled path maps to a real route on disk (no 404 ticks)', () => {
    const orphaned = scheduledPaths.filter((p) => !diskPaths.includes(p));
    expect(orphaned, `schedules with no route (404 every run): ${orphaned.join(', ')}`).toEqual([]);
  });

  it('every schedule is a well-formed 5-field cron expression', () => {
    const malformed = crons.filter((c) => (c.schedule ?? '').trim().split(/\s+/).length !== 5);
    expect(malformed.map((c) => c.path), 'malformed cron expressions').toEqual([]);
  });

  it('no duplicate scheduled paths', () => {
    expect(scheduledPaths.length).toBe(new Set(scheduledPaths).size);
  });
});
