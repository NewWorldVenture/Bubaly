'use server';

// app/(app)/economy/actions.ts — Family Economy (custom currencies) actions.
// Mirrors the wallet's immutable-ledger discipline: tokens move only via
// currency_transactions rows; balances are derived, never stored. Parents manage
// currencies/rewards and award tokens; redemptions debit on approval.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { balanceFrom, canAfford, normalizeTokenAmount, normalizeEmoji } from '@/lib/economy/ledger';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: boolean; error?: string };

function actionFailure(operation: string, error: unknown): Result {
  console.error(`[economy-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

function decisionResult(operation: string, data: unknown): Result {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return actionFailure(operation, new Error('Invalid decision response'));
  }
  const result = data as { ok?: unknown; reason?: unknown };
  if (result.ok === true) return { ok: true };
  const messages: Record<string, string> = {
    unauthenticated: 'Please sign in to continue.',
    forbidden: 'Only a parent or guardian can decide redemptions.',
    not_found: 'Redemption not found.',
    already_decided: 'This request was already decided.',
    out_of_stock: 'That reward is out of stock.',
    insufficient_tokens: 'They no longer have enough tokens.',
  };
  return { ok: false, error: messages[String(result.reason)] ?? `Could not ${operation}.` };
}

/** Create a custom currency (parent only). */
export async function createCurrencyAction(input: { name: string; emoji: string; unitLabel?: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can create a currency.' };
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Give the currency a name.' };
  const supabase = await createServer();
  const { error } = await supabase.from('family_currencies').insert({
    family_id: ctx.active.familyId, name, emoji: normalizeEmoji(input.emoji),
    unit_label: input.unitLabel?.trim() || null, created_by: ctx.user.id,
  });
  if (error) return actionFailure('create the currency', error);
  revalidatePath('/economy');
  return { ok: true };
}

/** Archive (soft-delete) a currency. */
export async function setCurrencyActiveAction(input: { currencyId: string; isActive: boolean }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can do this.' };
  const supabase = await createServer();
  const { error } = await supabase.from('family_currencies')
    .update({ is_active: input.isActive }).eq('id', input.currencyId).eq('family_id', ctx.active.familyId);
  if (error) return actionFailure('update the currency', error);
  revalidatePath('/economy');
  return { ok: true };
}

/** Award tokens to a member (credit the ledger). */
export async function awardTokensAction(input: { currencyId: string; memberId: string; amount: number; reason?: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can award tokens.' };
  const amount = normalizeTokenAmount(input.amount);
  if (!amount) return { ok: false, error: 'Enter a whole number greater than 0.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  // Confirm the currency + member belong to this family.
  const [{ data: cur, error: curError }, { data: mem, error: memError }] = await Promise.all([
    supabase.from('family_currencies').select('id').eq('id', input.currencyId).eq('family_id', familyId).maybeSingle(),
    supabase.from('family_members').select('id').eq('id', input.memberId).eq('family_id', familyId).maybeSingle(),
  ]);
  if (curError) return actionFailure('verify the currency', curError);
  if (memError) return actionFailure('verify the family member', memError);
  if (!cur) return { ok: false, error: 'Currency not found.' };
  if (!mem) return { ok: false, error: 'Family member not found.' };

  const { error } = await supabase.from('currency_transactions').insert({
    family_id: familyId, currency_id: input.currencyId, member_id: input.memberId,
    direction: 'credit', amount, reason: input.reason?.trim() || 'Awarded', related_type: 'manual', created_by: ctx.user.id,
  });
  if (error) return actionFailure('award tokens', error);
  revalidatePath('/economy');
  return { ok: true };
}

/** Create a reward kids can redeem tokens for. */
export async function createRewardAction(input: { currencyId: string; title: string; emoji: string; cost: number; stock?: number | null }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can create rewards.' };
  const title = input.title.trim();
  if (!title) return { ok: false, error: 'Give the reward a title.' };
  const cost = normalizeTokenAmount(input.cost);
  if (!cost) return { ok: false, error: 'Set a cost greater than 0.' };
  const supabase = await createServer();
  const { data: cur, error: curError } = await supabase.from('family_currencies').select('id').eq('id', input.currencyId).eq('family_id', ctx.active.familyId).maybeSingle();
  if (curError) return actionFailure('verify the currency', curError);
  if (!cur) return { ok: false, error: 'Currency not found.' };
  const { error } = await supabase.from('economy_rewards').insert({
    family_id: ctx.active.familyId, currency_id: input.currencyId, title, emoji: normalizeEmoji(input.emoji, '🎁'),
    cost, stock: input.stock ?? null, created_by: ctx.user.id,
  });
  if (error) return actionFailure('create the reward', error);
  revalidatePath('/economy');
  return { ok: true };
}

/** Archive a reward. */
export async function setRewardActiveAction(input: { rewardId: string; isActive: boolean }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can do this.' };
  const supabase = await createServer();
  const { error } = await supabase.from('economy_rewards')
    .update({ is_active: input.isActive }).eq('id', input.rewardId).eq('family_id', ctx.active.familyId);
  if (error) return actionFailure('update the reward', error);
  revalidatePath('/economy');
  return { ok: true };
}

/** A member requests to redeem a reward (creates a pending redemption). */
export async function requestRedemptionAction(input: { rewardId: string; memberId: string }): Promise<Result> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: reward, error: rewardError } = await supabase
    .from('economy_rewards')
    .select('id, currency_id, title, cost, is_active, stock')
    .eq('id', input.rewardId).eq('family_id', familyId).maybeSingle();
  if (rewardError) return actionFailure('load the reward', rewardError);
  if (!reward || !reward.is_active) return { ok: false, error: 'That reward is not available.' };
  if (reward.stock != null && reward.stock <= 0) return { ok: false, error: 'That reward is out of stock.' };

  const { data: mem, error: memError } = await supabase.from('family_members').select('id').eq('id', input.memberId).eq('family_id', familyId).maybeSingle();
  if (memError) return actionFailure('verify the family member', memError);
  if (!mem) return { ok: false, error: 'Family member not found.' };

  // Soft pre-check affordability (final check is on approval, to avoid races).
  const { data: txns, error: txnError } = await supabase
    .from('currency_transactions').select('direction, amount')
    .eq('family_id', familyId).eq('currency_id', reward.currency_id).eq('member_id', input.memberId);
  if (txnError) return actionFailure('check the token balance', txnError);
  if (!canAfford(balanceFrom(txns ?? []), reward.cost)) return { ok: false, error: 'Not enough tokens yet.' };

  const { error } = await supabase.from('economy_redemptions').insert({
    family_id: familyId, reward_id: reward.id, currency_id: reward.currency_id, member_id: input.memberId,
    title: reward.title, cost: reward.cost, status: 'pending', requested_by: ctx.user.id,
  });
  if (error) return actionFailure('request the redemption', error);
  revalidatePath('/economy');
  return { ok: true };
}

/** Parent approves or rejects a redemption. Approval debits the ledger. */
export async function decideRedemptionAction(input: { redemptionId: string; approve: boolean; note?: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can decide redemptions.' };
  const supabase = await createServer();

  const { data, error } = await supabase.rpc('economy_decide_redemption', {
    p_redemption_id: input.redemptionId,
    p_approve: input.approve,
    p_note: input.note?.trim() || null,
  });
  if (error) return actionFailure('decide the redemption', error);
  const result = decisionResult('decide the redemption', data);
  if (!result.ok) return result;

  revalidatePath('/economy');
  return { ok: true };
}
