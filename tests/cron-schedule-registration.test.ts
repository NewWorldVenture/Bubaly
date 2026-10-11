import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A cron *route* is only half of a scheduled job — the other half is an entry in
// vercel.json `crons`. If they drift, features fail SILENTLY in prod:
//   - a route on disk with no schedule  -> the job never fires (dead reminder/digest)
//   - a schedule with no route on disk  -> Vercel hits a 404 on every tick
// This guard keeps the two in exact 1:1 correspondence so neither can happen
// unnoticed. (Pairs with tests/cron-auth.test.ts, which proves each route is gated.)
//
// A route can also be HELD: moved out of app/api/cron into held/, which Next
// does not route, so no deployment exposes it and no schedule may name it. The
// 1:1 rule above stays exact — a held route is not on disk under app/ — and the
// hold is listed by name with a reason (HELD_UNSCHEDULED) and checked in both
// directions below, so the list cannot go stale and cannot quietly become a
// licence.

type Cron = { path: string; schedule: string };

const crons: Cron[] = (JSON.parse(readFileSync('vercel.json', 'utf8')).crons ?? []) as Cron[];
const dispatcher = readFileSync('scripts/cron-dispatch.mjs', 'utf8');

/** Routes held out of the deployable tree on purpose: where each sits, and why. */
const HELD_UNSCHEDULED: Record<string, { heldAt: string; reason: string }> = {
  '/api/cron/location-retention': {
    heldAt: 'held/api/cron/location-retention/route.ts',
    // The route deletes location_events older than a window and clears
    // coordinates. A destructive retention sweep must not be reachable from the
    // deployable candidate until the owner sets a retention policy, so the file
    // is out of app/ and out of both vercel.json and scripts/cron-dispatch.mjs.
    // Pinned from the route's side in
    // tests/a-removed-member-takes-their-location-with-them.test.ts.
    reason: 'held, unscheduled pending a retention decision',
  },
};

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
    const unscheduled = diskPaths.filter((p) => !scheduledPaths.includes(p));
    expect(unscheduled, `cron routes with no schedule (never fire): ${unscheduled.join(', ')}`).toEqual([]);
  });

  it('a held route is out of app/api/cron, present under held/, in neither scheduler, and says why', () => {
    for (const [path, { heldAt, reason }] of Object.entries(HELD_UNSCHEDULED)) {
      expect(diskPaths, `${path} is back in app/api/cron, so it deploys; schedule it and drop it from HELD_UNSCHEDULED, or move it to held/ again`)
        .not.toContain(path);
      expect(heldAt.startsWith('held/'), `${heldAt} is not under held/, the one place Next does not route`).toBe(true);
      expect(existsSync(heldAt), `${heldAt} is missing; the hold has lost its route, fix or drop the entry`).toBe(true);
      expect(scheduledPaths, `${path} is in vercel.json but its route is held; Vercel would 404 every run`).not.toContain(path);
      expect(dispatcher, `${path} is in the dispatcher table but its route is held`)
        .not.toMatch(new RegExp(`'${path.replace(/\//g, '\\/')}':\\s*'`));
      expect(readFileSync(heldAt, 'utf8'), `${heldAt} must stay gated, so a restore cannot ship it open`).toContain('if (!hasCronAuthorization');
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
