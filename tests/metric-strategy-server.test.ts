import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { loadStrategyMetrics, loadFamilyDecisionCompression } from '@/lib/metric/strategy-server';

const NOW = new Date('2026-03-15T12:00:00.000Z');
const CREATED = '2026-01-01T00:00:00.000Z';
const REACHED = '2026-01-05T00:00:00.000Z';
const PAID = '2026-01-11T00:00:00.000Z';
const WEEK = '2026-03-12T00:00:00.000Z';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
beforeEach(() => { db = createInMemorySupabase<SupabaseClient<Database>>(); });
afterEach(() => { vi.restoreAllMocks(); });
const seed = (table: string, rows: Row[]) => db.seed(table, rows.map((row) => ({ created_at: CREATED, ...row })));
function seedPaid(familyId: string) {
  seed('subscriptions', [{ id: 'sub-' + familyId, family_id: familyId, plan: 'family', status: 'active', updated_at: PAID }]);
  seed('activation_events', [{ id: 'act-' + familyId, family_id: familyId, milestone: 'first_outcome_viewed', created_at: REACHED }]);
}
const note = (id: string, familyId: string, createdAt = PAID): Row => ({
  id, kind: 'subscription', related_type: 'subscription', related_id: familyId,
  created_at: createdAt, meta: { plan: 'family', status: 'active' },
});

type Reply = { data: Row[] | null; count: number | null; error: unknown };
type Query = {
  limit(size: number): Query;
  gt(column: string, value: unknown): Query;
  then(resolve: (result: Reply) => unknown, reject?: (error: unknown) => unknown): Promise<unknown>;
};
/** Wrap the actual fake query, retaining its filters/projection/order. */
function instrument(options: {
  cap?: number;
  after?: (table: string, page: number, result: Reply) => Reply | Promise<Reply>;
  ignoreCursor?: string;
  throwFrom?: string;
}) {
  const original = db.from.bind(db);
  const pages: Record<string, number> = {};
  vi.spyOn(db, 'from').mockImplementation(((table: string) => {
    if (table === options.throwFrom) throw new Error('query construction failed');
    const query = original(table as never) as unknown as Query;
    const limit = query.limit.bind(query);
    query.limit = (size) => limit(Math.min(size, options.cap ?? size));
    if (table === options.ignoreCursor) query.gt = () => query;
    const then = query.then.bind(query);
    query.then = (resolve, reject) => then(async (result) => {
      pages[table] = (pages[table] ?? 0) + 1;
      return options.after ? options.after(table, pages[table], result) : result;
    }).then(resolve as (value: unknown) => unknown, reject);
    return query;
  }) as typeof db.from);
  return pages;
}

describe('paid activation evidence from persisted rows', () => {
  it('reports conflicting current rows separately from missing transition evidence', async () => {
    seedPaid('conflict'); seedPaid('same'); seedPaid('missing');
    seed('subscriptions', [
      { id: 'duplicate-conflict', family_id: 'conflict', plan: 'free', status: 'active', updated_at: '2026-03-01T00:00:00Z' },
      { id: 'duplicate-same', family_id: 'same', plan: 'basic', status: 'active' },
    ]);
    seed('admin_notifications', [note('a', 'conflict'), note('b', 'same')]);
    instrument({ cap: 1 });
    expect((await loadStrategyMetrics(db, NOW)).conversion)
      .toMatchObject({ families: 3, recordedPaidActivations: 1, ambiguousStatus: 1, missingEvidence: 1, priorOnly: 0 });
  });
  it('uses the webhook notification, even though the subscription was created at signup and renewed later', async () => {
    seedPaid('f1');
    db.table('subscriptions')[0].updated_at = '2026-03-01T00:00:00Z';
    seed('admin_notifications', [note('note-1', 'f1')]);
    expect((await loadStrategyMetrics(db, NOW)).conversion)
      .toMatchObject({ families: 1, recordedPaidActivations: 1, rate: 1, medianDays: 6, missingEvidence: 0 });
  });
  it('does not turn a renewal into a dated activation when no notification was recorded', async () => {
    seedPaid('f1');
    expect((await loadStrategyMetrics(db, NOW)).conversion)
      .toMatchObject({ recordedPaidActivations: 0, missingEvidence: 1, priorOnly: 0, medianDays: null });
    const select = db.log.find((entry) => entry.table === 'subscriptions');
    expect(JSON.stringify(select)).not.toContain('updated_at');
  });
  it('distinguishes a prior-only receipt and counts a subsequent reactivation once', async () => {
    seedPaid('prior'); seedPaid('reactivated'); seedPaid('unknown');
    seed('admin_notifications', [
      note('a', 'prior', CREATED), note('b', 'reactivated', CREATED), note('c', 'reactivated', PAID),
      note('d', 'reactivated', '2026-02-01T00:00:00Z'),
    ]);
    expect((await loadStrategyMetrics(db, NOW)).conversion)
      .toMatchObject({ recordedPaidActivations: 1, missingEvidence: 1, priorOnly: 1, medianDays: 6 });
  });
  it('requires the source type, active paid metadata, and matching family', async () => {
    seedPaid('f1');
    seed('admin_notifications', [
      { ...note('a', 'f1'), related_type: 'family' },
      { ...note('b', 'f1'), meta: {} },
      { ...note('c', 'f1'), meta: { plan: 'free', status: 'active' } },
      { ...note('d', 'f1'), kind: 'subscription_churn' },
      note('e', 'other'),
    ]);
    expect((await loadStrategyMetrics(db, NOW)).conversion).toMatchObject({ recordedPaidActivations: 0, missingEvidence: 1 });
  });
  it('ignores free or inactive current subscriptions even with a prior recorded activation', async () => {
    seedPaid('free'); seedPaid('trial');
    db.table('subscriptions')[0].plan = 'free';
    db.table('subscriptions')[1].status = 'trialing';
    seed('admin_notifications', [note('a', 'free'), note('b', 'trial')]);
    expect((await loadStrategyMetrics(db, NOW)).conversion).toMatchObject({ families: 2, recordedPaidActivations: 0, missingEvidence: 0 });
  });
});

