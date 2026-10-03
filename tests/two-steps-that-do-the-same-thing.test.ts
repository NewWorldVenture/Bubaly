// Two steps of one plan that create the same thing write it once.
//
// `lib/ai/tools/execute.ts:resolveIdempotencyKey` has always said what a run's
// key should be: inside a run, the tool's natural key — title + time, the shape
// of the thing being created — because "the duplicate a plan actually produces
// is two steps creating the same thing". That branch was unreachable from a
// plan. The executor handed its step key (household + run + step + tool) to
// `executeTool` as `idempotencyKey`, a caller-supplied key wins outright, and so
// every step got a key that carried the STEP: a retried step was deduplicated,
// two steps creating the identical calendar event were not, and both rows were
// written (finalaudit Q41; the same class had already landed as "planning a
// meal twice left two dinners in one slot").
//
// Now the executor hands the step key in as the FALLBACK. Within a run a tool
// with a natural key is keyed by it, so sibling steps collapse to one write and
// a retried step still finds its own receipt (same arguments, same natural
// key); a tool with no natural key keeps the step key, so two notes are still
// two notes and a retried note is still one. The resolved key is also what the
// services see, so the row-level duplicate guard (0256) and the ledger agree.
//
// These cases drive the REAL `executeTool`, the real registry tools and the
// real services against two fakes — the caller's client and the service-role
// ledger with 0250's unique key — the way tests/tool-execute.test.ts does.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { makeKey } from '@/lib/services/idempotency';
import { at } from './helpers/source-order';
import { stepIdempotencyKey } from '@/lib/ai/runs/executor';

const ledgerHolder = vi.hoisted(() => ({ client: null as SupabaseClient<Database> | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!ledgerHolder.client) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return ledgerHolder.client;
  },
}));

const { executeTool } = await import('@/lib/ai/tools/execute');
const { getTool } = await import('@/lib/ai/tools/registry');

const ROOT = join(__dirname, '..');
const FAMILY = 'fam-1';
const RUN = 'run-1';
const STEP_A = 'step-a';
const STEP_B = 'step-b';
const NOW = new Date('2026-09-05T12:00:00Z');

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
  const rpc = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
  return { db: { from, rpc } as unknown as SupabaseClient<Database>, calls };
}

type LedgerRow = Record<string, unknown> & { id: string; state: string; attempt: number; idempotency_key: string; family_id: string };

/** An in-memory `ai_tool_calls` with 0250's unique key, so a second reservation under one key clashes as it would in Postgres. */
function makeLedger() {
  const rows: LedgerRow[] = [];
  let counter = 0;
  const { db, calls } = makeDb((call) => {
    if (call.table === 'approval_requests') return call.kind === 'select' ? { data: null, error: null } : { data: { id: 'appr-1' }, error: null };
    if (call.table !== 'ai_tool_calls') return { data: null, error: null };
    if (call.kind === 'insert') {
      const payload = call.payload as LedgerRow;
      if (rows.some((r) => r.family_id === payload.family_id && r.idempotency_key === payload.idempotency_key)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_ai_tool_calls_idempotency"' } };
      }
      const row = { ...payload, id: `call-${++counter}` };
      rows.push(row);
      return { data: { id: row.id }, error: null };
    }
    if (call.kind === 'select') {
      const row = rows.find((r) => r.family_id === call.filters.family_id && r.idempotency_key === call.filters.idempotency_key);
      return { data: row ? { ...row } : null, error: null };
    }
    if (call.kind === 'update') {
      const row = rows.find((r) => r.id === call.filters.id);
      if (!row) return { data: null, error: null };
      if (Object.entries(call.filters).some(([column, value]) => row[column] !== value)) return { data: null, error: null };
      Object.assign(row, call.payload as Record<string, unknown>);
      return { data: { id: row.id }, error: null };
    }
    return { data: null, error: null };
  });
  return { db, calls, rows };
}

