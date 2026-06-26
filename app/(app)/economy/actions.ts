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

type Result = { ok: boolean; error?: string };

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
  if (error) return { ok: false, error: error.message };
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
  if (error) return { ok: false, error: error.message };
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
  const [{ data: cur }, { data: mem }] = await Promise.all([
    supabase.from('family_currencies').select('id').eq('id', input.currencyId).eq('family_id', familyId).maybeSingle(),
    supabase.from('family_members').select('id').eq('id', input.memberId).eq('family_id', familyId).maybeSingle(),
  ]);
  if (!cur) return { ok: false, error: 'Currency not found.' };
  if (!mem) return { ok: false, error: 'Family member not found.' };

  const { error } = await supabase.from('currency_transactions').insert({
    family_id: familyId, currency_id: input.currencyId, member_id: input.memberId,
    direction: 'credit', amount, reason: input.reason?.trim() || 'Awarded', related_type: 'manual', created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
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
  const { data: cur } = await supabase.from('family_currencies').select('id').eq('id', input.currencyId).eq('family_id', ctx.active.familyId).maybeSingle();
  if (!cur) return { ok: false, error: 'Currency not found.' };
  const { error } = await supabase.from('economy_rewards').insert({
    family_id: ctx.active.familyId, currency_id: input.currencyId, title, emoji: normalizeEmoji(input.emoji, '🎁'),
    cost, stock: input.stock ?? null, created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
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
  if (error) return { ok: false, error: error.message };
  revalidatePath('/economy');
  return { ok: true };
}

/** A member requests to redeem a reward (creates a pending redemption). */
export async function requestRedemptionAction(input: { rewardId: string; memberId: string }): Promise<Result> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: reward } = await supabase
    .from('economy_rewards')
    .select('id, currency_id, title, cost, is_active, stock')
    .eq('id', input.rewardId).eq('family_id', familyId).maybeSingle();
  if (!reward || !reward.is_active) return { ok: false, error: 'That reward is not available.' };
  if (reward.stock != null && reward.stock <= 0) return { ok: false, error: 'That reward is out of stock.' };

  const { data: mem } = await supabase.from('family_members').select('id').eq('id', input.memberId).eq('family_id', familyId).maybeSingle();
  if (!mem) return { ok: false, error: 'Family member not found.' };

  // Soft pre-check affordability (final check is on approval, to avoid races).
  const { data: txns } = await supabase
    .from('currency_transactions').select('direction, amount')
    .eq('family_id', familyId).eq('currency_id', reward.currency_id).eq('member_id', input.memberId);
  if (!canAfford(balanceFrom(txns ?? []), reward.cost)) return { ok: false, error: 'Not enough tokens yet.' };

  const { error } = await supabase.from('economy_redemptions').insert({
    family_id: familyId, reward_id: reward.id, currency_id: reward.currency_id, member_id: input.memberId,
    title: reward.title, cost: reward.cost, status: 'pending', requested_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/economy');
  return { ok: true };
}

/** Parent approves or rejects a redemption. Approval debits the ledger. */
export async function decideRedemptionAction(input: { redemptionId: string; approve: boolean; note?: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can decide redemptions.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: r } = await supabase
    .from('economy_redemptions')
    .select('id, currency_id, member_id, cost, status, reward_id')
    .eq('id', input.redemptionId).eq('family_id', familyId).maybeSingle();
  if (!r) return { ok: false, error: 'Redemption not found.' };
  if (r.status !== 'pending') return { ok: false, error: 'This request was already decided.' };

  if (!input.approve) {
    const { error } = await supabase.from('economy_redemptions')
      .update({ status: 'rejected', decided_by: ctx.user.id, decided_at: new Date().toISOString(), note: input.note?.trim() || null })
      .eq('id', r.id).eq('family_id', familyId);
    if (error) return { ok: false, error: error.message };
    revalidatePath('/economy');
    return { ok: true };
  }

  // Final affordability check, then debit the ledger.
  const { data: txns } = await supabase
    .from('currency_transactions').select('direction, amount')
    .eq('family_id', familyId).eq('currency_id', r.currency_id).eq('member_id', r.member_id);
  if (!canAfford(balanceFrom(txns ?? []), r.cost)) return { ok: false, error: 'They no longer have enough tokens.' };

  const { data: txn, error: txnErr } = await supabase.from('currency_transactions').insert({
    family_id: familyId, currency_id: r.currency_id, member_id: r.member_id,
    direction: 'debit', amount: r.cost, reason: 'Reward redeemed', related_type: 'redemption', related_id: r.id, created_by: ctx.user.id,
  }).select('id').single();
  if (txnErr) return { ok: false, error: txnErr.message };

  await supabase.from('economy_redemptions')
    .update({ status: 'fulfilled', decided_by: ctx.user.id, decided_at: new Date().toISOString(), txn_id: txn.id, note: input.note?.trim() || null })
    .eq('id', r.id).eq('family_id', familyId);

  // Decrement limited stock (best-effort).
  if (r.reward_id) {
    const { data: rw } = await supabase.from('economy_rewards').select('stock').eq('id', r.reward_id).maybeSingle();
    if (rw?.stock != null) await supabase.from('economy_rewards').update({ stock: Math.max(0, rw.stock - 1) }).eq('id', r.reward_id);
  }

  revalidatePath('/economy');
  return { ok: true };
}