describe('complete strategy reads', () => {
  it('reads every contributing source beyond 2,000 rows even under a smaller server cap', async () => {
    const rows = Array.from({ length: 2005 }, (_, i) => String(i).padStart(5, '0'));
    seed('family_automation_runs', rows.map((id) => ({ id, request_id: id, state: 'completed', created_at: WEEK })));
    seed('ai_plans', rows.map((id) => ({ id, request_id: id, created_at: WEEK })));
    seed('ai_plans', [{ id: '99999', request_id: '02003', created_at: WEEK }]);
    seed('ai_run_events', rows.map((id) => ({ id, run_id: id, event_type: id === '02004' ? 'replanned' : 'started', created_at: WEEK })));
    for (const id of rows) seedPaid(id);
    seed('admin_notifications', rows.map((id) => note(id, id)));
    seed('families', rows.map((id) => ({ id })));
    seed('referrals', rows.map((id) => ({ id, status: 'converted' })));
    seed('invites', rows.map((id) => ({ id, status: 'accepted' })));
    const pages = instrument({ cap: 137 });
    const metrics = await loadStrategyMetrics(db, NOW);
    expect(metrics.rework).toMatchObject({ terminal: 2005, reworked: 2 });
    expect(metrics.conversion).toMatchObject({ families: 2005, recordedPaidActivations: 2005 });
    expect(metrics.referrals).toMatchObject({ households: 2005, fromReferrals: 2005, membersInvited: 2005, coefficient: 1 });
    for (const table of ['family_automation_runs', 'ai_plans', 'ai_run_events', 'activation_events', 'subscriptions', 'admin_notifications', 'referrals', 'invites']) {
      expect(pages[table], table).toBeGreaterThan(15);
    }
  });
  it('does not skip the next row when an earlier page row is deleted during pagination', async () => {
    seedPaid('f1'); seedPaid('f2'); seedPaid('f3');
    instrument({ cap: 1, after: (table, page, result) => {
      if (table === 'activation_events' && page === 1) db.table(table).splice(0, 1);
      return result;
    } });
    expect((await loadStrategyMetrics(db, NOW)).conversion?.families).toBe(3);
  });
  it('does not loop or use a partial denominator when the cursor stops advancing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seedPaid('f1'); seedPaid('f2');
    const pages = instrument({ cap: 1, ignoreCursor: 'activation_events' });
    const result = await loadStrategyMetrics(db, NOW);
    expect(result.conversion).toBeNull();
    expect(result.referrals).not.toBeNull();
    expect(pages.activation_events).toBe(2);
  });
  it('uses fixed upper bounds for every source and the decision timestamp for approvals', async () => {
    const future = '2026-03-16T00:00:00.000Z';
    seed('family_automation_runs', [{ id: 'now', state: 'completed', created_at: WEEK }, { id: 'future', state: 'failed', created_at: future }]);
    seed('family_signals', [{ id: 'now', created_at: WEEK }, { id: 'future', created_at: future }]);
    seed('approval_requests', [{ id: 'now', created_at: CREATED, decided_at: WEEK }, { id: 'future', decided_at: future }]);
    seed('families', [{ id: 'now' }, { id: 'future', created_at: future }]);
    seed('referrals', [{ id: 'now', status: 'converted' }, { id: 'future', status: 'converted', created_at: future }]);
    seed('invites', [{ id: 'future', status: 'accepted', created_at: future }]);
    seedPaid('f1');
    seed('admin_notifications', [note('future', 'f1', future)]);
    seed('activation_events', [{ id: 'future', family_id: 'future', milestone: 'first_outcome_viewed', created_at: future }]);
    const result = await loadStrategyMetrics(db, NOW);
    expect(result.rework?.terminal).toBe(1);
    expect(result.compression).toMatchObject({ rawSignals: 1, humanDecisions: 1 });
    expect(result.referrals).toMatchObject({ households: 1, joined: 1, membersInvited: 0 });
    expect(result.conversion).toMatchObject({ families: 1, recordedPaidActivations: 0, missingEvidence: 1 });
  });
});

