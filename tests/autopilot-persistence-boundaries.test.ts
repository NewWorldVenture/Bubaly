import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { runAutopilotScan } from '@/lib/autopilot/scan';

// The accept action (M7) is a server action: it resolves the caller through
// `requireUserContext`, writes through `createServer`, and speaks through
// `getTranslations`. Each is mocked to a harness the tests steer; the scan
// tests below hand their own fake clients to `runAutopilotScan` directly and
// never touch these.
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  revalidatePath: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: harness.revalidatePath }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'parent@example.com' },
    memberships: [],
    active: { familyId: 'family-1', role: harness.role, member: { id: 'member-1', family_id: 'family-1', user_id: 'user-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  // Outside a request scope cookies() is unavailable; resolve through the real
  // catalogue so the assertions check the words a manager sees.
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { acceptPolicySuggestionAction } = await import('@/app/(app)/dashboard/trust/actions');

type QueryResult = { data: unknown; error: unknown };
type Write = { table: string; operation: string };

function failingReadClient(failingTable: string) {
  const writes: Write[] = [];
  const methods = ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'not', 'order', 'limit', 'maybeSingle', 'single'];
  const client = {
    from(table: string) {
      const result: QueryResult = table === failingTable
        ? { data: null, error: new Error(`read failed: ${table}`) }
        : { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const method of methods) chain[method] = () => chain;
      chain.insert = () => { writes.push({ table, operation: 'insert' }); return chain; };
      chain.update = () => { writes.push({ table, operation: 'update' }); return chain; };
      chain.delete = () => { writes.push({ table, operation: 'delete' }); return chain; };
      chain.then = (resolveResult: (value: QueryResult) => unknown, rejectResult: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolveResult, rejectResult);
      return chain;
    },
  };
  return { client, writes };
}

function suggestionInsertFailureClient() {
  const writes: Write[] = [];
  const now = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const reads: Record<string, QueryResult> = {
    renewals: { data: [{ id: 'renewal-1', title: 'Passport', expires_at: now, status: 'active' }], error: null },
    appointments: { data: [], error: null },
    chore_assignments: { data: [], error: null },
    family_members: { data: [], error: null },
    grocery_items: { data: [], error: null },
    reminders: { data: [], error: null },
    calendar_events: { data: [], error: null },
    subscriptions_tracked: { data: [], error: null },
    family_stress_signals: { data: [], error: null },
    medications: { data: [], error: null },
    family_digital_twin_profiles: { data: [], error: null },
    meal_plans: { data: [], error: null },
    family_insurance_policies: { data: [], error: null },
    wishlist_items: { data: [], error: null },
    autopilot_suggestions: { data: [], error: null },
  };
  const client = {
    from(table: string) {
      let operation = 'read';
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'not', 'order', 'limit', 'maybeSingle', 'single']) {
        chain[method] = () => chain;
      }
      chain.insert = () => { operation = 'insert'; writes.push({ table, operation }); return chain; };
      chain.update = () => { operation = 'update'; writes.push({ table, operation }); return chain; };
      chain.delete = () => { operation = 'delete'; writes.push({ table, operation }); return chain; };
      chain.then = (resolveResult: (value: QueryResult) => unknown, rejectResult: (reason: unknown) => unknown) => {
        let result = reads[table] ?? { data: [], error: null };
        if (table === 'reminders' && operation === 'insert') result = { data: { id: 'reminder-1' }, error: null };
        if (table === 'autopilot_suggestions' && operation === 'insert') result = { data: null, error: new Error('suggestion insert failed') };
        return Promise.resolve(result).then(resolveResult, rejectResult);
      };
      return chain;
    },
  };
  return { client, writes };
}

