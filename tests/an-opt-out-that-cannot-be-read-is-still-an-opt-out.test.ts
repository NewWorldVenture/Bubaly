// SEC-009 — an opt-out the database could not read is still an opt-out.
//
// Settings → Bubaly AI holds the switches a family may turn OFF: "Switch Bubaly
// off" (`enabled`), the autonomy dial, and "Allow memory" (`memory_enabled`).
// Every one of them was enforced from the FORGIVING read of
// `family_ai_settings`, which answers a FAILED query with the defaults — Bubaly
// on, `execute`, memory on. So the moment that one query timed out, a family
// that had switched Bubaly off was switched back on: the tool gate ran the
// write, the routine cron filed the paused family's routine, and the memory
// service kept what Bubaly noticed. None of those paths could tell "the family
// never saved a row" (genuinely the defaults) from "the database did not
// answer" (nobody knows).
//
// These cases drive the REAL settings read against a database whose
// `family_ai_settings` query fails, and assert the outcome a family would
// notice: nothing was written, nothing was filed, nothing was remembered, and
// the reason given says the settings could not be read — never "switched off",
// which would claim a choice the family may not have made.
//
// And the control the fix must not break: a PERSON's own action never consults
// Bubaly's switch, so the same failed read leaves their write untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';

const holder = vi.hoisted(() => ({ serviceClient: null as unknown }));
const cron = vi.hoisted(() => ({ createRequest: vi.fn(), createRun: vi.fn(), kickRun: vi.fn() }));

// The service-role client: the tool gate's ledger in one block, the cron's
// whole database in another. Production code must never reach either with a
// member's client, which is why it is replaced at the module boundary.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!holder.serviceClient) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return holder.serviceClient;
  },
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key),
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages: SOURCE_MESSAGES }),
  };
});
vi.mock('@/lib/server/cron-auth', () => ({
  hasCronAuthorization: (req: Request) => req.headers.get('authorization') === 'Bearer test-secret',
}));
vi.mock('@/lib/ai/runs/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/runs/store')>()),
  createRequest: cron.createRequest,
  createRun: cron.createRun,
}));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: cron.kickRun }));

const { executeTool } = await import('@/lib/ai/tools/execute');
const { getTool } = await import('@/lib/ai/tools/registry');
const { memorySlice } = await import('@/lib/ai/context/slices/memory');
const { rememberFact } = await import('@/lib/services/memory');
const { gateAiAction } = await import('@/lib/trust/ai-gate');
const { rememberOnboardingFacts } = await import('@/lib/onboarding/remember');
const { answerAssistant } = await import('@/lib/assistant/service');
const { classifyAssistantUtterance } = await import('@/lib/assistant/intent');
const { GET: routinesTick } = await import('@/app/api/cron/family-routines/route');

type Row = Record<string, unknown>;
type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Row; payload?: unknown };
type Reply = { data: unknown; error: unknown };

/** What PostgREST hands back when the settings query does not finish. */
const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };

const NOW = new Date('2026-09-05T12:00:00Z');
const NY = 'America/New_York';

