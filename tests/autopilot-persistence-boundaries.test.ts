import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { runAutopilotScan } from '@/lib/autopilot/scan';

// The scan STORES suggestion titles, and the subscription ones carry money, so it
// takes the locale and translator of whoever it writes for. Nothing here asserts
// wording; an echo translator is enough.
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;

// The accept action (M7) is a server action: it resolves the caller through
// `requireUserContext`, writes through `createServer`, and speaks through
// `getTranslations`. Each is mocked to a harness the tests steer; the scan
// tests below hand their own fake clients to `runAutopilotScan` directly and
// never touch these.
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  revalidatePath: vi.fn(),
  // What the family's real approval history supports when a parent accepts.
  // The accept action re-derives the proposal instead of trusting the row.
  candidates: [] as unknown[],
}));
vi.mock('@/lib/autopilot/policy-scan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/autopilot/policy-scan')>()),
  loadPolicyCandidates: async () => harness.candidates,
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
  // `is`: the scan reads the family's open shopping lists (both archive columns) first.
  const methods = ['select', 'eq', 'neq', 'is', 'in', 'gte', 'lte', 'lt', 'not', 'order', 'limit', 'maybeSingle', 'single'];
  const client = {
    from(table: string) {
      const result: QueryResult = table === failingTable
        ? { data: null, error: new Error(`read failed: ${table}`) }
        : { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const method of methods) chain[method] = () => chain;
      // A paged read stops at an empty page, so `.range()` must slice.
      chain.range = (from: number, to: number) => ({
        then: (resolveResult: (value: QueryResult) => unknown, rejectResult: (reason: unknown) => unknown) =>
          Promise.resolve(Array.isArray(result.data) ? { ...result, data: result.data.slice(from, to + 1) } : result)
            .then(resolveResult, rejectResult),
      });
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

describe('autopilot persistence boundaries', () => {
  it('fails closed before any write when a required family read fails', async () => {
    const { client, writes } = failingReadClient('calendar_events');

    await expect(runAutopilotScan(client as never, 'family-1', 'user-1', 'UTC', 'en-US', echo))
      .rejects.toThrow('Autopilot could not read the required family data');
    expect(writes).toEqual([]);
  });

  it.each(['card', 'reminder'] as const)('publishes neither row when the atomic %s write fails', async (stage) => {
    const staged: string[] = [];
    const db = createInMemorySupabase({
      rpcRole: 'service_role',
      cardReminderFault(name, atStage, rows) {
        expect(name).toBe('create_card_legacy_reminder_service');
        expect(db.table('autopilot_suggestions')).toEqual([]);
        expect(db.table('reminders')).toEqual([]);
        staged.push(atStage);
        if (atStage !== stage) return null;
        if (stage === 'reminder') {
          expect(rows).toHaveLength(2);
          expect(rows[1]).toMatchObject({ autopilot_origin: true, autopilot_card_id: rows[0].id });
        }
        return { code: '23514', message: `${stage} write refused` };
      },
    });
    db.seed('families', [{ id: 'family-1', timezone: 'UTC' }]);
    db.seed('family_members', [{ id: 'member-1', family_id: 'family-1', user_id: 'user-1', role: 'parent', is_active: true }]);
    db.seed('renewals', [{ id: 'renewal-1', family_id: 'family-1', title: 'Passport',
      expires_at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), status: 'active' }]);

    await expect(runAutopilotScan(db as never, 'family-1', 'user-1', 'UTC', 'en-US', echo))
      .rejects.toThrow('Autopilot could not save the reminder suggestion');
    expect(staged).toEqual(stage === 'card' ? ['card'] : ['card', 'reminder']);
    expect(db.table('autopilot_suggestions')).toEqual([]);
    expect(db.table('reminders')).toEqual([]);
    expect(db.table('notifications')).toEqual([]);
  });

  it('uses atomic reminder creation and checks compensation for other auto-created side effects', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/autopilot/scan.ts'), 'utf8');

    expect(source).toContain('const { data: inserted, error: suggestionError }');
    expect(source).toContain("supabase.rpc('create_card_legacy_reminder'");
    expect(source).toContain("supabase.rpc('create_card_legacy_reminder_service'");
    expect(source).toContain('createdGroceryIds');
    expect(source).toContain(".from('grocery_items').delete().in('id', createdGroceryIds)");
    expect(source).toContain("throw new Error('Autopilot could not save the suggestion')");
  });

  it('does not treat list lookup or stale suggestion archival errors as empty state', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/autopilot/scan.ts'), 'utf8');

    // The list lookup moved behind ensureDefaultGroceryListId (0443, DATA-007),
    // which returns a failed read as an error rather than "no list"; the scan
    // still throws on it rather than carrying on as though the family had none.
    expect(source).toContain("if (!list.id) throw new Error('Autopilot could not open or create the family shopping list')");
    const history = readFileSync(resolve(process.cwd(), 'lib/autopilot/history.ts'), 'utf8');
    expect(source).toContain('await archiveStaleSuggestions(supabase, familyId, stale, now)');
    expect(history).toContain("throw new Error('Autopilot could not archive stale suggestions')");
    expect(source).toContain('if (readResults.some((result) => result.error))');
  });

  it('never clears the policy pass’s own rows as stale, and runs that pass after its own writes', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/autopilot/scan.ts'), 'utf8');

    expect(source).toContain('!isPolicySuggestionKey(e.dedupe_key)');
    expect(source).toContain('await runPolicyScan(supabase, familyId, userId, { now })');
  });
});