describe('autopilot persistence boundaries', () => {
  it('fails closed before any write when a required family read fails', async () => {
    const { client, writes } = failingReadClient('calendar_events');

    await expect(runAutopilotScan(client as never, 'family-1', 'user-1'))
      .rejects.toThrow('Autopilot could not read the required family data');
    expect(writes).toEqual([]);
  });

  it('removes an auto-created reminder when its suggestion cannot be saved', async () => {
    const { client, writes } = suggestionInsertFailureClient();

    await expect(runAutopilotScan(client as never, 'family-1', 'user-1'))
      .rejects.toThrow('Autopilot could not save the suggestion');
    expect(writes).toEqual([
      { table: 'reminders', operation: 'insert' },
      { table: 'autopilot_suggestions', operation: 'insert' },
      { table: 'reminders', operation: 'delete' },
    ]);
  });

  it('checks suggestion persistence and compensates auto-created side effects', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/autopilot/scan.ts'), 'utf8');

    expect(source).toContain('const { data: inserted, error: suggestionError }');
    expect(source).toContain('createdReminderId');
    expect(source).toContain('createdGroceryIds');
    expect(source).toContain(".from('reminders').delete().eq('id', createdReminderId)");
    expect(source).toContain(".from('grocery_items').delete().in('id', createdGroceryIds)");
    expect(source).toContain("throw new Error('Autopilot could not save the suggestion')");
  });

  it('does not treat list lookup or stale suggestion deletion errors as empty state', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/autopilot/scan.ts'), 'utf8');

    expect(source).toContain('if (lookupError) throw new Error');
    expect(source).toContain('if (staleError) throw new Error');
    expect(source).toContain('if (readResults.some((result) => result.error))');
  });

  it('never clears the policy pass’s own rows as stale, and runs that pass after its own writes', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/autopilot/scan.ts'), 'utf8');

    expect(source).toContain('!isPolicySuggestionKey(e.dedupe_key)');
    expect(source).toContain('await runPolicyScan(supabase, familyId, userId, { now })');
  });
});

// ── accepting a learned policy (M7) ──────────────────────────────────────────
// The one path that turns an Autopilot policy suggestion into standing
// permission. What is pinned: it writes EXACTLY one trust_policies row, that
// row is narrow (AI × one domain × one capability × one tool), only a manager
// can take it, and nothing about the suggestion executes anything else.

const PROPOSAL = {
  domain: 'scheduling', capability: 'automate', tool: 'reminders.create',
  approvals: 4, evidence: 'Approved 4 times since 12 Aug, never rejected', firstApprovedAt: '2026-08-12T10:00:00Z',
};

function seedSuggestion(db: InMemorySupabase, over: Record<string, unknown> = {}) {
  db.seed('autopilot_suggestions', [{
    id: 'sug-1', family_id: 'family-1', member_id: null, kind: 'policy', status: 'open',
    title: 'Let Bubaly create reminders without asking',
    detail: 'Approved 4 times since 12 Aug, never rejected. Scheduling · reminders.create',
    confidence: 74, urgency: 1, action_type: 'accept_policy', action_label: 'Trust Bubaly with this',
    payload: PROPOSAL, source_kind: 'approval_requests', source_id: null,
    dedupe_key: 'policy:scheduling:automate:reminders.create', ...over,
  }]);
}

