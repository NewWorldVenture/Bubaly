// The Trust Engine gates AI actions and money. Its inputs failed open.
//
// `loadTrustInputs` destructured `data` from four reads and dropped every
// `error`, each falling back to `?? []`:
//
//   const [{ data: policies }, { data: grants }, …] = await settleAll([…]);
//   return { policies: (policies ?? []).map(toPolicy), grants: (grants ?? [])… };
//
// A failed `trust_policies` read therefore evaluated as "this family has no
// policies", and a failed `permission_grants` read as "this member has no deny
// grant". Those are steps 2 and 3 of `evaluateAction` — the two that produce an
// explicit deny — so the engine fell through to role defaults, which are more
// permissive by construction. That is why a family writes a policy at all.
//
// `settleAll` exists so a transport rejection arrives in the shape the caller
// already handles. This caller handled nothing, so the mechanism landed on the
// floor exactly here.
//
// Judged on the DECISION, not on whether anything threw: the old code threw
// nothing, which was the whole problem.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

const holder = vi.hoisted(() => ({ service: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.service }));

const { evaluateTrust } = await import('@/lib/trust/server');

type Row = Record<string, unknown>;

/**
 * A PostgREST fake that can fail a chosen table the way a real outage does —
 * resolving with { data: null, error }, which is what `settle` produces for a
 * rejected transport too.
 */
function store(seed: Record<string, Row[]>, failing: Set<string> = new Set()) {
  const inserted: Row[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    const result = () => (failing.has(table)
      ? { data: null, error: { message: `${table} is unavailable` }, count: null }
      : { data: seed[table] ?? [], error: null, count: (seed[table] ?? []).length });
    Object.assign(b, {
      select: () => b, eq: () => b, is: () => b, gt: () => b, lt: () => b, in: () => b,
      order: () => b, limit: () => b, or: () => b, filter: () => b,
      insert: (p: Row) => { inserted.push(p); return Promise.resolve({ data: null, error: null }); },
      update: () => b, upsert: () => b,
      single: () => Promise.resolve({ data: (seed[table] ?? [])[0] ?? null, error: null }),
      maybeSingle: () => Promise.resolve({ data: (seed[table] ?? [])[0] ?? null, error: null }),
      then: (ok: (v: unknown) => void) => Promise.resolve(result()).then(ok),
    });
    return b;
  };
  const db = { from } as unknown as SupabaseClient<Database>;
  holder.service = db;
  return { db, inserted };
}

const FAMILY = 'fam-1';
// A PARENT is the actor that matters here. The engine's role default for a
// parent is `allow`, so a parent is exactly who a family's deny policy is
// written to restrain — and exactly who a failed read hands the keys to. (A
// teen is already denied by the role default, so losing the policy changes
// nothing for them, which is why the first draft of this test proved nothing.)
const PARENT = { kind: 'member' as const, id: 'parent-1', role: 'parent' as const };

/**
 * A household policy blocking money automation, in the shape the COLUMNS have.
 * `toPolicy` reads subject_kind / subject_role / domain / capability — singular
 * — and a row with `domains: []` / `roles: []` silently maps to a policy that
 * applies to nothing, which is a fixture that tests itself rather than the code.
 */
const DENY_POLICY: Row = {
  id: 'pol-1', family_id: FAMILY, enabled: true, priority: 100, effect: 'deny',
  domain: 'finances', capability: 'automate', subject_kind: 'role', subject_role: 'parent',
  subject_member_id: null, conditions: {}, approval_model: 'single', required_approvals: 1,
  updated_at: '2026-09-01T00:00:00Z',
};

const REQUEST = {
  actor: PARENT, domain: 'finances', capability: 'automate' as const,
  title: 'Move £40 to savings', context: { amountCents: 4000 }, openApproval: false,
};

beforeEach(() => { holder.service = null; });

