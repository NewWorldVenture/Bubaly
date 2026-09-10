import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadCompletedValueRuns } from '@/lib/metric/value-runs-server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const SINCE = '2026-09-02T12:00:00.000Z';
const IN_WINDOW = '2026-09-07T12:00:00.000Z';
const OLD = '2026-08-01T12:00:00.000Z';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, state: 'completed', status: 'executed', created_at: IN_WINDOW,
  completed_at: IN_WINDOW, ...extra,
});

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('completed-run value evidence', () => {
  it('uses durable completion time, including older requests completed this week', async () => {
    db.seed('family_automation_runs', [
      run('long-running', { created_at: OLD }),
      run('start-boundary', { completed_at: SINCE }),
      run('end-boundary', { completed_at: NOW.toISOString() }),
      run('too-old', { completed_at: '2026-09-02T11:59:59.999Z' }),
      run('future', { completed_at: '2026-09-09T12:00:00.001Z' }),
      run('other-family', { family_id: 'family-2' }),
    ]);
    await expect(loadCompletedValueRuns(db, FAMILY, NOW)).resolves.toEqual({
      available: true, completedRuns: 3, undatedCompletedRuns: 0, sinceIso: SINCE, untilIso: NOW.toISOString(),
    });
  });

  it('counts each complete run once and excludes explicit partial and unsuccessful states', async () => {
    db.seed('family_automation_runs', [
      run('both-columns'), run('modern-only', { status: 'approved' }),
      run('legacy', { state: 'queued' }), run('legacy-null', { state: null }),
      run('legacy-concierge', { state: 'awaiting_approval' }),
      ...['partially_completed', 'failed', 'cancelled', 'blocked', 'executing', 'ready', 'paused'].map((state) => run(state, { state })),
      run('pending', { state: 'queued', status: 'pending' }),
    ]);
    const result = await loadCompletedValueRuns(db, FAMILY, NOW);
    expect(result).toMatchObject({ available: true, completedRuns: 5, undatedCompletedRuns: 0 });
  });

  it('reports undated completed history separately without substituting creation or approval time', async () => {
    db.seed('family_automation_runs', [
      run('current-undated', { completed_at: null }),
      run('old-undated', { created_at: OLD, completed_at: null }),
      run('legacy-concierge', { state: 'awaiting_approval', approved_at: IN_WINDOW, completed_at: null }),
      run('partial-undated', { state: 'partially_completed', completed_at: null }),
      run('future-undated', { created_at: '2026-09-10T12:00:00.000Z', completed_at: null }),
      run('other-undated', { family_id: 'family-2', completed_at: null }),
    ]);
    expect(await loadCompletedValueRuns(db, FAMILY, NOW)).toMatchObject({ available: true, completedRuns: 0, undatedCompletedRuns: 3 });
  });

  it('keeps actual zero available and never adds activity, reminders or autopilot to the monetary basis', async () => {
    db.seed('agent_activity', [{ id: 'activity', family_id: FAMILY, status: 'done', created_at: IN_WINDOW }]);
    db.seed('family_reminders', [{ id: 'reminder', family_id: FAMILY, status: 'completed', updated_at: IN_WINDOW }]);
    db.seed('autopilot_suggestions', [{ id: 'suggestion', family_id: FAMILY, status: 'auto_executed', created_at: IN_WINDOW }]);
    const from = vi.spyOn(db, 'from');
    expect(await loadCompletedValueRuns(db, FAMILY, NOW)).toMatchObject({ available: true, completedRuns: 0, undatedCompletedRuns: 0 });
    expect(from.mock.calls.map(([table]) => table)).toEqual(['family_automation_runs', 'family_automation_runs']);
  });

  it('uses exact server counts instead of a capped row list', async () => {
    db.seed('family_automation_runs', Array.from({ length: 1501 }, (_, index) => run(`run-${index}`)));
    expect(await loadCompletedValueRuns(db, FAMILY, NOW)).toMatchObject({ available: true, completedRuns: 1501 });
  });

  it.each([0, 1])('makes either missing exact count unavailable (read %s)', async (failedRead) => {
    const original = db.from.bind(db);
    let calls = 0;
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = original(table as never);
      if (calls++ !== failedRead) return query;
      const then = query.then.bind(query);
      query.then = ((fulfilled: (value: unknown) => unknown, rejected: (error: unknown) => unknown) =>
        then((reply) => fulfilled({ ...reply, count: null }), rejected)) as typeof query.then;
      return query;
    }) as typeof db.from);
    expect(await loadCompletedValueRuns(db, FAMILY, NOW)).toEqual({ available: false });
    expect(console.error).toHaveBeenCalled();
  });

  it('returns unavailable for database errors reading the durable timestamp', async () => {
    const original = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = original(table as never);
      query.then = ((fulfilled: (value: unknown) => unknown) => Promise.resolve(fulfilled({
        data: null, count: null, error: { message: 'completed_at is unavailable' },
      }))) as typeof query.then;
      return query;
    }) as typeof db.from);
    expect(await loadCompletedValueRuns(db, FAMILY, NOW)).toEqual({ available: false });
  });

  it('returns unavailable for rejected transport and synchronous client failures', async () => {
    const original = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = original(table as never);
      query.then = ((_fulfilled: (value: unknown) => unknown, rejected: (error: unknown) => unknown) =>
        Promise.reject(new Error('connection reset')).catch(rejected)) as typeof query.then;
      return query;
    }) as typeof db.from);
    expect(await loadCompletedValueRuns(db, FAMILY, NOW)).toEqual({ available: false });
    vi.mocked(db.from).mockImplementation(() => { throw new Error('client unavailable'); });
    expect(await loadCompletedValueRuns(db, FAMILY, NOW)).toEqual({ available: false });
  });

  it('rejects an invalid window or missing household before making a query', async () => {
    const from = vi.spyOn(db, 'from');
    expect(await loadCompletedValueRuns(db, '', NOW)).toEqual({ available: false });
    expect(await loadCompletedValueRuns(db, FAMILY, new Date('invalid'))).toEqual({ available: false });
    expect(from).not.toHaveBeenCalled();
  });
});