const EVENT_ROW = {
  id: 'event-1', family_id: FAMILY, title: 'Soccer', description: null, location: null,
  category: 'sports', starts_at: '2026-09-06T13:00:00.000Z', ends_at: null,
  all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: null,
  feed_id: null, external_uid: null, created_by: 'auth-1', onboarding_key: null,
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};

/** The caller's client: trust tables answered open, domain tables as each test needs. */
function makeFamilyDb(domain: (call: Call) => Reply | null) {
  let events = 0;
  let notes = 0;
  return makeDb((call) => {
    switch (call.table) {
      case 'trust_policies': case 'permission_grants': case 'trust_delegations': case 'emergency_sessions':
        return { data: [], error: null };
      case 'approval_requests': return call.kind === 'select' ? { data: null, error: null } : { data: { id: 'appr-1' }, error: null };
      case 'trust_audit_logs': return { data: null, error: null };
      case 'agent_activity': return { data: { id: 'activity-1' }, error: null };
      case 'calendar_events':
        // The service's own duplicate probe (0256) asks whether THIS key already wrote its row; here it never has.
        if (call.kind === 'select' && call.filters.idempotency_key !== undefined) return { data: null, error: null };
        if (call.kind === 'insert') { events += 1; return { data: { ...EVENT_ROW, id: `event-${events}` }, error: null }; }
        return { data: EVENT_ROW, error: null };
      case 'notes':
        if (call.kind === 'insert') {
          notes += 1;
          const payload = call.payload as { title: string | null; body: string };
          return { data: { id: `note-${notes}`, family_id: FAMILY, title: payload.title, body: payload.body, created_by: 'auth-1', created_at: NOW.toISOString(), updated_at: NOW.toISOString() }, error: null };
        }
        return { data: null, error: null };
      default: return domain(call) ?? { data: null, error: null };
    }
  });
}

function scopeWith(db: SupabaseClient<Database>): ServiceScope {
  return { db, familyId: FAMILY, userId: 'auth-1', memberId: 'member-1', role: 'parent', actorKind: 'ai', tz: 'America/New_York', now: NOW };
}

/** Exactly what `runToolStep` passes for a step of this run (lib/ai/runs/executor.ts). */
const asStep = (stepId: string, toolName: string) => ({
  runId: RUN, stepId, requestId: null, fallbackIdempotencyKey: stepIdempotencyKey(FAMILY, RUN, stepId, toolName), skipTrust: false,
});

