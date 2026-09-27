import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Approving a queued concierge run claims it (`status: approved`,
 * `state: executing`, `approved_at` = this claim), applies the plan, then
 * stamps it executed or hands it back. The stamp and the hand-back must only
 * touch the run while this action's claim still holds. Found by the owner's
 * review of #586: the stamp checked `status = 'approved'` alone, and the
 * hand-back accepted any `state`, so a parent who paused the run while its
 * plan was being applied (pause keeps `status = 'approved'`) had the pause
 * overwritten by `completed`, or by `awaiting_approval` on a failure, and a
 * newer claim on the same run was finalized by the older action.
 *
 * The fake database below applies each `.eq` filter to one run row, the way
 * PostgREST would, and the materializer is held so the test can change the
 * row between the claim and the stamp.
 */
const requireUserContext = vi.fn();
const createServer = vi.fn();
const materializeConciergePlan = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: () => createServer(),
  createServiceClient: () => { throw new Error('not used'); },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/services/approvals', () => ({
  decide: () => { throw new Error('no approval governs these runs'); },
  materializeConciergePlan: (...a: unknown[]) => materializeConciergePlan(...a),
}));

const PLAN = { id: 'plan-1', title: 'Beach day', description: null, location: null, planned_for: '2026-10-10', budget_cents: null };

type Row = Record<string, unknown>;

/** One `family_automation_runs` row; every update is applied only where its filters match. */
function database(run: Row) {
  const client = {
    from(table: string) {
      if (table === 'family_automation_runs') {
        return {
          select: () => {
            const read = { eq: () => read, maybeSingle: () => Promise.resolve({ data: { ...run }, error: null }) };
            return read;
          },
          update: (payload: Row) => {
            const filters: [string, unknown][] = [];
            const write = () => {
              const hit = filters.every(([k, v]) => run[k] === v);
              if (hit) Object.assign(run, payload);
              return hit ? [{ id: run.id }] : [];
            };
            const u: Record<string, unknown> = {};
            Object.assign(u, {
              eq: (k: string, v: unknown) => { filters.push([k, v]); return u; },
              select: () => u,
              maybeSingle: () => Promise.resolve({ data: write()[0] ?? null, error: null }),
              then: (res: (v: unknown) => unknown) => Promise.resolve({ data: write(), error: null }).then(res),
            });
            return u;
          },
        };
      }
      // concierge_plans reads the plan; approval_requests answers "none governs this plan".
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain, eq: () => chain, filter: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: PLAN, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
      });
      return chain;
    },
  };
  return client;
}

/** The materializer, held until the test has changed the row. */
function held(result: { applied: string[]; failed: string[] } | Error) {
  let letGo!: () => void;
  const gate = new Promise<void>((r) => { letGo = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  materializeConciergePlan.mockImplementation(async () => {
    entered();
    await gate;
    if (result instanceof Error) throw result;
    return result;
  });
  return { inside, letGo };
}

const pending = (): Row => ({
  id: 'run-1', family_id: 'fam-1', status: 'pending', state: 'awaiting_approval',
  approved_by: null, approved_at: null, metadata: { plan_id: 'plan-1', kinds: ['calendar'] },
});

/** What `pauseRun` writes (lib/ai/runs/controls.ts): the legacy status stays `approved`. */
const pause = (run: Row) => Object.assign(run, { state: 'paused', status: 'approved', paused_at: '2026-09-27T20:00:00.000Z' });

const approve = async () => (await import('@/app/(app)/dashboard/concierge/actions')).executeQueuedRunAction('run-1');

beforeEach(() => {
  requireUserContext.mockResolvedValue({
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' } },
    user: { id: 'user-1' },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('a run paused while its plan is being applied stays paused', () => {
  it('when the plan lands', async () => {
    const run = pending();
    createServer.mockResolvedValue(database(run));
    const h = held({ applied: ['calendar'], failed: [] });
    const result = approve();
    await h.inside;
    pause(run);
    h.letGo();
    const res = await result;
    expect(run.state).toBe('paused');
    expect(run.status).toBe('approved');
    expect(res.ok).toBe(false);
  });

  it('when part of the plan fails', async () => {
    const run = pending();
    createServer.mockResolvedValue(database(run));
    const h = held({ applied: [], failed: ['calendar'] });
    const result = approve();
    await h.inside;
    pause(run);
    h.letGo();
    await result;
    expect(run.state).toBe('paused');
    expect(run.status).toBe('approved');
  });

  it('when applying the plan throws', async () => {
    const run = pending();
    createServer.mockResolvedValue(database(run));
    const h = held(new Error('provider down'));
    const result = approve();
    await h.inside;
    pause(run);
    h.letGo();
    await expect(result).rejects.toThrow('provider down');
    expect(run.state).toBe('paused');
    expect(run.status).toBe('approved');
  });
});

describe('an older action does not finalize a newer claim', () => {
  it('a run re-claimed during the apply is left to the newer claim', async () => {
    const run = pending();
    createServer.mockResolvedValue(database(run));
    const h = held({ applied: ['calendar'], failed: [] });
    const result = approve();
    await h.inside;
    const newer = '2099-01-01T00:00:00.000Z';
    Object.assign(run, { status: 'approved', state: 'executing', approved_at: newer, approved_by: 'user-2' });
    h.letGo();
    const res = await result;
    expect(run.state).toBe('executing');
    expect(run.approved_at).toBe(newer);
    expect(res.ok).toBe(false);
  });
});

describe('the claim this action holds still decides the run (not over-tightened)', () => {
  it('a plan that lands is stamped completed', async () => {
    const run = pending();
    createServer.mockResolvedValue(database(run));
    materializeConciergePlan.mockResolvedValue({ applied: ['calendar'], failed: [] });
    const res = await approve();
    expect(res).toMatchObject({ ok: true, mode: 'auto' });
    expect(run).toMatchObject({ status: 'executed', state: 'completed' });
  });

  it('a plan that does not land is handed back for a retry', async () => {
    const run = pending();
    createServer.mockResolvedValue(database(run));
    materializeConciergePlan.mockResolvedValue({ applied: [], failed: ['calendar'] });
    const res = await approve();
    expect(res.ok).toBe(false);
    expect(run).toMatchObject({ status: 'pending', state: 'awaiting_approval', approved_at: null, approved_by: null });
  });

  it('a plan that throws is handed back for a retry', async () => {
    const run = pending();
    createServer.mockResolvedValue(database(run));
    materializeConciergePlan.mockRejectedValue(new Error('provider down'));
    await expect(approve()).rejects.toThrow('provider down');
    expect(run).toMatchObject({ status: 'pending', state: 'awaiting_approval', approved_at: null });
  });
});
