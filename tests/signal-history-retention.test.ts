import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { archiveStaleSuggestions } from '@/lib/autopilot/history';
import { runAutopilotScan } from '@/lib/autopilot/scan';
import { runSignalDetection } from '@/lib/intelligence/hard-signals-server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const NOW = new Date('2026-09-09T12:00:00.000Z');
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('signal history survives reconciliation', () => {
  it('archives stale suggestions without a decision, retains evidence and releases recurring dedupe keys', async () => {
    const db = createInMemorySupabase<SupabaseClient<Database>>({ uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] } });
    db.seed('autopilot_suggestions', [{
      id: 'stale', family_id: 'f1', dedupe_key: 'renewal:passport', status: 'open',
      title: 'Renew passport', payload: { source: 'passport' }, resolved_at: null, resolved_by: null,
    }]);
    expect(await archiveStaleSuggestions(db, 'f1', [{ id: 'stale', dedupe_key: 'renewal:passport' }], NOW)).toBe(1);
    expect(db.table('autopilot_suggestions')[0]).toMatchObject({
      id: 'stale', status: 'snoozed', expires_at: NOW.toISOString(), payload: { source: 'passport' },
      resolved_at: null, resolved_by: null, dedupe_key: 'archived:stale:renewal:passport',
    });
    const created = await db.from('autopilot_suggestions').insert({ family_id: 'f1', dedupe_key: 'renewal:passport', status: 'open', title: 'Renew passport', kind: 'document' }).select('id');
    expect(created.error).toBeNull();
    expect(db.table('autopilot_suggestions')).toHaveLength(2);
  });

  it('cannot archive another family or overwrite a decision made after the scan read', async () => {
    const db = createInMemorySupabase<SupabaseClient<Database>>();
    db.seed('autopilot_suggestions', [
      { id: 'other', family_id: 'f2', dedupe_key: 'other', status: 'open' },
      { id: 'decided', family_id: 'f1', dedupe_key: 'decided', status: 'dismissed', resolved_at: NOW.toISOString() },
    ]);
    expect(await archiveStaleSuggestions(db, 'f1', [{ id: 'other', dedupe_key: 'other' }, { id: 'decided', dedupe_key: 'decided' }], NOW)).toBe(0);
    expect(db.table('autopilot_suggestions')[0].status).toBe('open');
    expect(db.table('autopilot_suggestions')[1]).toMatchObject({ status: 'dismissed', dedupe_key: 'decided', resolved_at: NOW.toISOString() });
  });

  it('does not report an archive as successful when the write fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const chain: Record<string, unknown> = {};
    for (const method of ['update', 'eq', 'select']) chain[method] = () => chain;
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'write denied' } }).then(resolve);
    const db = { from: () => chain } as unknown as SupabaseClient<Database>;
    await expect(archiveStaleSuggestions(db, 'f1', [{ id: 'stale', dedupe_key: 'gone' }], NOW)).rejects.toThrow('Autopilot could not archive stale suggestions');
    expect(log).toHaveBeenCalled();
  });

  it('runs the scanner with more archived rows than its active-read cap without hiding a live suggestion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const db = createInMemorySupabase<SupabaseClient<Database>>();
    db.seed('autopilot_suggestions', [
      ...Array.from({ length: 600 }, (_, i) => ({ id: `old${i}`, family_id: 'f1', dedupe_key: `archived:old${i}:gone`, status: 'snoozed' })),
      { id: 'stale', family_id: 'f1', dedupe_key: 'renewal:gone', status: 'open' },
      { id: 'decided', family_id: 'f1', dedupe_key: 'renewal:dismissed', status: 'dismissed' },
    ]);
    expect((await runAutopilotScan(db, 'f1', 'u1')).cleared).toBe(1);
    expect(db.table('autopilot_suggestions')).toHaveLength(602);
    expect(db.table('autopilot_suggestions').find((row) => row.id === 'stale')).toMatchObject({ status: 'snoozed', expires_at: NOW.toISOString() });
    expect(db.table('autopilot_suggestions').find((row) => row.id === 'decided')?.status).toBe('dismissed');
    expect((await runAutopilotScan(db, 'f1', 'u1')).cleared).toBe(0);
  });

  it.each(['acknowledged', 'dismissed'])('preserves a %s family signal and its decision time on refresh', async (status) => {
    const db = createInMemorySupabase<SupabaseClient<Database>>({
      uniques: { family_signals: [['family_id', 'kind', 'subject_key']] },
      defaults: { family_signals: { status: 'active' } },
    });
    db.seed('routine_templates', [{ id: 'routine-1', family_id: 'f1', name: 'Bedtime', weekday_mask: 127, is_active: true }]);
    expect((await runSignalDetection(db, 'f1', NOW)).ok).toBe(true);
    const signal = db.table('family_signals')[0];
    expect(signal.status).toBe('active');
    signal.status = status;
    signal.updated_at = '2026-09-08T10:00:00.000Z';
    const before = { ...signal };
    expect((await runSignalDetection(db, 'f1', new Date('2026-09-10T12:00:00.000Z'))).ok).toBe(true);
    expect(db.table('family_signals')).toEqual([before]);
  });
});
