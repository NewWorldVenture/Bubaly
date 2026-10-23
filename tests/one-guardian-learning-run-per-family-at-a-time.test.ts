// One Guardian learning run per family at a time.
//
// runLearningForFamily dedupes by reading the family's suggestion history and
// inserting each draft it did not find, and guardian_suggestions has no unique
// key to refuse a second writer. Two runs for one family inside that span (the
// nightly cron and the dispatcher's mirrored tick, two managers pressing "Scan
// for tips", one pressing it during the sweep) both read "not suggested yet"
// and both inserted: the parent's queue held every suggestion twice.
//
// Both paths now run under the family's learning lease. Driven through the real
// cron route, the real server action and the real learning run against the
// in-memory database, whose app_settings key is unique as the table's is.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { REPEAT_SCAM_THRESHOLD } from '@/lib/guardian/learning';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'u-parent' }, active: { familyId: FAMILY, role: 'parent', member: { id: 'm-parent' } } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { GET } = await import('@/app/api/cron/guardian-learning/route');
const { generateGuardianSuggestionsAction } = await import('@/app/(app)/guardian/actions');
const { learningLeaseKey } = await import('@/lib/guardian/learning-lease');

const FAMILY = '11111111-1111-4111-8111-111111111111';
const SCAMMER = '+15559999999';
const NOW = new Date('2026-10-20T02:00:00.000Z');
const DAY = 86_400_000;
let db: InMemorySupabase;
const req = () => new Request('https://bubaly.test/api/cron/guardian-learning') as never;
const suggestions = () => db.table('guardian_suggestions');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { app_settings: [['key']] } });
  h.db = db;
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC', closed_at: null }]);
  // A number that keeps calling and keeps being caught: one flag_scam draft.
  db.seed('guardian_communications', Array.from({ length: REPEAT_SCAM_THRESHOLD + 1 }, (_, i) => ({
    id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, family_id: FAMILY, member_id: 'm-kid', comm_type: 'call_inbound', direction: 'inbound',
    from_number: SCAMMER, contact_id: null, scam_detected: true, trust_level_at_time: 'unknown',
    started_at: new Date(NOW.getTime() - (1 + i) * DAY).toISOString(), status: 'blocked',
  })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('two runs for one family at once', () => {
  it('the cron and its mirrored tick file the suggestion once', async () => {
    const [a, b] = await Promise.all([GET(req()), GET(req())]);
    const bodies = await Promise.all([a.json(), b.json()]);
    expect(suggestions(), 'both runs read "not suggested yet" and both inserted').toHaveLength(1);
    expect(bodies.map((body) => body.suggestionsCreated).sort()).toEqual([0, 1]);
    // The run that found the lease held was served by the other: not a failure.
    expect(bodies.map((body) => body.busy).sort()).toEqual([0, 1]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('two managers pressing "Scan for tips" together file it once, and the second is told a scan is running', async () => {
    const scans = await Promise.all([generateGuardianSuggestionsAction(), generateGuardianSuggestionsAction()]);
    expect(suggestions(), 'both scans read "not suggested yet" and both inserted').toHaveLength(1);
    // Not "all caught up": the second scan is told the first is still running.
    expect(scans).toEqual([{ ok: true, data: { created: 1 } }, { ok: false, error: 'guardian.aScanIsAlreadyRunning' }]);
  });

  it('a manager pressing "Scan for tips" during the nightly run files it once', async () => {
    const [cron] = await Promise.all([GET(req()), generateGuardianSuggestionsAction()]);
    await cron.json();
    expect(suggestions()).toHaveLength(1);
  });

  it('a scan while another holds the lease inserts nothing and says a scan is running', async () => {
    db.seed('app_settings', [{ key: learningLeaseKey(FAMILY), value: { token: 'another-run' }, updated_at: NOW.toISOString() }]);
    const scan = await generateGuardianSuggestionsAction();
    expect(scan).toEqual({ ok: false, error: 'guardian.aScanIsAlreadyRunning' });
    expect(suggestions()).toEqual([]);
  });

  it('releases the lease when it is done, so the next run learns (and dedupes) as before', async () => {
    expect(await generateGuardianSuggestionsAction()).toEqual({ ok: true, data: { created: 1 } });
    expect(await generateGuardianSuggestionsAction()).toEqual({ ok: true, data: { created: 0 } });
    expect(suggestions()).toHaveLength(1);
  });

  it('a lease that cannot be read is a failed run, not a guess', async () => {
    const failing = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => (table === 'app_settings'
          ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '57014', message: 'timeout' } }) }) }) }
          : (target as InMemorySupabase).from(table as never));
      },
    });
    h.db = failing;
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, failed: 1, suggestionsCreated: 0 });
    expect(suggestions()).toEqual([]);
  });
});
