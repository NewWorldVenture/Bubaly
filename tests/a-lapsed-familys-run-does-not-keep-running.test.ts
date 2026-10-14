// N8 — a run filed while the family had Ask Bubaly kept executing after it
// lapsed.
//
// The ai-runs cron claimed due runs and skipped only CLOSED families, so a run
// parked on an approval, a follow-up or a time budget kept writing to the
// household and calling the planner after the trial ended unpaid, the plan
// dropped below the feature's tier, or an admin switched Ask Bubaly Off — the
// very thing the answer, resume and re-run controls refuse to start. And the
// run page's Edit action restarted execution with no access check at all: the
// page checked when it rendered, so a page left open past the lapse could
// still kick the run.
//
// Driven through the real cron route (with `claim_ai_runs` emulated over the
// in-memory table, and the executor recorded rather than run) and through the
// real run page's edit action.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  executed: [] as string[],
  kicked: [] as string[],
  access: { ok: true } as Record<string, unknown>,
  actor: null as unknown,
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/ai/runs/executor', () => ({
  runGraph: async (runId: string) => { h.executed.push(runId); return { status: 'completed', completed: 1, failed: 0, pending: 0, awaitingApproval: 0 }; },
}));
vi.mock('@/lib/ai/planner/replan-port', () => ({ replanPortFor: () => null }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: (runId: string) => { h.kicked.push(runId); } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/auth')>()),
  requireUserContext: async () => h.actor,
}));
// The page's access gate, answered per call: the page renders while the
// family has Ask Bubaly, and the edit is sent after it lapsed.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  assertAIAccess: async () => h.access,
}));

const { GET: tick } = await import('@/app/api/cron/ai-runs/route');
// Loaded once, outside any case: the page's module graph is large.
const { default: RunDetailPage } = await import('@/app/(app)/dashboard/concierge/runs/[id]/page');

const PAID = '00000000-0000-4000-8000-0000000a8f01';
const LAPSED = '00000000-0000-4000-8000-0000000a8f02';
const FREE = '00000000-0000-4000-8000-0000000a8f03';
const NOW = Date.parse('2026-10-14T12:00:00Z');

let db: InMemorySupabase;

function claimAiRuns(args: Record<string, unknown>, mem: InMemorySupabase): string[] {
  const now = Date.now();
  const due = mem.table('family_automation_runs')
    .filter((r) => (r.state === 'ready' || r.state === 'scheduled_followup') && Date.parse(String(r.run_after)) <= now && r.lease_expires_at == null)
    .slice(0, Number(args.p_limit ?? 10));
  for (const r of due) Object.assign(r, { state: 'executing', lease_owner: `lease-${r.id}`, lease_expires_at: new Date(now + 180_000).toISOString(), attempt: Number(r.attempt) + 1 });
  return due.map((r) => String(r.id));
}

