import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-08 kid-investing money-integrity guard (third family ledger, after wallet
// 0217 + economy 0218). The invest tables shipped (0097) with `is_family_member`
// FOR ALL, so a child could INSERT into invest_holdings and mint themselves
// shares (portfolio value), bypassing the parent-approved order flow. Migration
// 0219 restricts invest_holdings writes to can_manage_family() (holdings are only
// written by the SECURITY DEFINER invest_decide_order RPC, which bypasses RLS)
// while keeping invest_orders INSERT open to members (a child places a pending
// buy/sell order). Proven live on the harness (child holdings-mint -> RLS error;
// child order placement -> allowed).
function migration(): string {
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('_invest_ledger_write_lockdown.sql'));
  expect(files.length, 'invest_ledger_write_lockdown migration must exist').toBe(1);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8');
}

describe('0219 invest ledger write lockdown', () => {
  const sql = migration();

  it('restricts invest_holdings writes to can_manage_family', () => {
    const h = sql.slice(sql.indexOf('invest_holdings'));
    expect(h).toContain('for insert to authenticated with check (public.can_manage_family(family_id))');
    expect(sql).toContain('create policy invest_holdings_mng_update');
    expect(sql).toContain('create policy invest_holdings_mng_delete');
  });

  it('keeps invest_holdings SELECT open to members (child views portfolio)', () => {
    expect(sql).toContain('create policy invest_holdings_select on public.invest_holdings\n      for select to authenticated using (public.is_family_member(family_id))');
  });

  it('keeps invest_orders INSERT open to members (child places a pending order)', () => {
    expect(sql).toContain('create policy invest_orders_insert on public.invest_orders\n      for insert to authenticated with check (public.is_family_member(family_id))');
  });

  it('restricts invest_orders UPDATE/DELETE (approve/cancel) to managers', () => {
    expect(sql).toContain('invest_orders_mng_update');
    expect(sql).toContain('invest_orders_mng_delete');
  });
});
