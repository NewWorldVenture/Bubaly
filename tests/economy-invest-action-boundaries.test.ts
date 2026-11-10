import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const economyActions = readFileSync('app/(app)/economy/actions.ts', 'utf8');
const investActions = readFileSync('app/(app)/wallet/invest/actions.ts', 'utf8');
const migration = readFileSync('supabase/migrations/0196_atomic_economy_and_invest_decisions.sql', 'utf8');

// 0196 created both RPCs; later migrations replaced their bodies. The database
// runs the LAST `create or replace`, so that is the body to read.
function liveFunction(name: string): { file: string; body: string } {
  const opening = new RegExp(`^create or replace function public\\.${name}\\(`, 'm');
  const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
  let live: { file: string; body: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(`supabase/migrations/${file}`, 'utf8');
    const start = sql.search(opening);
    if (start < 0) continue;
    const tag = /\$\w*\$/.exec(sql.slice(start));
    if (!tag) throw new Error(`${file} defines ${name} without a dollar-quoted body`);
    const bodyStart = start + tag.index + tag[0].length;
    const bodyEnd = sql.indexOf(tag[0], bodyStart);
    if (bodyEnd < 0) throw new Error(`${file} never closes the body of ${name}`);
    live = { file, body: sql.slice(start, bodyEnd) };
  }
  if (!live) throw new Error(`no migration defines public.${name}`);
  return live;
}

describe('economy and simulated-investing transaction boundaries', () => {
  it('sanitizes action failures and checks all direct writes', () => {
    for (const source of [economyActions, investActions]) {
      expect(source).toContain('describeActionError(');
      expect(source).not.toMatch(/return\s*\{[^\n]*error:\s*(?:error|txnErr|orderError)\??\.message/);
    }

    expect(economyActions).toContain("supabase.rpc('economy_decide_redemption'");
    expect(investActions).toContain("supabase.rpc('invest_decide_order'");
    expect(investActions).toContain("if (bucket.error) return actionFailure('load the Invest balance', t('invest.couldNotLoadTheInvestBalance'), bucket.error);");
  });

  it('defines authenticated, locked, all-or-nothing approval RPCs', () => {
    expect(migration).toContain('create or replace function public.economy_decide_redemption');
    expect(migration).toContain('create or replace function public.invest_decide_order');
    expect(migration).toContain('from public.economy_redemptions');
    expect(migration).toContain('from public.invest_orders');
    expect(migration.match(/for update/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(migration).toContain("grant execute on function public.economy_decide_redemption(uuid, boolean, text) to authenticated;");
    expect(migration).toContain("grant execute on function public.invest_decide_order(uuid, boolean) to authenticated;");
    expect(migration).toContain("revoke all on function public.economy_decide_redemption(uuid, boolean, text) from public;");
    expect(migration).toContain("revoke all on function public.invest_decide_order(uuid, boolean) from public;");
    expect(migration).toContain("status = 'fulfilled'");
    expect(migration).toContain("status = 'filled'");
  });

  it('keeps the live definitions of both RPCs authenticated, locked and all-or-nothing', () => {
    const redemption = liveFunction('economy_decide_redemption');
    const order = liveFunction('invest_decide_order');
    // Both were replaced after 0196, so this case reads something 0196 is not.
    expect(redemption.file > '0196_atomic_economy_and_invest_decisions.sql').toBe(true);
    expect(order.file > '0196_atomic_economy_and_invest_decisions.sql').toBe(true);

    for (const { body } of [redemption, order]) {
      expect(body).toContain('security definer');
      expect(body).toContain('if auth.uid() is null then');
      expect(body).toMatch(/if not public\.can_manage_family\(v_\w+\.family_id\) then/);
      expect(body).toMatch(/status <> 'pending'/);
    }

    // The decided row is locked before its status is read, and every row the
    // approval then moves is locked too: reward + ledger, bucket + ledger + holding.
    expect(redemption.body).toMatch(/from public\.economy_redemptions\s+where id = p_redemption_id\s+for update;/);
    expect(redemption.body).toMatch(/from public\.economy_rewards\s+where[^;]*\sfor update;/);
    expect(redemption.body).toMatch(/from public\.currency_transactions\s+where[^;]*\sfor update;/);
    expect(redemption.body.match(/for update/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(redemption.body).toContain("status = 'fulfilled'");

    expect(order.body).toMatch(/from public\.invest_orders\s+where id = p_order_id\s+for update;/);
    expect(order.body).toMatch(/from public\.wallet_buckets\s+where[^;]*\sfor update;/);
    expect(order.body).toMatch(/from public\.wallet_transactions\s+where[^;]*\sfor update;/);
    expect(order.body).toMatch(/from public\.invest_holdings\s+where[^;]*\sfor update;/);
    expect(order.body.match(/for update/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(order.body).toContain("status = 'filled'");
  });
});
