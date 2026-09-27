import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A concierge run that has been decided leaves "Needs your decision". (DATA-018)
 *
 * The concierge queues a run with `status = 'pending', state = 'awaiting_approval'`.
 * Approving and dismissing it wrote `status` only. Needs-you lists runs by
 * `state`, and `displayRunState` prefers `state` whenever it is not the
 * default — so on the local database, as a parent, after one dismissal and one
 * approval, both runs were still listed:
 *
 *   Waiting for approval: Dinner [status=dismissed, state=awaiting_approval]
 *   Dinner planned              [status=executed,  state=awaiting_approval]
 *
 * Both actions also read `pending` and then wrote unconditionally, so an
 * approval and a dismissal racing each other could both succeed — the plan
 * applied and the record saying it was dismissed.
 *
 * The double applies every filter to the row as it is when the write runs and
 * resolves each call on a later macrotask, so the race is a real interleaving.
 */

type Run = { id: string; family_id: string; status: string; state: string; metadata: Record<string, unknown>; approved_at: string | null; approved_by: string | null; summary?: string };
const db = vi.hoisted(() => ({ runs: [] as Array<Record<string, unknown>>, failFinal: false, beforeDismissWrite: null as null | (() => void) }));
const later = <T>(value: () => T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value()), 0));

function runs() {
  const filters: Array<[string, unknown]> = [];
  let patch: Record<string, unknown> | null = null;
  const exec = () => {
    let hits = db.runs.filter((r) => filters.every(([column, value]) => r[column] === value));
    if (patch) {
      if (db.failFinal && patch.status === 'executed') return { data: null, error: { message: 'write failed' } };
      if (patch.status === 'dismissed' && db.beforeDismissWrite) { const land = db.beforeDismissWrite; db.beforeDismissWrite = null; land(); }
      hits = db.runs.filter((r) => filters.every(([column, value]) => r[column] === value));
      for (const r of hits) Object.assign(r, patch);
      return { data: hits[0] ? { id: hits[0].id } : null, error: null };
    }
    return { data: hits[0] ? { ...hits[0] } : null, error: null };
  };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return chain; },
    update: (value: Record<string, unknown>) => { patch = value; return chain; },
    maybeSingle: () => later(exec),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => later(exec).then(resolve, reject),
  };
  return chain;
}
function passthrough(data: unknown) {
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, update: () => chain,
    maybeSingle: () => later(() => ({ data, error: null })),
    then: (resolve: (v: unknown) => unknown) => later(() => ({ data: null, error: null })).then(resolve),
  };
  return chain;
}
const client = {
  from: (table: string) => {
    if (table === 'family_automation_runs') return runs();
    if (table === 'concierge_plans') return passthrough({ id: 'plan-1', title: 'Dinner', description: null, location: null, planned_for: null, budget_cents: null });
    return passthrough(null);
  },
};

const materialize = vi.hoisted(() => ({ fn: null as unknown as ReturnType<typeof import('vitest')['vi']['fn']> }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'parent-user' }, active: { familyId: 'family-1', role: 'parent', member: { id: 'parent-1' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => client, createServiceClient: () => client }));
vi.mock('@/lib/services/approvals', async (original) => ({
  ...(await original<object>()),
  materializeConciergePlan: (...args: unknown[]) => (materialize.fn as (...a: unknown[]) => unknown)(...args),
}));

import { dismissQueuedRunAction, executeQueuedRunAction } from '@/app/(app)/dashboard/concierge/actions';

const run = () => db.runs[0] as Run;
/** What the Needs-you page reads. */
const needsYou = () => db.runs.filter((r) => r.state === 'awaiting_approval' || r.state === 'awaiting_context');

beforeEach(() => {
  db.failFinal = false;
  db.beforeDismissWrite = null;
  db.runs = [{ id: 'run-1', family_id: 'family-1', status: 'pending', state: 'awaiting_approval', metadata: { plan_id: 'plan-1', kinds: [] }, approved_at: null, approved_by: null }];
  materialize.fn = vi.fn(async () => ['calendar']);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a decided run is no longer waiting on anyone', () => {
  it('approving it runs the plan once and takes it off Needs-you', async () => {
    expect(await executeQueuedRunAction('run-1')).toMatchObject({ ok: true });
    expect(materialize.fn).toHaveBeenCalledTimes(1);
    expect(run()).toMatchObject({ status: 'executed', state: 'completed' });
    expect(needsYou()).toHaveLength(0);
  });

  it('dismissing it takes it off Needs-you', async () => {
    expect(await dismissQueuedRunAction('run-1')).toMatchObject({ ok: true });
    expect(run()).toMatchObject({ status: 'dismissed', state: 'cancelled' });
    expect(needsYou()).toHaveLength(0);
  });
});

describe('approval and dismissal cannot both win', () => {
  it('lets exactly one of them decide when they race, and runs the plan only if approval won', async () => {
    const [executed, dismissed] = await Promise.all([executeQueuedRunAction('run-1'), dismissQueuedRunAction('run-1')]);
    expect([executed.ok, dismissed.ok].filter(Boolean)).toHaveLength(1);
    expect(materialize.fn).toHaveBeenCalledTimes(executed.ok ? 1 : 0);
    expect(run().state).toBe(executed.ok ? 'completed' : 'cancelled');
  });

  it('does not overwrite an approval that landed after the dismissal read the run', async () => {
    // The dismissal has read `pending`; before its write, another parent's
    // approval completes. The write must not turn an executed run "dismissed".
    db.beforeDismissWrite = () => Object.assign(db.runs[0], { status: 'executed', state: 'completed' });
    expect(await dismissQueuedRunAction('run-1')).toEqual({ ok: false, error: 'actions.runNotFoundOrAlready' });
    expect(run()).toMatchObject({ status: 'executed', state: 'completed' });
  });

  it('refuses to dismiss a run already approved', async () => {
    await executeQueuedRunAction('run-1');
    expect(await dismissQueuedRunAction('run-1')).toEqual({ ok: false, error: 'actions.runNotFoundOrAlready' });
    expect(run()).toMatchObject({ status: 'executed', state: 'completed' });
  });
});

describe('an approval that does not finish goes back to the queue', () => {
  it('releases the run when applying the plan throws, so it can be retried', async () => {
    materialize.fn = vi.fn(async () => { throw new Error('provider down'); });
    await expect(executeQueuedRunAction('run-1')).rejects.toThrow('provider down');
    expect(run()).toMatchObject({ status: 'pending', state: 'awaiting_approval', approved_at: null });
    materialize.fn = vi.fn(async () => ['calendar']);
    expect(await executeQueuedRunAction('run-1')).toMatchObject({ ok: true });
  });

  it('releases the run when it cannot be recorded as executed', async () => {
    db.failFinal = true;
    expect(await executeQueuedRunAction('run-1')).toMatchObject({ ok: false, error: 'actions.appliedThePlanButCould' });
    expect(run()).toMatchObject({ status: 'pending', state: 'awaiting_approval' });
  });
});
