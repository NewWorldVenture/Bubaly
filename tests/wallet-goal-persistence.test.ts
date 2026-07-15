import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/0208_atomic_wallet_goal_funding.sql', 'utf8');
const server = readFileSync('lib/wallet/server.ts', 'utf8');
const actions = readFileSync('app/(app)/wallet/actions.ts', 'utf8');
const types = readFileSync('lib/database.types.ts', 'utf8');

describe('wallet goal funding persistence boundaries', () => {
  it('locks and validates the family goal, child wallet, and Save bucket', () => {
    expect(migration).toContain('create or replace function public.wallet_fund_goal');
    expect(migration).toContain('public.can_manage_family(p_family_id)');
    expect(migration).toContain('from public.wallet_goals');
    expect(migration).toContain('from public.child_wallets');
    expect(migration).toContain("kind = 'save'");
    expect(migration).toContain('for update;');
  });

  it('commits the debit, goal progress, and audit record in one RPC', () => {
    const debit = migration.indexOf('insert into public.wallet_transactions');
    const goalUpdate = migration.indexOf('update public.wallet_goals');
    const audit = migration.indexOf('insert into public.wallet_audit_logs');
    expect(debit).toBeGreaterThan(-1);
    expect(goalUpdate).toBeGreaterThan(debit);
    expect(audit).toBeGreaterThan(goalUpdate);
    expect(migration).toContain('grant execute on function public.wallet_fund_goal');
  });

  it('routes the server action through the typed RPC wrapper', () => {
    expect(server).toContain("supabase.rpc('wallet_fund_goal'");
    expect(types).toContain('wallet_fund_goal:');
    const section = actions.slice(actions.indexOf('export async function fundGoalAction'), actions.indexOf('/** Create a public gift link'));
    expect(section).toContain('fundGoal(supabase');
    expect(section).not.toContain("wallet_transactions').insert");
    expect(section).not.toContain("wallet_goals').update");
  });
});
