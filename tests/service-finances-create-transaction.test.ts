import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
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
