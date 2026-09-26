import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Escalation acknowledged" must be true.
 *
 * guardian_escalations is SELECT-only for family members. The acknowledge
 * action updated it through the parent's own session, which RLS filtered to
 * zero rows without an error — measured on the replayed schema: the parent sees
 * the escalation (1 row) and the update touches 0. The action said
 * "Escalation acknowledged", the page refreshed, and the red Emergency Alert
 * banner came straight back, every time.
 *
 * Alongside it: the on-demand learning run wrote its audit row through the same
 * session (refused, and the refusal discarded), and ran on from failed reads —
 * so a failed read of the pending queue re-filed every open suggestion.
 */

const state = vi.hoisted(() => ({
  role: 'parent' as string,
  updated: [] as Array<{ id: string }>,
  updateError: null as null | { message: string },
  existing: null as null | { acknowledged_at: string | null },
  audits: [] as Array<Record<string, unknown>>,
  filters: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'u-1' }, active: { familyId: 'f-1', role: state.role } }),
}));
vi.mock('@/lib/supabase/server', () => {
  const escalations = () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      update: () => chain,
      eq: (col: string, val: string) => { state.filters.push(`${col}=${val}`); return chain; },
      is: (col: string) => { state.filters.push(`${col} is null`); return chain; },
      select: (cols: string) => cols === 'id'
        ? Promise.resolve({ data: state.updateError ? null : state.updated, error: state.updateError })
        : chain,
      maybeSingle: () => Promise.resolve({ data: state.existing, error: null }),
    });
    return chain;
  };
  const service = {
    from: (table: string) => table === 'guardian_audit_log'
      ? { insert: (row: Record<string, unknown>) => { state.audits.push(row); return Promise.resolve({ error: null }); } }
      : escalations(),
  };
  // The parent's own session must not be used for this write at all.
  const session = { from: () => { throw new Error('acknowledged through the member session'); } };
  return { createServiceClient: () => service, createServer: async () => session };
});

async function acknowledge() {
  const { acknowledgeEscalationAction } = await import('@/app/(app)/guardian/actions');
  return acknowledgeEscalationAction('esc-1');
}

describe('acknowledging a Guardian escalation', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(state, { role: 'parent', updated: [], updateError: null, existing: null, audits: [], filters: [] });
  });

  it('acknowledges it, scoped to the family, and audits it', async () => {
    state.updated = [{ id: 'esc-1' }];
    expect(await acknowledge()).toEqual({ ok: true });
    expect(state.filters).toEqual(expect.arrayContaining(['id=esc-1', 'family_id=f-1', 'acknowledged_at is null']));
    expect(state.audits).toEqual([expect.objectContaining({ action: 'escalation.acknowledged', actor: 'parent', entity_id: 'esc-1' })]);
  });

  // The finding.
  it('does not say "acknowledged" when nothing was', async () => {
    state.updated = [];
    state.existing = null;
    const res = await acknowledge();
    expect(res.ok, 'a zero-row acknowledge was reported as done').toBe(false);
    expect(state.audits).toEqual([]);
  });

  it('treats an escalation someone already acknowledged as done, without overwriting it', async () => {
    state.updated = [];
    state.existing = { acknowledged_at: '2026-09-26T10:00:00Z' };
    expect(await acknowledge()).toEqual({ ok: true });
    expect(state.audits).toEqual([]);
  });

  it('still refuses a member who is not a manager', async () => {
    state.role = 'teen';
    state.updated = [{ id: 'esc-1' }];
    const res = await acknowledge();
    expect(res.ok).toBe(false);
    expect(state.filters).toEqual([]);
  });
});

describe('the Guardian learning run', () => {
  type Reply = { data: unknown; error: unknown };
  function fakeClient(replies: Record<string, Reply>, inserts: Array<{ table: string; row: unknown }>) {
    return {
      from: (table: string) => {
        const reply = replies[table] ?? { data: [], error: null };
        const chain: Record<string, unknown> = {};
        const done = Promise.resolve(reply);
        Object.assign(chain, {
          select: () => chain, eq: () => chain, gte: () => chain, order: () => chain,
          limit: () => done,
          then: (a: (v: Reply) => unknown, b: (e: unknown) => unknown) => done.then(a, b),
          insert: (row: unknown) => { inserts.push({ table, row }); return Promise.resolve({ error: table === 'guardian_audit_log' ? { message: 'RLS' } : null }); },
        });
        return chain;
      },
    };
  }

  it('stops when the pending queue cannot be read, instead of re-filing it', async () => {
    const { runLearningForFamily } = await import('@/lib/guardian/learning-run');
    const inserts: Array<{ table: string; row: unknown }> = [];
    const client = fakeClient({ guardian_suggestions: { data: null, error: { message: 'timeout' } } }, inserts);
    await expect(runLearningForFamily(client as never, 'f-1')).rejects.toThrow();
    expect(inserts).toEqual([]);
  });

  it('the parent-triggered action passes a client that can write the audit log', () => {
    const source = readFileSync('app/(app)/guardian/actions.ts', 'utf8');
    expect(source).toMatch(/runLearningForFamily\(supabase, ctx\.active\.familyId, \{ auditClient: createServiceClient\(\) \}\)/);
  });
});

describe('the Guardian dashboard', () => {
  const source = readFileSync('components/guardian/guardian-dashboard.tsx', 'utf8');
  for (const action of ['generateGuardianSuggestionsAction', 'updateContextAction', 'reviewSuggestionAction', 'acknowledgeEscalationAction']) {
    it(`${action} has a rejection path`, () => {
      const at = source.indexOf(`await ${action}(`);
      expect(at, `${action} is no longer called`).toBeGreaterThan(-1);
      const before = source.slice(Math.max(0, at - 120), at);
      const after = source.slice(at, at + 500);
      expect(before, `${action}: not inside a try`).toMatch(/try \{/);
      expect(after, `${action}: no catch`).toMatch(/catch \(err\)/);
    });
  }
});
