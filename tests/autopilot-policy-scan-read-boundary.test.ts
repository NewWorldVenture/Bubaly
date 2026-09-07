// Household Autopilot (M7): the persisted half. The policy scan reads the
// family's approval history and reconciles the `policy:*` rows it owns in
// autopilot_suggestions. Two things are pinned here: a read that fails is a
// scan that did not happen (treating it as "no approvals" would withdraw every
// open offer and silently stop making new ones), and the scan writes
// suggestions and nothing else — no policy, no reminder, no grocery.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { loadPolicyCandidates, runPolicyScan } from '@/lib/autopilot/policy-scan';
import { runAutopilotScan } from '@/lib/autopilot/scan';

type QueryResult = { data: unknown; error: unknown };
type Write = { table: string; operation: string };

const TABLES = ['approval_requests', 'ai_tool_calls', 'trust_policies', 'autopilot_suggestions'] as const;

/** A chainable stub in the style of tests/reasoning-context-read-boundary: one table's read fails. */
function stubClient(failingTable: string | null) {
  const writes: Write[] = [];
  const client = {
    from(table: string) {
      const result: QueryResult = table === failingTable
        ? { data: null, error: { message: `permission denied for table ${table}` } }
        : { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit']) chain[method] = () => chain;
      chain.maybeSingle = () => Promise.resolve(result);
      chain.single = () => Promise.resolve(result);
      chain.insert = () => { writes.push({ table, operation: 'insert' }); return chain; };
      chain.update = () => { writes.push({ table, operation: 'update' }); return chain; };
      chain.delete = () => { writes.push({ table, operation: 'delete' }); return chain; };
      chain.then = (onFulfilled: (value: QueryResult) => unknown, onRejected: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected);
      return chain;
    },
  };
  return { client, writes };
}

describe('policy scan read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(TABLES)('fails closed, writes nothing and logs when %s cannot be read', async (table) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, writes } = stubClient(table);

    await expect(runPolicyScan(client as never, 'family-1', 'user-1')).rejects.toThrow('Autopilot could not read the approval history');
    await expect(loadPolicyCandidates(client as never, 'family-1')).rejects.toThrow('Autopilot could not read the approval history');

    expect(writes).toEqual([]);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[autopilot] policy scan read failed');
  });

  it('does not log, and writes nothing, when every read succeeds and there is no history', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, writes } = stubClient(null);

    await expect(runPolicyScan(client as never, 'family-1', 'user-1')).resolves.toEqual({ candidates: 0, inserted: 0, refreshed: 0, cleared: 0 });

    expect(writes).toEqual([]);
    expect(err).not.toHaveBeenCalled();
  });
});

// ── the reconciliation, against real tables ──────────────────────────────────

const NOW = new Date('2026-09-07T12:00:00Z');
const DECIDED = ['2026-08-12T10:00:00Z', '2026-08-20T10:00:00Z', '2026-09-01T10:00:00Z', '2026-09-03T10:00:00Z'];
const KEY = 'policy:scheduling:automate:reminders.create';

let seq = 0;
function approvalRow(familyId: string, over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `approval-${seq}`, family_id: familyId, domain: 'scheduling', capability: 'automate',
    requested_by_kind: 'ai', status: 'approved', decided_at: DECIDED[(seq - 1) % DECIDED.length],
    // The legacy alias, as the chat wrapper and older rows spell it: the scan
    // resolves it to the registry's canonical name.
    payload: { name: 'create_reminder', args: { title: 'Pack the swim kit' } }, payload_kind: null,
    ...over,
  };
}

function seedStreak(db: InMemorySupabase, familyId: string, n: number) {
  seq = 0;
  db.seed('approval_requests', Array.from({ length: n }, () => approvalRow(familyId)));
  db.seed('ai_tool_calls', [
    { family_id: familyId, tool_name: 'reminders.create', state: 'succeeded', created_at: '2026-08-13T10:00:00Z', idempotency_key: 'k1' },
    { family_id: familyId, tool_name: 'reminders.create', state: 'succeeded', created_at: '2026-08-21T10:00:00Z', idempotency_key: 'k2' },
  ]);
}

const policyRows = (db: InMemorySupabase, familyId = 'family-1') =>
  db.table('autopilot_suggestions').filter((r) => r.family_id === familyId && r.kind === 'policy');