// Controls for the bounded writer fixture: these keep passing application tests
// from acquiring permissions or origin metadata that PostgreSQL does not grant.
// The native 0487 SQL/HTTP tests remain the oracle for RLS, locks and triggers.
describe('the atomic writer fixture preserves the database boundary', () => {
  const stamp = `autopilot-source:${'a'.repeat(64)}`;
  const at = '2026-09-22T09:00:00.000Z';
  const card = () => ({ id: 'card-1', family_id: 'family-1', member_id: null, kind: 'renewal',
    title: 'Passport', action_type: 'create_reminder', source_kind: 'renewals', source_id: 'renewal-1',
    status: 'open', updated_at: '2026-09-21T06:00:00.000Z', expires_at: at, payload: {}, dedupe_key: 'passport' });
  function household() {
    const db = createInMemorySupabase();
    db.seed('families', [{ id: 'family-1' }]);
    db.seed('family_members', [{ id: 'member-1', family_id: 'family-1', user_id: 'user-1', role: 'parent', is_active: true }]);
    return db;
  }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-09-21T06:00:00.000Z'); });
  afterEach(() => vi.useRealTimers());

  it('requires explicit role and current membership, and refuses unknown RPCs', async () => {
    const db = household();
    const args = { p_card: card(), p_at: at, p_actor: 'user-1' };
    expect((await db.rpc('create_card_legacy_reminder_service', args)).error?.code).toBe('42501');
    db.setRpcAuth(null, 'service_role');
    expect((await db.rpc('create_card_legacy_reminder_service', { ...args, p_actor: 'outsider' })).error?.code).toBe('42501');
    expect((await db.rpc('create_card_legacy_reminder_service', { ...args, p_card: { ...card(), member_id: 'foreign-member' } })).error?.code).toBe('42501');
    db.setRpcAuth(null);
    expect((await db.rpc('create_card_legacy_reminder', args)).error?.code).toBe('42501');
    expect((await db.rpc('unmodelled_writer', args)).error?.code).toBe('42883');
    expect(db.table('autopilot_suggestions')).toEqual([]);
    expect(db.table('reminders')).toEqual([]);
  });

  it('mints the scan identity and committed receipt even without a service actor', async () => {
    const db = household();
    db.setRpcAuth(null, 'service_role');
    const result = await db.rpc('create_card_legacy_reminder_service', {
      p_card: { ...card(), id: 'forged-id', created_at: '1900-01-01', status: 'executed', resolved_by: 'outsider' },
      p_at: at, p_actor: null,
    });
    expect(result.error).toBeNull();
    const [saved] = db.table('autopilot_suggestions');
    const [reminder] = db.table('reminders');
    expect(saved.id).not.toBe('forged-id');
    expect(saved).toMatchObject({ status: 'auto_executed', created_at: '2026-09-21T06:00:00.000Z', resolved_by: null, created_by: null });
    expect(reminder).toMatchObject({ autopilot_origin: true, autopilot_card_id: saved.id });
    expect(saved.payload).toMatchObject({ reminder_id: reminder.id });
    expect(result.data).toEqual({ card_id: saved.id, reminder_id: reminder.id, family_id: 'family-1' });
  });

  it('defaults real manual inserts without laundering seeded or direct generated rows', async () => {
    const db = household();
    db.seed('family_reminders', [{ id: 'historic', family_id: 'family-1' }]);
    expect(db.table('family_reminders')[0]).not.toHaveProperty('autopilot_origin');
    const manual = await db.from('family_reminders').insert({ id: 'manual', family_id: 'family-1' }).select('*').single();
    expect(manual.error).toBeNull();
    expect(manual.data).toMatchObject({ autopilot_origin: false, autopilot_card_id: null });
    for (const generated of [{ autopilot_origin: true }, { autopilot_card_id: 'card-1' }, { tags: [stamp] }]) {
      expect((await db.from('family_reminders').insert({ family_id: 'family-1', ...generated })).error?.code).toBe('42501');
      // PostgreSQL runs BEFORE INSERT even when ON CONFLICT finds an existing id.
      expect((await db.from('family_reminders').upsert({ id: 'manual', family_id: 'family-1', ...generated }, { onConflict: 'id' })).error?.code).toBe('42501');
    }
    expect((await db.from('reminders').insert({ family_id: 'family-1', related_type: 'renewal', related_id: 'renewal-1' })).error?.code).toBe('42501');
    expect(db.table('family_reminders')).toHaveLength(2);
    expect(db.table('family_reminders')[1]).toMatchObject({ id: 'manual', autopilot_origin: false, autopilot_card_id: null });
    expect(db.table('reminders')).toEqual([]);
  });

  it('replays only the same family receipt after revision and source time have passed', async () => {
    const db = household();
    db.setRpcAuth('user-1');
    db.seed('autopilot_suggestions', [card()]);
    const args = { p_card_id: 'card-1', p_expected_updated_at: card().updated_at, p_at: at, p_source_tag: stamp };
    const first = await db.rpc('create_card_family_reminder', args).maybeSingle();
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ autopilot_origin: true, autopilot_card_id: 'card-1', tags: [stamp] });
    vi.setSystemTime('2026-09-23T00:00:00.000Z');
    db.table('autopilot_suggestions')[0].status = 'executed';
    db.table('autopilot_suggestions')[0].updated_at = 'new revision';
    const replay = await db.rpc('create_card_family_reminder', args).maybeSingle();
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual(first.data);
    expect(db.table('family_reminders')).toHaveLength(1);
    db.table('family_reminders')[0].autopilot_card_id = 'other-card';
    expect((await db.rpc('create_card_family_reminder', args)).error?.code).toBe('40001');
    expect(db.table('family_reminders')).toHaveLength(1);
  });

  it('does not replay a recurrence receipt around an orphaned nonnull card guard', async () => {
    const db = household();
    db.setRpcAuth('user-1');
    const parent = { id: 'parent', family_id: 'family-1', status: 'completed', autopilot_origin: true,
      autopilot_card_id: 'missing-card', tags: [stamp] };
    db.seed('family_reminders', [parent, { ...parent, id: 'existing-repeat', status: 'active',
      idempotency_key: createHash('sha256').update('autopilot.repeat:parent').digest('hex') }]);
    expect((await db.rpc('repeat_card_family_reminder', { p_parent_id: parent.id, p_at: at })).error?.code).toBe('42501');
    expect(db.table('family_reminders')).toHaveLength(2);
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

const SUPPORTED = {
  domain: 'scheduling', capability: 'automate', toolName: 'reminders.create',
  approvals: 4, rejections: 0, corrections: 0, failedCalls: 0, succeededCalls: 4,
  firstApprovedAt: '2026-08-12T10:00:00Z', lastApprovedAt: '2026-09-01T10:00:00Z',
  evidence: 'Approved 4 times since 12 Aug, never rejected', confidence: 74,
  dedupeKey: 'policy:scheduling:automate:reminders.create',
  title: 'Let Bubaly create reminders without asking', actionLabel: 'Trust Bubaly with this',
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
    harness.candidates = [SUPPORTED];
  });
  afterEach(() => vi.restoreAllMocks());

  it('refuses a suggestion the family\'s approval history does not support', async () => {
    // A member can write autopilot_suggestions directly; a forged "suggestion"
    // proposing an AI permission, with invented evidence, must not become a
    // policy just because a parent clicked accept.
    harness.candidates = [];
    seedSuggestion(db, { payload: { ...PROPOSAL, domain: 'finances', tool: 'wallet.transfer', evidence: 'Approved 40 times, never rejected' } });

    const res = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    expect(res).toEqual({ ok: false, error: 'That suggestion does not propose a policy.' });
    expect(db.table('trust_policies')).toEqual([]);
    expect(db.table('autopilot_suggestions')[0].status).toBe('open');
  });

  it('writes the policy from the re-derived evidence, not the row', async () => {
    seedSuggestion(db, { payload: { ...PROPOSAL, approvals: 999, evidence: 'Approved 999 times' } });

    const res = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    expect(res).toEqual({ ok: true });
    const [policy] = db.table('trust_policies');
    expect(String(policy.description)).toContain('Approved 4 times since 12 Aug, never rejected');
    expect((policy.conditions as Record<string, unknown>).approvals).toBe(4);
  });

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

  it('two simultaneous accepts write ONE policy: the second loses the claim', async () => {
    seedSuggestion(db);

    const results = await Promise.all([
      acceptPolicySuggestionAction({ suggestionId: 'sug-1' }),
      acceptPolicySuggestionAction({ suggestionId: 'sug-1' }),
    ]);

    expect(db.table('trust_policies')).toHaveLength(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: 'That suggestion is no longer open.' });
    expect(db.table('autopilot_suggestions')[0].status).toBe('executed');
  });

  it('recovers an abandoned claim of your own: an old \'approved\' row with no policy is accepted again, once', async () => {
    // The accept claimed the row and then stopped before writing the policy.
    seedSuggestion(db, { status: 'approved', resolved_by: 'user-1', resolved_at: new Date(Date.now() - 10 * 60_000).toISOString() });

    const results = await Promise.all([
      acceptPolicySuggestionAction({ suggestionId: 'sug-1' }),
      acceptPolicySuggestionAction({ suggestionId: 'sug-1' }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(db.table('trust_policies')).toHaveLength(1);
    expect(db.table('autopilot_suggestions')[0]).toMatchObject({ status: 'executed', resolved_by: 'user-1' });
  });

  it('leaves a claim that is still in flight, or another manager\'s, alone', async () => {
    seedSuggestion(db, { status: 'approved', resolved_by: 'user-1', resolved_at: new Date().toISOString() });
    expect(await acceptPolicySuggestionAction({ suggestionId: 'sug-1' })).toEqual({ ok: false, error: 'That suggestion is no longer open.' });
    db.reset();
    seedSuggestion(db, { status: 'approved', resolved_by: 'user-2', resolved_at: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect(await acceptPolicySuggestionAction({ suggestionId: 'sug-1' })).toEqual({ ok: false, error: 'That suggestion is no longer open.' });
    expect(db.table('trust_policies')).toEqual([]);
    expect(db.table('autopilot_suggestions')[0].status).toBe('approved');
  });

  it('never flips a dismissal that landed mid-accept back to executed, and writes no policy', async () => {
    seedSuggestion(db);
    // Another member dismisses the card while the accept re-derives the evidence.
    harness.candidates = new Proxy([SUPPORTED], {
      get(target, prop, receiver) {
        if (prop === 'find') Object.assign(db.table('autopilot_suggestions')[0], { status: 'dismissed', resolved_by: 'user-2', updated_at: '2026-09-09T11:00:00Z' });
        return Reflect.get(target, prop, receiver);
      },
    });

    const res = await acceptPolicySuggestionAction({ suggestionId: 'sug-1' });

    expect(res).toEqual({ ok: false, error: 'That suggestion is no longer open.' });
    expect(db.table('autopilot_suggestions')[0]).toMatchObject({ status: 'dismissed', resolved_by: 'user-2' });
    expect(db.table('trust_policies')).toEqual([]);
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
