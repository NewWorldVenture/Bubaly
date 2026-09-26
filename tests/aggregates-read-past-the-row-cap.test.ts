import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { readAllAsQuery } from '@/lib/supabase/read-all';

// An aggregate computed by reading rows and reducing them in TypeScript is
// only as complete as the read. The admin console's tiles are built that way,
// and so is a wallet balance.
//
// The admin console's aggregates are computed by reading rows into the page and
// reducing them. PostgREST answers an unbounded select with at most
// `db-max-rows` — 1,000 on a default project — and says nothing, so each of
// those aggregates silently became "the first thousand":
//
//   admin/reports   the Documents tile rendered `docs.length`, so past a
//                   thousand documents it read exactly "1,000" forever, beside
//                   family and subscription tiles that were EXACT counts;
//                   storage, growth buckets and the revenue trend were all
//                   reduced over a prefix
//   admin/backup    a page titled "Data & Storage" reported the size of the
//                   first thousand documents as the total
//
// A count is not rows: `{ count: 'exact', head: true }` is uncapped and was
// already used for the family/user/subscription tiles, which is why those were
// right and the ones beside them were wrong.
const CAP = 1000;
const OVER = CAP + 337;

type DB = SupabaseClient<Database>;

function seededDocs(n: number) {
  const db = createInMemorySupabase({ maxRows: CAP });
  db.seed('documents', Array.from({ length: n }, (_, i) => ({
    id: `doc-${String(i).padStart(6, '0')}`,
    size_bytes: 1_000,
  })));
  return db;
}

describe('an admin aggregate is computed over every row, not the first page', () => {
  it('reproduces the defect: an unbounded select stops at the cap, silently', async () => {
    const db = seededDocs(OVER) as unknown as DB;
    const { data, error } = await db.from('documents').select('size_bytes');

    // Short, and silent about it — exactly what the page consumed.
    expect(error).toBeNull();
    expect(data).toHaveLength(CAP);
    const truncatedTotal = (data ?? []).reduce((sum, d) => sum + ((d as { size_bytes: number | null }).size_bytes ?? 0), 0);
    expect(truncatedTotal).toBe(CAP * 1_000);
  });

  it('a paged read sums every document', async () => {
    const db = seededDocs(OVER) as unknown as DB;
    const { data, error } = await readAllAsQuery<{ size_bytes: number | null }>(
      (from, to) => db.from('documents').select('size_bytes').order('id').range(from, to),
      { max: 25_000 },
    );

    expect(error).toBeNull();
    expect(data).toHaveLength(OVER);
    expect((data ?? []).reduce((sum, d) => sum + (d.size_bytes ?? 0), 0)).toBe(OVER * 1_000);
  });

  it('a count is not rows: `head: true` was never capped', async () => {
    const db = seededDocs(OVER) as unknown as DB;
    const { count, error } = await db.from('documents').select('id', { count: 'exact', head: true });
    expect(error).toBeNull();
    expect(count).toBe(OVER);
  });

  it('passing the ceiling is reported, not rounded down to it', async () => {
    // The whole point of `max`: reaching it returns the rows as a PREFIX plus an
    // error, which the admin pages join into their incomplete-report banner.
    // Without this, a bigger ceiling would just be a bigger silent truncation.
    const db = seededDocs(OVER) as unknown as DB;
    const { data, error } = await readAllAsQuery<{ size_bytes: number | null }>(
      (from, to) => db.from('documents').select('size_bytes').order('id').range(from, to),
      { max: 1_100 },
    );
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/PREFIX|prefix/);
    expect(data).toBeNull();
  });
});

// The billing page is the same defect with a sharper edge: it reduced EVERY
// figure — Est. MRR, Active, Past Due, the plan donut, the six-month trend and
// the recent list — from one unbounded read that also carried no `.order()`.
// Unordered means the thousand rows the server returns are an arbitrary
// thousand, so "the ten most recent subscriptions" was the ten most recent OF
// AN ARBITRARY THOUSAND, and "Past Due / Unpaid" could omit unpaid accounts.
describe('the billing page reduces over every subscription', () => {
  const OVERDUE_MARKER = 'past_due';

  function seededSubs(n: number, overdueFrom: number) {
    const db = createInMemorySupabase({ maxRows: CAP });
    db.seed('subscriptions', Array.from({ length: n }, (_, i) => ({
      id: `sub-${String(i).padStart(6, '0')}`,
      family_id: `fam-${String(i).padStart(6, '0')}`,
      plan: 'family_plus',
      // Every overdue account sits PAST the cap — the shape that matters, since
      // an unpaid account the page cannot see is one nobody chases.
      status: i >= overdueFrom ? OVERDUE_MARKER : 'active',
      created_at: '2026-01-01T00:00:00Z',
      current_period_end: null,
    })));
    return db as unknown as DB;
  }

  it('reproduces it: past-due accounts beyond the cap are invisible', async () => {
    const db = seededSubs(OVER, CAP + 100);
    const { data } = await db.from('subscriptions').select('family_id, plan, status, created_at, current_period_end');

    expect(data).toHaveLength(CAP);
    const pastDue = (data ?? []).filter((s) => (s as { status: string }).status === OVERDUE_MARKER);
    // Every overdue account was seeded past the cap, so the page showed zero.
    expect(pastDue).toHaveLength(0);
  });

  it('a paged read sees every past-due account', async () => {
    const db = seededSubs(OVER, CAP + 100);
    const { data, error } = await readAllAsQuery<{ status: string }>(
      (from, to) => db.from('subscriptions').select('family_id, plan, status, created_at, current_period_end').order('id').range(from, to),
      { max: 50_000 },
    );

    expect(error).toBeNull();
    expect(data).toHaveLength(OVER);
    expect((data ?? []).filter((s) => s.status === OVERDUE_MARKER)).toHaveLength(OVER - (CAP + 100));
  });
});

