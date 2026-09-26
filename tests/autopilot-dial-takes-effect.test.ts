// The autopilot dial is the switch that decides whether Bubaly acts on its own.
// It wrote ONE trust policy — that is what its doc comment claimed — by reading
// the existing policy, branching on what came back, and DISCARDING the read's
// error.
//
// A PostgREST read resolves with { data, error }. A refused read therefore
// handed back `data: null`, which is indistinguishable from "no policy yet", and
// the else branch inserted a SECOND policy. Nothing in the schema prevents it:
// 0093_trust_engine.sql gives trust_policies two non-unique indexes and no
// unique key on (family_id, name).
//
// Two rows change the answer. Both carry priority 10, the engine takes the
// highest-priority match, and the policies were loaded with no ORDER BY — so
// which one governed was decided by whatever order Postgres returned. A parent
// who set the dial to `off` could be left with a stale `allow` still deciding.
//
// And it ratcheted: with two rows present `.maybeSingle()` itself fails
// (postgrest-js returns PGRST116 and `data: null` for more than one row), so
// every later save read null again and inserted yet another policy. The dial
// could never take effect again — and reported success each time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateAction } from '@/lib/trust/engine';

const requireUserContext = vi.fn();
const createServer = vi.fn();
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

type Recorded = { updates: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }>; inserts: Record<string, unknown>[] };

/**
 * A client that records what the action did. `updateReturns` is what the UPDATE
 * reports back: the rows it actually matched (`[]` means nothing was there),
 * or an error.
 */
function client(updateReturns: { data: Array<{ id: string }> | null; error: unknown }, insertError: unknown = null) {
  const rec: Recorded = { updates: [], inserts: [] };
  const from = () => {
    const filters: Record<string, unknown> = {};
    let patch: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      update: (p: Record<string, unknown>) => { patch = p; return chain; },
      insert: (row: Record<string, unknown>) => {
        rec.inserts.push(row);
        return Promise.resolve({ data: null, error: insertError });
      },
      select: () => {
        rec.updates.push({ patch, filters: { ...filters } });
        return Promise.resolve(updateReturns);
      },
      eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
      // Reached only if something awaits the update without .select().
      then: (onF: (v: unknown) => unknown) => {
        rec.updates.push({ patch, filters: { ...filters } });
        return Promise.resolve(updateReturns).then(onF);
      },
    };
    return chain;
  };
  return { supabase: { from }, rec };
}

const load = async () => (await import('@/app/(app)/dashboard/concierge/actions')).setConciergeAutopilotAction;

describe('turning autopilot off actually turns it off', () => {
  beforeEach(() => {
    vi.resetModules();
    requireUserContext.mockResolvedValue({
      active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' } },
      user: { id: 'user-1' },
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('updates every policy of that name rather than one id read back', async () => {
    // The already-duplicated family: two rows exist. Both must be moved, or the
    // one left behind can still be the one the engine picks.
    const { supabase, rec } = client({ data: [{ id: 'p-1' }, { id: 'p-2' }], error: null });
    createServer.mockResolvedValue(supabase);

    const res = await (await load())('off');

    expect(res.ok).toBe(true);
    expect(rec.inserts, 'a policy already existed — inserting adds a third').toEqual([]);
    expect(rec.updates).toHaveLength(1);
    // Keyed on the family and the policy NAME, not on an id a read returned.
    expect(rec.updates[0].filters).toMatchObject({ family_id: 'fam-1', name: 'Concierge autopilot' });
    expect(rec.updates[0].filters).not.toHaveProperty('id');
    expect(rec.updates[0].patch).toMatchObject({ effect: 'deny', enabled: true });
  });

  it('inserts only when the update matched nothing', async () => {
    const { supabase, rec } = client({ data: [], error: null });
    createServer.mockResolvedValue(supabase);

    const res = await (await load())('auto');

    expect(res.ok).toBe(true);
    expect(rec.inserts).toHaveLength(1);
    expect(rec.inserts[0]).toMatchObject({
      family_id: 'fam-1', name: 'Concierge autopilot', effect: 'allow',
      subject_kind: 'ai', enabled: true, is_system: true,
    });
  });

  it('reports failure instead of success when the update is refused', async () => {
    // The whole point. A refused write used to leave the dial reporting ok.
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a); });
    const { supabase, rec } = client({ data: null, error: { message: 'permission denied for table trust_policies' } });
    createServer.mockResolvedValue(supabase);

    const res = await (await load())('off');

    expect(res.ok, 'told the parent autopilot was off when nothing was written').toBe(false);
    expect(rec.inserts, 'a refused update must not be read as "no policy yet"').toEqual([]);
    expect(logged.length).toBeGreaterThan(0);
    expect(String(logged[0][0])).toContain('[concierge]');
  });

  it('reports failure when the insert is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = client({ data: [], error: null }, { message: 'insert denied' });
    createServer.mockResolvedValue(supabase);

    expect((await (await load())('ask')).ok).toBe(false);
  });

  it('maps each dial position to the effect the engine obeys', async () => {
    for (const [level, effect] of [['auto', 'allow'], ['ask', 'require_approval'], ['off', 'deny']] as const) {
      vi.resetModules();
      const { supabase, rec } = client({ data: [], error: null });
      createServer.mockResolvedValue(supabase);
      await (await load())(level);
      expect(rec.inserts[0], level).toMatchObject({ effect });
    }
  });

  it('refuses a caller who is not a manager, before any write', async () => {
    requireUserContext.mockResolvedValue({
      active: { familyId: 'fam-1', role: 'child', member: { id: 'mem-9' } }, user: { id: 'user-9' },
    });
    const { supabase, rec } = client({ data: [], error: null });
    createServer.mockResolvedValue(supabase);

    expect((await (await load())('auto')).ok).toBe(false);
    expect(rec.updates).toEqual([]);
    expect(rec.inserts).toEqual([]);
  });
});

