'use server';

// app/(app)/wallet/invest/actions.ts — EDUCATIONAL kid investing actions.
// Simulated only. A "buy" moves cash out of the child's INVEST bucket (a
// wallet_transactions debit) and records shares; a "sell" moves cash back in.
// Orders are parent-approved. The wallet ledger stays the source of truth.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { orderAmountCents } from '@/lib/invest/portfolio';
import { evaluateTrust, roleOf } from '@/lib/trust/server';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: boolean; error?: string };

function actionFailure(operation: string, message: string, error: unknown): Result {
  console.error(`[invest-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

async function decisionResult(operation: string, message: string, data: unknown): Promise<Result> {
  const tr = await getTranslations();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return actionFailure(operation, message, new Error(tr('actions.invalidDecisionResponse')));
  }
  const result = data as { ok?: unknown; reason?: unknown };
  if (result.ok === true) return { ok: true };
  const messages: Record<string, string> = {
    unauthenticated: 'Please sign in to continue.',
    forbidden: 'Only a parent or guardian can approve investing.',
    not_found: tr('actions.orderNotFound'),
    already_decided: tr('actions.thisOrderWasAlreadyDecided'),
    missing_invest_bucket: 'The Invest bucket is not available for this child.',
    insufficient_cash: 'No longer enough in the Invest bucket.',
    insufficient_shares: 'No longer enough shares to sell.',
  };
  return { ok: false, error: messages[String(result.reason)] ?? `Could not ${operation}.` };
}

/** Live balance (cents) of a child's INVEST bucket from the immutable ledger. */
async function investBucketBalance(supabase: Awaited<ReturnType<typeof createServer>>, familyId: string, childWalletId: string) {
  const { data: bucket, error: bucketError } = await supabase
    .from('wallet_buckets').select('id')
    .eq('family_id', familyId).eq('child_wallet_id', childWalletId).eq('kind', 'invest').maybeSingle();
  if (bucketError) return { bucketId: null as string | null, balance: 0, error: bucketError };
  if (!bucket) return { bucketId: null as string | null, balance: 0 };
  const { data: txns, error: txnError } = await supabase
    .from('wallet_transactions').select('direction, amount_cents, status')
    .eq('family_id', familyId).eq('bucket_id', bucket.id).in('status', ['completed', 'processing']);
  if (txnError) return { bucketId: bucket.id, balance: 0, error: txnError };
  const balance = (txns ?? []).reduce((s, t) => s + (t.direction === 'credit' ? t.amount_cents : -t.amount_cents), 0);
  return { bucketId: bucket.id, balance };
}

/** Request a buy/sell order (pending parent approval). */
export async function placeInvestOrderAction(input: { childWalletId: string; assetId: string; side: 'buy' | 'sell'; shares: number }): Promise<Result> {
  const t = await getTranslations();
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const shares = Math.floor(Number(input.shares) * 10000) / 10000;
  if (!Number.isFinite(shares) || shares <= 0) return { ok: false, error: tr('actions.enterANumberOfShares') };

  const supabase = await createServer();
  const [{ data: cw, error: walletError }, { data: asset, error: assetError }] = await settleAll([
    supabase.from('child_wallets').select('id').eq('id', input.childWalletId).eq('family_id', familyId).maybeSingle(),
    supabase.from('invest_assets').select('id, price_cents, is_active').eq('id', input.assetId).maybeSingle(),
  ]);
  if (walletError) return actionFailure('load the child wallet', tr('invest.couldNotLoadTheChildWallet'), walletError);
  if (assetError) return actionFailure('load the investment', t('invest.couldNotLoadTheInvestment'), assetError);
  if (!cw) return { ok: false, error: tr('actions.childWalletNotFound') };
  if (!asset || !asset.is_active) return { ok: false, error: tr('actions.thatInvestmentIsNotAvailable') };

  const amount = orderAmountCents(shares, asset.price_cents);
  if (amount <= 0) return { ok: false, error: tr('actions.amountMustBeGreaterThan') };

  if (input.side === 'buy') {
    const bucket = await investBucketBalance(supabase, familyId, input.childWalletId);
    if (bucket.error) return actionFailure('load the Invest balance', t('invest.couldNotLoadTheInvestBalance'), bucket.error);
    const { balance } = bucket;
    if (amount > balance) return { ok: false, error: tr('actions.notEnoughMoneyInThe') };
  } else {
    const { data: holding, error: holdingError } = await supabase
      .from('invest_holdings').select('shares').eq('family_id', familyId).eq('child_wallet_id', input.childWalletId).eq('asset_id', input.assetId).maybeSingle();
    if (holdingError) return actionFailure('load the investment holding', t('invest.couldNotLoadTheInvestmentHolding'), holdingError);
    if (!holding || holding.shares < shares) return { ok: false, error: tr('actions.notEnoughSharesToSell') };
  }

  // Trust Engine: only an EXPLICIT denial blocks placing an order — a role
  // default "no" still lets a child *ask*, since fills are parent-approved.
  const { decision } = await evaluateTrust(supabase, familyId, {
    actor: { kind: 'member', id: ctx.active.member.id, role: roleOf(ctx.active.role) },
    domain: 'finances', capability: 'automate',
    title: `Invest order: ${input.side} ${(amount / 100).toFixed(2)}`,
    context: { amountCents: amount }, openApproval: false,
  });
  if (decision.effect === 'deny' && (decision.basis === 'deny_grant' || decision.basis === 'policy')) {
    return { ok: false, error: `Blocked by household policy: ${decision.reason}` };
  }

  const { error } = await supabase.from('invest_orders').insert({
    family_id: familyId, child_wallet_id: input.childWalletId, asset_id: input.assetId,
    side: input.side, shares, price_cents: asset.price_cents, amount_cents: amount,
    status: 'pending', requested_by: ctx.user.id,
  });
  if (error) return actionFailure('place the investment order', t('invest.couldNotPlaceTheInvestmentOrder'), error);
  revalidatePath('/wallet/invest');
  return { ok: true };
}

/** Parent approves (fills) or rejects an order. Fills move cash + shares. */
export async function decideInvestOrderAction(input: { orderId: string; approve: boolean }): Promise<Result> {
  const t = await getTranslations();
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: tr('actions.onlyAParentGuardianCan') };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: order, error: orderError } = await supabase
    .from('invest_orders')
    .select('id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status')
    .eq('id', input.orderId).eq('family_id', familyId).maybeSingle();
  if (orderError) return actionFailure('load the investment order', t('invest.couldNotLoadTheInvestmentOrder'), orderError);
  if (!order) return { ok: false, error: tr('actions.orderNotFound') };
  if (order.status !== 'pending') return { ok: false, error: tr('actions.thisOrderWasAlreadyDecided') };

  if (input.approve) {
    const { decision } = await evaluateTrust(supabase, familyId, {
      actor: { kind: 'member', id: ctx.active.member.id, role: roleOf(ctx.active.role) },
      domain: 'finances', capability: 'approve',
      title: `Fill invest order ${(order.amount_cents / 100).toFixed(2)}`,
      context: { amountCents: order.amount_cents }, openApproval: false,
    });
    if (decision.effect === 'deny') return { ok: false, error: `Blocked by household policy: ${decision.reason}` };
  }

  const { data, error } = await supabase.rpc('invest_decide_order', {
    p_order_id: input.orderId,
    p_approve: input.approve,
  });
  if (error) return actionFailure('decide the investment order', t('invest.couldNotDecideTheInvestmentOrder'), error);
  const result = await decisionResult(tr('actions.decideTheInvestmentOrder'), tr('invest.couldNotDecideTheInvestment'), data);
  if (!result.ok) return result;

  revalidatePath('/wallet/invest');
  return { ok: true };
}
