import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The finding this migration exists to end, quoted from the production metadata
// audit that has now stopped a release three times:
//
//   "wallet_transactions still has a permissive INSERT policy alongside the
//    intended manager-only policy ... allowing any family member, potentially
//    including a child account, to submit a completed credit and create
//    spendable wallet funds."
//
// The money was never actually mintable — 0254's RESTRICTIVE guards AND with
// the union of the permissive policies, and docs/audit/wallet-write-rls-check.sql
// proves that behaviourally by injecting the drifted policy and failing if a
// child can mint. What was true is that the stray policy was still THERE, and
// 0217/0254/0267 all drop policies by hardcoded name, so a policy whose name
// nobody listed survives every one of them. 0275 sweeps by shape instead.
const raw = readFileSync('supabase/migrations/0275_money_permissive_write_sweep.sql', 'utf8');
const sql = raw.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

const WALLET = ['family_wallets', 'child_wallets', 'wallet_buckets', 'wallet_transactions', 'wallet_rules'];
const FINANCE = ['financial_accounts', 'transactions', 'budgets', 'bills', 'savings_goals'];

describe('0275 money permissive write sweep', () => {
  it('sweeps by shape, not by a list of names somebody has to remember', () => {
    // The whole point. A name-based drop can only remove what its author knew
    // about, which is why this is the fourth migration to touch this boundary.
    expect(sql).toMatch(/from pg_policy p/);
    expect(sql).toMatch(/and p\.polpermissive/);
    expect(sql).toMatch(/and p\.polcmd in \('a','w','d','\*'\)/);
  });

  it('leaves reads alone on both groups', () => {
    // 'r' is SELECT. Narrowing reads would empty "My Wallet" for every
    // non-manager — a product change, not a leak, per 0267's header.
    expect(sql).not.toMatch(/polcmd in \([^)]*'r'/);
    for (const t of [...WALLET, ...FINANCE]) {
      expect(sql).toMatch(new RegExp(`create policy %1\\$s_select[\\s\\S]*?is_family_member`));
      expect(sql).toContain(t);
    }
  });

  it('never sweeps the restrictive guards that are actually holding the line', () => {
    // polpermissive is true only for PERMISSIVE policies, so the guards can
    // never be selected by the sweep. If that predicate is ever dropped, the
    // migration would remove its own backstop.
    expect(sql).toMatch(/and p\.polpermissive/);
    expect(sql).not.toMatch(/polpermissive\s+is\s+false/);
  });

  it('re-asserts the intended policies before dropping anything', () => {
    // A FOR ALL policy carries SELECT as well as the writes. Dropping one
    // before the explicit select policy exists would leave reads with no
    // policy at all mid-transaction.
    const selectIdx = sql.indexOf('_select on public.%1$I for select');
    const sweepIdx = sql.indexOf('from pg_policy p');
    expect(selectIdx).toBeGreaterThan(-1);
    expect(sweepIdx).toBeGreaterThan(selectIdx);
  });

  it('gives the household finance tables the restrictive guard the wallet tables have had since 0254', () => {
    // 0267 narrowed financial_accounts/transactions/budgets/bills/savings_goals
    // by name and left no backstop, so the identical drift would reopen the
    // household's money the identical way.
    expect(sql).toMatch(/%1\$s_manager_insert_guard on public\.%1\$I as restrictive for insert/);
    expect(sql).toMatch(/%1\$s_manager_update_guard on public\.%1\$I as restrictive for update/);
    expect(sql).toMatch(/%1\$s_manager_delete_guard on public\.%1\$I as restrictive for delete/);
    for (const t of FINANCE) expect(sql).toContain(`'${t}'`);
  });

  it('every write policy it creates is manager-gated, never membership-gated', () => {
    // is_family_member on a write is the original 0088 defect. A child is a
    // family member.
    const writes = sql.match(/create policy [^;']*for (insert|update|delete)[^']*/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w).toContain('can_manage_family');
      expect(w).not.toContain('is_family_member');
    }
  });

  it('fails loudly instead of reporting success it did not achieve', () => {
    // A sweep that silently matched nothing looks exactly like one that worked.
    expect(sql).toMatch(/raise exception '0275 FAILED/);
    expect(sql).toMatch(/select count\(\*\) into remaining/);
  });

  it('touches no money rows', () => {
    // Policies only. This migration must never read or move a balance.
    expect(sql).not.toMatch(/\b(update|delete from|insert into)\s+public\.(wallet_transactions|wallet_buckets|child_wallets|family_wallets|transactions)\b/i);
  });
});

describe('the migration set stays collision-free', () => {
  it('claims a version nobody else has', () => {
    const versions = readdirSync('supabase/migrations')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, 4));
    expect(versions.filter((v) => v === '0275')).toHaveLength(1);
  });

  // A reserved-number guard used to live here: 0270 and 0274 were held by two
  // in-flight branches, and taking one would have handed whichever merged first
  // a collision. Both have since landed and consumed their reservations — 0270
  // with the travel-confirmation import, 0274 with the finance receipts — so the
  // guard has served its purpose and is gone rather than left to rot.
  //
  // Collision detection itself is NOT reimplemented here. It lives in
  // tests/migration-version-safety.test.ts, which checks against
  // KNOWN_DUPLICATE_MIGRATIONS — this repo carries real historical duplicates
  // (0010, 0026, 0042 and more), so a naive "every version appears once" check
  // fails on history rather than on a new mistake.
});
