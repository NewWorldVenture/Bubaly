import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const economyActions = readFileSync('app/(app)/economy/actions.ts', 'utf8');
const investActions = readFileSync('app/(app)/wallet/invest/actions.ts', 'utf8');
const migration = readFileSync('supabase/migrations/0196_atomic_economy_and_invest_decisions.sql', 'utf8');

describe('economy and simulated-investing transaction boundaries', () => {
  it('sanitizes action failures and checks all direct writes', () => {
    for (const source of [economyActions, investActions]) {
      expect(source).toContain('describeActionError');
      expect(source).not.toMatch(/return\s*\{[^\n]*error:\s*(?:error|txnErr|orderError)\??\.message/);
    }

    expect(economyActions).toContain("supabase.rpc('economy_decide_redemption'");
    expect(investActions).toContain("supabase.rpc('invest_decide_order'");
    expect(investActions).toContain("if (bucket.error) return actionFailure('load the Invest balance', bucket.error);");
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
});
