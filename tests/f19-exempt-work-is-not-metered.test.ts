import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { admitAiRequest, type AdmitArgs } from './helpers/admit-ai-request';

// F19, independent review on #892 (comment 5970498462). Work the family did not
// ask for — chore-proof validation (`exemptFromAllowance`), a system-scope
// concierge intake (inbound contact-center routing), a scheduled routine — is
// filed as an `ai_requests` row for the record. Both meters (0477's admission
// and `assertAIAccess`) counted EVERY row, so that work used up the paid
// allowance: a Free family at 9 of 10 whose child submitted a chore proof was
// at 10 of 10 and its next real request was refused. The owner's ruling is
// that background work is not silently charged (#771 review 5391362628).
//
// 0477 adds `ai_requests.metered` (default true); exempt work is filed with
// `metered = false`, and both meters count only metered rows. This drives the
// REAL `withAiRequest`, `createRequest`, `submitRequest` and `assertAIAccess`
// over one in-memory database whose `admit_ai_request` is emulated from the
// same table (tests/helpers/admit-ai-request.ts), sequentially and in races.

const FAMILY = 'fam-1';
const USER = 'user-1';

const state = vi.hoisted(() => ({
  planLevel: 0,
  /** Refuse an insert that names `metered`, as PostgREST does before 0477 adds the column. */
  columnMissing: false,
}));

let store: InMemorySupabase;

/** The store, with `admit_ai_request` served from its own table, and an optional pre-0477 schema. */
function client() {
  return {
    from: (table: string) => {
      const builder = store.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (table === 'ai_requests' && state.columnMissing) {
        const insert = builder.insert.bind(builder);
        builder.insert = (row: unknown) => {
          if (row && typeof row === 'object' && 'metered' in row) {
            const refused = { data: null, error: { code: 'PGRST204', message: "Could not find the 'metered' column of 'ai_requests' in the schema cache" } };
            const chain = { select: () => chain, single: async () => refused, then: (ok: (v: unknown) => unknown) => ok(refused) };
            return chain;
          }
          return insert(row);
        };
      }
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'admit_ai_request') return { data: null, error: { code: 'PGRST202', message: `unexpected rpc ${name}` } };
      return admitAiRequest(db, args as unknown as AdmitArgs);
    },
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
  };
}
const db = { from: (t: string) => client().from(t), rpc: (n: string, a: Record<string, unknown>) => client().rpc(n, a), auth: client().auth };

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => db, createServiceClient: () => db }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => state.planLevel }));
vi.mock('@/lib/server/feature-tiers', () => ({ getResolvedFeatureTiers: async () => ({ 'ai-requests': 'free' }) }));
vi.mock('@/lib/ai/context/intents', () => ({
  classifyIntent: async () => ({ intent: 'plan_week', confidence: 0.9, entities: {}, source: 'fast_path' }),
  isIntentKey: (v: unknown) => typeof v === 'string',
}));
vi.mock('@/lib/ai/context/builder', () => ({
  buildContext: async () => ({ ok: true, data: { header: {}, slices: {}, stats: {}, sensitiveOmitted: [], text: 'ctx' } }),
}));
vi.mock('@/lib/ai/planner', () => ({
  planRequest: async () => ({ ok: true, data: { kind: 'plan', planId: 'plan-1', runId: 'run-1', stepCount: 1, riskLevel: 'low', requiresApproval: false, summary: 'Planned.' } }),
}));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => {} }));

const { withAiRequest, AiRequestOverAllowance } = await import('@/lib/ai/observability');
const { createRequest } = await import('@/lib/ai/runs/store');
const { submitRequest } = await import('@/lib/ai/runs/intake');
const { assertAIAccess } = await import('@/lib/server/ai-access');

const member = (): ServiceScope => ({
  db: db as unknown as ServiceScope['db'],
  familyId: FAMILY, userId: USER, memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'UTC',
});
const system = (): ServiceScope => ({
  db: db as unknown as ServiceScope['db'],
  familyId: FAMILY, userId: null, memberId: null, role: 'system', actorKind: 'system', tz: 'UTC',
});
const ctx = {
  user: { id: USER, email: 'parent@example.com' },
  memberships: [],
  active: { familyId: FAMILY, role: 'parent', member: { id: 'member-1' }, family: { name: 'Fam', timezone: 'UTC' } },
};

const rows = () => store.table('ai_requests').filter((r: Row) => r.family_id === FAMILY);
const meteredRows = () => rows().filter((r: Row) => r.metered === true);
function seedPaid(n: number) {
  store.seed('ai_requests', Array.from({ length: n }, (_, i) => ({ family_id: FAMILY, kind: 'feature', feature: 'notes.summary', status: 'completed', request_text: `paid ${i}` })));
}

/** A paid request through the wrapper: the body's call count is the model's. */
const model = vi.fn(async () => 'answer');
const paid = () => withAiRequest(member(), { feature: 'notes.summary', text: 'Summarise a note' }, () => model());
/** Chore-proof validation, as lib/chores/ai.ts files it. */
const choreProof = () => withAiRequest(member(), { feature: 'chores.validate', text: 'Validate a chore submission', exemptFromAllowance: true }, () => model());
const used = async () => {
  const access = await assertAIAccess(ctx as never, { db: db as never });
  return access.ok ? access.monthlyUsed : `refused:${access.code}`;
};

