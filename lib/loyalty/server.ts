// lib/loyalty/server.ts
// Service-role loyalty engine. The ONLY path that mutates point balances, so they
// can never be tampered with client-side. Used by the admin console (manual
// award, fulfill) and the family redeem action (which resolves the caller's
// family then calls in here with the service-role client).
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { computeTier, canRedeem, DEFAULT_LOYALTY, type TierThresholds } from '@/lib/marketing/loyalty';

type DB = SupabaseClient<Database>;
type Settings = Database['public']['Tables']['loyalty_settings']['Row'];
type Account = Database['public']['Tables']['loyalty_accounts']['Row'];

export async function getSettings(supabase: DB): Promise<Settings | null> {
  const { data } = await supabase.from('loyalty_settings').select('*').eq('singleton', true).maybeSingle();
  return data ?? null;
}

function thresholds(s: Settings | null): TierThresholds {
  return { silverAt: s?.tier_silver_at ?? DEFAULT_LOYALTY.tier_silver_at, goldAt: s?.tier_gold_at ?? DEFAULT_LOYALTY.tier_gold_at };
}

/** Get-or-create the family's loyalty account. */
export async function ensureAccount(supabase: DB, familyId: string): Promise<Account> {
  const { data: existing } = await supabase.from('loyalty_accounts').select('*').eq('family_id', familyId).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabase
    .from('loyalty_accounts')
    .insert({ family_id: familyId })
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Could not create loyalty account');
  return data;
}

export type AwardOpts = { kind?: 'earn' | 'adjust'; reason?: string; source?: string; rewardId?: string | null; actorId?: string | null };

/**
 * Award (or, with a negative amount + kind 'adjust', deduct) points. Updates the
 * balance, lifetime (positive earns only), and tier, and writes a ledger row with
 * the running balance_after.
 */
export async function awardPoints(supabase: DB, familyId: string, points: number, opts: AwardOpts = {}): Promise<Account> {
  if (!Number.isFinite(points) || points === 0) return ensureAccount(supabase, familyId);
  const settings = await getSettings(supabase);
  const account = await ensureAccount(supabase, familyId);

  const newBalance = Math.max(0, account.points_balance + points);
  const newLifetime = account.lifetime_points + Math.max(0, points);
  const tier = computeTier(newLifetime, thresholds(settings));

  const { data: updated, error } = await supabase
    .from('loyalty_accounts')
    .update({ points_balance: newBalance, lifetime_points: newLifetime, tier })
    .eq('family_id', familyId)
    .select('*')
    .single();
  if (error || !updated) throw new Error(error?.message ?? 'Could not update balance');

  await supabase.from('loyalty_transactions').insert({
    family_id: familyId,
    points,
    kind: opts.kind ?? 'earn',
    reason: opts.reason ?? null,
    source: opts.source ?? null,
    balance_after: newBalance,
    reward_id: opts.rewardId ?? null,
    created_by: opts.actorId ?? null,
  });
  return updated;
}

export type RedeemResult = { ok: boolean; error?: string; redemptionId?: string };

/** Redeem a catalog reward: validates active/stock/balance, deducts points, and
 *  creates a pending redemption + ledger row. Stock is decremented when finite. */
export async function redeemReward(supabase: DB, familyId: string, rewardId: string, actorId?: string | null): Promise<RedeemResult> {
  const { data: reward } = await supabase.from('loyalty_rewards').select('*').eq('id', rewardId).is('deleted_at', null).maybeSingle();
  if (!reward || !reward.is_active) return { ok: false, error: 'This reward is not available.' };
  if (reward.stock != null && reward.stock <= 0) return { ok: false, error: 'This reward is out of stock.' };

  const account = await ensureAccount(supabase, familyId);
  if (!canRedeem(account.points_balance, reward.cost_points)) {
    return { ok: false, error: `You need ${reward.cost_points - account.points_balance} more points.` };
  }

  // Deduct points (writes the ledger + new balance).
  await awardPoints(supabase, familyId, -reward.cost_points, { kind: 'adjust', source: 'redemption', reason: `Redeemed: ${reward.name}`, rewardId, actorId });

  const { data: redemption, error } = await supabase
    .from('loyalty_redemptions')
    .insert({ family_id: familyId, reward_id: rewardId, reward_name: reward.name, cost_points: reward.cost_points, status: 'pending', created_by: actorId ?? null })
    .select('id')
    .single();
  if (error || !redemption) {
    // Best-effort refund if the redemption row failed to write.
    await awardPoints(supabase, familyId, reward.cost_points, { kind: 'adjust', source: 'redemption_refund', reason: 'Redemption failed — refund' });
    return { ok: false, error: 'Could not complete redemption. Your points were not charged.' };
  }

  if (reward.stock != null) {
    await supabase.from('loyalty_rewards').update({ stock: Math.max(0, reward.stock - 1) }).eq('id', rewardId);
  }
  return { ok: true, redemptionId: redemption.id };
}
