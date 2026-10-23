// The model-refresh cron answers inside its function limit and does not serve
// the same prefix on every run.
//
// It refreshed every stale family (and with a six-hour TTL against runs twelve
// hours apart, that is nearly every family) one at a time, three serial
// multi-query passes each, inside maxDuration 60, with no clock and no
// per-family bound. A hung read held the loop until the platform killed the
// function: no response, and every family after it in id order unrefreshed,
// run after run. Now it is budgeted, bounded per family and rotated by its
// slot (lib/server/cron-family-sweep.ts, lib/server/cron-slot.ts), and an
// unreached or timed-out family fails the run. Driven through the real route
// against the in-memory database; only the three refresh passes are stand-ins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { SCHEDULES } from '../scripts/cron-dispatch.mjs';
import { dailySlotsCron, MODEL_REFRESH_SLOTS } from '@/lib/server/cron-slot';

const h = vi.hoisted(() => ({
  db: null as unknown,
  refreshed: [] as string[],
  /** Each family's twin pass moves the clock this far: how a run outgrows its budget. */
  takesMs: 0,
  /** A family whose twin pass never answers. */
  hangs: null as string | null,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/twin/project-server', () => ({
  runTwinProjection: async (_db: unknown, familyId: string) => {
    h.refreshed.push(familyId);
    if (familyId === h.hangs) await new Promise(() => {});
    if (h.takesMs) vi.setSystemTime(Date.now() + h.takesMs);
    return { ok: true, entities: 1, edges: 1 };
  },
}));
vi.mock('@/lib/planning/prep-server', () => ({ runPrepGeneration: async () => ({ ok: true, plans: 0 }) }));
vi.mock('@/lib/intelligence/hard-signals-server', () => ({ runSignalDetection: async () => ({}) }));

const { GET } = await import('@/app/api/cron/model-refresh/route');

const ids = Array.from({ length: 8 }, (_, i) => `fam-${i}`);
let db: InMemorySupabase;
const req = () => new Request('https://bubaly.test/api/cron/model-refresh') as never;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-10-20T04:00:00.000Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.refreshed = []; h.takesMs = 0; h.hangs = null;
  db = createInMemorySupabase({ uniques: { family_model_dirty: [['family_id']] } });
  h.db = db;
  db.seed('families', ids.map((id) => ({ id, timezone: 'UTC', closed_at: null })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a family whose refresh never answers', () => {
  it('is that family\'s failure: the run still answers, and the rest are refreshed', async () => {
    h.hangs = 'fam-3';
    let answered = false;
    const pending = GET(req()).then((res) => { answered = true; return res; });
    await vi.advanceTimersByTimeAsync(13_000);
    expect(answered, 'the serial loop waited on the hung read until the platform killed the function').toBe(true);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, families: 8, refreshed: 7, failures: 1, timedOut: 1, unreached: 0 });
    expect(new Set(h.refreshed)).toEqual(new Set(ids));
  });
});

describe('a run that outgrows its budget', () => {
  it('stops starting families, and counts the ones it never reached as failures', async () => {
    h.takesMs = 15_000;
    const res = await GET(req());
    const body = await res.json();
    expect(res.status, 'the serial loop ran every family past the function limit and answered 200').toBe(502);
    expect(body.unreached).toBeGreaterThan(0);
    expect(body).toMatchObject({ ok: false, families: 8 });
    expect(body.refreshed + body.unreached).toBe(8);
    expect(body.failures).toBe(body.unreached);
  });

  it('starts the 16:00 run half the ring past the 04:00 run, so the two serve different families', async () => {
    h.takesMs = 15_000;
    await GET(req());
    const morning = [...h.refreshed];
    h.refreshed = [];
    vi.setSystemTime(new Date('2026-10-20T16:00:00.000Z'));
    await GET(req());
    const evening = [...h.refreshed];
    expect(morning.length).toBeGreaterThan(0);
    expect(morning.length).toBeLessThan(ids.length);
    expect(evening[0]).toBe(ids[(ids.indexOf(morning[0]) + ids.length / 2) % ids.length]);
    expect(evening.filter((id) => morning.includes(id)), 'the second run of the day re-served the first run\'s prefix').toEqual([]);
  });

  it('a slot caught up after midnight is still that slot, not the next day\'s first run', async () => {
    h.takesMs = 15_000;
    vi.setSystemTime(new Date('2026-10-20T16:00:00.000Z'));
    await GET(req());
    const slot = [...h.refreshed];
    h.refreshed = [];
    vi.setSystemTime(new Date('2026-10-21T00:30:00.000Z'));
    await GET(req());
    expect(h.refreshed[0]).toBe(slot[0]);
  });

  it('names the slots the dispatcher schedules', () => {
    expect(dailySlotsCron(MODEL_REFRESH_SLOTS)).toBe((SCHEDULES as Record<string, string>)['/api/cron/model-refresh']);
  });
});