describe('failures affect only dependent metrics', () => {
  it.each(['platform', 'household'])('owns earlier rejections when a later count builder throws: %s', async (surface) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const listen = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', listen);
    try {
      instrument({ throwFrom: 'autopilot_suggestions', after: (table, _page, result) => {
        if (table === 'family_signals') throw new Error('earlier count rejected');
        return result;
      } });
      if (surface === 'platform') {
        const result = await loadStrategyMetrics(db, NOW);
        expect(result.compressionRead).toBe('failed');
        expect(result.rework).not.toBeNull();
        expect(result.conversion).not.toBeNull();
      } else {
        expect(await loadFamilyDecisionCompression(db, 'f1', NOW)).toEqual({ ok: false });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listen);
    }
  });
  it.each([
    ['family_automation_runs', 'rework'], ['ai_plans', 'rework'], ['ai_run_events', 'rework'],
    ['family_signals', 'compression'], ['autopilot_suggestions', 'compression'],
    ['family_ai_recommendations', 'compression'], ['approval_requests', 'compression'],
    ['activation_events', 'conversion'], ['subscriptions', 'conversion'], ['admin_notifications', 'conversion'],
    ['families', 'referrals'], ['referrals', 'referrals'], ['invites', 'referrals'],
  ])('handles rejected transport for %s independently', async (source, group) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    instrument({ after: (table, _page, result) => {
      if (table === source) throw new Error('transport failed');
      return result;
    } });
    const metrics = await loadStrategyMetrics(db, NOW);
    expect(metrics[group as 'rework' | 'compression' | 'conversion' | 'referrals']).toBeNull();
    expect(metrics.compressionRead).toBe(group === 'compression' ? 'failed' : 'ok');
    for (const key of ['rework', 'conversion', 'referrals'] as const) {
      if (key !== group) expect(metrics[key], key).not.toBeNull();
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining('read failed'), expect.any(Error));
  });
  it('fails closed on a later billing-event page without using subscription updated_at', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seedPaid('f1');
    seed('admin_notifications', [note('a', 'f1'), note('b', 'f1')]);
    instrument({ cap: 1, after: (table, page, result) =>
      table === 'admin_notifications' && page === 2 ? { data: null, count: null, error: { message: 'down' } } : result });
    expect((await loadStrategyMetrics(db, NOW)).conversion).toBeNull();
  });
  it.each(['families', 'family_signals'])('does not interpret a missing exact count as zero: %s', async (source) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    instrument({ after: (table, _page, result) => table === source ? { ...result, count: null } : result });
    const result = await loadStrategyMetrics(db, NOW);
    if (source === 'families') expect(result.referrals).toBeNull();
    else expect(result.compressionRead).toBe('failed');
  });
  it('does not interpret missing row data as an empty ledger', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    instrument({ after: (table, _page, result) => table === 'ai_plans' ? { ...result, data: null } : result });
    expect((await loadStrategyMetrics(db, NOW)).rework).toBeNull();
  });
  it('contains a synchronous query-construction failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    instrument({ throwFrom: 'activation_events' });
    const result = await loadStrategyMetrics(db, NOW);
    expect(result.conversion).toBeNull();
    expect(result.referrals).not.toBeNull();
  });
});

describe('referral denominator and household compression', () => {
  it('keeps accepted member invites outside the new-household numerator', async () => {
    seed('families', [{ id: 'f1' }, { id: 'f2' }]);
    seed('referrals', [{ id: 'r1', status: 'converted' }, { id: 'r2', status: 'pending' }]);
    seed('invites', ['1', '2', '3', '4'].map((id) => ({ id, family_id: 'f1', status: 'accepted' })));
    expect((await loadStrategyMetrics(db, NOW)).referrals)
      .toMatchObject({ households: 2, joined: 1, coefficient: 0.5, membersInvited: 4 });
  });
  it('scopes every family count and excludes future signals and decisions', async () => {
    seed('family_signals', [{ id: 'a', family_id: 'f1', created_at: WEEK }, { id: 'b', family_id: 'other', created_at: WEEK }]);
    seed('autopilot_suggestions', [{ id: 'a', family_id: 'f1', created_at: WEEK }]);
    seed('family_ai_recommendations', [{ id: 'a', family_id: 'f1', created_at: '2026-04-01T00:00:00Z' }]);
    seed('approval_requests', [{ id: 'a', family_id: 'f1', decided_at: WEEK }, { id: 'b', family_id: 'other', decided_at: WEEK }]);
    expect(await loadFamilyDecisionCompression(db, 'f1', NOW)).toMatchObject({ ok: true, data: { rawSignals: 2, humanDecisions: 1 } });
  });
  it('distinguishes a household with no signals from a rejected read', async () => {
    expect(await loadFamilyDecisionCompression(db, 'f1', NOW)).toEqual({ ok: true, data: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    instrument({ after: (table, _page, result) => {
      if (table === 'family_signals') throw new Error('offline');
      return result;
    } });
    expect(await loadFamilyDecisionCompression(db, 'f1', NOW)).toEqual({ ok: false });
  });
});
