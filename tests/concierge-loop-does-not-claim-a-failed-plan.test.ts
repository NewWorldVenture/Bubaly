import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit C1-S9-72 — the callers of the concierge materializer.
 *
 * Each read an empty result as "already in place": the manual button ticked
 * itself done, the autopilot recorded a completed run over a plan that never
 * reached the calendar, and an approved queued run was stamped executed —
 * retiring the one button that retries. The materializer now reports what
 * failed; these cases drive each caller with that report.
 */
const requireUserContext = vi.fn();
const createServer = vi.fn();
const createServiceClient = vi.fn();
const materializeConciergePlan = vi.fn();
const evaluateTrust = vi.fn();
const getAISettings = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: () => createServer(),
  createServiceClient: () => createServiceClient(),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/services/approvals', () => ({
  materializeConciergePlan: (...a: unknown[]) => materializeConciergePlan(...a),
}));
vi.mock('@/lib/trust/server', () => ({
  evaluateTrust: (...a: unknown[]) => evaluateTrust(...a),
  roleOf: () => 'parent',
}));
vi.mock('@/lib/services/ai-settings', () => ({ getAISettings: () => getAISettings() }));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: () => ({}) }));

const PLAN = { id: 'plan-1', title: 'Beach day', description: null, location: null, planned_for: '2026-10-10', budget_cents: null };

type Sb = {
  planError?: unknown;
  ledgerError?: unknown;
  run?: Record<string, unknown> | null;
  updateRows?: unknown[];
};

function userClient(o: Sb, updates: Record<string, unknown>[]) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(
          table === 'concierge_plans'
            ? { data: o.planError ? null : PLAN, error: o.planError ?? null }
            : { data: o.run ?? null, error: null },
        ),
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: o.ledgerError ? null : [], error: o.ledgerError ?? null }).then(res),
        update: (payload: Record<string, unknown>) => {
          updates.push({ table, ...payload });
          const u: Record<string, unknown> = {};
          Object.assign(u, {
            eq: () => u,
            select: () => u,
            then: (res: (v: unknown) => unknown) => Promise.resolve({ data: o.updateRows ?? [{ id: 'row' }], error: null }).then(res),
          });
          return u;
        },
      });
      return chain;
    },
  };
}

function serviceClient(inserts: Record<string, unknown>[], insertError: unknown = null) {
  return {
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        inserts.push({ table, ...payload });
        return Promise.resolve({ error: insertError });
      },
    }),
  };
}

const actions = () => import('@/app/(app)/dashboard/concierge/actions');

