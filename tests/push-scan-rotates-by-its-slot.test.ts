// The push scan's start walks the whole ring even when only vercel.json fires.
//
// /api/cron/push-scan is fired every two hours by the dispatcher and once a day,
// at 12:00 UTC, by vercel.json. The pass numbered its rotation by the two-hour
// slot, so the 12:00 run was always index 12d+6, which is 2 mod 4, and the van
// der Corput start of such an index always lies in [N/4, N/2). With the
// dispatcher down and the budget cutting the run short, every run started in
// that one quarter of the ring and the families in the rest of it were never
// reached first. The run is now named the way autopilot-scan and model-refresh
// are (lib/server/cron-slot.ts lastDailySlot, rotateForSlot): the UTC day picks
// the start, the slot moves it on by its share. Driven through the real route
// against the in-memory database; generation is a stand-in that spends the
// budget, so a run reaches only its first wave of four families.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { parseCron, SCHEDULES } from '../scripts/cron-dispatch.mjs';
import { dailySlotsCron, PUSH_SCAN_SLOTS } from '@/lib/server/cron-slot';

const h = vi.hoisted(() => ({ db: null as unknown, generated: [] as string[] }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
// Each generation outlasts the run's 60 s generation budget: the first wave of
// four is all a run starts.
vi.mock('@/lib/server/notifications', () => ({
  generateFamilyNotifications: async (_db: unknown, familyId: string) => {
    h.generated.push(familyId);
    vi.setSystemTime(Date.now() + 61_000);
    return 0;
  },
}));
vi.mock('@/lib/server/push', () => ({
  dispatchPendingPushes: async () => ({ notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } }),
}));
vi.mock('@/lib/services/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/scope')>()),
  systemScopeForFamily: async (_db: unknown, familyId: string) => ({ familyId }),
}));
vi.mock('@/lib/services/tasks', () => ({ respawnMissingChoreAssignments: async () => ({ ok: true, data: { respawned: 0, failed: 0 } }) }));

const { GET } = await import('@/app/api/cron/push-scan/route');

const N = 16;
const ids = Array.from({ length: N }, (_, i) => `family-${String(i).padStart(2, '0')}`);
const req = () => new Request('https://bubaly.test/api/cron/push-scan') as never;

/** One run at `iso`: the families it reached, and where in the ring it started. */
async function runAt(iso: string): Promise<{ reached: string[]; start: number }> {
  h.generated = [];
  vi.setSystemTime(new Date(iso));
  const res = await GET(req());
  // The budget cut the run short: that is the case the rotation is for.
  expect(await res.json()).toMatchObject({ unserved: N - 4 });
  const reached = new Set(h.generated.map((id) => ids.indexOf(id)));
  // A rotation: the reached families are consecutive around the ring, and the
  // start is the one whose predecessor was not reached.
  const start = [...reached].find((i) => !reached.has((i + N - 1) % N));
  if (start === undefined || reached.size !== 4) throw new Error(`not one wave of four: ${[...reached].join(',')}`);
  return { reached: [...h.generated], start };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = createInMemorySupabase({ uniques: { app_settings: [['key']] } });
  db.seed('families', ids.map((id) => ({ id, closed_at: null })));
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('only vercel.json firing: one 12:00 UTC run a day', () => {
  it('consecutive days start once in each quarter of the ring, and eight of them reach every family', async () => {
    const runs = [];
    for (let day = 19; day <= 26; day++) runs.push(await runAt(`2026-10-${day}T12:00:00.000Z`));
    // The defect: every start in [N/4, N/2) — quarter 1, every day.
    expect(runs.slice(0, 4).map((r) => Math.floor(r.start / (N / 4))).sort()).toEqual([0, 1, 2, 3]);
    expect(runs.map((r) => Math.floor(r.start / (N / 8))).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // One start in each eighth leaves no gap wider than a wave of four.
    expect(new Set(runs.flatMap((r) => r.reached)).size, 'families no 12:00 run ever reached').toBe(N);
  });
});

describe('the dispatcher\'s ticks', () => {
  it('a late tick of a slot is that slot: 12:07 starts where 12:00 did', async () => {
    const onTime = await runAt('2026-10-21T12:00:00.000Z');
    expect((await runAt('2026-10-21T12:07:00.000Z')).start).toBe(onTime.start);
  });

  it('the next slot of the day starts a slot\'s share of the ring further on', async () => {
    const noon = await runAt('2026-10-21T12:00:00.000Z');
    const two = await runAt('2026-10-21T14:00:00.000Z');
    expect(two.start).toBe((noon.start + Math.floor(N / PUSH_SCAN_SLOTS.length)) % N);
  });
});

describe('the slots are the schedules', () => {
  it('match the dispatcher\'s two-hourly schedule, and vercel.json fires one of them', () => {
    expect(parseCron(dailySlotsCron(PUSH_SCAN_SLOTS))).toEqual(parseCron((SCHEDULES as Record<string, string>)['/api/cron/push-scan']));
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
    const fired = vercel.crons.find((c) => c.path === '/api/cron/push-scan')?.schedule;
    expect(PUSH_SCAN_SLOTS.map((m) => `${m % 60} ${Math.floor(m / 60)} * * *`)).toContain(fired);
  });
});
