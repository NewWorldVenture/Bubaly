import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { countHandledThisWeek, loadTimeSaved } from '@/lib/metric/time-saved-server';
import { HANDLED_LEGACY_RUN_STATUSES, HANDLED_RUN_STATES, isHandledRun } from '@/lib/metric/time-saved';
import { buildBrief, type BriefInput } from '@/lib/briefing/build';

const FAMILY = 'family-1';
const NOW = new Date('2026-03-15T12:00:00.000Z');
const inWindow = '2026-03-12T09:00:00.000Z';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
beforeEach(() => { db = createInMemorySupabase<SupabaseClient<Database>>(); });
afterEach(() => vi.restoreAllMocks());

describe('shared recorded-plan metric', () => {
  it('keeps client counts and the planning-time model on the same dated subset', async () => {
    db.seed('family_automation_runs', [
      { id: 'done', family_id: FAMILY, state: 'completed', status: 'executed', completed_at: inWindow, created_at: '2026-01-01T12:00:00.000Z' },
      { id: 'partial', family_id: FAMILY, state: 'partially_completed', status: 'executed', completed_at: inWindow, created_at: inWindow },
      { id: 'undated', family_id: FAMILY, state: 'awaiting_approval', status: 'executed', completed_at: null, created_at: inWindow },
    ]);
    db.seed('agent_activity', [{ id: 'same-plan-step', family_id: FAMILY, status: 'done', created_at: inWindow }]);
    db.seed('autopilot_suggestions', [{ id: 'legacy-auto', family_id: FAMILY, status: 'auto_executed', created_at: inWindow }]);
    db.seed('family_reminders', [{ id: 'human-completed', family_id: FAMILY, status: 'completed', updated_at: inWindow }]);
    const result = await countHandledThisWeek(db, FAMILY, NOW);
    expect(result).toMatchObject({ available: true, parts: { run: 1 }, total: 1, undatedCompletedRuns: 1 });
    expect(Object.keys(result.parts)).toEqual(['run']);
    expect(await loadTimeSaved(db, FAMILY, NOW)).toMatchObject({ available: true, data: { actions: 1, minutes: 12, undatedCompletedRuns: 1, rows: [{ kind: 'run' }] } });
  });

  it('retains undated coverage when no completed plan can be placed in this week', async () => {
    db.seed('family_automation_runs', [{ id: 'undated', family_id: FAMILY, state: 'completed', status: 'executed', completed_at: null, created_at: inWindow }]);
    expect(await loadTimeSaved(db, FAMILY, NOW)).toMatchObject({ available: true, data: { actions: 0, minutes: 0, undatedCompletedRuns: 1, show: true } });
  });

  it('returns unavailable for a client read failure without claiming an empty week', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'from').mockImplementation(() => { throw new Error('client unavailable'); });
    expect(await countHandledThisWeek(db, FAMILY, NOW)).toMatchObject({ available: false, total: null, undatedCompletedRuns: null, parts: { run: null } });
    expect(await loadTimeSaved(db, FAMILY, NOW)).toEqual({ available: false });
  });

  it('keeps a true empty subset distinct from unreadable history', async () => {
    expect(await loadTimeSaved(db, FAMILY, NOW)).toMatchObject({ available: true, data: { actions: 0, minutes: 0, undatedCompletedRuns: 0, show: false } });
  });
});
describe('the shared vocabulary', () => {
  it('names exactly the two states that mean Bubaly finished something', () => {
    expect([...HANDLED_RUN_STATES]).toEqual(['completed', 'partially_completed']);
    expect(isHandledRun({ state: 'completed' })).toBe(true);
    expect(isHandledRun({ state: 'partially_completed' })).toBe(true);
    expect(isHandledRun({ state: 'executing' })).toBe(false);
    expect(isHandledRun({ state: 'failed' })).toBe(false);
    expect(isHandledRun({ state: null })).toBe(false);
    expect(isHandledRun({})).toBe(false);
  });

  it('reads the legacy column too, through the repo\'s one mapping', () => {
    expect([...HANDLED_LEGACY_RUN_STATUSES]).toEqual(['executed']);
    expect(isHandledRun({ state: 'awaiting_approval', status: 'executed' })).toBe(true);
    expect(isHandledRun({ state: 'queued', status: 'executed' })).toBe(true);
    expect(isHandledRun({ state: 'queued', status: 'pending' })).toBe(false);
    expect(isHandledRun({ status: 'dismissed' })).toBe(false);
  });
});

describe('the brief consumes the same number', () => {
  const input = (over: Partial<BriefInput> = {}): BriefInput => ({
    kind: 'daily',
    now: NOW,
    events: [],
    snapshot: {},
    completedRuns: [],
    activity: [],
    ...over,
  });

  /** Seven finished runs — one more than `mergeCompletedByBubaly`'s list cap. */
  const sevenRuns = Array.from({ length: 7 }, (_, i) => ({
    id: `run-${i}`, summary: `Thing ${i}`, state: 'completed', progress: null,
    completed_at: `2026-03-1${i % 5}T10:00:00.000Z`, updated_at: inWindow,
  }));

  it('uses the ledger count when it is supplied, not the length of a capped list', () => {
    const brief = buildBrief(input({ completedRuns: sevenRuns, handledThisWeek: 11 }), 'UTC');
    expect(brief.handled).toHaveLength(6);      // the LIST is still capped
    expect(brief.counts.handled).toBe(11);      // the COUNT is the shared one
    expect(brief.counts.handledSource).toBe('completed_plans');
  });

  it('keeps a failed completion metric unavailable despite listed activity', () => {
    // A capped history list contains a different subset and cannot answer a
    // failed completed-plan count.
    const brief = buildBrief(input({ completedRuns: sevenRuns, handledThisWeek: null }), 'UTC');
    expect(brief.counts.handled).toBeNull();
    expect(brief.counts.handledSource).toBe('unavailable');
  });

  it('marks the source as listed when no ledger count was supplied at all', () => {
    const brief = buildBrief(input({ completedRuns: sevenRuns }), 'UTC');
    expect(brief.counts.handledSource).toBe('listed');
  });
});
