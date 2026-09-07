// ONE handled-this-week definition.
//
// Before S-15 there were three: the Autopilot panel counted runs with
// `trigger_type = 'plan_accepted'` and the legacy `status = 'executed'`; the
// Daily Brief counted the length of a list capped at six; time-saved counted
// three other tables and no runs at all. This suite pins the one definition and
// the two properties that used to be wrong — a run is counted once, and a
// failed read is not zero.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { countHandledThisWeek, loadTimeSaved } from '@/lib/metric/time-saved-server';
import { HANDLED_RUN_STATES, isHandledRun } from '@/lib/metric/time-saved';
import { buildBrief, type BriefInput } from '@/lib/briefing/build';

const FAMILY = 'family-1';
const OTHER = 'family-2';
const NOW = new Date('2026-03-15T12:00:00.000Z');
const inWindow = '2026-03-12T09:00:00.000Z';
const beforeWindow = '2026-02-01T09:00:00.000Z';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
});
afterEach(() => { vi.restoreAllMocks(); });

const run = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, state, status: 'executed', trigger_type: 'plan_accepted',
  created_at: inWindow, ...extra,
});

describe('countHandledThisWeek', () => {
  it('counts runs in the handled states under ANY trigger', async () => {
    db.seed('family_automation_runs', [
      run('r1', 'completed', { trigger_type: 'plan_accepted' }),
      run('r2', 'partially_completed', { trigger_type: 'routine' }),
      run('r3', 'completed', { trigger_type: null }),
      // Not handled: still going, or ended badly.
      run('r4', 'executing'),
      run('r5', 'failed'),
      run('r6', 'cancelled'),
    ]);

    const { parts, total } = await countHandledThisWeek(db, FAMILY, NOW);
    expect(parts.run).toBe(3);
    expect(total).toBe(3);
  });

  it('counts each run exactly once', async () => {
    // The old panel matched on trigger_type AND the legacy status column; a run
    // that satisfied both definitions could be added twice by a naive union.
    db.seed('family_automation_runs', [run('r1', 'completed')]);
    db.seed('agent_activity', []);
    const { total } = await countHandledThisWeek(db, FAMILY, NOW);
    expect(total).toBe(1);
  });

  it('ignores runs outside the week and other households', async () => {
    db.seed('family_automation_runs', [
      run('r1', 'completed'),
      run('old', 'completed', { created_at: beforeWindow }),
      run('theirs', 'completed', { family_id: OTHER }),
    ]);
    const { parts } = await countHandledThisWeek(db, FAMILY, NOW);
    expect(parts.run).toBe(1);
  });

  it('adds the runs to the three existing sources', async () => {
    db.seed('family_automation_runs', [run('r1', 'completed'), run('r2', 'partially_completed')]);
    db.seed('autopilot_suggestions', [
      { id: 'a1', family_id: FAMILY, status: 'auto_executed', created_at: inWindow },
      { id: 'a2', family_id: FAMILY, status: 'open', created_at: inWindow },
    ]);
    db.seed('agent_activity', [{ id: 'g1', family_id: FAMILY, status: 'done', created_at: inWindow }]);
    db.seed('family_reminders', [
      { id: 'm1', family_id: FAMILY, status: 'completed', updated_at: inWindow },
      { id: 'm2', family_id: FAMILY, status: 'completed', updated_at: inWindow },
    ]);

    const { parts, total } = await countHandledThisWeek(db, FAMILY, NOW);
    expect(parts).toEqual({ run: 2, autopilot: 1, assistant: 1, reminder: 2 });
    expect(total).toBe(6);
  });

  it('is unavailable — not zero — when a source fails to read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.seed('family_automation_runs', [run('r1', 'completed')]);
    const original = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table === 'agent_activity') {
        return { select: () => ({ eq: () => ({ eq: () => ({ gte: () => Promise.resolve({ count: null, error: { message: 'boom' } }) }) }) }) };
      }
      return original(table as never);
    }) as typeof db.from);

    const { parts, total } = await countHandledThisWeek(db, FAMILY, NOW);
    expect(parts.assistant).toBeNull();
    expect(total).toBeNull();
    expect(parts.run).toBe(1);       // the readable parts are still readable
    expect(spy).toHaveBeenCalled();
  });
});

describe('loadTimeSaved', () => {
  it('is the single time-saved definition, and includes runs', async () => {
    db.seed('family_automation_runs', [run('r1', 'completed')]);           // 12 min
    db.seed('autopilot_suggestions', [{ id: 'a1', family_id: FAMILY, status: 'auto_executed', created_at: inWindow }]); // 5
    db.seed('agent_activity', [{ id: 'g1', family_id: FAMILY, status: 'done', created_at: inWindow }]);                 // 4
    db.seed('family_reminders', [{ id: 'm1', family_id: FAMILY, status: 'completed', updated_at: inWindow }]);          // 2

    const result = await loadTimeSaved(db, FAMILY, NOW);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.data.actions).toBe(4);
    expect(result.data.minutes).toBe(23);
    expect(result.data.rows.map((r) => r.kind)).toEqual(['run', 'autopilot', 'assistant', 'reminder']);
  });

  it('reports unavailable rather than a zero week when a read fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table === 'family_automation_runs') {
        return { select: () => ({ eq: () => ({ in: () => ({ gte: () => Promise.resolve({ count: null, error: { message: 'boom' } }) }) }) }) };
      }
      return original(table as never);
    }) as typeof db.from);

    const result = await loadTimeSaved(db, FAMILY, NOW);
    expect(result.available).toBe(false);
    expect(spy).toHaveBeenCalled();
  });

  it('is available and empty when the family genuinely had a quiet week', async () => {
    const result = await loadTimeSaved(db, FAMILY, NOW);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.data.actions).toBe(0);
    expect(result.data.show).toBe(false);
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
    expect(brief.counts.handledSource).toBe('ledger');
  });

  it('falls back to what it can see itself when the ledger read failed', () => {
    // Under-reporting is acceptable; inventing a number is not, and neither is
    // silently passing a zero off as the ledger's answer.
    const brief = buildBrief(input({ completedRuns: sevenRuns, handledThisWeek: null }), 'UTC');
    expect(brief.counts.handled).toBe(6);
    expect(brief.counts.handledSource).toBe('listed');
  });

  it('marks the source as listed when no ledger count was supplied at all', () => {
    const brief = buildBrief(input({ completedRuns: sevenRuns }), 'UTC');
    expect(brief.counts.handledSource).toBe('listed');
  });
});
