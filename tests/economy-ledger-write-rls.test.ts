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

// 0218 is not the last word on economy_redemptions_insert: a later migration
// dropped and recreated it. The policy the database enforces is the LAST
// `create policy` of that name, so that is the statement to read.
function liveRedemptionInsertPolicy(): { file: string; statement: string; lastDrop: string } {
  const opening = 'create policy economy_redemptions_insert on public.economy_redemptions';
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
  let file = '';
  let statement = '';
  let lastDrop = '';
  for (const candidate of files) {
    const text = readFileSync(`supabase/migrations/${candidate}`, 'utf8');
    if (text.includes('drop policy if exists economy_redemptions_insert on public.economy_redemptions')) lastDrop = candidate;
    const start = text.lastIndexOf(opening);
    if (start < 0) continue;
    file = candidate;
    statement = text.slice(start, text.indexOf(';', start)).replace(/\s+/g, ' ');
  }
  return { file, statement, lastDrop };
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

  it('keeps the live economy_redemptions INSERT policy open to a member asking for themselves', () => {
    const live = liveRedemptionInsertPolicy();
    expect(live.file, 'a migration must define economy_redemptions_insert').not.toBe('');
    // Recreated after 0218, and not dropped again by anything later.
    expect(live.file > '0218_economy_ledger_write_lockdown.sql').toBe(true);
    expect(live.lastDrop <= live.file, `${live.lastDrop} drops the policy after ${live.file} created it`).toBe(true);
    expect(live.statement).toBe(
      'create policy economy_redemptions_insert on public.economy_redemptions for insert to authenticated '
        + 'with check (public.is_family_member(family_id) '
        + 'and (public.is_self_member(member_id) or public.can_manage_family(family_id)))',
    );
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