describe('policy scan reconciliation', () => {
  let db: InMemorySupabase;
  beforeEach(() => { db = createInMemorySupabase({ uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] } }); });

  it('offers ONE narrow policy suggestion once the family has approved the same tool three times, and executes nothing', async () => {
    seedStreak(db, 'family-1', 3);

    const result = await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });

    expect(result).toEqual({ candidates: 1, inserted: 1, refreshed: 0, cleared: 0 });
    const rows = policyRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      family_id: 'family-1', member_id: null, kind: 'policy', status: 'open', urgency: 1, confidence: 70,
      action_type: 'accept_policy', source_kind: 'approval_requests', dedupe_key: KEY, created_by: 'user-1',
      title: 'Let Bubaly create reminders without asking',
      payload: { domain: 'scheduling', capability: 'automate', tool: 'reminders.create', approvals: 3, firstApprovedAt: '2026-08-12T10:00:00Z' },
    });
    expect(String(rows[0].detail)).toContain('Approved 3 times since 12 Aug, never rejected');
    // Offered, never applied: the policy is written only when a manager accepts.
    expect(db.table('trust_policies')).toEqual([]);
    expect(db.table('reminders')).toEqual([]);
    expect(db.table('grocery_items')).toEqual([]);
  });

  it('is idempotent: a second scan neither duplicates nor rewrites the open offer', async () => {
    seedStreak(db, 'family-1', 3);
    await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });
    const before = { ...policyRows(db)[0] };

    const again = await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });

    expect(again).toEqual({ candidates: 1, inserted: 0, refreshed: 0, cleared: 0 });
    expect(policyRows(db)).toHaveLength(1);
    expect(policyRows(db)[0]).toEqual(before);
  });

  it('refreshes an open offer when the streak grows', async () => {
    seedStreak(db, 'family-1', 3);
    await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });
    db.seed('approval_requests', [approvalRow('family-1', { decided_at: '2026-09-05T10:00:00Z' })]);

    const result = await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });

    expect(result).toEqual({ candidates: 1, inserted: 0, refreshed: 1, cleared: 0 });
    const [row] = policyRows(db);
    expect(row.confidence).toBe(74);
    expect(String(row.detail)).toContain('Approved 4 times since 12 Aug, never rejected');
    expect((row.payload as { approvals: number }).approvals).toBe(4);
    expect(row.status).toBe('open');
  });

  it('respects a dismissed offer: it is not re-made and not rewritten', async () => {
    seedStreak(db, 'family-1', 3);
    await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });
    policyRows(db)[0].status = 'dismissed';
    db.seed('approval_requests', [approvalRow('family-1', { decided_at: '2026-09-05T10:00:00Z' })]);

    const result = await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });

    expect(result).toEqual({ candidates: 1, inserted: 0, refreshed: 0, cleared: 0 });
    expect(policyRows(db)).toHaveLength(1);
    expect(policyRows(db)[0]).toMatchObject({ status: 'dismissed', confidence: 70 });
  });

  it('withdraws an open offer when a rejection breaks the streak', async () => {
    seedStreak(db, 'family-1', 3);
    await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });
    db.seed('approval_requests', [approvalRow('family-1', { status: 'rejected', decided_at: '2026-09-05T10:00:00Z' })]);

    const result = await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });

    expect(result).toEqual({ candidates: 0, inserted: 0, refreshed: 0, cleared: 1 });
    expect(policyRows(db)).toEqual([]);
  });

  it('withdraws an open offer when the tool fails', async () => {
    seedStreak(db, 'family-1', 3);
    await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });
    db.seed('ai_tool_calls', [{ family_id: 'family-1', tool_name: 'reminders.create', state: 'failed', created_at: '2026-09-05T10:00:00Z', idempotency_key: 'k3' }]);

    const result = await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });

    expect(result.cleared).toBe(1);
    expect(policyRows(db)).toEqual([]);
  });

  it('does not offer a policy the family already holds — to Bubaly or to everyone', async () => {
    seedStreak(db, 'family-1', 3);
    db.seed('trust_policies', [{
      family_id: 'family-1', name: 'Reminders OK', domain: 'scheduling', capability: 'automate',
      subject_kind: 'everyone', effect: 'allow', enabled: true, conditions: { tags: ['reminders.create'] },
    }]);

    const result = await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });

    expect(result).toEqual({ candidates: 0, inserted: 0, refreshed: 0, cleared: 0 });
    expect(policyRows(db)).toEqual([]);
  });

  it('ignores a plan approval even when its payload names a tool', async () => {
    seq = 0;
    db.seed('approval_requests', Array.from({ length: 3 }, () => approvalRow('family-1', { payload_kind: 'plan_steps', payload: { name: 'create_reminder', steps: [] } })));

    const result = await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });

    expect(result.candidates).toBe(0);
    expect(policyRows(db)).toEqual([]);
  });

  it('reads only the scanning family', async () => {
    seedStreak(db, 'family-2', 3);

    const forOne = await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });
    expect(forOne).toEqual({ candidates: 0, inserted: 0, refreshed: 0, cleared: 0 });
    expect(policyRows(db, 'family-1')).toEqual([]);

    const forTwo = await runPolicyScan(db as never, 'family-2', null, { now: NOW });
    expect(forTwo.inserted).toBe(1);
    expect(policyRows(db, 'family-2')[0]).toMatchObject({ family_id: 'family-2', created_by: null });
  });

  it('touches nothing but the four tables it reads and the suggestions it owns', async () => {
    seedStreak(db, 'family-1', 3);
    await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });
    db.seed('approval_requests', [approvalRow('family-1', { status: 'rejected', decided_at: '2026-09-05T10:00:00Z' })]);
    await runPolicyScan(db as never, 'family-1', 'user-1', { now: NOW });

    const touched = new Set(db.log.map((entry) => entry.table));
    expect([...touched].sort()).toEqual([...TABLES].sort());
    expect(db.table('trust_policies')).toEqual([]);
  });
});

describe('the main Autopilot scan and the policy pass share one table', () => {
  it('leaves an open learned-policy offer in place across main scans, and reports it without executing it', async () => {
    const db = createInMemorySupabase({ uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] } });
    seedStreak(db, 'family-1', 3);

    const first = await runAutopilotScan(db as never, 'family-1', 'user-1');
    expect(first.policyCandidates).toBe(1);
    expect(first.autoExecuted).toBe(0);
    expect(policyRows(db)).toHaveLength(1);

    // The main pass clears OPEN rows whose signal vanished; a policy row is
    // never among its drafts, so without the carve-out this second scan would
    // delete the offer it had just made.
    const second = await runAutopilotScan(db as never, 'family-1', 'user-1');
    expect(second.cleared).toBe(0);
    expect(second.policyCandidates).toBe(1);
    expect(policyRows(db)).toHaveLength(1);
    expect(policyRows(db)[0].status).toBe('open');

    expect(db.table('trust_policies')).toEqual([]);
    expect(db.table('reminders')).toEqual([]);
  });
});