const SOCCER = { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z', category: 'sports' };
const inserts = (calls: Call[], table: string) => calls.filter((c) => c.table === table && c.kind === 'insert');

let family: ReturnType<typeof makeFamilyDb>;
let ledger: ReturnType<typeof makeLedger>;
let scope: ServiceScope;

beforeEach(() => {
  family = makeFamilyDb(() => null);
  ledger = makeLedger();
  ledgerHolder.client = ledger.db;
  scope = scopeWith(family.db);
});
afterEach(() => vi.restoreAllMocks());

describe('two steps that do the same thing', () => {
  it('write it once: the second step replays the first one\'s result instead of creating a second event', async () => {
    const first = await executeTool(scope, 'calendar.createEvent', SOCCER, asStep(STEP_A, 'calendar.createEvent'));
    const second = await executeTool(scope, 'calendar.createEvent', { ...SOCCER, title: '  soccer ' }, asStep(STEP_B, 'calendar.createEvent'));

    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    expect(second.status === 'ok' && second.data).toMatchObject({ id: 'event-1' });
    expect(second.status === 'ok' && second.summary).toBe('Added Soccer at 9:00 AM Sunday');
    expect(inserts(family.calls, 'calendar_events'), 'one calendar row for two steps').toHaveLength(1);
    expect(ledger.rows).toHaveLength(1);
    // The one receipt belongs to the step that wrote, under the run's natural key.
    expect(ledger.rows[0]).toMatchObject({ run_id: RUN, plan_step_id: STEP_A, state: 'succeeded', attempt: 1 });
    expect(ledger.rows[0].idempotency_key).toBe(makeKey([FAMILY, RUN, 'calendar.createEvent', `calendar.createEvent:soccer:${SOCCER.starts_at}`]));
    expect(ledger.rows[0].idempotency_key).not.toBe(stepIdempotencyKey(FAMILY, RUN, STEP_A, 'calendar.createEvent'));
  });

  it('are two different things when the natural key differs — a different time is a different event', async () => {
    await executeTool(scope, 'calendar.createEvent', SOCCER, asStep(STEP_A, 'calendar.createEvent'));
    const other = await executeTool(scope, 'calendar.createEvent', { ...SOCCER, starts_at: '2026-09-13T13:00:00Z' }, asStep(STEP_B, 'calendar.createEvent'));

    expect(other.status).toBe('ok');
    expect(other.status === 'ok' && other.data).toMatchObject({ id: 'event-2' });
    expect(inserts(family.calls, 'calendar_events')).toHaveLength(2);
    expect(ledger.rows).toHaveLength(2);
    expect(new Set(ledger.rows.map((r) => r.idempotency_key)).size).toBe(2);
  });

  it('a retried step still finds its own receipt: the same step twice is one write', async () => {
    await executeTool(scope, 'calendar.createEvent', SOCCER, asStep(STEP_A, 'calendar.createEvent'));
    const retry = await executeTool(scope, 'calendar.createEvent', SOCCER, asStep(STEP_A, 'calendar.createEvent'));

    expect(retry.status).toBe('ok');
    expect(inserts(family.calls, 'calendar_events')).toHaveLength(1);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].attempt).toBe(1);
  });

  it('are the same key for the service as for the ledger, so 0256\'s row-level guard sees the same call', async () => {
    await executeTool(scope, 'calendar.createEvent', SOCCER, asStep(STEP_A, 'calendar.createEvent'));
    const [insert] = inserts(family.calls, 'calendar_events');
    expect((insert.payload as { idempotency_key: string }).idempotency_key).toBe(ledger.rows[0].idempotency_key);
  });

  it('that run at the same moment: one executes, the other is told to wait, and its retry replays', async () => {
    // Two steps of one batch (the executor runs a batch with Promise.allSettled):
    // the first has reserved its receipt and is mid-write when the second
    // reserves. Held on a promise rather than a timer, so the interleaving is
    // the one being tested and not whichever one the fakes happen to produce.
    const tool = getTool('calendar.createEvent')!;
    const original = tool.execute.bind(tool);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    const executions = vi.spyOn(tool, 'execute').mockImplementation(async (...args) => {
      started();
      await held;
      return original(...args);
    });

    const first = executeTool(scope, 'calendar.createEvent', SOCCER, asStep(STEP_A, 'calendar.createEvent'));
    await inFlight;
    const second = await executeTool(scope, 'calendar.createEvent', SOCCER, asStep(STEP_B, 'calendar.createEvent'));
    expect(second).toMatchObject({ status: 'error', retryable: true });
    expect(second.status === 'error' && second.error).toMatch(/already doing that/i);

    release();
    expect((await first).status).toBe('ok');
    expect(executions).toHaveBeenCalledTimes(1);

    // The executor retries a retryable error on its next pass; by then the receipt is settled.
    const retry = await executeTool(scope, 'calendar.createEvent', SOCCER, asStep(STEP_B, 'calendar.createEvent'));
    expect(retry.status).toBe('ok');
    expect(retry.status === 'ok' && retry.data).toMatchObject({ id: 'event-1' });
    expect(executions).toHaveBeenCalledTimes(1);
    expect(inserts(family.calls, 'calendar_events')).toHaveLength(1);
    expect(ledger.rows).toHaveLength(1);
  });
});

