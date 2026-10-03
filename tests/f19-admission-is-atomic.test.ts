import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import { admitRpc, type AdmitArgs } from './helpers/admit-ai-request';

// F19, the concurrent half. The Free allowance is a COUNT of the family's
// `ai_requests` rows, read by the route and then filed later by
// `withAiRequest`. Two requests at 9 of 10 both read 9 and both file: 11.
// On a capped plan the row is now ADMITTED — counted and filed as one decision
// under a per-family lock (`admit_ai_request`, 0477) — and a refusal stops the
// body before the model. This drives the real `withAiRequest` and the real
// `createRequest` against a fake ledger whose `rpc` emulates the function over
// the same in-memory table (tests/helpers/admit-ai-request.ts).

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  planLevel: 0 as number | 'throws',
  /** 'missing': the function is not deployed yet (code shipped before 0477). */
  rpcFault: null as null | 'missing',
  insertFault: false,
}));

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: unknown = null;
  private head = false;
  select(_cols?: string, opts?: { head?: boolean }) { if (this.op === 'select') this.head = Boolean(opts?.head); return this; }
  insert(row: Row) { this.op = 'insert'; this.payload = row; return this; }
  update(patch: Row) { this.op = 'update'; this.payload = patch; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this; }
  gte(col: string, v: string) { this.filters.push((r) => String(r[col]) >= v); return this; }
  async maybeSingle() { const r = await this.run(); return { data: r.data?.[0] ?? null, error: r.error }; }
  async single() { const r = await this.run(); return r.error ? { data: null, error: r.error } : { data: r.data?.[0] ?? null, error: null }; }
  then<T>(ok: (v: { data: Row[] | null; error: unknown; count?: number }) => T, ko?: (e: unknown) => T) { return this.run().then(ok, ko); }
  private async run(): Promise<{ data: Row[] | null; error: { code?: string; message: string } | null; count?: number }> {
    await Promise.resolve();
    if (this.op === 'insert') {
      if (state.insertFault) return { data: null, error: { code: '08006', message: 'connection failure' } };
      // `metered` defaults to true, as 0477's column does.
      const row: Row = { id: `req-${state.rows.length + 1}`, created_at: new Date().toISOString(), metered: true, ...(this.payload as Row) };
      if (row.client_request_id != null && state.rows.some((r) => r.family_id === row.family_id && r.client_request_id === row.client_request_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_ai_requests_client_request"' } };
      }
      state.rows.push(row);
      return { data: [row], error: null };
    }
    const hit = state.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'update') { for (const r of hit) Object.assign(r, this.payload as Row); return { data: hit, error: null }; }
    if (this.head) return { data: null, error: null, count: hit.length };
    return { data: hit, error: null };
  }
}

const ledger = {
  from: (table: string) => {
    if (table !== 'ai_requests') throw new Error(`unexpected table ${table}`);
    return new Query();
  },
  rpc: async (name: string, args: AdmitArgs) => {
    state.rpcCalls.push({ name, args: args as unknown as Record<string, unknown> });
    if (state.rpcFault === 'missing') {
      return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.admit_ai_request in the schema cache' } };
    }
    return admitRpc(ledger)(name, args);
  },
};

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ledger }));
vi.mock('@/lib/ai/usage', () => ({ recordModelCall: async () => undefined }));
vi.mock('@/lib/server/plan', () => ({
  resolveFamilyPlanLevel: async () => {
    if (state.planLevel === 'throws') throw new Error('plan read failed');
    return state.planLevel;
  },
}));

const { withAiRequest, AiRequestDuplicate, AiRequestNotFiled, AiRequestOverAllowance } = await import('@/lib/ai/observability');

const FAMILY = 'fam-1';
const scope = { db: ledger, familyId: FAMILY, userId: 'u1', memberId: 'm1', role: 'parent', actorKind: 'member', tz: 'UTC' } as unknown as ServiceScope;

function seed(n: number) {
  for (let i = 0; i < n; i++) state.rows.push({ id: `old-${i}`, family_id: FAMILY, kind: 'feature', metered: true, created_at: new Date().toISOString() });
}
const admissions = () => state.rpcCalls.filter((c) => c.name === 'admit_ai_request');

