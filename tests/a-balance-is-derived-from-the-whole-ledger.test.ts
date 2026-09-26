// A balance totalled from part of a ledger is not a balance.
//
// PostgREST caps a response at `db-max-rows` — 1,000 on a default Supabase
// project — whatever the client asked for. `tests/no-limit-above-the-row-cap.test.ts`
// exists because of that, and it catches `.limit(n)` for n above the cap. It
// cannot catch a read with **no `.limit()` at all**, which is the same silent
// truncation with less to see.
//
// `bucketBalanceCents` in `lib/wallet/server.ts` was written that way:
//
//     supabase.from('wallet_transactions')
//       .select('direction, amount_cents, status')
//       .eq('family_id', …).eq('bucket_id', …)        // ← no bound, no paging
//
// and its result is reduced in JavaScript into the number that decides whether
// a child may spend. On a bucket with more rows than the cap it totals the
// first page. The other guard's own header names the consequence — "wallet
// balances totalled from part of the ledger" — so the risk was understood; the
// check simply could not see a query that asks for no limit.
//
// Every other money operation in this file goes through an RPC
// (`wallet_transfer`, `wallet_decide_spend`, `wallet_fund_goal`,
// `wallet_reserve_card_auth`, …), where the total is computed in SQL. This was
// the one that did not.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = process.cwd();
const ROW_CAP = 1000;

/** Tables whose rows are summed into a number someone is allowed to spend. */
const LEDGERS = ['wallet_transactions', 'invest_holdings', 'stripe_authorizations'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (new Set(['.ts', '.tsx']).has(extname(path))) out.push(path);
  }
  return out;
}

/** A query chain, from `.from('t')` to the end of the statement. */
function chains(source: string, table: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const pattern = new RegExp(`\\.from\\(\\s*['"]${table}['"]\\s*\\)`, 'g');
  for (const m of source.matchAll(pattern)) {
    // Everything up to the statement's end — far enough to see .range/.limit.
    const rest = source.slice(m.index!, m.index! + 600).split(/;\s*\n/)[0];
    out.push({ text: rest, line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

/**
 * Bounded: one row, a counted head, a real limit, or paged — **or not a read at
 * all**. The first version of this sweep reported nine sites and six were
 * `.insert()` or `.update()` chains, which have no row ceiling to exceed. A
 * write is not a total.
 */
function isBounded(chain: string): boolean {
  if (!/\.select\(/.test(chain)) return true;           // insert / update / delete
  if (/\.(maybeSingle|single)\(/.test(chain)) return true;
  if (/head:\s*true|count:\s*'exact'/.test(chain)) return true;
  if (/\.range\(/.test(chain)) return true;               // paged by readAll/readAllAsQuery
  const limit = /\.limit\((\d+)\)/.exec(chain);
  return !!limit && Number(limit[1]) <= ROW_CAP;
}

const unbounded = sourceFiles(join(ROOT, 'lib'))
  .concat(sourceFiles(join(ROOT, 'app')))
  .flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return LEDGERS.flatMap((table) => chains(source, table)
      .filter((c) => !isBounded(c.text))
      .map((c) => `${relative(ROOT, file)}:${c.line} reads ${table} with no bound — PostgREST will stop at ${ROW_CAP} rows and the total will be wrong`));
  });

describe('a money total reads every row it is totalling', () => {
  it('is looking at the ledgers it claims to', () => {
    const seen = sourceFiles(join(ROOT, 'lib')).concat(sourceFiles(join(ROOT, 'app')))
      .flatMap((f) => LEDGERS.flatMap((t) => chains(readFileSync(f, 'utf8'), t)));
    // A sweep that matches nothing passes forever.
    expect(seen.length).toBeGreaterThan(5);
  });

  it('never totals a ledger from an unbounded read', () => {
    expect(unbounded).toEqual([]);
  });

  // The site this was written for, named — so a regression fails with the
  // function rather than with a count.
  it('bucketBalanceCents pages the ledger rather than asking for all of it', () => {
    const source = readFileSync(join(ROOT, 'lib/wallet/server.ts'), 'utf8');
    const fn = source.slice(source.indexOf('export async function bucketBalanceCents'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body, 'bucketBalanceCents no longer pages its read').toContain('readAll');
    expect(body).toMatch(/\.range\(from, to\)/);
  });

  // The other guard's blind spot, pinned as a fact rather than a memory: it is
  // a `.limit()` check, so a query with no limit is invisible to it. If that
  // ever changes this case fails and the two can be merged.
  it('the row-cap guard really is blind to an unbounded read', () => {
    const other = readFileSync(join(ROOT, 'tests/no-limit-above-the-row-cap.test.ts'), 'utf8');
    expect(other).toMatch(/\\\.limit\\\(/);
    expect(other.includes('.range('), 'the row-cap guard now looks at paging too').toBe(false);
  });
});