describe('two steps whose tool has no natural key', () => {
  // `notes.create` declares none on purpose: two notes with the same words are
  // two notes. The step key stays, so siblings write twice and a retry does not.
  const NOTE = { body: 'Bins go out Tuesday' };

  it('keep the step key: two notes are two notes', async () => {
    await executeTool(scope, 'notes.create', NOTE, asStep(STEP_A, 'notes.create'));
    const second = await executeTool(scope, 'notes.create', NOTE, asStep(STEP_B, 'notes.create'));

    expect(second.status).toBe('ok');
    expect(second.status === 'ok' && second.data).toMatchObject({ id: 'note-2' });
    expect(inserts(family.calls, 'notes')).toHaveLength(2);
    expect(ledger.rows.map((r) => r.idempotency_key)).toEqual([
      stepIdempotencyKey(FAMILY, RUN, STEP_A, 'notes.create'),
      stepIdempotencyKey(FAMILY, RUN, STEP_B, 'notes.create'),
    ]);
  });

  it('and a retried note is still one note', async () => {
    await executeTool(scope, 'notes.create', NOTE, asStep(STEP_A, 'notes.create'));
    const retry = await executeTool(scope, 'notes.create', NOTE, asStep(STEP_A, 'notes.create'));
    expect(retry.status).toBe('ok');
    expect(retry.status === 'ok' && retry.data).toMatchObject({ id: 'note-1' });
    expect(inserts(family.calls, 'notes')).toHaveLength(1);
  });
});

describe('a caller that supplies its own key still wins outright', () => {
  it('the chat route\'s message key is taken as given, natural key or not', async () => {
    const KEY = 'message-7:create-soccer';
    await executeTool(scope, 'calendar.createEvent', SOCCER, { idempotencyKey: KEY });
    expect(ledger.rows[0].idempotency_key).toBe(KEY);
  });
});

describe('the shape of the fix', () => {
  const exec = readFileSync(join(ROOT, 'lib/ai/tools/execute.ts'), 'utf8');
  const executor = readFileSync(join(ROOT, 'lib/ai/runs/executor.ts'), 'utf8');

  it('the executor hands its step key in as the fallback, nowhere as the key', () => {
    expect(executor.match(/fallbackIdempotencyKey: stepIdempotencyKey\(/g), 'one supply site').toHaveLength(1);
    expect(executor).not.toMatch(/idempotencyKey: stepIdempotencyKey\(/);
    // The default port passes it through under the same name.
    expect(executor).toContain('fallbackIdempotencyKey: opts.fallbackIdempotencyKey,');
    expect(executor).not.toMatch(/\bidempotencyKey: opts\.idempotencyKey,/);
  });

  it('within a run the natural key is taken first, the fallback only when there is none', () => {
    const resolve = exec.slice(exec.indexOf('function resolveIdempotencyKey'), exec.indexOf('type Reservation ='));
    expect(resolve).toContain('if (supplied) return supplied;');
    expect(resolve).toContain('if (natural) return makeKey([scope.familyId, scope.runId ?? scope.requestId ?? null, tool.name, natural]);');
    expect(resolve).toContain('return opts.fallbackIdempotencyKey ?? scopeKey(scope, tool.name, input);');
    expect(at(resolve, 'if (natural)')).toBeLessThan(at(resolve, 'opts.fallbackIdempotencyKey ??'));
  });

  it('the resolved key reaches the services on the call scope, and only inside a context', () => {
    expect(exec).toContain('const key = resolveIdempotencyKey(context, tool, input, opts);');
    expect(exec).toMatch(/const callScope: ServiceScope = !tool\.readOnly && \(context\.runId \|\| context\.stepId \|\| context\.requestId \|\| context\.idempotencyKey\)\s*\? \{ \.\.\.context, idempotencyKey: key \}\s*: context;/);
    expect(exec).toContain('const reservation = await reserveCall(ledger, callScope, tool, key, input);');
  });
});
