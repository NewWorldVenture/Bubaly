// `executeTool` is the choke point every AI write goes through, so these tests
// are about the ORDER of its steps and what each one refuses to let past:
//
//   • an unknown tool denies instead of quietly doing nothing;
//   • invalid arguments never reach the database;
//   • a household policy outranks the risk tier, and the risk tier outranks
//     the generic role matrix;
//   • a repeated call under one idempotency key executes once;
//   • every executed write leaves an `ai_tool_calls` row, success or failure.
//
// Two fakes stand in for Supabase: the caller's client (trust tables + the
// domain tables the services write) and the service-role client the ledger is
// written with, which is mocked at the module boundary because production code
// must never be able to write that ledger with a member's client.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';

const ledgerHolder = vi.hoisted(() => ({ client: null as SupabaseClient<Database> | null }));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!ledgerHolder.client) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return ledgerHolder.client;
  },
}));

const { executeTool } = await import('@/lib/ai/tools/execute');

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

/** Chainable PostgREST fake; every builder is thenable so both terminal styles resolve. */
function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, ilike: chain, or: chain,
      eq: filter, is: filter, in: filter,
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gt: (c: string, v: unknown) => filter(`gt:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

type LedgerRow = Record<string, unknown> & { id: string; state: string; attempt: number; idempotency_key: string; family_id: string };

/** An in-memory `ai_tool_calls` with the real unique key, so conflicts behave like 0250. */
function makeLedger(seed: LedgerRow[] = [], opts: { pendingApproval?: string } = {}) {
  const rows: LedgerRow[] = [...seed];
  let counter = 0;
  const { db, calls } = makeDb((call) => {
    // Trust rows are filed through this client too (0252): answer like the
    // family fake did so the same ids and payloads can be asserted.
    if (call.table === 'approval_requests') {
      // Since 0273 the filer LOOKS FIRST for a pending row with the same
      // dedupe_key. Answering a select the same way as an insert made that
      // lookup always hit, so no card was ever filed — model the real table
      // instead: nothing pending unless a test says so.
      if (call.kind === 'select') {
        return { data: opts.pendingApproval ? { id: opts.pendingApproval } : null, error: null };
      }
      return { data: { id: 'appr-1' }, error: null };
    }
    if (call.table !== 'ai_tool_calls') return { data: null, error: null };
    if (call.kind === 'insert') {
      const payload = call.payload as LedgerRow;
      const clash = rows.find((r) => r.family_id === payload.family_id && r.idempotency_key === payload.idempotency_key);
      if (clash) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_ai_tool_calls_idempotency"' } };
      const row = { ...payload, id: `call-${++counter}` };
      rows.push(row);
      return { data: { id: row.id }, error: null };
    }
    if (call.kind === 'select') {
      const row = rows.find((r) => r.family_id === call.filters.family_id && r.idempotency_key === call.filters.idempotency_key);
      return { data: row ?? null, error: null };
    }
    if (call.kind === 'update') {
      const row = rows.find((r) => r.id === call.filters.id);
      if (!row) return { data: null, error: null };
      // The optimistic guard the takeover relies on.
      if (call.filters.state !== undefined && row.state !== call.filters.state) return { data: null, error: null };
      Object.assign(row, call.payload as Record<string, unknown>);
      return { data: { id: row.id }, error: null };
    }
    return { data: null, error: null };
  });
  const made = { db, calls, rows };
  currentLedger = made;
  return made;
}

/** The most recent ledger fake: where approval and audit rows land now. */
let currentLedger: { calls: Call[] } = { calls: [] };
/** Every trust write a test can observe, whichever client filed it. */
const trustCalls = (family: { calls: Call[] }) => [...family.calls, ...currentLedger.calls];

const NOW = new Date('2026-09-05T12:00:00Z');

const EVENT_ROW = {
  id: 'event-1', family_id: 'fam-1', title: 'Soccer', description: null, location: null,
  category: 'sports', starts_at: '2026-09-06T13:00:00.000Z', ends_at: null,
  all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: null,
  feed_id: null, external_uid: null, created_by: 'auth-1', onboarding_key: null,
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};

type PolicyRow = Record<string, unknown>;

/** The caller's client: trust tables plus whatever domain rows a test needs. */
function makeFamilyDb(options: { policies?: PolicyRow[]; domain?: (call: Call) => Reply | null } = {}) {
  return makeDb((call) => {
    switch (call.table) {
      case 'trust_policies': return { data: options.policies ?? [], error: null };
      case 'permission_grants': return { data: [], error: null };
      case 'trust_delegations': return { data: [], error: null };
      case 'emergency_sessions': return { data: [], error: null };
      case 'approval_requests':
        // See makeLedger: a pre-check select must not answer like an insert.
        return call.kind === 'select' ? { data: null, error: null } : { data: { id: 'appr-1' }, error: null };
      case 'trust_audit_logs': return { data: null, error: null };
      case 'agent_activity': return { data: { id: 'activity-1' }, error: null };
      default: return options.domain?.(call) ?? { data: null, error: null };
    }
  });
}

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db,
    familyId: 'fam-1',
    userId: 'auth-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'ai',
    tz: 'America/New_York',
    now: NOW,
    ...extra,
  };
}

const CREATE_EVENT_ARGS = { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z', category: 'sports' };

/** Serves the calendar tables for a successful create, delete and verify. */
const calendarDomain = (call: Call): Reply | null => {
  if (call.table !== 'calendar_events') return null;
  if (call.kind === 'select' && call.filters.idempotency_key !== undefined) {
    // The service's own duplicate probe (0256) asks whether THIS call already
    // wrote its row; in these tests it never has.
    return { data: null, error: null };
  }
  return { data: EVENT_ROW, error: null };
};

beforeEach(() => {
  const ledger = makeLedger();
  ledgerHolder.client = ledger.db;
});

describe('default deny', () => {
  it('denies an unknown tool without touching anything', async () => {
    const family = makeFamilyDb();
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'finances.transferMoney', { amount: 100 });

    expect(outcome).toMatchObject({ status: 'denied', toolCallId: null });
    expect(outcome.status === 'denied' && outcome.reason).toMatch(/no tool called/i);
    expect(family.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  it('rejects invalid arguments before any query runs', async () => {
    const family = makeFamilyDb();
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'calendar.createEvent', { starts_at: '2026-09-06T13:00:00Z' });

    expect(outcome).toMatchObject({ status: 'error', retryable: false, toolCallId: null });
    expect(outcome.status === 'error' && outcome.error).toMatch(/arguments it cannot use/i);
    expect(family.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  it('reports the failure instead of writing when the ledger cannot be reached', async () => {
    ledgerHolder.client = null; // a deployment with no service-role key
    const family = makeFamilyDb({ domain: calendarDomain });

    const outcome = await executeTool(scopeWith(family.db), 'calendar.createEvent', CREATE_EVENT_ARGS);

    expect(outcome).toMatchObject({ status: 'error', retryable: true });
    expect(family.calls.some((c) => c.table === 'calendar_events')).toBe(false);
  });
});

describe('allowed writes', () => {
  it('executes, records the ledger row and verifies the change', async () => {
    const family = makeFamilyDb({ domain: calendarDomain });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'calendar.createEvent', CREATE_EVENT_ARGS);

    expect(outcome.status).toBe('ok');
    expect(outcome.status === 'ok' && outcome.summary).toBe('Added Soccer at 9:00 AM Sunday');
    expect(outcome.status === 'ok' && outcome.verified).toBe(true);

    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      family_id: 'fam-1',
      tool_name: 'calendar.createEvent',
      actor_kind: 'ai',
      state: 'succeeded',
      attempt: 1,
      resource_table: 'calendar_events',
      resource_id: 'event-1',
      error: null,
    });
    expect(ledger.rows[0].idempotency_key).toEqual(expect.any(String));
    expect(typeof ledger.rows[0].duration_ms).toBe('number');
    expect((ledger.rows[0].outputs as { result: { title: string } }).result.title).toBe('Soccer');
  });

  it('does not add a second activity line when the service already wrote one', async () => {
    const family = makeFamilyDb({ domain: calendarDomain });
    await executeTool(scopeWith(family.db), 'calendar.createEvent', CREATE_EVENT_ARGS);
    expect(family.calls.filter((c) => c.table === 'agent_activity')).toHaveLength(1);
  });

  it('writes the activity line itself for services that record none', async () => {
    // `routines.pause` is one of the tools whose service records nothing, so the
    // executor is the only thing standing between it and an unrecorded change.
    // `groceries.checkItem` used to be the example here and no longer is: its
    // service records now, which is what the case below asserts.
    const family = makeFamilyDb({
      domain: (call) => (call.table === 'family_automation_rules'
        ? {
          data: {
            id: 'rule-1', family_id: 'fam-1', name: 'Sunday meal plan', said: 'every Sunday plan our meals',
            action_config: { prompt: 'plan our meals' }, is_enabled: false, next_run_at: null,
            schedule_kind: 'cron', schedule_expr: '0 17 * * 0', anchor_key: null, offset_days: null, at_hour: null,
          },
          error: null,
        }
        : null),
    });

    const outcome = await executeTool(scopeWith(family.db), 'routines.pause', { routine_id: 'rule-1', enabled: false });

    expect(outcome).toMatchObject({ status: 'ok' });
    const activity = family.calls.find((c) => c.table === 'agent_activity');
    expect(activity?.payload).toMatchObject({ family_id: 'fam-1', agent: 'scheduling' });
  });

  it('leaves the line to the service for a tick-off, and writes exactly one', async () => {
    // The tick-off verbs moved their record INTO the service so a person doing
    // it is on the household trail too. The executor must then stand down, or
    // the assistant's path would get two entries for one action.
    const family = makeFamilyDb({
      domain: (call) => (call.table === 'grocery_items'
        ? { data: { id: 'item-1', name: 'Milk', quantity: null, category: 'Dairy', is_checked: true }, error: null }
        : null),
    });

    const outcome = await executeTool(scopeWith(family.db), 'groceries.checkItem', { item_id: 'item-1' });

    expect(outcome).toMatchObject({ status: 'ok', summary: 'Ticked Milk off the list' });
    expect(family.calls.filter((c) => c.table === 'agent_activity')).toHaveLength(1);
    // The service's own copy, not the executor's generic summary.
    const activity = family.calls.find((c) => c.table === 'agent_activity');
    expect(activity?.payload).toMatchObject({
      family_id: 'fam-1', agent: 'groceries', title: 'Ticked Milk off the shopping list',
    });
  });

  it('evaluates a cron actor as an adult rather than a guest, so routine work still runs', async () => {
    const family = makeFamilyDb({ domain: calendarDomain });
    const outcome = await executeTool(
      scopeWith(family.db, { role: 'system', actorKind: 'system', userId: null, memberId: null }),
      'calendar.createEvent',
      CREATE_EVENT_ARGS,
    );
    expect(outcome.status).toBe('ok');
    const audit = trustCalls(family).find((c) => c.table === 'trust_audit_logs');
    expect(audit?.payload).toMatchObject({ actor_kind: 'ai_agent', capability: 'automate', decision: 'allow' });
  });

  it('records a failed ledger row when the service cannot write', async () => {
    const family = makeFamilyDb({
      domain: (call) => (call.table === 'calendar_events'
        ? { data: null, error: { code: '42501', message: 'permission denied for table calendar_events' } }
        : null),
    });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'calendar.createEvent', CREATE_EVENT_ARGS);

    expect(outcome.status).toBe('error');
    expect(ledger.rows[0]).toMatchObject({ state: 'failed', tool_name: 'calendar.createEvent' });
    expect(ledger.rows[0].error).toEqual(expect.any(String));
  });
});

describe('trust gate', () => {
  it('denies when a household policy says no, and nothing is written or reserved', async () => {
    const family = makeFamilyDb({
      policies: [{
        id: 'pol-1', domain: 'calendar', capability: 'all', subject_kind: 'ai',
        effect: 'deny', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 100, enabled: true,
      }],
      domain: calendarDomain,
    });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'calendar.createEvent', CREATE_EVENT_ARGS);

    expect(outcome).toMatchObject({ status: 'denied' });
    expect(family.calls.some((c) => c.table === 'calendar_events')).toBe(false);
    expect(ledger.rows).toHaveLength(0);
    expect(trustCalls(family).some((c) => c.table === 'trust_audit_logs')).toBe(true);
  });

  it('a household policy outranks the risk tier — a deny still denies a low-risk tool', async () => {
    const family = makeFamilyDb({
      policies: [{
        id: 'pol-2', domain: 'tasks', capability: 'automate', subject_kind: 'ai',
        effect: 'deny', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 50, enabled: true,
      }],
    });

    const outcome = await executeTool(scopeWith(family.db, { role: 'teen' }), 'add_todo', { task: 'Take out the bins' });

    expect(outcome).toMatchObject({ status: 'denied' });
    expect(family.calls.some((c) => c.table === 'todo_items')).toBe(false);
  });

  it('a blanket allow cannot clear a high-risk tool — the tier still holds it for a person', async () => {
    // The Trust form lets any manager save a policy with domain `all` and
    // effect `allow`. That row used to short-circuit the risk tier entirely, so
    // every destructive, expensive or irreversible tool ran with nobody asked.
    const family = makeFamilyDb({
      policies: [{
        id: 'pol-blanket', domain: 'all', capability: 'all', subject_kind: 'ai',
        effect: 'allow', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 100, enabled: true,
      }],
      domain: calendarDomain,
    });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'calendar.deleteEvent', { event_id: 'event-1' });

    expect(outcome).toMatchObject({ status: 'pending_approval' });
    expect(family.calls.some((c) => c.table === 'calendar_events' && c.kind === 'delete')).toBe(false);
  });

  it('a policy that names the area it governs still decides — that is what a policy is for', async () => {
    const family = makeFamilyDb({
      policies: [{
        id: 'pol-specific', domain: 'calendar', capability: 'automate', subject_kind: 'ai',
        effect: 'allow', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 100, enabled: true,
      }],
      domain: calendarDomain,
    });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'calendar.deleteEvent', { event_id: 'event-1' });

    expect(outcome).toMatchObject({ status: 'ok' });
  });

  it('reuses the pending card on a resend instead of filing a second one', async () => {
    // The other half of 0273. This filer opens a row when the RISK TIER
    // tightened an `allow`, and left keyless it would keep filing duplicate
    // cards on the registry path while the chat path was fixed. A parent who
    // sees two identical cards approves both, and the resource is written twice.
    const family = makeFamilyDb({ domain: calendarDomain });
    const ledger = makeLedger([], { pendingApproval: 'appr-existing' });
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'calendar.deleteEvent', { event_id: 'event-1' });

    expect(outcome).toMatchObject({ status: 'pending_approval', approvalId: 'appr-existing' });
    expect(trustCalls(family).some((c) => c.table === 'approval_requests' && c.kind === 'insert')).toBe(false);
  });

  it('holds a high-risk tool for approval and stores the payload so it can execute later', async () => {
    const family = makeFamilyDb({ domain: calendarDomain });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'calendar.deleteEvent', { event_id: 'event-1' });

    expect(outcome).toMatchObject({ status: 'pending_approval', approvalId: 'appr-1', toolCallId: null });
    // Nothing was deleted and no idempotency key was burned on an unexecuted call.
    expect(family.calls.some((c) => c.table === 'calendar_events' && c.kind === 'delete')).toBe(false);
    expect(ledger.rows).toHaveLength(0);

    const approval = trustCalls(family).find((c) => c.table === 'approval_requests' && c.kind === 'insert');
    expect(approval?.payload).toMatchObject({
      family_id: 'fam-1',
      domain: 'calendar',
      capability: 'automate',
      payload_kind: 'tool',
      status: 'pending',
      payload: { name: 'calendar.deleteEvent', args: { event_id: 'event-1' } },
    });
    expect((approval?.payload as { consequences: string[] }).consequences.length).toBeGreaterThan(0);

    // The tier's decision is auditable, not just the engine's.
    const audits = trustCalls(family).filter((c) => c.table === 'trust_audit_logs');
    expect(audits.some((c) => (c.payload as { context: { basis: string } }).context.basis === 'risk_tier')).toBe(true);
  });

  it('attaches consequences to an approval the trust engine opened', async () => {
    const family = makeFamilyDb({
      policies: [{
        id: 'pol-3', domain: 'calendar', capability: 'automate', subject_kind: 'ai',
        effect: 'require_approval', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 100, enabled: true,
      }],
      domain: calendarDomain,
    });

    const outcome = await executeTool(scopeWith(family.db), 'calendar.updateEvent', { event_id: 'event-1', title: 'Soccer practice' });

    expect(outcome).toMatchObject({ status: 'pending_approval', approvalId: 'appr-1' });
    const patch = trustCalls(family).find((c) => c.table === 'approval_requests' && c.kind === 'update');
    expect((patch?.payload as { consequences: string[] }).consequences.length).toBeGreaterThan(0);
  });

  it("lets a teen's small task through, which ROLE_DEFAULTS alone would deny", async () => {
    const family = makeFamilyDb({
      domain: (call) => {
        if (call.table === 'todo_lists') return { data: { id: 'list-1' }, error: null };
        if (call.table === 'todo_items') {
          return {
            data: {
              id: 'todo-1', family_id: 'fam-1', list_id: 'list-1', title: 'Take out the bins', notes: null,
              is_done: false, due_date: null, priority: 'medium', assigned_to_id: 'member-1', created_by: 'member-1',
              tags: [], completed_at: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
            },
            error: null,
          };
        }
        return null;
      },
    });

    const outcome = await executeTool(scopeWith(family.db, { role: 'teen' }), 'add_todo', { task: 'Take out the bins' });

    expect(outcome).toMatchObject({ status: 'ok', summary: 'Added the task Take out the bins' });
    const audit = trustCalls(family).find((c) => c.table === 'trust_audit_logs');
    // The engine itself refused (a teen has no `automate` capability); the risk
    // tier is what let a low-risk task through, and both are recorded.
    expect(audit?.payload).toMatchObject({ decision: 'deny' });
    const tierAudit = trustCalls(family).filter((c) => c.table === 'trust_audit_logs')
      .find((c) => (c.payload as { context: { basis: string } }).context.basis === 'risk_tier');
    expect(tierAudit?.payload).toMatchObject({ decision: 'allow' });
  });

  it('lets read-only tools through without a gate or a ledger row', async () => {
    const family = makeFamilyDb({
      domain: (call) => (call.table === 'calendar_events' ? { data: [EVENT_ROW], error: null } : null),
    });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'list_upcoming_events', {});

    expect(outcome).toMatchObject({ status: 'ok', toolCallId: null });
    expect(outcome.status === 'ok' && outcome.summary).toMatch(/Found 1 event/);
    expect(family.calls.some((c) => c.table === 'trust_policies')).toBe(false);
    expect(ledger.calls).toHaveLength(0);
  });
});

describe('idempotency', () => {
  const KEY = 'run-1:step-1:create-soccer';

  it('executes once when the same call is repeated under one key', async () => {
    const family = makeFamilyDb({ domain: calendarDomain });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;
    const scope = scopeWith(family.db);

    const first = await executeTool(scope, 'calendar.createEvent', CREATE_EVENT_ARGS, { idempotencyKey: KEY });
    const second = await executeTool(scope, 'calendar.createEvent', CREATE_EVENT_ARGS, { idempotencyKey: KEY });

    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    expect(second.status === 'ok' && second.data).toMatchObject({ id: 'event-1' });
    // One row written, one ledger entry, one execution.
    expect(family.calls.filter((c) => c.table === 'calendar_events' && c.kind === 'insert')).toHaveLength(1);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].attempt).toBe(1);
  });

  it('replays the recorded summary rather than inventing one', async () => {
    const family = makeFamilyDb({ domain: calendarDomain });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;
    const scope = scopeWith(family.db);

    await executeTool(scope, 'calendar.createEvent', CREATE_EVENT_ARGS, { idempotencyKey: KEY });
    const replay = await executeTool(scope, 'calendar.createEvent', CREATE_EVENT_ARGS, { idempotencyKey: KEY });

    expect(replay.status === 'ok' && replay.summary).toBe('Added Soccer at 9:00 AM Sunday');
  });

  it('refuses to run while another worker holds the reservation', async () => {
    const family = makeFamilyDb({ domain: calendarDomain });
    const ledger = makeLedger([{
      id: 'call-existing', family_id: 'fam-1', idempotency_key: KEY, state: 'reserved', attempt: 1,
      // A lease is measured against real elapsed time, not the family's clock:
      // it exists to detect a worker that died, and a test clock must not make
      // a live reservation look abandoned.
      locked_at: new Date().toISOString(), tool_name: 'calendar.createEvent',
    }]);
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'calendar.createEvent', CREATE_EVENT_ARGS, { idempotencyKey: KEY });

    expect(outcome).toMatchObject({ status: 'error', retryable: true });
    expect(outcome.status === 'error' && outcome.error).toMatch(/already doing that/i);
    expect(family.calls.some((c) => c.table === 'calendar_events' && c.kind === 'insert')).toBe(false);
  });

  it('takes over a failed reservation so a retry actually re-executes', async () => {
    const family = makeFamilyDb({ domain: calendarDomain });
    const ledger = makeLedger([{
      id: 'call-existing', family_id: 'fam-1', idempotency_key: KEY, state: 'failed', attempt: 1,
      locked_at: new Date(Date.now() - 60_000).toISOString(), tool_name: 'calendar.createEvent',
    }]);
    ledgerHolder.client = ledger.db;

    const outcome = await executeTool(scopeWith(family.db), 'calendar.createEvent', CREATE_EVENT_ARGS, { idempotencyKey: KEY });

    expect(outcome.status).toBe('ok');
    expect(family.calls.filter((c) => c.table === 'calendar_events' && c.kind === 'insert')).toHaveLength(1);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ id: 'call-existing', state: 'succeeded', attempt: 2 });
  });

  it('lets the same words on a later turn execute again — a family adding milk twice means it', async () => {
    const family = makeFamilyDb({
      domain: (call) => {
        if (call.table === 'grocery_lists') return { data: { id: 'list-1' }, error: null };
        if (call.table === 'grocery_items' && call.kind === 'select') return { data: [], error: null };
        if (call.table === 'grocery_items' && call.kind === 'insert') {
          return { data: [{ id: 'item-1', name: 'Milk', quantity: null, category: 'Dairy', is_checked: false }], error: null };
        }
        return null;
      },
    });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;
    const scope = scopeWith(family.db);

    // No run, step, request or caller key: two separate chat turns.
    await executeTool(scope, 'add_grocery_item', { item: 'Milk' });
    await executeTool(scope, 'add_grocery_item', { item: 'Milk' });

    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0].idempotency_key).not.toBe(ledger.rows[1].idempotency_key);
    expect(family.calls.filter((c) => c.table === 'grocery_items' && c.kind === 'insert')).toHaveLength(2);
  });

  it('derives one key per step for executor calls, so a retried step is deduplicated', async () => {
    const family = makeFamilyDb({ domain: calendarDomain });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;
    const scope = scopeWith(family.db);

    await executeTool(scope, 'calendar.createEvent', CREATE_EVENT_ARGS, { runId: 'run-1', stepId: 'step-1' });
    const retry = await executeTool(scope, 'calendar.createEvent', CREATE_EVENT_ARGS, { runId: 'run-1', stepId: 'step-1' });

    expect(retry.status).toBe('ok');
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ run_id: 'run-1', plan_step_id: 'step-1' });
    expect(family.calls.filter((c) => c.table === 'calendar_events' && c.kind === 'insert')).toHaveLength(1);
  });
});

describe('skipTrust', () => {
  it('executes an already-approved step without opening a second approval', async () => {
    const family = makeFamilyDb({ domain: calendarDomain });
    const ledger = makeLedger();
    ledgerHolder.client = ledger.db;

    // calendar.deleteEvent is high risk: without skipTrust this is an approval.
    const outcome = await executeTool(
      scopeWith(family.db),
      'calendar.deleteEvent',
      { event_id: 'event-1' },
      { skipTrust: true, runId: 'run-1', stepId: 'step-9' },
    );

    expect(outcome).toMatchObject({ status: 'ok', summary: 'Removed Soccer from the calendar' });
    expect(trustCalls(family).some((c) => c.table === 'approval_requests')).toBe(false);
    expect(family.calls.some((c) => c.table === 'trust_policies')).toBe(false);
    expect(ledger.rows[0]).toMatchObject({ state: 'succeeded', tool_name: 'calendar.deleteEvent' });
  });
});