beforeEach(() => {
  requireUserContext.mockResolvedValue({
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' } },
    user: { id: 'user-1' },
  });
  getAISettings.mockResolvedValue({ enabled: true, behavior: 'act', categoryBehavior: {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('the manual "Make it happen" button', () => {
  it('a refused write is not ok — the button would tick itself done', async () => {
    createServer.mockResolvedValue(userClient({}, []));
    materializeConciergePlan.mockResolvedValue({ applied: [], failed: ['calendar'] });
    const res = await (await actions()).applyConciergePlanAction('plan-1', ['calendar']);
    expect(res.ok).toBe(false);
  });

  it('the genuine "already applied" stays ok with nothing applied', async () => {
    createServer.mockResolvedValue(userClient({}, []));
    materializeConciergePlan.mockResolvedValue({ applied: [], failed: [] });
    const res = await (await actions()).applyConciergePlanAction('plan-1', ['calendar']);
    expect(res).toEqual({ ok: true, applied: [] });
  });

  it('a refused plan read is not "Plan not found"', async () => {
    createServer.mockResolvedValue(userClient({ planError: { message: 'permission denied' } }, []));
    const res = await (await actions()).applyConciergePlanAction('plan-1', ['calendar']);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).not.toBe('Plan not found');
    expect(materializeConciergePlan).not.toHaveBeenCalled();
  });
});

describe('the autopilot on plan acceptance', () => {
  const accept = async () => (await actions()).planAcceptedAction('plan-1', 'draft', 'booked');

  it('a plan that did not land is recorded as failed, not "already in place"', async () => {
    const inserts: Record<string, unknown>[] = [];
    createServer.mockResolvedValue(userClient({}, []));
    createServiceClient.mockReturnValue(serviceClient(inserts));
    evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', basis: 'policy', reason: 'dial' }, approvalId: null });
    materializeConciergePlan.mockResolvedValue({ applied: [], failed: ['calendar', 'reminder', 'task'] });
    const res = await accept();
    expect(res.ok).toBe(false);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ state: 'failed', status: 'failed' });
    expect(String(inserts[0].summary)).not.toContain('already in place');
    expect(String(inserts[0].summary)).toContain('could not add');
  });

  it('a partial landing is recorded as partial, and names what is missing', async () => {
    const inserts: Record<string, unknown>[] = [];
    createServer.mockResolvedValue(userClient({}, []));
    createServiceClient.mockReturnValue(serviceClient(inserts));
    evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', basis: 'policy', reason: 'dial' }, approvalId: null });
    materializeConciergePlan.mockResolvedValue({ applied: ['reminder', 'task'], failed: ['calendar'] });
    const res = await accept();
    expect(res.ok).toBe(false);
    expect(inserts[0]).toMatchObject({ state: 'partially_completed', status: 'executed' });
    expect(String(inserts[0].summary)).toContain('could not add the calendar event');
  });

  it('a full landing is completed and ok', async () => {
    const inserts: Record<string, unknown>[] = [];
    createServer.mockResolvedValue(userClient({}, []));
    createServiceClient.mockReturnValue(serviceClient(inserts));
    evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', basis: 'policy', reason: 'dial' }, approvalId: null });
    materializeConciergePlan.mockResolvedValue({ applied: ['calendar', 'reminder', 'task'], failed: [] });
    const res = await accept();
    expect(res).toMatchObject({ ok: true, mode: 'auto' });
    expect(inserts[0]).toMatchObject({ state: 'completed', status: 'executed' });
  });

  it('a lost run record does not fail work that landed (not over-tightened)', async () => {
    const inserts: Record<string, unknown>[] = [];
    createServer.mockResolvedValue(userClient({}, []));
    createServiceClient.mockReturnValue(serviceClient(inserts, { message: 'insert refused' }));
    evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', basis: 'policy', reason: 'dial' }, approvalId: null });
    materializeConciergePlan.mockResolvedValue({ applied: ['reminder'], failed: [] });
    const res = await accept();
    expect(res.ok).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it('a refused ledger pre-check proceeds to the materializer, which is the authority', async () => {
    const inserts: Record<string, unknown>[] = [];
    createServer.mockResolvedValue(userClient({ ledgerError: { message: 'timeout' } }, []));
    createServiceClient.mockReturnValue(serviceClient(inserts));
    evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', basis: 'policy', reason: 'dial' }, approvalId: null });
    materializeConciergePlan.mockResolvedValue({ applied: ['reminder'], failed: [] });
    const res = await accept();
    expect(materializeConciergePlan).toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('"check the Autopilot panel" is not said over a queue row that was refused', async () => {
    const inserts: Record<string, unknown>[] = [];
    createServer.mockResolvedValue(userClient({}, []));
    createServiceClient.mockReturnValue(serviceClient(inserts, { message: 'insert refused' }));
    evaluateTrust.mockResolvedValue({ decision: { effect: 'require_approval', basis: 'policy', reason: 'dial' }, approvalId: 'appr-1' });
    const res = await accept();
    expect(res.ok).toBe(false);
  });

  it('a queued plan whose row landed is ok in ask mode', async () => {
    const inserts: Record<string, unknown>[] = [];
    createServer.mockResolvedValue(userClient({}, []));
    createServiceClient.mockReturnValue(serviceClient(inserts));
    evaluateTrust.mockResolvedValue({ decision: { effect: 'require_approval', basis: 'policy', reason: 'dial' }, approvalId: 'appr-1' });
    const res = await accept();
    expect(res).toMatchObject({ ok: true, mode: 'ask' });
    expect(inserts[0]).toMatchObject({ status: 'pending', state: 'awaiting_approval' });
  });
});

describe('approving a queued run', () => {
  const RUN = { id: 'run-1', status: 'pending', metadata: { plan_id: 'plan-1', kinds: ['calendar'] } };

  it('a plan that did not land leaves the run pending — the retry stays offered', async () => {
    const updates: Record<string, unknown>[] = [];
    createServer.mockResolvedValue(userClient({ run: RUN }, updates));
    materializeConciergePlan.mockResolvedValue({ applied: [], failed: ['calendar'] });
    const res = await (await actions()).executeQueuedRunAction('run-1');
    expect(res.ok).toBe(false);
    expect(updates.filter((u) => u.table === 'family_automation_runs'), 'stamped executed over a failure').toEqual([]);
  });

  it('a plan that landed stamps the run executed', async () => {
    const updates: Record<string, unknown>[] = [];
    createServer.mockResolvedValue(userClient({ run: RUN }, updates));
    materializeConciergePlan.mockResolvedValue({ applied: ['calendar'], failed: [] });
    const res = await (await actions()).executeQueuedRunAction('run-1');
    expect(res.ok).toBe(true);
    expect(updates.find((u) => u.table === 'family_automation_runs')).toMatchObject({ status: 'executed' });
  });
});