describe('why one leftover policy mattered', () => {
  // Proves the consequence rather than asserting it: the engine resolves two
  // equal-priority policies by list position, so a stale `allow` left behind by
  // the old code could out-rank the `deny` the parent had just chosen.
  // The shape the loader produces (lib/trust/server.ts toPolicy) and the actor
  // the autopilot loop evaluates as — `subject_kind: 'ai'` matches an actor of
  // kind 'ai_agent', which is what the running loop passes.
  const policy = (id: string, effect: string) => ({
    id, domain: 'scheduling', capability: 'automate' as const,
    subjectKind: 'ai' as const, subjectRole: null, subjectMemberId: null,
    effect, conditions: {}, approvalModel: 'single' as const, requiredApprovals: 1,
    priority: 10, enabled: true,
  });
  const ask = {
    actor: { kind: 'ai_agent' as const, id: 'ai', role: null },
    domain: 'scheduling', capability: 'automate' as const,
  };

  it('the first equal-priority policy in the list wins', () => {
    const stale = policy('p-old', 'allow');
    const chosen = policy('p-new', 'deny');
    const inputs = { grants: [], delegations: [], emergencyDomains: [], context: {} };

    const staleFirst = evaluateAction({ ...ask, policies: [stale, chosen], ...inputs } as never);
    const chosenFirst = evaluateAction({ ...ask, policies: [chosen, stale], ...inputs } as never);

    // Same two rows, opposite answers — decided purely by order.
    expect(staleFirst.effect).toBe('allow');
    expect(chosenFirst.effect).toBe('deny');
  });

  it('once both rows carry the same effect, order stops mattering', () => {
    // What the fix guarantees: the update moves every row of that name, so
    // whichever the engine reaches first gives the parent's answer.
    const a = policy('p-old', 'deny');
    const b = policy('p-new', 'deny');
    const inputs = { grants: [], delegations: [], emergencyDomains: [], context: {} };
    expect(evaluateAction({ ...ask, policies: [a, b], ...inputs } as never).effect).toBe('deny');
    expect(evaluateAction({ ...ask, policies: [b, a], ...inputs } as never).effect).toBe('deny');
  });
});

describe('the policy load is ordered, so ties resolve the same way twice', () => {
  it('lib/trust/server.ts orders trust_policies before the engine sorts them', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('lib/trust/server.ts', 'utf8');
    const load = source.slice(source.indexOf("from('trust_policies')"));
    const statement = load.slice(0, load.indexOf('\n    supabase.from('));
    expect(statement, 'an unordered select has no defined row order')
      .toContain(".order('priority', { ascending: false })");
    expect(statement, 'priority alone still ties').toContain(".order('created_at'");
  });
});