function runOf(familyId: string, id: string): Row {
  return {
    id, family_id: familyId, plan_id: null, request_id: null, run_type: 'concierge', state: 'ready', status: 'approved',
    run_after: new Date(NOW - 60_000).toISOString(), lease_owner: null, lease_expires_at: null, attempt: 1, max_attempts: 5, cancel_requested_at: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ rpc: { claim_ai_runs: claimAiRuns } });
  h.db = db;
  h.executed = [];
  h.kicked = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [
    { id: PAID, name: 'Paid', timezone: 'UTC', trial_ends_at: null, closed_at: null },
    // A five-day trial that ended unpaid.
    { id: LAPSED, name: 'Lapsed', timezone: 'UTC', trial_ends_at: new Date(NOW - 86_400_000).toISOString(), closed_at: null },
    // Free: below Ask Bubaly's Family Basic tier.
    { id: FREE, name: 'Free', timezone: 'UTC', trial_ends_at: null, closed_at: null },
  ]);
  db.seed('subscriptions', [{ id: 'sub-paid', family_id: PAID, plan: 'basic', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]);
  db.seed('family_automation_runs', [runOf(PAID, 'run-paid'), runOf(LAPSED, 'run-lapsed'), runOf(FREE, 'run-free')]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const request = () => new NextRequest('https://bubaly.test/api/cron/ai-runs', { headers: { authorization: 'Bearer x' } });
const row = (id: string) => db.table('family_automation_runs').find((r) => r.id === id) as Row;

describe('the ai-runs cron', () => {
  it('executes only the runs of families that still have Ask Bubaly, and puts the rest back a day out', async () => {
    const res = await tick(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(h.executed).toEqual(['run-paid']);
    expect(body).toMatchObject({ executed: 1, deferredUnentitled: 2 });
    for (const id of ['run-lapsed', 'run-free']) {
      // Put back, not cancelled: subscribing again picks the run up.
      expect(row(id)).toMatchObject({ state: 'ready', lease_owner: null, lease_expires_at: null });
      expect(Date.parse(String(row(id).run_after))).toBeGreaterThanOrEqual(NOW + 23 * 60 * 60_000);
    }
  });

  it('executes nothing when an admin has switched Ask Bubaly off', async () => {
    db.seed('app_settings', [{ key: 'feature_tiers', value: { 'ai-requests': 'off' } }]);

    const body = await (await tick(request())).json();

    expect(h.executed).toEqual([]);
    expect(body).toMatchObject({ executed: 0, deferredUnentitled: 3 });
  });

  it('runs nothing in a wave whose families’ plans cannot be read, and says so', async () => {
    db.replace('families', db.table('families').filter((f) => f.id !== LAPSED));

    const res = await tick(request());

    expect(res.status).toBe(502);
    expect(h.executed).toEqual([]);
    expect(row('run-paid')).toMatchObject({ state: 'ready', lease_owner: null });
  });
});

describe('the run page’s Edit action', () => {
  const REQUEST = '00000000-0000-4000-8000-0000000a8f31';
  const PLAN = '00000000-0000-4000-8000-0000000a8f32';
  const RUN = '00000000-0000-4000-8000-0000000a8f33';
  const PARENT = { member: '00000000-0000-4000-8000-0000000a8f11', user: '00000000-0000-4000-8000-0000000a8f21' };

  beforeEach(() => {
    db.seed('family_members', [{ id: PARENT.member, family_id: PAID, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' }]);
    db.seed('ai_requests', [{ id: REQUEST, family_id: PAID, requested_by: PARENT.user, requested_by_member_id: PARENT.member, kind: 'concierge', request_text: 'Saturday', status: 'blocked' }]);
    db.seed('ai_plans', [{ id: PLAN, family_id: PAID, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
    db.seed('ai_plan_steps', [{
      id: 'step-1', family_id: PAID, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: 'tasks.createTodo', description: 'Pack the kit',
      input_json: { title: 'Pack the kit' }, dependency_ids: [], condition: null, status: 'failed', approval_required: false, approval_id: null,
      risk_level: 'low', retry_count: 0, max_retries: 0, result_json: null, error: 'Timed out',
    }]);
    db.seed('family_automation_runs', [{
      ...runOf(PAID, RUN), plan_id: PLAN, request_id: REQUEST, state: 'blocked', requested_by_member_id: PARENT.member, created_by: PARENT.user,
    }]);
    h.actor = {
      user: { id: PARENT.user, email: 'dana@example.test' },
      active: { familyId: PAID, role: 'parent', member: { id: PARENT.member, display_name: 'Dana' }, family: { id: PAID, name: 'Paid', timezone: 'UTC' } },
    };
  });

  /** The page as it rendered for the family while it had Ask Bubaly, and the edit action it handed to the controls. */
  async function renderedEditAction(): Promise<(stepId: string, edits: Record<string, string>) => Promise<{ ok: boolean; code?: string }>> {
    h.access = { ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null };
    const tree = await RunDetailPage({ params: Promise.resolve({ id: RUN }) });
    const found: unknown[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const props = (node as { props?: Record<string, unknown> }).props;
      if (!props) return;
      if (typeof props.onEditStep === 'function') found.push(props.onEditStep);
      walk(props.children);
    };
    walk(tree);
    expect(found).toHaveLength(1);
    return found[0] as never;
  }

  it('refuses an edit sent after the family lost Ask Bubaly, and restarts nothing', async () => {
    const edit = await renderedEditAction();
    h.access = { ok: false, status: 403, code: 'trial_expired', needLevel: 1, error: 'Your free trial has ended.' };

    const result = await edit('step-1', { title: 'Pack the shin guards' });

    expect(result).toMatchObject({ ok: false, code: 'trial_expired' });
    expect(h.kicked).toEqual([]);
    expect(db.table('ai_plans')).toHaveLength(1);
    expect(row(RUN)).toMatchObject({ plan_id: PLAN, state: 'blocked' });
  });

  it('control: the same edit goes through while the family has it', async () => {
    const edit = await renderedEditAction();

    const result = await edit('step-1', { title: 'Pack the shin guards' });

    expect(result).toMatchObject({ ok: true });
    expect(h.kicked).toEqual([RUN]);
    expect(row(RUN).plan_id).not.toBe(PLAN);
  });
});
