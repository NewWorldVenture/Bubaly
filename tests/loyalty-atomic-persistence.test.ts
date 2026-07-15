import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/0204_atomic_loyalty_transactions.sql', 'utf8');
const server = readFileSync('lib/loyalty/server.ts', 'utf8');
const types = readFileSync('lib/database.types.ts', 'utf8');

describe('loyalty atomic persistence boundary', () => {
  it('serializes account, reward, redemption, and stock mutations in the database', () => {
    expect(migration).toContain('create or replace function public.loyalty_award_points');
    expect(migration).toContain('create or replace function public.loyalty_redeem_reward');
    expect(migration).toContain('create or replace function public.loyalty_cancel_redemption');
    expect(migration).toContain('from public.loyalty_accounts\n   where family_id = p_family_id\n   for update;');
    expect(migration).toContain('from public.loyalty_rewards\n   where id = p_reward_id');
    expect(migration).toContain('set stock = stock - 1');
    expect(migration).toContain('set stock = stock + 1');
    expect(migration).toContain('revoke all on function public.loyalty_redeem_reward(uuid, uuid, uuid) from public, anon, authenticated;');
    expect(migration).toContain('grant execute on function public.loyalty_redeem_reward(uuid, uuid, uuid) to service_role;');
  });

  it('uses RPC results instead of separate client-side balance and ledger writes', () => {
    expect(server).toContain("supabase.rpc('loyalty_award_points'");
    expect(server).toContain("supabase.rpc('loyalty_redeem_reward'");
    expect(server).toContain("supabase.rpc('loyalty_cancel_redemption'");
    expect(server).not.toContain("from('loyalty_transactions').insert");
    expect(server).not.toContain('Best-effort refund');
    expect(types).toContain('loyalty_award_points:');
    expect(types).toContain('loyalty_redeem_reward:');
    expect(types).toContain('loyalty_cancel_redemption:');
  });
});
