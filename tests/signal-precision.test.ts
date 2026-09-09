import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { signalPrecision } from '@/lib/metric/signal-precision';
import { loadSignalPrecision } from '@/lib/metric/signal-precision-server';
import { SignalPrecisionCard } from '@/components/metrics/signal-precision-card';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const RECENT = '2026-09-08T12:00:00.000Z';
const OLD = '2026-08-01T12:00:00.000Z';
const FUTURE = '2026-10-01T12:00:00.000Z';
afterEach(() => vi.restoreAllMocks());

describe('signal precision', () => {
  it('counts each positive status and dismissal, with both source denominators', () => {
    const summary = signalPrecision([
      { kind: 'family_signals', status: 'acknowledged' },
      { kind: 'family_signals', status: 'dismissed' },
      { kind: 'autopilot', status: 'approved' },
      { kind: 'autopilot', status: 'executed' },
      { kind: 'autopilot', status: 'auto_executed' },
      { kind: 'autopilot', status: 'dismissed', count: 2 },
    ]);
    expect(summary).toMatchObject({ accepted: 4, dismissed: 3, decided: 7, precision: 4 / 7 });
    expect(summary.bySource.family_signals.precision).toBe(0.5);
    expect(summary.bySource.autopilot.precision).toBe(0.6);
  });

  it('excludes undecided and unknown states; no decisions is not 0%', () => {
    expect(signalPrecision(['active', 'open', 'snoozed', 'failed', 'unknown'].map((status) => ({ kind: 'autopilot', status })))).toMatchObject({
      decided: 0, precision: null,
    });
    expect(signalPrecision([{ kind: 'autopilot', status: 'dismissed' }]).precision).toBe(0);
  });
});

describe('exact current-outcome reads', () => {
  it('uses decision times, scopes both tables to the family and omits pending/snoozed outcomes', async () => {
    const db = createInMemorySupabase<SupabaseClient<Database>>();
    db.seed('family_signals', [
      { id: 's1', family_id: 'f1', status: 'acknowledged', created_at: OLD, updated_at: RECENT },
      { id: 's2', family_id: 'f1', status: 'dismissed', updated_at: RECENT },
      { id: 's3', family_id: 'f2', status: 'dismissed', updated_at: RECENT },
      { id: 's4', family_id: 'f1', status: 'acknowledged', updated_at: OLD },
      { id: 's5', family_id: 'f1', status: 'acknowledged', updated_at: FUTURE },
      { id: 's6', family_id: 'f1', status: 'active', updated_at: RECENT },
    ]);
    db.seed('autopilot_suggestions', [
      { id: 'a1', family_id: 'f1', status: 'auto_executed', created_at: OLD, resolved_at: RECENT },
      { id: 'a2', family_id: 'f1', status: 'dismissed', resolved_at: RECENT },
      { id: 'a3', family_id: 'f2', status: 'dismissed', resolved_at: RECENT },
      { id: 'a4', family_id: 'f1', status: 'executed', resolved_at: OLD },
      { id: 'a5', family_id: 'f1', status: 'approved', resolved_at: FUTURE },
      { id: 'a6', family_id: 'f1', status: 'snoozed', resolved_at: RECENT },
      { id: 'a7', family_id: 'f1', status: 'approved', resolved_at: null },
    ]);
    expect(await loadSignalPrecision(db, { familyId: 'f1' }, NOW)).toMatchObject({
      available: true, data: { accepted: 2, dismissed: 2, decided: 4, precision: 0.5 },
    });
    expect(await loadSignalPrecision(db, { allFamilies: true }, NOW)).toMatchObject({
      available: true, data: { accepted: 2, dismissed: 4, decided: 6, precision: 1 / 3 },
    });
    expect(await loadSignalPrecision(db, { familyId: '' }, NOW)).toEqual({ available: false });
  });

  it('counts beyond database row-page limits instead of sampling', async () => {
    const db = createInMemorySupabase<SupabaseClient<Database>>();
    db.seed('family_signals', Array.from({ length: 2501 }, (_, i) => ({
      id: String(i), family_id: 'f1', status: i < 2000 ? 'acknowledged' : 'dismissed', updated_at: RECENT,
    })));
    expect(await loadSignalPrecision(db, { familyId: 'f1' }, NOW)).toMatchObject({
      available: true, data: { accepted: 2000, dismissed: 501, decided: 2501, precision: 2000 / 2501 },
    });
  });

  it.each(['postgrest', 'transport', 'builder', 'missing-count'])('returns unavailable for %s failure, never partial precision', async (mode) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = createInMemorySupabase<SupabaseClient<Database>>();
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table !== 'autopilot_suggestions') return from(table as never);
      if (mode === 'builder') throw new Error('builder failed');
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'in', 'gte', 'lte', 'eq']) chain[method] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => (
        mode === 'transport' ? Promise.reject(new Error('offline')) : Promise.resolve({
          data: null, count: null, error: mode === 'postgrest' ? { message: 'denied' } : null,
        })
      ).then(resolve, reject);
      return chain;
    }) as typeof db.from);
    expect(await loadSignalPrecision(db, { familyId: 'f1' }, NOW)).toEqual({ available: false });
    expect(console.error).toHaveBeenCalled();
  });
});

describe('visible precision states', () => {
  it('renders no decisions separately from unavailable and a true zero', async () => {
    const empty = renderToStaticMarkup(await SignalPrecisionCard({ result: { available: true, data: signalPrecision([]) }, retryHref: '/dashboard/family-signals' }));
    const failed = renderToStaticMarkup(await SignalPrecisionCard({ result: { available: false }, retryHref: '/dashboard/family-signals' }));
    const zero = renderToStaticMarkup(await SignalPrecisionCard({ result: { available: true, data: signalPrecision([{ kind: 'autopilot', status: 'dismissed' }]) }, retryHref: '/admin/ai-activity', allFamilies: true }));
    expect(empty).toContain('No recorded decisions');
    expect(empty).not.toContain('0%');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Signal precision is unavailable');
    expect(failed).toContain('href="/dashboard/family-signals"');
    expect(failed).not.toContain('0%');
    expect(zero).toContain('0%');
    expect(zero).toContain('0 accepted out of 1 decided');
    expect(zero).toContain('Automatic executions count');
  });
});
