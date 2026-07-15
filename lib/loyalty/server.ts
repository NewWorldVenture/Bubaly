// lib/loyalty/server.ts
// Service-role loyalty engine. The ONLY path that mutates point balances, so they
// can never be tampered with client-side. Used by the admin console (manual
// award, fulfill) and the family redeem action (which resolves the caller's
// family then calls in here with the service-role client).
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';

type DB = SupabaseClient<Database>;
type Settings = Database['public']['Tables']['loyalty_settings']['Row'];
type Account = Database['public']['Tables']['loyalty_accounts']['Row'];

export async function getSettings(supabase: DB): Promise<Settings | null> {
  const { data, error } = await supabase.from('loyalty_settings').select('*').eq('singleton', true).maybeSingle();
  if (error) console.error('[loyalty] settings read failed', error);
  return data ?? null;
}

type LoyaltyRpcResult = {
  ok?: boolean;
  reason?: string;
  needed?: number;
  account?: Account;
  redemption_id?: string;
};

function parseRpcResult(data: Json | null): LoyaltyRpcResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data as LoyaltyRpcResult;
}

function stableRpcError(operation: string, error: unknown): Error {
  console.error(`[loyalty] ${operation} failed`, error);
  return new Error(`Could not ${operation}.`);
}

/** Get-or-create the family's loyalty account. */
export async function ensureAccount(supabase: DB, familyId: string): Promise<Account> {
  const { data: existing, error: readError } = await supabase.from('loyalty_accounts').select('*').eq('family_id', familyId).maybeSingle();
  if (readError) throw stableRpcError('load the loyalty account', readError);
  if (existing) return existing;
  const { data, error } = await supabase
    .from('loyalty_accounts')
    .insert({ family_id: familyId })
    .select('*')
    .single();
  if (error || !data) {
    // A concurrent first-use request may have won the unique insert. Read it
    // once more before treating the operation as a failure.
    const { data: concurrent, error: retryError } = await supabase.from('loyalty_accounts').select('*').eq('family_id', familyId).maybeSingle();
    if (concurrent) return concurrent;
    throw stableRpcError('create the loyalty account', retryError ?? error ?? new Error('Account was not returned after creation.'));
  }
  return data;
}

export type AwardOpts = { kind?: 'earn' | 'redeem' | 'adjust' | 'expire'; reason?: string; source?: string; rewardId?: string | null; actorId?: string | null };

/**
 * Award (or, with a negative amount + kind 'adjust', deduct) points. Updates the
 * balance, lifetime (positive earns only), and tier, and writes a ledger row with
 * the running balance_after.
 */
export async function awardPoints(supabase: DB, familyId: string, points: number, opts: AwardOpts = {}): Promise<Account> {
  if (!Number.isFinite(points) || points === 0) return ensureAccount(supabase, familyId);
  const { data, error } = await supabase.rpc('loyalty_award_points', {
    p_family_id: familyId,
    p_points: Math.trunc(points),
    p_kind: opts.kind ?? 'earn',
    p_reason: opts.reason ?? null,
    p_source: opts.source ?? null,
    p_reward_id: opts.rewardId ?? null,
    p_actor_id: opts.actorId ?? null,
  });
  if (error) throw stableRpcError('update loyalty points', error);
  const result = parseRpcResult(data);
  if (!result.ok) {
    if (result.reason === 'insufficient_points') throw new Error('Insufficient loyalty points.');
    throw stableRpcError('update loyalty points', new Error(result.reason ?? 'The loyalty engine rejected the update.'));
  }
  if (!result.account) throw stableRpcError('update loyalty points', new Error('The updated loyalty account was not returned.'));
  return result.account;
}

export type RedeemResult = { ok: boolean; error?: string; redemptionId?: string };

/** Redeem a catalog reward: validates active/stock/balance, deducts points, and
 *  creates a pending redemption + ledger row. Stock is decremented when finite. */
export async function redeemReward(supabase: DB, familyId: string, rewardId: string, actorId?: string | null): Promise<RedeemResult> {
  const { data, error } = await supabase.rpc('loyalty_redeem_reward', {
    p_family_id: familyId,
    p_reward_id: rewardId,
    p_actor_id: actorId ?? null,
  });
  if (error) {
    console.error('[loyalty] redeem reward failed', error);
    return { ok: false, error: 'Could not complete redemption right now.' };
  }
  const result = parseRpcResult(data);
  if (result.ok && result.redemption_id) return { ok: true, redemptionId: result.redemption_id };
  if (result.reason === 'not_available') return { ok: false, error: 'This reward is not available.' };
  if (result.reason === 'out_of_stock') return { ok: false, error: 'This reward is out of stock.' };
  if (result.reason === 'insufficient_points') return { ok: false, error: `You need ${result.needed ?? 0} more points.` };
  console.error('[loyalty] redeem reward rejected', result.reason ?? 'unknown reason');
  return { ok: false, error: 'Could not complete redemption right now.' };
}

export type CancelRedemptionResult = { ok: boolean; error?: string };

/** Cancel a pending redemption, refund its points, and restore finite stock atomically. */
export async function cancelRedemption(supabase: DB, redemptionId: string, actorId?: string | null): Promise<CancelRedemptionResult> {
  const { data, error } = await supabase.rpc('loyalty_cancel_redemption', {
    p_redemption_id: redemptionId,
    p_actor_id: actorId ?? null,
  });
  if (error) throw stableRpcError('cancel the loyalty redemption', error);
  const result = parseRpcResult(data);
  if (result.ok) return { ok: true };
  if (result.reason === 'not_found') return { ok: false, error: 'Redemption not found.' };
  if (result.reason === 'already_processed') return { ok: false, error: 'Redemption was already processed.' };
  throw stableRpcError('cancel the loyalty redemption', new Error(result.reason ?? 'The loyalty engine rejected the cancellation.'));
}