/** Chainable PostgREST fake that records every call; `single`/`maybeSingle` unwrap a list the way the client does. */
function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    const one = () => {
      const r = respond(call);
      return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
    };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, range: chain, ilike: chain, like: chain, or: chain, contains: chain,
      eq: filter, neq: filter, is: filter, in: filter,
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gt: (c: string, v: unknown) => filter(`gt:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      upsert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(one()),
      maybeSingle: () => Promise.resolve(one()),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const EVENT_ROW = {
  id: 'event-1', family_id: 'fam-1', title: 'Soccer', description: null, location: null,
  category: 'sports', starts_at: '2026-09-06T13:00:00.000Z', ends_at: null,
  all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: null,
  feed_id: null, external_uid: null, created_by: 'auth-1', onboarding_key: null,
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};

const FACTS = [
  { id: 'f1', family_id: 'fam-1', member_id: null, category: 'preference', label: 'Diet', value: 'vegetarian', notes: null, is_pinned: false, source: 'user', confidence: null, expires_at: null, created_by: 'u', created_at: '', updated_at: '' },
];

const settingsRow = (familyId: string, over: Row = {}): Row => ({
  family_id: familyId, enabled: true, behavior: 'execute', category_behavior: {}, risk_overrides: {},
  child_channels: {}, memory_enabled: true, quiet_hours_start: null, quiet_hours_end: null, ...over,
});

/**
 * One household's database. `settings: 'unreadable'` is the case under test —
 * the settings query itself fails — and everything else answers so that a
 * write which gets PAST the gate visibly succeeds. That is what makes a
 * regression show: with the forgiving read back, these cases see a calendar
 * row, a remembered fact, a recalled list.
 */
function householdDb(opts: { settings: 'unreadable' | Row | null; facts?: Row[] }) {
  return makeDb((call) => {
    switch (call.table) {
      case 'family_ai_settings':
        return opts.settings === 'unreadable' ? { data: null, error: TIMEOUT } : { data: opts.settings, error: null };
      case 'trust_policies': case 'permission_grants': case 'trust_delegations': case 'emergency_sessions':
        return { data: [], error: null };
      case 'approval_requests':
        return call.kind === 'select' ? { data: null, error: null } : { data: { id: 'appr-1' }, error: null };
      case 'trust_audit_logs': return { data: null, error: null };
      case 'agent_activity': return { data: { id: 'activity-1' }, error: null };
      case 'calendar_events':
        // The service's own duplicate probe (0256) asks whether THIS call already wrote its row.
        if (call.kind === 'select' && call.filters.idempotency_key !== undefined) return { data: null, error: null };
        return { data: EVENT_ROW, error: null };
      case 'family_facts':
        if (call.kind === 'insert') return { data: { ...(call.payload as Row), id: 'fact-new', created_at: '', updated_at: '' }, error: null };
        return { data: opts.facts ?? [], error: null };
      case 'family_playbook_suggestions':
        if (call.kind === 'insert') return { data: { ...(call.payload as Row), id: 'suggestion-new' }, error: null };
        return { data: [], error: null };
      default: return { data: null, error: null };
    }
  });
}

/** An in-memory `ai_tool_calls` with the real unique key, so a claimed call is visible. */
function makeLedger() {
  const rows: Row[] = [];
  let counter = 0;
  const { db, calls } = makeDb((call) => {
    if (call.table === 'approval_requests') {
      return call.kind === 'select' ? { data: null, error: null } : { data: { id: 'appr-1' }, error: null };
    }
    if (call.table !== 'ai_tool_calls') return { data: null, error: null };
    if (call.kind === 'insert') {
      const payload = call.payload as Row;
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
      if (call.filters.state !== undefined && row.state !== call.filters.state) return { data: null, error: null };
      Object.assign(row, call.payload as Row);
      return { data: { id: row.id }, error: null };
    }
    return { data: null, error: null };
  });
  return { db, calls, rows };
}

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent',
    actorKind: 'ai', tz: NY, now: NOW, ...extra,
  };
}

const CREATE_EVENT_ARGS = { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z', category: 'sports' };

// ── The tool gate ───────────────────────────────────────────────────────────

describe('the tool gate: Bubaly’s own write when the family’s switch cannot be read', () => {
  it('runs nothing, files no approval, claims no ledger row — and says the settings could not be read', async () => {
    const ledger = makeLedger();
    holder.serviceClient = ledger.db;
    const family = householdDb({ settings: 'unreadable' });

    const outcome = await executeTool(scopeWith(family.db), 'calendar.createEvent', CREATE_EVENT_ARGS);

    expect(outcome).toMatchObject({ status: 'error', retryable: true, toolCallId: null });
    // "Switched off" would be a claim about a choice the family may never have made.
    expect(outcome.status === 'error' && outcome.error).not.toMatch(/switched off/i);
    expect(family.calls.some((c) => c.table === 'calendar_events')).toBe(false);
    expect([...family.calls, ...ledger.calls].some((c) => c.table === 'approval_requests' && c.kind === 'insert')).toBe(false);
    expect(ledger.rows).toHaveLength(0);
  });

  it('control: a person’s own change still goes through — Bubaly’s switch was never theirs', async () => {
    const ledger = makeLedger();
    holder.serviceClient = ledger.db;
    const family = householdDb({ settings: 'unreadable' });

    const outcome = await executeTool(scopeWith(family.db, { actorKind: 'member' }), 'calendar.createEvent', CREATE_EVENT_ARGS);

    expect(outcome.status).toBe('ok');
    expect(family.calls.some((c) => c.table === 'calendar_events' && c.kind === 'insert')).toBe(true);
  });

  it('control: the same write runs for Bubaly when the switch reads as on, so the refusal above is the read', async () => {
    const ledger = makeLedger();
    holder.serviceClient = ledger.db;
    const family = householdDb({ settings: settingsRow('fam-1') });

    const outcome = await executeTool(scopeWith(family.db), 'calendar.createEvent', CREATE_EVENT_ARGS);

    expect(outcome.status).toBe('ok');
    expect(family.calls.some((c) => c.table === 'calendar_events' && c.kind === 'insert')).toBe(true);
  });
});

// ── The routine cron ────────────────────────────────────────────────────────

type CronState = {
  rules: Row[];
  families: Row[];
  routineRuns: Row[];
  settings: Record<string, Row | 'unreadable'>;
};

/** The service-role database the cron ticks against: real tables, real filters, and one family whose settings will not read. */
function cronDb(state: CronState): SupabaseClient<Database> {
  const from = (table: string) => {
    const filters: Row = {};
    let payload: Row | null = null;
    let kind: 'select' | 'insert' | 'update' = 'select';
    const rowsFor = () => {
      const source = table === 'family_automation_rules' ? state.rules
        : table === 'families' ? state.families
          : table === 'routine_runs' ? state.routineRuns
            : [];
      return source.filter((r) => Object.entries(filters).every(([c, v]) => {
        if (c.startsWith('lte:')) return String(r[c.slice(4)] ?? '') <= String(v);
        if (c.startsWith('not:')) return r[c.slice(4)] !== null && r[c.slice(4)] !== undefined;
        if (c.startsWith('is:')) return (r[c.slice(3)] ?? null) === v;
        if (c.startsWith('in:')) return (v as unknown[]).includes(r[c.slice(3)]);
        return r[c] === v;
      }));
    };
    const result = (): Reply => {
      if (table === 'family_ai_settings') {
        const answer = state.settings[String(filters.family_id)];
        if (answer === 'unreadable') return { data: null, error: TIMEOUT };
        return { data: answer ? [answer] : [], error: null };
      }
      if (kind === 'insert' && table === 'routine_runs') {
        const row = payload as Row;
        const clash = state.routineRuns.some((r) => r.rule_id === row.rule_id && r.due_at === row.due_at);
        if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        state.routineRuns.push({ ...row });
        return { data: row, error: null };
      }
      if (kind === 'update') {
        for (const row of rowsFor()) Object.assign(row, payload);
        return { data: rowsFor(), error: null };
      }
      return { data: rowsFor(), error: null };
    };
    const one = () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; };
    const b: Row = {};
    Object.assign(b, {
      select: () => b, order: () => b, limit: () => b,
      eq: (c: string, v: unknown) => { filters[c] = v; return b; },
      lte: (c: string, v: unknown) => { filters[`lte:${c}`] = v; return b; },
      not: (c: string) => { filters[`not:${c}`] = true; return b; },
      is: (c: string, v: unknown) => { filters[`is:${c}`] = v; return b; },
      in: (c: string, v: unknown) => { filters[`in:${c}`] = v; return b; },
      insert: (p: Row) => { kind = 'insert'; payload = p; return b; },
      update: (p: Row) => { kind = 'update'; payload = p; return b; },
      single: async () => one(),
      maybeSingle: async () => one(),
      then: (resolve: (v: unknown) => void) => resolve(result()),
    });
    return b;
  };
  return { from } as unknown as SupabaseClient<Database>;
}

const rule = (id: string, familyId: string): Row => ({
  id, family_id: familyId, name: 'Plan our meals', action_config: { prompt: 'Plan our meals for next week' },
  schedule_kind: 'cron', schedule_expr: '0 17 * * 0', anchor_key: null, offset_days: null, at_hour: null,
  next_run_at: '2026-09-05T12:00:00.000Z', said: 'every Sunday at 5pm', is_enabled: true,
});

describe('the routine cron: a paused family whose switch cannot be read', () => {
  // A fixed Saturday afternoon, so "the next Sunday 5pm" is a fact. Only Date
  // is faked: faking timers wholesale would stall the awaits in the route.
  const FROZEN_NOW = new Date('2026-09-05T13:00:00.000Z');
  const tick = () => routinesTick(new Request('https://bubaly.test/api/cron/family-routines', { headers: { authorization: 'Bearer test-secret' } }) as never);
  let state: CronState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN_NOW);
    cron.createRequest.mockReset().mockResolvedValue({ ok: true, data: { id: 'req-1' } });
    cron.createRun.mockReset().mockResolvedValue({ ok: true, data: { id: 'run-1' } });
    cron.kickRun.mockReset();
    state = {
      rules: [rule('rule-1', 'fam-1'), rule('rule-2', 'fam-2')],
      families: [{ id: 'fam-1', timezone: NY }, { id: 'fam-2', timezone: NY }],
      routineRuns: [],
      // fam-1's settings do not read; fam-2's say Bubaly is on.
      settings: { 'fam-1': 'unreadable', 'fam-2': settingsRow('fam-2') },
    };
    holder.serviceClient = cronDb(state);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('files nothing for that family, still files the other family’s routine, and reports the tick as a problem', async () => {
    const res = await tick();

    expect(await res.json()).toMatchObject({ ok: false, filed: 1, skipped: 1, problems: 1 });
    expect(cron.createRequest).toHaveBeenCalledTimes(1);
    expect(cron.createRequest.mock.calls[0][0]).toMatchObject({ familyId: 'fam-2' });

    const held = state.routineRuns.find((r) => r.rule_id === 'rule-1');
    expect(held).toMatchObject({ status: 'skipped' });
    expect(String(held?.detail)).toMatch(/could not read/i);
    expect(String(held?.detail)).not.toMatch(/switched off/i);
  });

  it('costs the family one occurrence and never the routine: the rule is still armed for next Sunday', async () => {
    await tick();
    // Sunday 5pm New York, the next one after the tick — not null, which is
    // what "the routine simply resumes" depends on.
    expect(state.rules[0].next_run_at).toBe('2026-09-06T21:00:00.000Z');
    expect(state.rules[0].last_run_at).toBeTruthy();
  });
});

// ── The memory service ──────────────────────────────────────────────────────

describe('the memory service: "Allow memory" cannot be read', () => {
  it('refuses what Bubaly noticed, keeps nothing, and does not call it the family’s choice', async () => {
    const family = householdDb({ settings: 'unreadable' });

    const res = await rememberFact(scopeWith(family.db), {
      category: 'preference', key: 'Go-to dinner', content: 'Taco night', source: 'ai_conversation', confidence: 70,
    });

    expect(res).toMatchObject({ ok: false, code: 'db', retryable: true });
    expect(res.ok === false && res.error).not.toMatch(/switched off/i);
    expect(family.calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('control: still saves what a person typed, without ever asking the switch', async () => {
    const family = householdDb({ settings: 'unreadable' });

    const res = await rememberFact(scopeWith(family.db, { actorKind: 'member' }), {
      category: 'preference', key: 'Shoe size', content: 'US 3', source: 'user',
    });

    expect(res.ok).toBe(true);
    expect(family.calls.some((c) => c.table === 'family_facts' && c.kind === 'insert')).toBe(true);
    // Their memory is their own record: the switch is about what BUBALY keeps.
    expect(family.calls.some((c) => c.table === 'family_ai_settings')).toBe(false);
  });
});

// ── The other places Bubaly acts, remembers, or uses what it remembers ─────

describe('every other surface that enforces a switch fails closed the same way', () => {
  it('the shared AI gate (chat, Magic Import, the school desk) denies and opens no approval', async () => {
    const family = householdDb({ settings: 'unreadable' });

    const outcome = await gateAiAction(family.db, 'fam-1', {
      toolName: 'calendar.createEvent', domain: 'calendar', actorId: 'bubaly', actorRole: 'parent',
      agent: 'Bubaly', title: 'Add soccer practice', payload: {},
    });

    expect(outcome.effect).toBe('deny');
    expect(outcome.effect === 'deny' && outcome.reason).not.toMatch(/switched off/i);
    expect(family.calls.some((c) => c.table === 'approval_requests')).toBe(false);
  });

  it('recall looks nothing up, rather than telling the model "nothing is remembered"', async () => {
    const family = householdDb({ settings: 'unreadable', facts: FACTS });

    const res = await getTool('memory.recall')!.execute(scopeWith(family.db), {});

    expect(res).toMatchObject({ ok: false, code: 'db', retryable: true });
    expect(family.calls.some((c) => c.table === 'family_facts')).toBe(false);
  });

  it('the context slice fails rather than putting the family’s facts in front of the model', async () => {
    const family = householdDb({ settings: 'unreadable', facts: FACTS });

    const res = await memorySlice.load(scopeWith(family.db), { viewer: { canManage: true }, members: [] } as never);

    expect(res.ok).toBe(false);
    expect(family.calls.some((c) => c.table === 'family_facts')).toBe(false);
  });

  it('onboarding finishes, remembers nothing, and reports the answers as not written — not as a family that opted out', async () => {
    const family = householdDb({ settings: 'unreadable' });
    const answers = { householdAdults: 2, householdChildren: 2, childAges: [6, 9], region: 'Austin', country: 'US', goals: ['meals', 'chores'] };

    const res = await rememberOnboardingFacts(scopeWith(family.db, { actorKind: 'member' }), answers);

    expect(res).toEqual({ written: 0, failed: 4, memoryDisabled: false });
    expect(family.calls.some((c) => c.table === 'family_facts')).toBe(false);
  });

  it('the kitchen speaker saves nothing and hands the route its "something went wrong", not "switched off"', async () => {
    const family = householdDb({ settings: 'unreadable' });
    // 21:30 UTC on Monday 14 September 2026 is 17:30 Monday in New York.
    const spoken = new Date('2026-09-14T21:30:00Z');
    const link = { id: 'link-1', family_id: 'fam-1', user_id: 'user-1', provider: 'alexa', scopes: ['ask', 'capture'], timezone: NY } as const;

    await expect(
      answerAssistant(family.db, link as never, classifyAssistantUtterance('add soccer practice tomorrow at 4pm', spoken, NY), spoken),
    ).rejects.toThrow(/could not be read/);

    expect(family.calls.some((c) => c.table === 'calendar_events')).toBe(false);
    expect(family.calls.filter((c) => c.kind === 'insert' && c.table !== 'assistant_link_events')).toEqual([]);
  });
});