beforeEach(() => {
  state.rows = [];
  state.rpcCalls = [];
  state.planLevel = 0;
  state.rpcFault = null;
  state.insertFault = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a capped plan admits the request; a refusal stops the body', () => {
  it('at 10 of 10 the admission refuses and the body never runs', async () => {
    seed(10);
    const body = vi.fn(async () => 'ran');
    const err = await withAiRequest(scope, { feature: 'notes.summary', text: 'Summarise a note' }, body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRequestOverAllowance);
    // Callers that already stop on an unfiled request stop on this too.
    expect(err).toBeInstanceOf(AiRequestNotFiled);
    expect(err).toMatchObject({ code: 'allowance_exceeded', allowance: 10 });
    expect(body).not.toHaveBeenCalled();
    expect(state.rows).toHaveLength(10);
    expect(admissions()[0].args).toMatchObject({
      p_family_id: FAMILY, p_allowance: 10, p_kind: 'feature', p_feature: 'notes.summary',
      p_requested_by: 'u1', p_requested_by_member_id: 'm1',
    });
  });

  it('under the allowance the row is admitted and the body runs with its id', async () => {
    seed(9);
    let seen: string | null = null;
    await withAiRequest(scope, { feature: 'notes.summary', text: 'Summarise a note' }, async (obs) => { seen = obs.requestId; });
    expect(seen).toBe('req-10');
    expect(state.rows).toHaveLength(10);
    expect(state.rows.at(-1)).toMatchObject({ status: 'completed', feature: 'notes.summary' });
  });

  it('eight requests racing at 9 of 10: one body runs, seven are refused, ten rows', async () => {
    seed(9);
    const body = vi.fn(async () => 'ran');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => withAiRequest(scope, { feature: 'notes.summary', text: 'Summarise a note' }, body)),
    );
    expect(body).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(7);
    for (const r of refused) expect(r.reason).toBeInstanceOf(AiRequestOverAllowance);
    expect(state.rows).toHaveLength(10);
  });

  it('a keyed retry of a filed request is still a duplicate — even at 10 of 10 — and runs nothing', async () => {
    seed(9);
    await withAiRequest(scope, { feature: 'assistant.turn', text: 'Assistant turn', clientRequestId: 'k-1' }, async () => 'first');
    const body = vi.fn(async () => 'again');
    const err = await withAiRequest(scope, { feature: 'assistant.turn', text: 'Assistant turn', clientRequestId: 'k-1' }, body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRequestDuplicate);
    expect(err).toMatchObject({ requestId: 'req-10' });
    expect(body).not.toHaveBeenCalled();
    expect(state.rows).toHaveLength(10);
  });

  it('deployed before 0477 (the function is missing): refused as not filed, never run unmetered', async () => {
    state.rpcFault = 'missing';
    const body = vi.fn(async () => 'ran');
    const err = await withAiRequest(scope, { feature: 'notes.summary', text: 'Summarise a note' }, body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRequestNotFiled);
    expect(err).not.toBeInstanceOf(AiRequestOverAllowance);
    expect(body).not.toHaveBeenCalled();
    expect(state.rows).toHaveLength(0);
  });

  it('a surface exempt from the allowance is filed and counted but not refused', async () => {
    seed(10);
    const body = vi.fn(async () => 'ran');
    await withAiRequest(scope, { feature: 'chores.validate', text: 'Validate a chore submission', exemptFromAllowance: true }, body);
    expect(body).toHaveBeenCalledTimes(1);
    expect(admissions()).toHaveLength(0);
    expect(state.rows).toHaveLength(11);
  });
});

describe('an unlimited plan files plainly and is never refused', () => {
  it('uses the plain insert, not the admission, however many rows the month holds', async () => {
    state.planLevel = 1;
    seed(50);
    const body = vi.fn(async () => 'ran');
    await withAiRequest(scope, { feature: 'notes.summary', text: 'Summarise a note' }, body);
    expect(body).toHaveBeenCalledTimes(1);
    expect(admissions()).toHaveLength(0);
    expect(state.rows).toHaveLength(51);
  });

  it('keeps the keyed duplicate rule unchanged', async () => {
    state.planLevel = 2;
    await withAiRequest(scope, { feature: 'assistant.turn', text: 'Assistant turn', clientRequestId: 'k-2' }, async () => 'first');
    const body = vi.fn(async () => 'again');
    await expect(withAiRequest(scope, { feature: 'assistant.turn', text: 'Assistant turn', clientRequestId: 'k-2' }, body))
      .rejects.toBeInstanceOf(AiRequestDuplicate);
    expect(body).not.toHaveBeenCalled();
    expect(admissions()).toHaveLength(0);
  });
});

describe('a plan that cannot be read', () => {
  it('files plainly (no number to admit against) and the body runs', async () => {
    state.planLevel = 'throws';
    const body = vi.fn(async () => 'ran');
    await withAiRequest(scope, { feature: 'notes.summary', text: 'Summarise a note' }, body);
    expect(body).toHaveBeenCalledTimes(1);
    expect(admissions()).toHaveLength(0);
  });

  it('is still treated as capped when the filing fails: refused, not run unrecorded', async () => {
    state.planLevel = 'throws';
    state.insertFault = true;
    const body = vi.fn(async () => 'ran');
    await expect(withAiRequest(scope, { feature: 'notes.summary', text: 'Summarise a note' }, body)).rejects.toBeInstanceOf(AiRequestNotFiled);
    expect(body).not.toHaveBeenCalled();
  });
});
