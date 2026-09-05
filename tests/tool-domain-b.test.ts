// Contract tests for the finances / trips / home / documents / school /
// sports tools: they are registered with the domains and risk tiers the
// trust engine is written against, no tool pretends to search an external
// provider directory, the executor's view-sensitivity gate keeps a child out
// of the family's money and files, and a read tool's summary quotes the
// figures the service computed rather than a paraphrase.
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
const { getTool, listTools } = await import('@/lib/ai/tools/registry');
const { toolInputSchema } = await import('@/lib/ai/tools/legacy-adapter');

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: chain,
      eq: filter, is: filter, in: filter,
      neq: (c: string, v: unknown) => filter(`neq:${c}`, v),
      ilike: (c: string, v: unknown) => filter(`ilike:${c}`, v),
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

/** Trust tables empty (so the role matrix + risk tier decide), domain tables from `domain`. */
function makeFamilyDb(domain: (call: Call) => Reply | null = () => null) {
  return makeDb((call) => {
    switch (call.table) {
      case 'trust_policies': case 'permission_grants': case 'trust_delegations': case 'emergency_sessions': return { data: [], error: null };
      case 'approval_requests': return { data: { id: 'appr-1' }, error: null };
      case 'trust_audit_logs': case 'agent_activity': return { data: { id: 'x' }, error: null };
      default: return domain(call) ?? { data: null, error: null };
    }
  });
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent', actorKind: 'ai', tz: 'America/New_York', now: NOW, ...extra };
}

beforeEach(() => {
  ledgerHolder.client = makeDb(() => ({ data: { id: 'call-1' }, error: null })).db;
});

const MINE: Record<string, string> = {
  'finances.listTransactions': 'finances', 'finances.spendingByCategory': 'finances', 'finances.budgetVsActual': 'finances',
  'finances.comparePeriods': 'finances', 'finances.merchantMovement': 'finances', 'finances.recurringChanges': 'finances',
  'finances.unusualTransactions': 'finances', 'finances.updateBudget': 'finances', 'finances.createSavingsGoal': 'finances',
  'trips.getTrip': 'travel', 'trips.findOrCreateVacation': 'travel', 'trips.buildPlan': 'travel', 'trips.createPackingList': 'travel',
  'trips.computeReadiness': 'travel', 'trips.documentsRisk': 'travel', 'trips.syncToCalendar': 'travel', 'trips.commitmentConflicts': 'travel',
  'home.tradeFromIssue': 'home_maintenance', 'home.listContractors': 'home_maintenance', 'home.lastServiceByTrade': 'home_maintenance',
  'home.listOpenMaintenance': 'home_maintenance', 'home.saveContractor': 'home_maintenance', 'home.createServiceRecord': 'home_maintenance',
  'home.createMaintenanceTask': 'home_maintenance',
  'documents.listDocuments': 'documents', 'documents.expiringBefore': 'documents', 'documents.readDocument': 'documents', 'documents.linkToVacation': 'documents',
  'school.listEventsBetween': 'education', 'school.listHomeworkDue': 'education', 'school.listClasses': 'education',
  'sports.listTeams': 'education', 'sports.listPracticesBetween': 'education',
};

describe('registration and metadata', () => {
  it('registers every domain-B tool under the trust domain the policies are written against', () => {
    for (const [name, domain] of Object.entries(MINE)) {
      const tool = getTool(name);
      expect(tool, name).not.toBeNull();
      expect(tool?.domain, name).toBe(domain);
    }
  });

  it('tiers the writes honestly', () => {
    const risk = (name: string) => getTool(name)?.risk;
    expect(risk('finances.updateBudget')).toBe('high');
    expect(risk('finances.createSavingsGoal')).toBe('medium');
    expect(risk('home.saveContractor')).toBe('low');
    expect(risk('home.createMaintenanceTask')).toBe('low');
    expect(risk('trips.createPackingList')).toBe('low');
    expect(risk('trips.syncToCalendar')).toBe('medium');
    expect(risk('trips.buildPlan')).toBe('medium');
    for (const name of Object.keys(MINE)) {
      const tool = getTool(name)!;
      if (tool.readOnly) expect(tool.risk, name).toBe('low');
      else expect(typeof tool.idempotencyFrom, `${name} write needs a duplicate guard`).toBe('function');
    }
  });

  it('offers no tool that claims to search an external provider directory', () => {
    const names = listTools().map((t) => t.name.toLowerCase());
    expect(names.some((n) => /findpro|searchprovider|findcontractor|searchcontractor/.test(n))).toBe(false);
    expect(getTool('find_pro')).toBeNull();
  });

  it('expresses every input as strict JSON Schema with nullable optionals', () => {
    for (const name of Object.keys(MINE)) {
      const schema = toolInputSchema(getTool(name)!);
      expect(schema, name).not.toBeNull();
      expect(schema?.additionalProperties).toBe(false);
    }
    const listSchema = toolInputSchema(getTool('finances.listTransactions')!)!;
    expect(listSchema.required).toEqual(expect.arrayContaining(['from', 'to', 'type', 'category', 'member_id', 'limit']));
  });
});