describe('a rule that could not be read is not permission', () => {
  it('denies when the policy loads', async () => {
    // The baseline. Without this passing, the case below proves nothing.
    const { db } = store({ trust_policies: [DENY_POLICY], permission_grants: [], trust_delegations: [], emergency_sessions: [] });
    const { decision } = await evaluateTrust(db, FAMILY, REQUEST);
    expect(decision.effect).toBe('deny');
    expect(decision.basis).toBe('policy');
  });

  it('does not allow when the policy read fails', async () => {
    // The finding. The deny above is invisible, and the old code answered as if
    // the family had never written it.
    const { db } = store(
      { trust_policies: [DENY_POLICY], permission_grants: [], trust_delegations: [], emergency_sessions: [] },
      new Set(['trust_policies']),
    );
    const { decision } = await evaluateTrust(db, FAMILY, REQUEST);
    expect(decision.effect, 'a failed rule read became permission').not.toBe('allow');
    expect(decision.basis).toBe('degraded');
  });

  it('does not allow when the deny-grant read fails', async () => {
    // The other half of the same hole: step 2 of the engine is a per-member
    // deny grant, and it is read from a different table.
    const { db } = store(
      { trust_policies: [], permission_grants: [], trust_delegations: [], emergency_sessions: [] },
      new Set(['permission_grants']),
    );
    const { decision } = await evaluateTrust(db, FAMILY, REQUEST);
    expect(decision.effect).not.toBe('allow');
    expect(decision.basis).toBe('degraded');
  });

  it('asks rather than refusing outright', async () => {
    // Control on the direction of the fix. A hard deny would turn a transient
    // database blip into an outage of the whole AI layer — the same argument
    // the file already makes for not failing the audit write. A human can still
    // say yes.
    const { db } = store(
      { trust_policies: [], permission_grants: [], trust_delegations: [], emergency_sessions: [] },
      new Set(['trust_policies']),
    );
    const { decision } = await evaluateTrust(db, FAMILY, REQUEST);
    expect(decision.effect).toBe('require_approval');
  });

  it('leaves a deny alone when the rules did load', async () => {
    // Control: degrading must not rewrite decisions it has no business in.
    const { db } = store({
      trust_policies: [], trust_delegations: [], emergency_sessions: [],
      permission_grants: [{ member_id: 'parent-1', domain: 'finances', capability: 'automate', effect: 'deny' }],
    });
    const { decision } = await evaluateTrust(db, FAMILY, REQUEST);
    expect(decision.effect).toBe('deny');
    expect(decision.basis).toBe('deny_grant');
  });

  it('still records the degraded decision in the audit trail', async () => {
    // The family's one window onto what Bubaly decided has to show this too.
    const { db, inserted } = store(
      { trust_policies: [], permission_grants: [], trust_delegations: [], emergency_sessions: [] },
      new Set(['trust_policies']),
    );
    await evaluateTrust(db, FAMILY, REQUEST);
    const audit = inserted.find((r) => 'decision' in r);
    expect(audit?.decision).toBe('require_approval');
  });
});

describe('degrading must not loosen what it was meant to tighten', () => {
  // Reviewing the first version of this fix found two ways the downgrade made
  // things WORSE than the fail-open it replaced. Both are asserted here.

  it('leaves an emergency elevation alone', async () => {
    // `evaluateAction` resolves emergency in step 1, BEFORE a policy or grant is
    // read, so a failed read cannot have produced the allow. Downgrading it put
    // a human approval in front of Emergency Operations Mode — the one place
    // where asking is worse than acting.
    const { db } = store(
      { trust_policies: [], permission_grants: [], trust_delegations: [], emergency_sessions: [{ elevated_domains: ['finances'] }] },
      new Set(['trust_policies']),
    );
    const { decision } = await evaluateTrust(db, FAMILY, REQUEST);
    expect(decision.effect).toBe('allow');
    expect(decision.basis).toBe('emergency');
  });

  it('still downgrades a non-emergency allow when the read failed', async () => {
    // The control for the case above: excluding emergency must not exclude
    // everything else with it.
    const { db } = store(
      { trust_policies: [], permission_grants: [], trust_delegations: [], emergency_sessions: [] },
      new Set(['trust_policies']),
    );
    const { decision } = await evaluateTrust(db, FAMILY, REQUEST);
    expect(decision.effect).toBe('require_approval');
    expect(decision.basis).toBe('degraded');
  });
});
