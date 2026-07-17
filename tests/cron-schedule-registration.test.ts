import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A cron *route* is only half of a scheduled job — the other half is an entry in
// vercel.json `crons`. If they drift, features fail SILENTLY in prod:
//   - a route on disk with no schedule  -> the job never fires (dead reminder/digest)
//   - a schedule with no route on disk  -> Vercel hits a 404 on every tick
// This guard keeps the two in exact 1:1 correspondence so neither can happen
// unnoticed. (Pairs with tests/cron-auth.test.ts, which proves each route is gated.)

type Cron = { path: string; schedule: string };

const crons: Cron[] = (JSON.parse(readFileSync('vercel.json', 'utf8')).crons ?? []) as Cron[];

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
