import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-08 economy money-integrity guard (sibling of the wallet lockdown). The family
// economy tables shipped (0096) with `is_family_member` FOR ALL, so a child could
// INSERT a credit into currency_transactions and MINT tokens redeemable for
// parent-defined rewards. Migration 0218 restricts writes on the currency ledger
// + config + rewards to can_manage_family(), while KEEPING economy_redemptions
// INSERT open to members (a child legitimately requests a redemption). Proven live
// on the harness (child mint -> RLS error; child redemption request -> OK; manager
// award -> OK). This test pins the fix, including the redemption exception.
function migration(): string {
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('_economy_ledger_write_lockdown.sql'));
  expect(files.length, 'economy_ledger_write_lockdown migration must exist').toBe(1);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8');
}

describe('0218 economy ledger write lockdown', () => {
  const sql = migration();

  it('restricts the currency ledger + config + rewards writes to can_manage_family', () => {
    expect(sql).toContain("array['family_currencies','currency_transactions','economy_rewards']");
    expect(sql).toContain('for insert to authenticated with check (public.can_manage_family(family_id))');
  });

  it('keeps economy_redemptions INSERT open to members (child requests a redemption)', () => {
    const block = sql.slice(sql.indexOf('economy_redemptions'));
    expect(block).toContain('create policy economy_redemptions_insert on public.economy_redemptions\n      for insert to authenticated with check (public.is_family_member(family_id))');
  });

  it('restricts economy_redemptions UPDATE/DELETE (approve/deny) to managers', () => {
    expect(sql).toContain('economy_redemptions_mng_update');
    expect(sql).toContain('economy_redemptions_mng_delete');
    const upd = sql.slice(sql.indexOf('economy_redemptions_mng_update'));
    expect(upd).toContain('can_manage_family(family_id)');
  });

  it('drops the permissive "Members manage" FOR ALL policies from 0096', () => {
    expect(sql).toContain('drop policy if exists "Members manage %1$s"');
    expect(sql).toContain('drop policy if exists "Members manage economy_redemptions"');
  });
});
