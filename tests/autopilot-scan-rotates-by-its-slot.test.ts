// The Autopilot cron's second run of the day scans a new slice, not the first
// run's prefix again.
//
// vercel.json fires /api/cron/autopilot-scan at 06:30 and the dispatcher at
// 06:30 and 18:30 (it catches up sub-daily slots). The pass rotated its start by
// the UTC day alone, so both runs of a day started at the same family and, cut
// off by the same 40 s budget, the 18:30 run re-scanned what 06:30 had just
// scanned. The day still picks the start (so the 06:30 run alone walks the whole
// rotation); the 18:30 run starts half the ring further on. Driven through the
// real route against the in-memory database; the scan itself is a stand-in.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { SCHEDULES } from '../scripts/cron-dispatch.mjs';
import { AUTOPILOT_SCAN_SLOTS, dailySlotsCron } from '@/lib/server/cron-slot';

const h = vi.hoisted(() => ({ db: null as unknown, scanned: [] as string[] }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/feature-entitlement', () => ({
  getFeatureTiersByHref: async () => ({}),
  resolveFeatureEntitlement: async () => ({ allowed: true }),
}));
// Every scan takes 20 s of the function's 60, so a run reaches two families.
vi.mock('@/lib/autopilot/scan', () => ({
  runAutopilotScan: async (_db: unknown, familyId: string) => {
    h.scanned.push(familyId);
    vi.setSystemTime(Date.now() + 20_000);
    return { scanned: 1, autoExecuted: 0, notified: 0, policyCandidates: 0, cleared: 0 };
  },
}));

const { GET } = await import('@/app/api/cron/autopilot-scan/route');

const ids = Array.from({ length: 12 }, (_, i) => `family-${String(i).padStart(2, '0')}`);
const req = () => new Request('https://bubaly.test/api/cron/autopilot-scan') as never;

async function runAt(iso: string): Promise<string[]> {
  h.scanned = [];
  vi.setSystemTime(new Date(iso));
  await GET(req());
  return [...h.scanned];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = createInMemorySupabase();
  db.seed('families', ids.map((id) => ({ id, timezone: 'UTC', closed_at: null })));
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('two runs on one UTC day', () => {
  it('the 18:30 run starts half the ring past the 06:30 run and scans different families', async () => {
    const morning = await runAt('2026-10-21T06:30:00.000Z');
    const evening = await runAt('2026-10-21T18:30:00.000Z');
    expect(morning.length).toBeGreaterThan(0);
    expect(morning.length).toBeLessThan(ids.length);
    expect(evening[0], 'both runs of the day started at the same family').toBe(ids[(ids.indexOf(morning[0]) + ids.length / 2) % ids.length]);
    expect(evening.filter((id) => morning.includes(id))).toEqual([]);
  });

  it('a late tick of a slot is that slot: 07:00 is the 06:30 run, 00:30 the next day is the 18:30 run', async () => {
    const morning = await runAt('2026-10-21T06:30:00.000Z');
    expect((await runAt('2026-10-21T07:00:00.000Z'))[0]).toBe(morning[0]);
    const evening = await runAt('2026-10-21T18:30:00.000Z');
    expect((await runAt('2026-10-22T00:30:00.000Z'))[0]).toBe(evening[0]);
  });

  it('a new day starts somewhere new (the day, not the slot, drives the rotation)', async () => {
    const monday = await runAt('2026-10-19T06:30:00.000Z');
    const tuesday = await runAt('2026-10-20T06:30:00.000Z');
    expect(tuesday[0]).not.toBe(monday[0]);
  });
});

describe('the slots are the schedules', () => {
  it('match the dispatcher, and vercel.json fires the first of them', () => {
    expect(dailySlotsCron(AUTOPILOT_SCAN_SLOTS)).toBe((SCHEDULES as Record<string, string>)['/api/cron/autopilot-scan']);
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
    const first = AUTOPILOT_SCAN_SLOTS[0];
    expect(vercel.crons.find((c) => c.path === '/api/cron/autopilot-scan')?.schedule).toBe(`${first % 60} ${Math.floor(first / 60)} * * *`);
  });
});
