'use server';

// Server actions for the "My Wallet" hub. Every write is scoped to the
// signed-in user's active family and relies on the tables' own family-scoped
// RLS as the security boundary (never the service role).
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import type { AccountType } from '@/lib/database.types';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: boolean; error?: string };

function actionFailure(operation: string, error: unknown): Result {
  console.error(`[wallet-hub] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

const ACCOUNT_TYPES: AccountType[] = ['checking', 'savings', 'credit', 'investment', 'retirement'];
const CARD_BRANDS = ['visa', 'mastercard', 'amex', 'discover', 'other'];
const CARD_KINDS = ['credit', 'debit', 'gas', 'store', 'prepaid', 'other'];
const PASS_KINDS = ['membership', 'loyalty', 'ticket', 'insurance', 'transit', 'other'];
const REWARD_KINDS = ['points', 'miles', 'cashback'];
const TXN_TYPES = ['income', 'expense', 'transfer'];
const TXN_STATUS = ['posted', 'pending', 'cleared', 'failed', 'scheduled'];

const str = (v: unknown, max = 120): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const dollars = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const cents = (v: unknown): number => Math.round(dollars(v) * 100);

export async function addAccountAction(input: Record<string, unknown>): Promise<Result> {
  const ctx = await requireUserContext();
  const name = str(input.name);
  if (!name) return { ok: false, error: 'Account name is required' };
  const type = ACCOUNT_TYPES.includes(input.type as AccountType) ? (input.type as AccountType) : 'checking';
  const supabase = await createServer();
  const { error } = await supabase.from('financial_accounts').insert({
    family_id: ctx.active.familyId, name, type,
    institution: str(input.institution) || null,
    last_four: str(input.last_four, 4) || null,
    balance: dollars(input.balance),
    created_by: ctx.user.id,
  });
  return error ? actionFailure('add the account', error) : { ok: true };
}

export async function addCardAction(input: Record<string, unknown>): Promise<Result> {
  const ctx = await requireUserContext();
  const name = str(input.name);
  if (!name) return { ok: false, error: 'Card name is required' };
  const supabase = await createServer();
  const { error } = await supabase.from('wallet_cards').insert({
    family_id: ctx.active.familyId, name,
    brand: CARD_BRANDS.includes(String(input.brand)) ? String(input.brand) : 'other',
    kind: CARD_KINDS.includes(String(input.kind)) ? String(input.kind) : 'credit',
    last_four: str(input.last_four, 4) || null,
    available_cents: cents(input.available),
    limit_cents: input.limit != null && input.limit !== '' ? cents(input.limit) : null,
    color: str(input.color, 16) || null,
    created_by: ctx.user.id,
  });
  return error ? actionFailure('add the card', error) : { ok: true };
}

export async function addPassAction(input: Record<string, unknown>): Promise<Result> {
  const ctx = await requireUserContext();
  const name = str(input.name);
  if (!name) return { ok: false, error: 'Pass name is required' };
  const supabase = await createServer();
  const { error } = await supabase.from('wallet_passes').insert({
    family_id: ctx.active.familyId, name,
    kind: PASS_KINDS.includes(String(input.kind)) ? String(input.kind) : 'membership',
    status: str(input.status, 60) || null,
    detail: str(input.detail, 120) || null,
    member_no: str(input.member_no, 60) || null,
    created_by: ctx.user.id,
  });
  return error ? actionFailure('add the pass', error) : { ok: true };
}

export async function addRewardAction(input: Record<string, unknown>): Promise<Result> {
  const ctx = await requireUserContext();
  const name = str(input.name);
  if (!name) return { ok: false, error: 'Program name is required' };
  const kind = REWARD_KINDS.includes(String(input.kind)) ? String(input.kind) : 'points';
  const unit = kind === 'miles' ? 'miles' : kind === 'cashback' ? '$' : 'points';
  const supabase = await createServer();
  const { error } = await supabase.from('wallet_rewards').insert({
    family_id: ctx.active.familyId, name, kind, unit,
    balance: dollars(input.balance),
    value_cents: cents(input.value),
    program: str(input.program, 80) || null,
    created_by: ctx.user.id,
  });
  return error ? actionFailure('add the reward', error) : { ok: true };
}

export async function addTransactionAction(input: Record<string, unknown>): Promise<Result> {
  const ctx = await requireUserContext();
  const name = str(input.name);
  if (!name) return { ok: false, error: 'Description is required' };
  const supabase = await createServer();
  const { error } = await supabase.from('transactions').insert({
    family_id: ctx.active.familyId, name,
    merchant: str(input.merchant, 80) || null,
    amount: Math.abs(dollars(input.amount)),
    type: TXN_TYPES.includes(String(input.type)) ? String(input.type) as never : 'expense',
    status: TXN_STATUS.includes(String(input.status)) ? String(input.status) : 'posted',
    category: str(input.category, 40) || null,
    account_id: typeof input.account_id === 'string' && input.account_id ? input.account_id : null,
    date: typeof input.date === 'string' && input.date ? input.date : new Date().toISOString().slice(0, 10),
    created_by: ctx.user.id,
  });
  return error ? actionFailure('add the transaction', error) : { ok: true };
}

const DELETABLE = new Set(['wallet_cards', 'wallet_passes', 'wallet_rewards', 'financial_accounts', 'transactions']);

export async function deleteWalletRowAction(input: { table: string; id: string }): Promise<Result> {
  await requireUserContext();
  if (!DELETABLE.has(input.table) || !input.id) return { ok: false, error: 'Invalid request' };
  const supabase = await createServer();
  // RLS ensures the row belongs to the caller's family; scope the delete to the id.
  const { error } = await supabase.from(input.table as never).delete().eq('id', input.id);
  return error ? actionFailure('delete the wallet item', error) : { ok: true };
}
