// One subject's refused row write is that subject's failure, not the platform's.
//
// /api/cron/automations → runAutomations walked every workflow's subjects in
// one loop and `throw`-ed on any claim, reservation or record write that was
// refused. The throw left the function, so every subject after this family in
// this workflow AND every later workflow were skipped for the day, and the
// route answered 500. The row it had reserved stayed `running`, and a
// `running` row was skipped for ever on every later pass: no reaper exists, so
// that family's workflow froze — the same stranding a function killed
// mid-loop left behind, with no maxDuration or budget on the route.
//
// Behavioural, against the in-memory database: the second subject still gets
// its email after the first subject's record write is refused, the refused row
// is moved on rather than left `running`, a stale `running` row is re-claimed
// by exactly one of two passes, and the route reports the tail its budget cut
// off as `unserved` with a 502.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { MarketingCustomer } from '@/lib/marketing/customers';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  customers: [] as MarketingCustomer[],
  sends: [] as string[],
  db: null as unknown,
  /** The clock moves this far inside every send: how a run outgrows its budget. */
  sendTakesMs: 0,
}));

vi.mock('@/lib/marketing/customers', () => ({
  getMarketingCustomersWithError: async () => ({ customers: h.customers, error: null }),
}));
vi.mock('@/lib/marketing/automation-steps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/marketing/automation-steps')>()),
  // As the real runSteps: a step the earlier attempt delivered (`previous`) is not sent again.
  runSteps: async (steps: unknown[], recipient: { email: string | null }, _copy: unknown, _db: unknown, _admit: unknown, previous: readonly string[] = []) => {
    if (h.sendTakesMs) vi.setSystemTime(Date.now() + h.sendTakesMs);
    return steps.map((_, i) => {
      if (previous[i] !== 'send_email') h.sends.push(recipient.email ?? '');
      return 'send_email';
    });
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/rate-limit-db', () => ({ pruneRateLimits: async () => true }));

import { runAutomations, STALE_RUNNING_MS } from '@/lib/marketing/automation-runner';
import { GET } from '@/app/api/cron/automations/route';

type DB = SupabaseClient<Database>;
const DAY = 86_400_000;
const NOW = new Date('2026-10-20T13:00:00.000Z');

function inactive(familyId: string): MarketingCustomer {
  return {
    familyId, name: `Family ${familyId}`, ownerEmail: `${familyId}@synthetic.invalid`, memberCount: 3, plan: 'basic', planLabel: 'Basic',
    status: 'active', lifecycle: 'active', estLtvCents: 0,
    createdAt: new Date(NOW.getTime() - 200 * DAY).toISOString(),
    lastActivityAt: new Date(NOW.getTime() - 60 * DAY).toISOString(),
  } as MarketingCustomer;
}

function withWorkflow(): InMemorySupabase {
  const db = createInMemorySupabase({ uniques: { marketing_automation_runs: [['workflow_id', 'subject_key']] } });
  db.seed('marketing_automation_workflows', [{
    id: 'wf-1', trigger: 'customer_inactive', status: 'active', deleted_at: null, steps: [{ action: 'send_email' }], run_count: 0,
  }]);
  return db;
}
const runs = (db: InMemorySupabase) => db.table('marketing_automation_runs');
const runFor = (db: InMemorySupabase, familyId: string) => runs(db).find((r) => r.subject_key === familyId);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.customers = [inactive('fam-1'), inactive('fam-2')];
  h.sends = [];
  h.sendTakesMs = 0;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a subject whose record write is refused', () => {
  it('is the only subject that fails: the next subject still gets its email, and the run says one failed', async () => {
    const db = withWorkflow();
    let refused = false;
    // The FIRST record write (the completed/failed stamp after the steps ran)
    // is refused; every other write on the table lands.
    const faulty = withFaults(db, (table, calls) => {
      if (table !== 'marketing_automation_runs' || refused) return null;
      const patch = calls.find((c) => c.method === 'update')?.args[0] as { status?: string } | undefined;
      if (patch?.status !== 'completed') return null;
      refused = true;
      return { code: '57014', message: 'canceling statement due to statement timeout' };
    });

    const summary = await runAutomations(faulty as unknown as DB);

    expect(h.sends, 'the second subject was never reached').toEqual(['fam-1@synthetic.invalid', 'fam-2@synthetic.invalid']);
    expect(summary).toMatchObject({ workflows: 1, runs: 1, failures: 1, unserved: 0 });
    expect(runFor(db, 'fam-2')).toMatchObject({ status: 'completed' });
  });

  it('does not leave its row `running`: the fallback stamp moves it to failed with its receipts, so the next pass retries only what did not go out', async () => {
    const db = withWorkflow();
    let refused = false;
    const faulty = withFaults(db, (table, calls) => {
      if (table !== 'marketing_automation_runs' || refused) return null;
      const patch = calls.find((c) => c.method === 'update')?.args[0] as { status?: string } | undefined;
      if (patch?.status !== 'completed') return null;
      refused = true;
      return { code: '57014', message: 'canceling statement due to statement timeout' };
    });
    await runAutomations(faulty as unknown as DB);

    const row = runFor(db, 'fam-1');
    expect(row?.status, 'left running, the subject is skipped for ever').toBe('failed');
    expect((row?.metadata as { actions?: string[] }).actions).toEqual(['send_email']);

    // The retry claims the failed row and sends nothing again: the receipt says the email went.
    h.sends = [];
    const summary = await runAutomations(db as unknown as DB);
    expect(h.sends).toEqual([]);
    expect(summary).toMatchObject({ runs: 1, failures: 0 });
    expect(runFor(db, 'fam-1')).toMatchObject({ status: 'completed' });
  });
});