describe('the view-sensitivity gate', () => {
  it("denies a child's assistant reading transactions, before any row is read", async () => {
    const family = makeFamilyDb();
    const outcome = await executeTool(scopeWith(family.db, { role: 'child' }), 'finances.listTransactions', {});
    expect(outcome.status).toBe('denied');
    expect(outcome.status === 'denied' && outcome.reason).toMatch(/private to the adults/i);
    expect(family.calls.some((c) => c.table === 'transactions')).toBe(false);
  });

  it("denies a teen's assistant opening a document, before the storage bucket is touched", async () => {
    const family = makeFamilyDb();
    const outcome = await executeTool(scopeWith(family.db, { role: 'teen' }), 'documents.readDocument', { document_id: 'd-1' });
    expect(outcome.status).toBe('denied');
    expect(family.calls.some((c) => c.table === 'documents')).toBe(false);
  });

  it('lets a parent read spending and quotes the computed total in the summary', async () => {
    const family = makeFamilyDb((call) => (call.table === 'transactions'
      ? { data: [
        { id: 't-1', family_id: 'fam-1', name: 'Grocer', merchant: null, amount: 120.5, category: 'Groceries', date: '2026-09-01', type: 'expense', member_id: null, account_id: null },
        { id: 't-2', family_id: 'fam-1', name: 'Gas', merchant: null, amount: 40, category: 'Fuel', date: '2026-09-02', type: 'expense', member_id: null, account_id: null },
      ], error: null }
      : null));
    const outcome = await executeTool(scopeWith(family.db), 'finances.spendingByCategory', { from: '2026-09-01', to: '2026-09-05' });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.summary).toContain('$160.50');
    expect(outcome.summary).toContain('Groceries');
    expect((outcome.data as { total: number }).total).toBe(160.5);
    // Reads are never ledgered; the ledger fake saw nothing.
    expect(family.calls.find((c) => c.table === 'transactions')?.filters.family_id).toBe('fam-1');
  });

  it('answers an honest empty when there are no rows', async () => {
    const family = makeFamilyDb((call) => (call.table === 'budgets' ? { data: [], error: null } : null));
    const outcome = await executeTool(scopeWith(family.db), 'finances.budgetVsActual', {});
    expect(outcome).toMatchObject({ status: 'ok', summary: 'No budgets are set up yet' });
  });
});

describe('everyday reads and writes', () => {
  it('infers a trade without touching the database', async () => {
    const family = makeFamilyDb();
    const outcome = await executeTool(scopeWith(family.db, { role: 'teen' }), 'home.tradeFromIssue', { issue: 'the sink is leaking' });
    expect(outcome).toMatchObject({ status: 'ok', data: { trade: 'plumbing' } });
    expect(outcome.status === 'ok' && outcome.summary).toMatch(/Plumbing job/);
    expect(family.calls).toHaveLength(0);
  });

  it('rejects a malformed sports window as invalid arguments rather than an empty answer', async () => {
    const family = makeFamilyDb();
    const outcome = await executeTool(scopeWith(family.db), 'sports.listPracticesBetween', { from: 'tuesday' });
    expect(outcome).toMatchObject({ status: 'error', retryable: false });
    expect(outcome.status === 'error' && outcome.error).toMatch(/start time/i);
  });

  it('asks a person before changing a budget, with consequences on the card', async () => {
    const family = makeFamilyDb();
    const outcome = await executeTool(scopeWith(family.db), 'finances.updateBudget', { category: 'Groceries', amount: 600 });
    expect(outcome.status).toBe('pending_approval');
    expect(family.calls.some((c) => c.table === 'budgets')).toBe(false);
    const consequences = getTool('finances.updateBudget')!.consequences!({ category: 'Groceries', amount: 600, period: 'monthly' });
    expect(consequences[0]).toBe('Sets the Groceries budget to $600.00 per month.');
  });

  it('saves a contractor as a low-risk write for a parent and records the ledger row', async () => {
    const row = { id: 'c-1', family_id: 'fam-1', name: 'Bob Pipes', trade: 'plumbing', company: null, phone: null, email: null, website: null, rating: null, hourly_rate: null, is_preferred: false, last_used_on: null, notes: null, created_by: 'auth-1', updated_by: 'auth-1', deleted_at: null, metadata: {}, created_at: '', updated_at: '' };
    const family = makeFamilyDb((call) => (call.table === 'home_contractors' ? (call.kind === 'insert' ? { data: row, error: null } : { data: null, error: null }) : null));
    const outcome = await executeTool(scopeWith(family.db), 'home.saveContractor', { name: 'Bob Pipes', trade: 'plumber' });
    expect(outcome).toMatchObject({ status: 'ok', summary: 'Saved Bob Pipes (plumbing) to your contractors', toolCallId: 'call-1' });
    expect(family.calls.find((c) => c.kind === 'insert' && c.table === 'home_contractors')?.payload).toMatchObject({ family_id: 'fam-1', trade: 'plumbing' });
  });
});
