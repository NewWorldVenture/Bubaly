import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// F-F08 recorded `addFundsAction` as "the one money mutator that writes the
// balance directly". Checked against the tree: it does not, and nothing does.
// It inserts rows into `wallet_transactions` — the immutable ledger — and the
// wallet has no balance column for anything to write. The schema agrees: the
// only `%balance%` columns in the whole database are
//
//   financial_accounts.balance            an external institution's figure
//   loyalty_accounts.points_balance       a third-party loyalty total
//   loyalty_transactions.balance_after    a recorded historical reading
//   stripe_financial_accounts.cached_balance_cents   a cache, and named one
//   wallet_rewards.balance                a reward catalogue field
//
// and none of them is a child's spendable money, which is summed from the
// ledger on read.
//
// So this file is not a fix. It is the property F-F08 was worried about, made
// checkable, so that the next money feature cannot quietly add a running total
// and update it from TypeScript — which is how a ledger and a balance start
// disagreeing, and how the disagreement stays invisible until someone audits.
const DERIVED = ['saved_cents', 'spendable_cents', 'balance_cents', 'total_cents'];

/**
 * A cache of an external system's number is not a derived total: nothing here
 * computes it, the provider owns it, and the column says so in its own name.
 */
const CACHE_OF_AN_EXTERNAL_TRUTH = new Set(['lib/stripe/treasury.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !full.includes('.test.')) out.push(full);
  }
  return out;
}

const blankComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

/** Lines that hand a derived money total to a write. */
export function writesADerivedTotal(source: string): string[] {
  const src = blankComments(source);
  const out: string[] = [];
  src.split('\n').forEach((line, i) => {
    if (!/\.(update|upsert)\s*\(|\.insert\s*\(/.test(line)) return;
    // The call's argument, which may run on for a few lines.
    const window = src.split('\n').slice(i, i + 6).join(' ');
    for (const field of DERIVED) {
      if (new RegExp(`\\b${field}\\s*:`).test(window)) out.push(`line ${i + 1}: ${field}`);
    }
  });
  return out;
}

describe('a money total is derived, never written', () => {
  const files = [...walk('app'), ...walk('lib')];

  it('finds the money code (non-vacuity)', () => {
    const wallet = files.filter((f) => /wallet/i.test(f));
    expect(wallet.length).toBeGreaterThan(5);
    expect(files.length).toBeGreaterThan(500);
  });

  it('reads a write of a running total, and not a read of one (sanity)', () => {
    expect(writesADerivedTotal("await sb.from('wallet_goals').update({ saved_cents: next });"))
      .toEqual(['line 1: saved_cents']);
    expect(writesADerivedTotal("const { data } = await sb.from('wallet_goals').select('saved_cents');")).toEqual([]);
    expect(writesADerivedTotal("const total = rows.reduce((n, r) => n + r.saved_cents, 0);")).toEqual([]);
    // Prose is not a write.
    expect(writesADerivedTotal("// never update saved_cents here\nconst x = 1;")).toEqual([]);
  });

  it('nothing in app/ or lib/ writes one', () => {
    const offenders = files
      .filter((f) => !CACHE_OF_AN_EXTERNAL_TRUTH.has(f.split('\\').join('/')))
      .flatMap((f) => writesADerivedTotal(readFileSync(f, 'utf8')).map((d) => `${f} :: ${d}`));
    expect(
      offenders,
      'These set a running money total from TypeScript. Sum the ledger on read, or move the write\n'
      + 'into a database function where it is transactional with the ledger row it belongs to:\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('the goal balance moves through a database function, not a read-modify-write', () => {
    // wallet_fund_goal does the ledger insert and the goal total in ONE
    // statement pair inside the database. Doing it from TypeScript would mean
    // read, add, write — and two parents funding a goal at once would each
    // write a total computed before the other's row existed.
    const server = readFileSync('lib/wallet/server.ts', 'utf8');
    expect(server).toMatch(/supabase\.rpc\('wallet_fund_goal'/);
    expect(blankComments(server)).not.toMatch(/saved_cents\s*:/);
  });

  it('addFundsAction credits the ledger, which is what F-F08 asked about', () => {
    const actions = blankComments(readFileSync('app/(app)/wallet/actions.ts', 'utf8'));
    const start = actions.indexOf('export async function addFundsAction');
    expect(start).toBeGreaterThan(-1);
    const body = actions.slice(start, actions.indexOf('export async function', start + 10));
    expect(body).toMatch(/from\('wallet_transactions'\)\s*\.insert\(/);
    for (const field of DERIVED) expect(body, field).not.toMatch(new RegExp(`\\b${field}\\s*:`));
  });
});
