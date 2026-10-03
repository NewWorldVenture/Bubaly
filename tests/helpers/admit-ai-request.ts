// An in-memory stand-in for `public.admit_ai_request` (0477, F19), for tests
// whose fake Supabase client already models `ai_requests`.
//
// It drives the fake's OWN query builder — the key lookup, the head count, the
// insert and its 23505 — so a fault a test injects into that table (a refused
// insert, an unreadable read-back) reaches the admission exactly as it reaches
// a plain `createRequest`. The per-family advisory lock is modelled by a
// promise chain per family, so concurrent admissions in one test serialise the
// way they do in Postgres. The count is the meter's: the family's rows since
// the start of the UTC month.

type Result = { data: unknown; error: { code?: string; message: string } | null; count?: number | null };
// The fake builders are thenables with whichever filters their test needed;
// this drives only select/eq/gte/maybeSingle/insert/single on them.
type Chain = {
  select: (cols?: string, opts?: { count?: 'exact'; head?: boolean }) => Chain;
  eq: (col: string, value: unknown) => Chain;
  gte: (col: string, value: string) => Chain;
  insert: (row: Record<string, unknown>) => Chain;
  maybeSingle: () => PromiseLike<Result>;
  single: () => PromiseLike<Result>;
  then: PromiseLike<Result>['then'];
};
type FakeDb = { from: (table: string) => unknown };
const chain = (db: FakeDb) => db.from('ai_requests') as Chain;

export type AdmitArgs = {
  p_family_id: string; p_allowance: number; p_kind: string; p_request_text: string;
  p_requested_by?: string | null; p_requested_by_member_id?: string | null; p_conversation_id?: string | null;
  p_feature?: string | null; p_interpreted_intent?: string | null; p_status?: string; p_priority?: number;
  p_client_request_id?: string | null; p_started_at?: string | null;
};

const locks = new Map<string, Promise<unknown>>();

function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function withFamilyLock<T>(familyId: string, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(familyId) ?? Promise.resolve();
  const run = before.then(fn, fn);
  locks.set(familyId, run.catch(() => undefined));
  return run;
}

const answer = (request_id: string | null, outcome: 'admitted' | 'refused' | 'existing', used: number | null): Result =>
  ({ data: [{ request_id, outcome, used }], error: null });

async function readKey(db: FakeDb, args: AdmitArgs): Promise<Result> {
  return chain(db).select('id')
    .eq('family_id', args.p_family_id)
    .eq('client_request_id', args.p_client_request_id)
    .maybeSingle();
}

export async function admitAiRequest(db: FakeDb, args: AdmitArgs, opts?: { now?: Date }): Promise<Result> {
  return withFamilyLock(args.p_family_id, async () => {
    if (args.p_client_request_id) {
      const prior = await readKey(db, args);
      if (prior.error) return { data: null, error: prior.error };
      const id = (prior.data as { id?: string } | null)?.id;
      if (id) return answer(id, 'existing', null);
    }
    const counted: Result = await chain(db).select('id', { count: 'exact', head: true })
      .eq('family_id', args.p_family_id)
      .gte('created_at', monthStartIso(opts?.now ?? new Date()));
    if (counted.error) return { data: null, error: counted.error };
    const used = counted.count ?? 0;
    if (used >= args.p_allowance) return answer(null, 'refused', used);
    const inserted: Result = await chain(db).insert({
      family_id: args.p_family_id,
      conversation_id: args.p_conversation_id ?? null,
      requested_by: args.p_requested_by ?? null,
      requested_by_member_id: args.p_requested_by_member_id ?? null,
      kind: args.p_kind,
      feature: args.p_feature ?? null,
      request_text: args.p_request_text,
      interpreted_intent: args.p_interpreted_intent ?? null,
      status: args.p_status ?? 'queued',
      priority: args.p_priority ?? 0,
      client_request_id: args.p_client_request_id ?? null,
      ...(args.p_started_at ? { started_at: args.p_started_at } : {}),
    }).select('id').single();
    if (inserted.error?.code === '23505' && args.p_client_request_id) {
      const prior = await readKey(db, args);
      const id = (prior.data as { id?: string } | null)?.id;
      if (id) return answer(id, 'existing', null);
      return { data: null, error: inserted.error };
    }
    if (inserted.error || !inserted.data) return { data: null, error: inserted.error ?? { message: 'no row' } };
    return answer((inserted.data as { id: string }).id, 'admitted', used + 1);
  });
}

/** `db.rpc` for a fake client: answers `admit_ai_request`, refuses anything else. */
export function admitRpc(db: FakeDb, opts?: { now?: () => Date }) {
  return async (name: string, args: AdmitArgs): Promise<Result> => {
    if (name !== 'admit_ai_request') return { data: null, error: { code: 'PGRST202', message: `unexpected rpc ${name}` } };
    return admitAiRequest(db, args, { now: opts?.now?.() });
  };
}
