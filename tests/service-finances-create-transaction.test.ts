import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { financeTools } from '@/lib/ai/tools/finances';
import { createTransaction } from '@/lib/services/finances';
import type { ServiceScope } from '@/lib/services/types';

// The first writer `transactions` has had outside the wallet's own UI action.
// Until it existed Bubaly could analyse a family's spending six ways and could
// not record a single charge — which is why §26 (hand it a receipt, the
// purchase lands) had nowhere to start.
//
// The interesting assertions here are the ones about what it does NOT do:
// it writes no `fingerprint`, because every fingerprint available today can
// delete a real charge, and no `idempotency_key`, because that column is typed
// in database.types.ts and no migration ever adds it.

type Call = { table: string; kind: 'select' | 'insert'; filters: Record<string, unknown>; payload?: Record<string, unknown> };

function makeDb(rows: (table: string, filters: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const filter = (c: string, v: unknown) => { call.filters[c] = v; return b; };
    Object.assign(b, {
      select: () => b, eq: filter,
      insert: (payload: Record<string, unknown>) => { call.kind = 'insert'; call.payload = payload; return b; },
      maybeSingle: () => Promise.resolve({ data: rows(table, call.filters), error: null }),
      single: () => Promise.resolve({
        data: call.kind === 'insert'
          ? { id: 'txn-new', ...call.payload, created_at: '2026-09-05T12:00:00Z', updated_at: '2026-09-05T12:00:00Z' }
          : rows(table, call.filters),
        error: null,
      }),
      then: (resolve: (v: unknown) => void) => resolve({ data: rows(table, call.filters), error: null }),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');
const scope = (over: Partial<ServiceScope> = {}): ServiceScope => ({
  db: null as never, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1',
  role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW, ...over,
});
const ours = (table: string, f: Record<string, unknown>) => (f.family_id === 'fam-1' ? { id: String(f.id) } : null);
const insertOf = (calls: Call[]) => calls.find((c) => c.table === 'transactions' && c.kind === 'insert')?.payload;

describe('createTransaction writes the row', () => {
  it('records a purchase with the family, the date and the acting user', async () => {
    const { db, calls } = makeDb(ours);
    const res = await createTransaction(scope({ db }), { name: 'Groceries', amount: 42.1, merchant: 'Trader Joe’s' });

    expect(res.ok).toBe(true);
    expect(insertOf(calls)).toMatchObject({
      family_id: 'fam-1', name: 'Groceries', amount: 42.1, type: 'expense',
      merchant: 'Trader Joe’s', date: '2026-09-05', created_by: 'auth-1', source: 'manual',
    });
  });

  it.each([
    [0.005, 0.01],
    [0.01, 0.01],
    [42.1, 42.1],
    [42.12, 42.12],
    [42.126, 42.13],
  ])('records %s as %s without changing the caller input', async (amount, expectedAmount) => {
    const { db, calls } = makeDb(ours);
    const input = Object.freeze({ name: 'Groceries', amount });
    const res = await createTransaction(scope({ db }), input);

    expect(res).toMatchObject({ ok: true, data: { amount: expectedAmount } });
    expect(insertOf(calls)).toMatchObject({ amount: expectedAmount });
    expect(input.amount).toBe(amount);
  });

  it('dates it in the family time zone, not UTC', async () => {
    // 00:30 UTC on the 6th is still the 5th in New York. A charge dated a day
    // late lands in the wrong budget month at a month boundary.
    const { db, calls } = makeDb(ours);
    await createTransaction(scope({ db, now: new Date('2026-09-06T00:30:00Z') }), { name: 'Late snack', amount: 4 });
    expect(insertOf(calls)).toMatchObject({ date: '2026-09-05' });
  });

  it('stores the amount unsigned and puts the direction in `type`', async () => {
    const { db, calls } = makeDb(ours);
    await createTransaction(scope({ db }), { name: 'Refund', amount: 12.5, type: 'income' });
    expect(insertOf(calls)).toMatchObject({ amount: 12.5, type: 'income' });
  });

  it('marks an AI-recorded charge as such', async () => {
    const { db, calls } = makeDb(ours);
    await createTransaction(scope({ db, actorKind: 'ai' }), { name: 'Groceries', amount: 20 });
    expect(insertOf(calls)).toMatchObject({ source: 'ai' });
  });
});

describe('createTransaction refuses what it cannot stand behind', () => {
  it.each([['teen'], ['child'], ['caregiver'], ['guest']] as const)('refuses a %s before any query', async (role) => {
    const { db, calls } = makeDb(ours);
    const res = await createTransaction(scope({ db, role }), { name: 'Groceries', amount: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('record a purchase on the household books');
    expect(calls).toHaveLength(0);
  });

  it('lets the run executor through as system', async () => {
    const { db } = makeDb(ours);
    expect((await createTransaction(scope({ db, role: 'system' }), { name: 'Groceries', amount: 10 })).ok).toBe(true);
  });

  it.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY]])('refuses an amount of %s', async (amount) => {
    const { db, calls } = makeDb(ours);
    const res = await createTransaction(scope({ db }), { name: 'Groceries', amount });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each([[0.001], [0.0049], [Number.MIN_VALUE], [Number.MAX_VALUE]])('refuses %s when cent normalization is zero or non-finite before any query', async (amount) => {
    const { db, calls } = makeDb(ours);
    const input = Object.freeze({ name: 'Groceries', amount, accountId: 'acct-1' });
    const res = await createTransaction(scope({ db }), input);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('one cent');
    expect(calls).toHaveLength(0);
    expect(input.amount).toBe(amount);
  });

  it('refuses a malformed date rather than guessing one', async () => {
    const { db } = makeDb(ours);
    const res = await createTransaction(scope({ db }), { name: 'Groceries', amount: 10, date: 'last Tuesday' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('YYYY-MM-DD');
  });

  it('refuses a source outside 0256’s CHECK instead of letting the database reject it', async () => {
    const { db } = makeDb(ours);
    const res = await createTransaction(scope({ db }), { name: 'Groceries', amount: 10, source: 'guesswork' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('manual, receipt, import, ai');
  });
});

describe('every foreign key it writes is checked against THIS family', () => {
  // `account_id` (0006), `member_id` (0110) and `receipt_document_id` (0256)
  // are all plain FKs with no family predicate, and all three can arrive from
  // model output. RLS guards the row; it does not guard what the row points at.
  it.each([
    ['accountId', 'account', 'financial_accounts'],
    ['memberId', 'member', 'family_members'],
    ['receiptDocumentId', 'receipt', 'documents'],
  ] as const)('refuses another household’s %s', async (field, noun, table) => {
    const { db, calls } = makeDb((t, f) => (t === table ? null : ours(t, f)));
    const res = await createTransaction(scope({ db, role: 'system' }), { name: 'Groceries', amount: 10, [field]: 'someone-elses' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(`That ${noun} does not belong to this family`);
    expect(insertOf(calls), 'nothing may be written after a cross-family reference').toBeUndefined();
  });

  it('scopes each check by family_id, not by id alone', async () => {
    const { db, calls } = makeDb(ours);
    await createTransaction(scope({ db }), { name: 'Groceries', amount: 10, accountId: 'acct-1', memberId: 'member-2', receiptDocumentId: 'doc-1' });
    for (const table of ['financial_accounts', 'family_members', 'documents']) {
      expect(calls.find((c) => c.table === table)?.filters).toMatchObject({ family_id: 'fam-1' });
    }
  });

  it('accepts all three when they are this family’s', async () => {
    const { db, calls } = makeDb(ours);
    const res = await createTransaction(scope({ db }), { name: 'Groceries', amount: 10, accountId: 'acct-1', memberId: 'member-2', receiptDocumentId: 'doc-1' });
    expect(res.ok).toBe(true);
    expect(insertOf(calls)).toMatchObject({ account_id: 'acct-1', member_id: 'member-2', receipt_document_id: 'doc-1' });
  });
});

describe('purchase approval consequences', () => {
  const tool = financeTools.find((entry) => entry.name === 'finances.createTransaction')!;

  it.each([
    ['expense', 'an expense', 'It counts toward expense spending.'],
    ['income', 'income', 'It does not count as expense spending.'],
    ['transfer', 'a transfer', 'It does not count as income or expense spending.'],
    [undefined, 'an expense', 'It counts toward expense spending.'],
    [null, 'an expense', 'It counts toward expense spending.'],
  ])('describes the direction and spending effect for type %s', (type, direction, effect) => {
    const input = tool.input.parse({ name: 'Household transaction', amount: 42.1, merchant: 'Corner Shop', type });
    const consequences = tool.consequences?.(input);

    expect(consequences).toHaveLength(1);
    expect(consequences?.[0]).toContain('$42.10 at Corner Shop');
    expect(consequences?.[0]).toContain(`as ${direction} on the household books`);
    expect(consequences?.[0]).toContain(effect);
    expect(consequences?.[0]).not.toContain('counts against the budget');
  });
});

describe('executor-issued purchase operations', () => {
  const input = { name: 'Coffee', amount: 4.5, merchant: 'Blue Bottle' };
  const original = {
    id: 'txn-operation', family_id: 'fam-1', ...input, type: 'expense', category: null,
    date: '2026-09-05', notes: null, account_id: null, member_id: null, receipt_document_id: null,
    source: 'ai', created_by: 'auth-1', created_at: '2026-09-05T12:00:00Z', updated_at: '2026-09-05T12:00:00Z',
  };
  type RpcReply = { data: unknown; error: unknown };
  type RpcStep = RpcReply | ((args: Record<string, unknown>) => RpcReply);

  function makeOperationDb(inputs: Record<string, unknown>, replies: RpcStep[], overrides: Record<string, unknown> = {}, lookupError: unknown = null) {
    const ledger = {
      id: 'call-1', family_id: 'fam-1', tool_name: 'finances.createTransaction',
      requested_by: 'auth-1', requested_by_member_id: 'member-1', actor_kind: 'ai', inputs, ...overrides,
    };
    const ledgerCalls: { table: string; filters: Record<string, unknown> }[] = [];
    const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
    const from = (table: string) => {
      const call = { table, filters: {} as Record<string, unknown> };
      ledgerCalls.push(call);
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (key: string, value: unknown) => { call.filters[key] = value; return b; },
        maybeSingle: () => Promise.resolve({ data: ledger, error: lookupError }),
      });
      return b;
    };
    const rpc = (name: string, args: Record<string, unknown>) => {
      const step = replies[rpcCalls.length];
      rpcCalls.push({ name, args });
      if (!step) throw new Error('Unexpected operation RPC call');
      return Promise.resolve(typeof step === 'function' ? step(args) : step);
    };
    return { db: { from, rpc } as unknown as SupabaseClient<Database>, ledgerCalls, rpcCalls };
  }

  it('probes privately, preserves caller FK checks, then submits the normalized row atomically', async () => {
    const purchase = { ...input, accountId: 'acct-1', memberId: 'member-2', receiptDocumentId: 'doc-1' };
    const toolInputs = { ...input, account_id: 'acct-1', member_id: 'member-2', receipt_document_id: 'doc-1' };
    const op = makeOperationDb(toolInputs, [
      { data: null, error: null },
      (args) => ({ data: { transaction: { ...original, ...(args.p_transaction as Record<string, unknown>) }, replayed: false, recordState: 'unchanged' }, error: null }),
    ]);
    const { db, calls } = makeDb(ours);
    const res = await createTransaction(scope({ db, actorKind: 'ai', toolOperation: { id: 'call-1', db: op.db } }), purchase);

    expect(res).toMatchObject({ ok: true, data: { id: 'txn-operation', operation: { replayed: false, recordState: 'unchanged' } } });
    expect(op.ledgerCalls).toEqual([{ table: 'ai_tool_calls', filters: { id: 'call-1', family_id: 'fam-1' } }]);
    expect(op.rpcCalls).toHaveLength(2);
    expect(op.rpcCalls[0]).toMatchObject({ name: 'finance_record_transaction_operation', args: { p_transaction: null } });
    expect(op.rpcCalls[1].args).toMatchObject({
      p_tool_call_id: 'call-1', p_family_id: 'fam-1', p_actor_user_id: 'auth-1', p_actor_member_id: 'member-1', p_actor_kind: 'ai',
      p_expected_inputs: toolInputs, p_intent: { version: 1, requestedAmount: 4.5, date: null },
        p_transaction: { ...input, account_id: 'acct-1', member_id: 'member-2', receipt_document_id: 'doc-1' },
    });
    expect(Object.keys(op.rpcCalls[1].args.p_transaction as object).sort()).toEqual([
      'account_id', 'amount', 'category', 'created_by', 'date', 'family_id', 'member_id', 'merchant', 'name', 'notes', 'receipt_document_id', 'source', 'type',
    ]);
    for (const table of ['financial_accounts', 'family_members', 'documents']) {
      expect(calls.find((call) => call.table === table)?.filters).toMatchObject({ family_id: 'fam-1' });
    }
    expect(insertOf(calls)).toBeUndefined();
  });

  it.each(['unchanged', 'edited', 'deleted'] as const)('returns a %s replay without querying old references or writing activity', async (recordState) => {
    const purchase = { ...input, accountId: 'old-account', receiptDocumentId: 'old-document' };
    const op = makeOperationDb({ ...input, account_id: 'old-account', receipt_document_id: 'old-document' }, [
      { data: { transaction: original, replayed: true, recordState }, error: null },
    ]);
    const { db, calls } = makeDb(() => null);
    const res = await createTransaction(scope({ db, actorKind: 'ai', toolOperation: { id: 'call-1', db: op.db } }), purchase);
    expect(res).toMatchObject({ ok: true, data: { id: original.id, date: original.date, operation: { replayed: true, recordState } } });
    expect(calls).toHaveLength(0);
    expect(op.rpcCalls).toHaveLength(1);
    expect(op.rpcCalls[0].args.p_transaction).toBeNull();
  });

  it.each([
    ['family_id', 'another-family'], ['tool_name', 'finances.updateBudget'],
    ['requested_by', 'another-user'], ['requested_by_member_id', 'another-member'], ['actor_kind', 'member'],
  ])('refuses a mismatched ledger %s before any RPC or caller query', async (field, value) => {
    const op = makeOperationDb(input, [], { [field]: value });
    const { db, calls } = makeDb(ours);
    const res = await createTransaction(scope({ db, actorKind: 'ai', toolOperation: { id: 'call-1', db: op.db } }), input);
    expect(res.ok).toBe(false);
    expect(op.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses changed requested amounts even when they round to the same cents', async () => {
    const op = makeOperationDb(input, []);
    const { db, calls } = makeDb(ours);
    const res = await createTransaction(scope({ db, actorKind: 'ai', toolOperation: { id: 'call-1', db: op.db } }), { ...input, amount: 4.504 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('authorized inputs');
    expect(op.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it.each([['teen'], ['child'], ['caregiver'], ['guest']] as const)('keeps the role guard ahead of operation access for a %s', async (role) => {
    const op = makeOperationDb(input, []);
    const { db, calls } = makeDb(ours);
    const res = await createTransaction(scope({ db, role, actorKind: 'ai', toolOperation: { id: 'call-1', db: op.db } }), input);
    expect(res.ok).toBe(false);
    expect(op.ledgerCalls).toHaveLength(0);
    expect(op.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['accountId', 'account_id', 'financial_accounts'],
    ['memberId', 'member_id', 'family_members'],
    ['receiptDocumentId', 'receipt_document_id', 'documents'],
  ] as const)('keeps the caller-family guard for a first write with %s', async (field, toolField, table) => {
    const op = makeOperationDb({ ...input, [toolField]: 'another-familys' }, [{ data: null, error: null }]);
    const { db, calls } = makeDb((t, filters) => t === table ? null : ours(t, filters));
    const res = await createTransaction(scope({ db, actorKind: 'ai', toolOperation: { id: 'call-1', db: op.db } }), { ...input, [field]: 'another-familys' });
    expect(res.ok).toBe(false);
    expect(op.rpcCalls).toHaveLength(1);
    expect(insertOf(calls)).toBeUndefined();
  });

  it('replays a durable receipt after a lost write response, even on another day', async () => {
    const op = makeOperationDb(input, [
      { data: null, error: null },
      { data: null, error: { message: 'write response lost' } },
      { data: { transaction: original, replayed: true, recordState: 'unchanged' }, error: null },
    ]);
    const { db, calls } = makeDb(ours);
    const operationScope = scope({ db, actorKind: 'ai', toolOperation: { id: 'call-1', db: op.db } });
    expect((await createTransaction(operationScope, input)).ok).toBe(false);
    const replay = await createTransaction({ ...operationScope, now: new Date('2026-09-07T12:00:00Z') }, input);
    expect(replay).toMatchObject({ ok: true, data: { id: original.id, date: '2026-09-05', operation: { replayed: true } } });
    expect(op.rpcCalls.filter((call) => call.args.p_transaction !== null)).toHaveLength(1);
    expect(op.rpcCalls[2].args.p_intent).toEqual(op.rpcCalls[0].args.p_intent);
    expect(calls).toHaveLength(0);
  });

  it('accepts a write-RPC replay when another attempt completed after the probe', async () => {
    const op = makeOperationDb(input, [
      { data: null, error: null },
      { data: { transaction: original, replayed: true, recordState: 'unchanged' }, error: null },
    ]);
    const { db, calls } = makeDb(ours);
    const res = await createTransaction(scope({ db, actorKind: 'ai', toolOperation: { id: 'call-1', db: op.db } }), input);
    expect(res).toMatchObject({ ok: true, data: { operation: { replayed: true } } });
    expect(calls).toHaveLength(0);
  });

  it('binds nullable requester identities without inventing a human actor', async () => {
    const op = makeOperationDb(input, [
      { data: { transaction: { ...original, source: 'manual', created_by: null }, replayed: true, recordState: 'unchanged' }, error: null },
    ], { requested_by: null, requested_by_member_id: null, actor_kind: 'system' });
    const { db } = makeDb(ours);
    const res = await createTransaction(scope({ db, role: 'system', actorKind: 'system', userId: null, memberId: null, toolOperation: { id: 'call-1', db: op.db } }), input);
    expect(res.ok).toBe(true);
    expect(op.rpcCalls[0].args).toMatchObject({ p_actor_user_id: null, p_actor_member_id: null, p_actor_kind: 'system' });
  });

  it('does not fall back to a direct insert when ledger lookup fails', async () => {
    const op = makeOperationDb(input, [], {}, { message: 'ledger unavailable' });
    const { db, calls } = makeDb(ours);
    const res = await createTransaction(scope({ db, actorKind: 'ai', toolOperation: { id: 'call-1', db: op.db } }), input);
    expect(res.ok).toBe(false);
    expect(op.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('does not treat a probe error or an invalid receipt as a miss', async () => {
    for (const reply of [
      { data: null, error: { message: 'receipt unavailable' } },
      { data: { transaction: original, replayed: false, recordState: 'unchanged' }, error: null },
    ]) {
      const op = makeOperationDb(input, [reply]);
      const { db, calls } = makeDb(ours);
      const res = await createTransaction(scope({ db, actorKind: 'ai', toolOperation: { id: 'call-1', db: op.db } }), input);
      expect(res.ok).toBe(false);
      expect(op.rpcCalls).toHaveLength(1);
      expect(calls).toHaveLength(0);
    }
  });
});

describe('purchase operation output', () => {
  const tool = financeTools.find((entry) => entry.name === 'finances.createTransaction')!;
  const oldOutput = { id: 'txn-1', name: 'Coffee', amount: 4.5, type: 'expense', date: '2026-09-05', merchant: 'Blue Bottle' };

  it('still accepts old cached output without operation metadata', () => {
    const parsed = tool.output.parse(oldOutput);
    expect(tool.summarize({}, parsed)).toBe('Recorded $4.50 at Blue Bottle on 2026-09-05');
  });

  it.each(['unchanged', 'edited', 'deleted'] as const)('describes a %s record as historical without claiming a new insert', (recordState) => {
    const parsed = tool.output.parse({ ...oldOutput, replayed: true, record_state: recordState });
    const summary = tool.summarize({}, parsed);
    expect(summary).toContain('Previously recorded $4.50 at Blue Bottle on 2026-09-05');
    expect(summary).toContain('No new transaction was added.');
    if (recordState !== 'unchanged') expect(summary).toContain(`The transaction was later ${recordState}.`);
  });
});

describe('what it deliberately does not write', () => {
  it('writes no fingerprint, so two identical purchases stay two rows', async () => {
    // 0256 migrated `fingerprint` and a partial unique index, and the obvious
    // key — family + merchant + amount + date — is a money-losing bug: two
    // coffees at one shop on one day for one price collide, and a "that's a
    // duplicate" handler discards a real charge while reporting success.
    // Deriving it from the receipt only moves the loss, because one photo of a
    // split Costco receipt is two charges with one document. Until something
    // can identify a CHARGE, no key is the honest answer.
    const { db, calls } = makeDb(ours);
    await createTransaction(scope({ db }), { name: 'Coffee', amount: 4.5, merchant: 'Blue Bottle' });
    const payload = insertOf(calls)!;
    expect(payload).not.toHaveProperty('fingerprint');
    expect(Object.values(payload)).not.toContain(undefined);
  });

  it('writes no idempotency_key, which is typed but never migrated', async () => {
    // lib/database.types.ts types `transactions.idempotency_key`; no migration
    // adds it — 0256 gave it only to its six keyed tables. Writing it would be
    // a PGRST204 against real schema, which no unit test would ever catch.
    const { db, calls } = makeDb(ours);
    await createTransaction(scope({ db }), { name: 'Coffee', amount: 4.5 });
    expect(insertOf(calls)).not.toHaveProperty('idempotency_key');
  });

  it('two identical calls produce two separate inserts', async () => {
    const { db, calls } = makeDb(ours);
    const input = { name: 'Coffee', amount: 4.5, merchant: 'Blue Bottle', date: '2026-09-05' } as const;
    expect((await createTransaction(scope({ db }), { ...input })).ok).toBe(true);
    expect((await createTransaction(scope({ db }), { ...input })).ok).toBe(true);
    expect(calls.filter((c) => c.table === 'transactions' && c.kind === 'insert')).toHaveLength(2);
  });
});