// A wallet balance is a ledger SUM, so the cap does not merely shorten a list —
// it changes a number that gates a decision.
//
// Money is not at risk: both authoritative paths sum in SQL under a lock.
// `wallet_reserve_card_auth` (0155) decides card authorizations, and
// `invest_decide_order` (0196) decides fills and refuses with
// `insufficient_cash`. A SQL aggregate reads every row; `db-max-rows` caps
// response ROWS, not an aggregate.
//
// What the capped TypeScript sum cost was the gate BEFORE those: a child with
// more than a thousand ledger rows in their Invest bucket was told "not enough
// money" for funds they had, with no way past it.
describe('a wallet balance is summed over the whole ledger', () => {
  function seededLedger(credits: number, debits: number) {
    const db = createInMemorySupabase({ maxRows: CAP });
    const rows = [
      ...Array.from({ length: credits }, (_, i) => ({
        id: `txn-a-${String(i).padStart(6, '0')}`,
        family_id: 'fam-1', bucket_id: 'bucket-1', direction: 'credit', amount_cents: 100, status: 'completed',
      })),
      // The debits sort AFTER the credits by id, so a capped read that stops at
      // 1,000 sees credits only — a balance that is too HIGH. Reverse the naming
      // and it is too LOW. Which way it errs is arbitrary, which is the point.
      ...Array.from({ length: debits }, (_, i) => ({
        id: `txn-b-${String(i).padStart(6, '0')}`,
        family_id: 'fam-1', bucket_id: 'bucket-1', direction: 'debit', amount_cents: 100, status: 'completed',
      })),
    ];
    db.seed('wallet_transactions', rows);
    return db as unknown as DB;
  }

  const sum = (rows: { direction: string; amount_cents: number }[]) =>
    rows.reduce((n, t) => n + (t.direction === 'credit' ? t.amount_cents : -t.amount_cents), 0);

  it('reproduces it: a capped read sums an arbitrary slice of the ledger', async () => {
    const db = seededLedger(900, 400);   // true balance: (900 - 400) * 100 = 50_000
    const { data } = await db.from('wallet_transactions')
      .select('direction, amount_cents, status')
      .eq('family_id', 'fam-1').eq('bucket_id', 'bucket-1').in('status', ['completed', 'processing']);

    expect(data).toHaveLength(CAP);
    // 900 credits + the first 100 debits = 80_000, not the true 50_000.
    expect(sum((data ?? []) as { direction: string; amount_cents: number }[])).toBe(80_000);
  });

  it('a paged read sums the whole ledger', async () => {
    const db = seededLedger(900, 400);
    const { data, error } = await readAllAsQuery<{ direction: string; amount_cents: number; status: string }>(
      (from, to) => db.from('wallet_transactions').select('direction, amount_cents, status')
        .eq('family_id', 'fam-1').eq('bucket_id', 'bucket-1').in('status', ['completed', 'processing'])
        .order('id').range(from, to),
      { max: 50_000 },
    );

    expect(error).toBeNull();
    expect(data).toHaveLength(1_300);
    expect(sum(data ?? [])).toBe(50_000);
  });
});

describe('the pages themselves still page (MAIN-F-J05, J06, J07)', () => {
  // The cases above prove the helper against a capped fake. They never read the
  // pages, so putting a page back on a bare select passed them. Each chain below
  // feeds a total someone reads as the truth: an admin tile, the MRR, a child's
  // Invest balance.
  const SITES: { file: string; table: string }[] = [
    { file: 'app/(app)/admin/reports/page.tsx', table: 'families' },
    { file: 'app/(app)/admin/reports/page.tsx', table: 'profiles' },
    { file: 'app/(app)/admin/reports/page.tsx', table: 'subscriptions' },
    { file: 'app/(app)/admin/reports/page.tsx', table: 'documents' },
    { file: 'app/(app)/admin/reports/page.tsx', table: 'audit_logs' },
    { file: 'app/(app)/admin/backup/page.tsx', table: 'documents' },
    { file: 'app/(app)/admin/billing/page.tsx', table: 'subscriptions' },
    { file: 'app/(app)/wallet/invest/actions.ts', table: 'wallet_transactions' },
  ];

  it.each(SITES)('$file reads $table in pages or as a count', async ({ file, table }) => {
    const { readFile } = await import('node:fs/promises');
    const source = (await readFile(file, 'utf8')).split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    const marker = `from('${table}')`;
    const chains: string[] = [];
    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
      // A chain ends at the `,` or `;` that closes its statement; a readAllAsQuery
      // callback closes with `.range(from, to)`.
      const rest = source.slice(at);
      const end = rest.search(/\)\s*(,|;)\s*\n/);
      chains.push(rest.slice(0, end === -1 ? rest.length : end + 1));
    }
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      const flat = chain.replace(/\s+/g, ' ');
      const isWrite = /\.(insert|update|upsert|delete)\(/.test(chain);
      const isCount = /count: 'exact', head: true/.test(chain);
      const pages = /\.order\('id'\)[^;]*\.range\(from, to\)/.test(flat);
      expect(isWrite || isCount || pages, `${file}: ${flat.slice(0, 160)}`).toBe(true);
    }
  });

  it('the Documents tile is a count, not docs.length (MAIN-F-J05)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = (await readFile('app/(app)/admin/reports/page.tsx', 'utf8')).split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    expect(source).toContain("supabase.from('documents').select('id', { count: 'exact', head: true })");
    expect(source).toMatch(/key: 'documents',[^}]*value: \(docCountResult\.count \?\? 0\)/);
    expect(source).not.toMatch(/docs\.length/);
  });
});