describe('accepting a learned policy suggestion', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase();
    harness.db = db;
    harness.role = 'parent';
    harness.revalidatePath.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('writes exactly one narrow, tag-scoped trust_policies row and marks the suggestion done', async () => {
    seedSuggestion(db);

    const res = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    expect(res).toEqual({ ok: true });
    const policies = db.table('trust_policies');
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      family_id: 'family-1', created_by: 'user-1',
      name: 'Bubaly may create reminders',
      domain: 'scheduling', capability: 'automate',
      subject_kind: 'ai', subject_role: null, subject_member_id: null,
      effect: 'allow', enabled: true, priority: 200,
    });
    const conditions = policies[0].conditions as Record<string, unknown>;
    expect(conditions.tags).toEqual(['reminders.create']);
    expect(conditions.source).toBe('autopilot');
    expect(conditions.suggestionId).toBe('sug-1');
    expect(String(policies[0].description)).toContain('Approved 4 times since 12 Aug, never rejected');

    const [suggestion] = db.table('autopilot_suggestions');
    expect(suggestion).toMatchObject({ status: 'executed', resolved_by: 'user-1' });
    expect(suggestion.resolved_at).toBeTruthy();

    // Nothing else was executed on the family's behalf.
    expect(db.table('reminders')).toEqual([]);
    expect(db.table('grocery_items')).toEqual([]);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/dashboard/trust');
    expect(harness.revalidatePath).toHaveBeenCalledWith('/dashboard/autopilot');
  });

  it('cannot write a second policy from the same suggestion', async () => {
    seedSuggestion(db);
    await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    const again = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    expect(again).toEqual({ ok: false, error: 'That suggestion is no longer open.' });
    expect(db.table('trust_policies')).toHaveLength(1);
  });

  it('is manager-only: a teen cannot hand Bubaly standing permission', async () => {
    seedSuggestion(db);
    harness.role = 'teen';

    const res = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/parent or adult/i);
    expect(db.table('trust_policies')).toEqual([]);
    expect(db.table('autopilot_suggestions')[0].status).toBe('open');
  });

  it('refuses a suggestion that is not a policy proposal', async () => {
    seedSuggestion(db, { kind: 'reminder', action_type: 'create_reminder', payload: { title: 'Dentist', at: '2026-09-08T09:00:00Z' } });

    const res = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    expect(res).toEqual({ ok: false, error: 'That suggestion does not propose a policy.' });
    expect(db.table('trust_policies')).toEqual([]);
    expect(db.table('autopilot_suggestions')[0].status).toBe('open');
  });

  it('refuses a proposal that would widen into a blanket', async () => {
    for (const payload of [{ ...PROPOSAL, domain: 'all' }, { ...PROPOSAL, capability: 'all' }, { ...PROPOSAL, domain: 'not-a-domain' }, { domain: 'scheduling' }]) {
      db.reset();
      seedSuggestion(db, { payload });
      const res = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });
      expect(res).toEqual({ ok: false, error: 'That suggestion does not propose a policy.' });
      expect(db.table('trust_policies')).toEqual([]);
    }
  });

  it('refuses a suggestion from another family', async () => {
    seedSuggestion(db, { family_id: 'family-2' });

    const res = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    expect(res.ok).toBe(false);
    expect(db.table('trust_policies')).toEqual([]);
    expect(db.table('autopilot_suggestions')[0].status).toBe('open');
  });

  it('does not write a second row when the family already holds a covering policy, but still closes the offer', async () => {
    seedSuggestion(db);
    db.seed('trust_policies', [{
      id: 'held-1', family_id: 'family-1', name: 'Reminders OK', domain: 'scheduling', capability: 'automate',
      subject_kind: 'ai', effect: 'allow', enabled: true, conditions: { tags: ['reminders.create'] },
    }]);

    const res = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    expect(res).toEqual({ ok: true });
    expect(db.table('trust_policies')).toHaveLength(1);
    expect(db.table('trust_policies')[0].id).toBe('held-1');
    expect(db.table('autopilot_suggestions')[0].status).toBe('executed');
  });

  it('fails closed when the suggestion cannot be read: no policy, no reassurance', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const writes: Write[] = [];
    harness.db = {
      from(table: string) {
        const result: QueryResult = { data: null, error: { message: `permission denied for table ${table}`, code: '42501' } };
        const chain: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'in', 'limit']) chain[method] = () => chain;
        chain.maybeSingle = () => Promise.resolve(result);
        chain.single = () => Promise.resolve(result);
        chain.insert = () => { writes.push({ table, operation: 'insert' }); return chain; };
        chain.update = () => { writes.push({ table, operation: 'update' }); return chain; };
        chain.then = (onFulfilled: (value: QueryResult) => unknown, onRejected: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(onFulfilled, onRejected);
        return chain;
      },
    };

    const res = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(writes).toEqual([]);
  });
});