beforeEach(() => {
  store = createInMemorySupabase({ userId: USER, uniques: { ai_requests: [['family_id', 'client_request_id']] } });
  state.planLevel = 0;
  state.columnMissing = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('exempt work is recorded but never charged (sequential)', () => {
  it('a chore proof at 9 of 10 files unmetered; the family\'s 10th paid request is still admitted, the 11th refused', async () => {
    seedPaid(9);
    await choreProof();
    expect(rows()).toHaveLength(10);
    expect(rows().at(-1)).toMatchObject({ feature: 'chores.validate', metered: false });
    expect(await used()).toBe(9);

    await expect(paid()).resolves.toBe('answer');
    expect(meteredRows()).toHaveLength(10);
    expect(await used()).toBe('refused:allowance_exceeded');
    await expect(paid()).rejects.toBeInstanceOf(AiRequestOverAllowance);
    expect(model).toHaveBeenCalledTimes(2); // the chore proof and the 10th paid request
  });

  it('a chore proof at 10 of 10 still runs, files unmetered, and does not take the count past the cap', async () => {
    seedPaid(10);
    await expect(choreProof()).resolves.toBe('answer');
    expect(rows()).toHaveLength(11);
    expect(meteredRows()).toHaveLength(10);
    await expect(paid()).rejects.toBeInstanceOf(AiRequestOverAllowance);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('a system-scope intake (inbound contact-center routing) at 9 of 10 does not use up the member\'s 10th request', async () => {
    seedPaid(9);
    const inbound = await submitRequest(system(), { text: 'Inbound: plan the dentist visit' }, { kick: vi.fn() });
    expect(inbound.ok).toBe(true);
    expect(rows().at(-1)).toMatchObject({ kind: 'concierge', metered: false });
    expect(await used()).toBe(9);
    const mine = await submitRequest(member(), { text: 'Plan our week' }, { kick: vi.fn() });
    expect(mine.ok).toBe(true);
    expect(meteredRows()).toHaveLength(10);
    expect(await submitRequest(member(), { text: 'Plan our weekend' }, { kick: vi.fn() }))
      .toMatchObject({ ok: false, code: 'allowance_exceeded', limit: 10 });
  });

  it('a scheduled routine (system scope, kind routine) is filed unmetered', async () => {
    const filed = await createRequest(system(), { requestText: 'Weekly plan', kind: 'routine' }, { db: db as never });
    expect(filed.ok).toBe(true);
    expect(rows()).toEqual([expect.objectContaining({ kind: 'routine', metered: false })]);
  });

  it('negative control: a member\'s ordinary request on an unlimited plan is still metered', async () => {
    state.planLevel = 1;
    await paid();
    expect(rows()).toEqual([expect.objectContaining({ feature: 'notes.summary', metered: true })]);
  });
});

describe('exempt work racing paid admissions (concurrent)', () => {
  it('8 chore proofs and 8 paid requests at 9 of 10: every proof runs, exactly one paid request is admitted', async () => {
    seedPaid(9);
    const results = await Promise.allSettled([
      ...Array.from({ length: 8 }, () => choreProof()),
      ...Array.from({ length: 8 }, () => paid()),
    ]);
    const proofs = results.slice(0, 8);
    const paids = results.slice(8);
    expect(proofs.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(paids.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(paids.filter((r) => r.status === 'rejected' && r.reason instanceof AiRequestOverAllowance)).toHaveLength(7);
    expect(meteredRows()).toHaveLength(10);
    expect(rows().filter((r: Row) => r.metered === false)).toHaveLength(8);
    expect(rows()).toHaveLength(18);
    expect(model).toHaveBeenCalledTimes(9);
    expect(await used()).toBe('refused:allowance_exceeded');
  });

  it('system-scope intakes racing member submissions at 9 of 10: all inbound filed, one member submission admitted', async () => {
    seedPaid(9);
    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => submitRequest(system(), { text: `Inbound ${i}` }, { kick: vi.fn() })),
      ...Array.from({ length: 4 }, (_, i) => submitRequest(member(), { text: `Plan ${i}` }, { kick: vi.fn() })),
    ]);
    expect(results.slice(0, 4).every((r) => r.ok)).toBe(true);
    expect(results.slice(4).filter((r) => r.ok)).toHaveLength(1);
    expect(results.slice(4).filter((r) => !r.ok && r.code === 'allowance_exceeded')).toHaveLength(3);
    expect(meteredRows()).toHaveLength(10);
    expect(rows()).toHaveLength(14);
  });
});

describe('deployed before 0477 adds the column', () => {
  it('an exempt filing falls back to the metered insert rather than losing the record', async () => {
    state.planLevel = 1;
    state.columnMissing = true;
    await expect(choreProof()).resolves.toBe('answer');
    // Filed the way it was before this change: counted (the column's default).
    expect(rows()).toEqual([expect.objectContaining({ feature: 'chores.validate', metered: true })]);
  });
});