describe('a `running` row is a lease, not a verdict', () => {
  it('a row left running longer than the stale threshold is re-claimed and run; a fresh one is another pass at work', async () => {
    const db = withWorkflow();
    const stale = new Date(NOW.getTime() - STALE_RUNNING_MS - 60_000).toISOString();
    db.seed('marketing_automation_runs', [
      // Reserved by a pass that was killed mid-steps: no claim stamp, an old row.
      { id: 'run-stale', workflow_id: 'wf-1', status: 'running', subject_key: 'fam-1', metadata: { trigger: 'customer_inactive' }, created_at: stale },
      // Reserved a moment ago by a pass still running.
      { id: 'run-fresh', workflow_id: 'wf-1', status: 'running', subject_key: 'fam-2', metadata: { trigger: 'customer_inactive', claimedAt: NOW.toISOString() } },
    ]);

    const summary = await runAutomations(db as unknown as DB);

    expect(h.sends, 'the stale row froze the workflow for this family').toEqual(['fam-1@synthetic.invalid']);
    expect(summary).toMatchObject({ runs: 1, failures: 0 });
    expect(runs(db).find((r) => r.id === 'run-stale')).toMatchObject({ status: 'completed' });
    expect(runs(db).find((r) => r.id === 'run-fresh')).toMatchObject({ status: 'running' });
  });

  it('two passes that both read the stale row re-claim it once: the fence is the metadata as read', async () => {
    const db = withWorkflow();
    h.customers = [inactive('fam-1')];
    db.seed('marketing_automation_runs', [
      { id: 'run-stale', workflow_id: 'wf-1', status: 'running', subject_key: 'fam-1', metadata: { trigger: 'customer_inactive' },
        created_at: new Date(NOW.getTime() - STALE_RUNNING_MS - 60_000).toISOString() },
    ]);
    const [a, b] = await Promise.all([runAutomations(db as unknown as DB), runAutomations(db as unknown as DB)]);
    expect(h.sends).toEqual(['fam-1@synthetic.invalid']);
    expect(a.runs + b.runs).toBe(1);
    expect(a.failures + b.failures).toBe(0);
  });
});

describe('the route is budgeted', () => {
  it('stops starting subjects once the budget is spent, counts the tail as unserved and answers 502', async () => {
    const db = withWorkflow();
    h.db = db;
    h.customers = [inactive('fam-1'), inactive('fam-2'), inactive('fam-3')];
    // One send outlives the route's whole budget.
    h.sendTakesMs = 250_000;

    const res = await GET(new Request('https://bubaly.test/api/cron/automations') as never);

    expect(res.status, 'an unserved tail looked like a clean run').toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, runs: 1, failures: 0, unserved: 2 });
    expect(h.sends).toEqual(['fam-1@synthetic.invalid']);
  });

  it('declares its own maxDuration rather than inheriting the platform default', async () => {
    const route = await import('@/app/api/cron/automations/route');
    expect(route.maxDuration).toBe(300);
  });
});
