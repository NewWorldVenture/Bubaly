import { readdirSync, readFileSync } from 'node:fs';
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

// The definition a function has TODAY: the last migration, in the order they
// apply, that creates or replaces it, cut down to that function's own body.
// 0205 created these four; 0483 has since replaced two of them, so a check of
// 0205 alone says nothing about what a database built from this tree runs.
const MIGRATIONS = 'supabase/migrations';
function liveDefinition(fn: string): { file: string; body: string } {
  const head = new RegExp(`create or replace function public\\.${fn}\\(`, 'i');
  let live = { file: '', body: '' };
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    const source = readFileSync(`${MIGRATIONS}/${file}`, 'utf8');
    const at = source.search(head);
    if (at < 0) continue;
    const quote = /\bas\s+(\$[a-z_]*\$)/i.exec(source.slice(at));
    if (!quote) continue;
    const open = at + quote.index + quote[0].length;
    const close = source.indexOf(quote[1], open);
    live = { file, body: source.slice(at, close < 0 ? source.length : close) };
  }
  return live;
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

  it('holds the manager gate and the row locks in the definition each money RPC has today', () => {
    const transfer = liveDefinition('wallet_transfer');
    const gift = liveDefinition('wallet_approve_gift');
    const spend = liveDefinition('wallet_decide_spend');
    const allowance = liveDefinition('wallet_decide_allowance');

    for (const [fn, live] of Object.entries({
      wallet_transfer: transfer,
      wallet_approve_gift: gift,
      wallet_decide_spend: spend,
      wallet_decide_allowance: allowance,
    })) {
      expect(live.file, `no migration defines public.${fn}`).not.toBe('');
      expect(live.body, `${fn} in ${live.file} lost its manager gate`)
        .toContain('public.can_manage_family(p_family_id)');
      expect(live.body, `${fn} in ${live.file} is cut past its own body`)
        .not.toMatch(/create or replace function[\s\S]*create or replace function/i);
    }

    // Both wallets, in id order, so two opposite transfers cannot deadlock.
    expect(transfer.body, `wallet_transfer in ${transfer.file} no longer locks both wallets`)
      .toMatch(/from public\.child_wallets\s+where [^;]*\border by id for update;/);
    // The spend bucket the balance is read from.
    expect(transfer.body, `wallet_transfer in ${transfer.file} no longer locks the spend bucket`)
      .toMatch(/from public\.wallet_buckets\s+where [^;]*\bfor update;/);

    expect(gift.body, `wallet_approve_gift in ${gift.file} no longer locks the gift`)
      .toMatch(/from public\.gift_payments\s+where [^;]*\bfor update;/);

    expect(spend.body, `wallet_decide_spend in ${spend.file} no longer locks the approval`)
      .toMatch(/from public\.parent_approvals\s+where [^;]*\bfor update;/);
    expect(spend.body, `wallet_decide_spend in ${spend.file} no longer locks the ledger row it decides`)
      .toMatch(/from public\.wallet_transactions where id = v_approval\.ref_id [^;]*\bfor update;/);
    expect(spend.body, `wallet_decide_spend in ${spend.file} no longer locks the spend bucket`)
      .toMatch(/from public\.wallet_buckets\s+where [^;]*\bfor update;/);

    expect(allowance.body, `wallet_decide_allowance in ${allowance.file} no longer locks the approval`)
      .toMatch(/from public\.parent_approvals\s+where [^;]*\bfor update;/);
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
