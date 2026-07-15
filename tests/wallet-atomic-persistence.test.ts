import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/0205_atomic_wallet_money_actions.sql', 'utf8');
const server = readFileSync('lib/wallet/server.ts', 'utf8');
const actions = readFileSync('app/(app)/wallet/actions.ts', 'utf8');
const types = readFileSync('lib/database.types.ts', 'utf8');

function section(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = end ? source.indexOf(end, startAt + start.length) : -1;
  return source.slice(startAt, endAt < 0 ? source.length : endAt);
}

describe('Wallet atomic money persistence boundary', () => {
  it('locks money state and grants only authenticated manager RPC access', () => {
    for (const fn of ['wallet_transfer', 'wallet_approve_gift', 'wallet_decide_spend', 'wallet_decide_allowance']) {
      expect(migration).toContain(`create or replace function public.${fn}`);
      expect(migration).toContain(`grant execute on function public.${fn}`);
    }
    expect(migration).toContain('public.can_manage_family(p_family_id)');
    expect(migration).toContain('order by id for update;');
    expect(migration).toContain('from public.gift_payments');
    expect(migration).toContain('from public.parent_approvals');
    expect(migration).toContain('from public.wallet_transactions where id = v_approval.ref_id');
    expect(migration).toContain('wallet_credit_child_ledger');
    expect(migration).toContain('returning id into v_inserted_id');
    expect(migration).toContain('revoke all on function public.wallet_transfer');
    expect(migration).toContain('from public, anon;');
  });

  it('keeps ledger and state transitions behind typed RPC wrappers', () => {
    for (const fn of ['wallet_transfer', 'wallet_approve_gift', 'wallet_decide_spend', 'wallet_decide_allowance']) {
      expect(server).toContain(`supabase.rpc('${fn}'`);
      expect(types).toContain(`${fn}:`);
    }
    expect(section(actions, 'export async function sendMoneyAction', 'export async function requestAllowanceAction'))
      .toContain('transferWallets(');
    expect(section(actions, 'export async function approveGiftAction', 'export async function dismissGiftAction'))
      .toContain('approveGift(');
    expect(section(actions, 'export async function decideSpendRequestAction', 'export async function sendMoneyAction'))
      .toContain('decideSpend(');
    expect(section(actions, 'export async function decideAllowanceRequestAction', ''))
      .toContain('decideAllowance(');
    expect(section(actions, 'export async function approveGiftAction', 'export async function dismissGiftAction'))
      .not.toContain("gift_payments').update({ status: 'completed'");
    expect(section(actions, 'export async function sendMoneyAction', 'export async function requestAllowanceAction'))
      .not.toContain('debitSpendBucket(');
    expect(section(actions, 'export async function decideSpendRequestAction', 'export async function sendMoneyAction'))
      .not.toContain("parent_approvals').update");
  });
});
