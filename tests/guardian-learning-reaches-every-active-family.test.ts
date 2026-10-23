// Guardian learning reaches every family with activity, however many calls
// and texts the platform screens.
//
// /api/cron/guardian-learning found its families by reading one row per
// guardian_communication of the last 60 days through readAll with `max: 5000`
// — and readAll reports its ceiling as an error, by design. Past 5,000 screened
// calls and texts in the window (about 83 a day platform-wide) the read errored,
// the throw answered 500, and the nightly learning job was down for every
// family until rows aged out. Below the cap, the serial loop under maxDuration
// 60 had no time check, so a kill mid-loop left the same families unlearned
// every night.
//
// The route now reads DISTINCT families with a skip-scan whose cost is the
// number of active households, and runs them rotated, bounded and budgeted,
// reporting an unreached tail as a failure. Behavioural, against the in-memory
// database with the server's row cap in place.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  learned: [] as string[],
  /** Each family's learning moves the clock this far: how a run outgrows its budget. */
  learningTakesMs: 0,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/guardian/learning-run', () => ({
  runLearningForFamily: async (_db: unknown, familyId: string) => {
    h.learned.push(familyId);
    if (h.learningTakesMs) vi.setSystemTime(Date.now() + h.learningTakesMs);
    return { analyzed: 1, created: 1, skipped: 0 };
  },
}));

const { GET } = await import('@/app/api/cron/guardian-learning/route');

const NOW = new Date('2026-10-20T02:00:00.000Z');
/** PostgREST's default ceiling on one response. */
const DB_MAX_ROWS = 1000;
let db: InMemorySupabase;
const req = () => new Request('https://bubaly.test/api/cron/guardian-learning') as never;
const families = (n: number) => Array.from({ length: n }, (_, i) => `fam-${String(i).padStart(2, '0')}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.learned = []; h.learningTakesMs = 0;
  db = createInMemorySupabase({ maxRows: DB_MAX_ROWS });
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('more than 5,000 screened communications in the window', () => {
  it('is an ordinary night: every active open family is learned for, and the run is 200', async () => {
    const active = families(3);
    db.seed('families', [...active.map((id) => ({ id, closed_at: null })), { id: 'fam-closed', closed_at: '2026-09-01T00:00:00.000Z' }]);
    const recent = '2026-10-10T12:00:00.000Z';
    for (const familyId of [...active, 'fam-closed']) {
      db.seed('guardian_communications', Array.from({ length: 1_600 }, (_, i) => ({
        id: `${familyId}-gc-${String(i).padStart(5, '0')}`, family_id: familyId, started_at: recent,
      })));
    }
    // Before the window: not an active family.
    db.seed('guardian_communications', [{ id: 'old-gc', family_id: 'fam-old', started_at: '2026-07-01T00:00:00.000Z' }]);
    db.seed('families', [{ id: 'fam-old', closed_at: null }]);

    const res = await GET(req());
    expect(res.status, 'the nightly run 500s once the platform logs more than 5,000 communications').toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, families: 3, suggestionsCreated: 3, failed: 0, unreached: 0 });
    expect([...h.learned].sort()).toEqual(active);
  });
});

describe('a pass that outgrows its budget', () => {
  it('stops starting families, counts the tail as a failure and answers 502', async () => {
    const active = families(6);
    db.seed('families', active.map((id) => ({ id, closed_at: null })));
    db.seed('guardian_communications', active.map((familyId) => ({ id: `${familyId}-gc`, family_id: familyId, started_at: '2026-10-10T12:00:00.000Z' })));
    h.learningTakesMs = 15_000; // three families spend the budget

    const res = await GET(req());
    expect(res.status, 'an unreached tail looked like a clean run').toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, families: 6, unreached: 3, failed: 3 });
    expect(h.learned).toHaveLength(3);
  });

  it('rotates where it starts, so the same families are not the unreached ones every night', async () => {
    const active = families(6);
    db.seed('families', active.map((id) => ({ id, closed_at: null })));
    db.seed('guardian_communications', active.map((familyId) => ({ id: `${familyId}-gc`, family_id: familyId, started_at: '2026-10-10T12:00:00.000Z' })));
    h.learningTakesMs = 15_000;
    await GET(req());
    const tonight = [...h.learned].sort();
    h.learned = [];
    vi.setSystemTime(new Date('2026-10-21T02:00:00.000Z'));
    await GET(req());
    expect([...h.learned].sort()).not.toEqual(tonight);
  });
});
