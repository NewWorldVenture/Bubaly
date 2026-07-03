'use server';

// app/(app)/wallet/invest/actions.ts — EDUCATIONAL kid investing actions.
// Simulated only. A "buy" moves cash out of the child's INVEST bucket (a
// wallet_transactions debit) and records shares; a "sell" moves cash back in.
// Orders are parent-approved. The wallet ledger stays the source of truth.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { orderAmountCents } from '@/lib/invest/portfolio';
import { evaluateTrust, roleOf } from '@/lib/trust/server';

type Result = { ok: boolean; error?: string };

/** Live balance (cents) of a child's INVEST bucket from the immutable ledger. */
async function investBucketBalance(supabase: Awaited<ReturnType<typeof createServer>>, familyId: string, childWalletId: string) {
  const { data: bucket } = await supabase
    .from('wallet_buckets').select('id')
    .eq('family_id', familyId).eq('child_wallet_id', childWalletId).eq('kind', 'invest').maybeSingle();
  if (!bucket) return { bucketId: null as string | null, balance: 0 };
  const { data: txns } = await supabase
    .from('wallet_transactions').select('direction, amount_cents, status')
    .eq('family_id', familyId).eq('bucket_id', bucket.id).in('status', ['completed', 'processing']);
  const balance = (txns ?? []).reduce((s, t) => s + (t.direction === 'credit' ? t.amount_cents : -t.amount_cents), 0);
  return { bucketId: bucket.id, balance };
}

/** Request a buy/sell order (pending parent approval). */
export async function placeInvestOrderAction(input: { childWalletId: string; assetId: string; side: 'buy' | 'sell'; shares: number }): Promise<Result> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const shares = Math.floor(Number(input.shares) * 10000) / 10000;
  if (!Number.isFinite(shares) || shares <= 0) return { ok: false, error: 'Enter a number of shares greater than 0.' };

  const supabase = await createServer();
  const [{ data: cw }, { data: asset }] = await Promise.all([
    supabase.from('child_wallets').select('id').eq('id', input.childWalletId).eq('family_id', familyId).maybeSingle(),
    supabase.from('invest_assets').select('id, price_cents, is_active').eq('id', input.assetId).maybeSingle(),
  ]);
  if (!cw) return { ok: false, error: 'Child wallet not found.' };
  if (!asset || !asset.is_active) return { ok: false, error: 'That investment is not available.' };

  const amount = orderAmountCents(shares, asset.price_cents);
  if (amount <= 0) return { ok: false, error: 'Amount must be greater than $0.' };

  if (input.side === 'buy') {
    const { balance } = await investBucketBalance(supabase, familyId, input.childWalletId);
    if (amount > balance) return { ok: false, error: 'Not enough money in the Invest bucket. Add to Invest first.' };
  } else {
    const { data: holding } = await supabase
      .from('invest_holdings').select('shares').eq('family_id', familyId).eq('child_wallet_id', input.childWalletId).eq('asset_id', input.assetId).maybeSingle();
    if (!holding || holding.shares < shares) return { ok: false, error: 'Not enough shares to sell.' };
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
  if (error) return { ok: false, error: error.message };
  revalidatePath('/wallet/invest');
  return { ok: true };
}

/** Parent approves (fills) or rejects an order. Fills move cash + shares. */
export async function decideInvestOrderAction(input: { orderId: string; approve: boolean }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can approve investing.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: order } = await supabase
    .from('invest_orders')
    .select('id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status')
    .eq('id', input.orderId).eq('family_id', familyId).maybeSingle();
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.status !== 'pending') return { ok: false, error: 'This order was already decided.' };

  if (!input.approve) {
    await supabase.from('invest_orders').update({ status: 'rejected', decided_by: ctx.user.id, decided_at: new Date().toISOString() }).eq('id', order.id).eq('family_id', familyId);
    revalidatePath('/wallet/invest');
    return { ok: true };
  }

  const { decision } = await evaluateTrust(supabase, familyId, {
    actor: { kind: 'member', id: ctx.active.member.id, role: roleOf(ctx.active.role) },
    domain: 'finances', capability: 'approve',
    title: `Fill invest order ${(order.amount_cents / 100).toFixed(2)}`,
    context: { amountCents: order.amount_cents }, openApproval: false,
  });
  if (decision.effect === 'deny') return { ok: false, error: `Blocked by household policy: ${decision.reason}` };

  const { bucketId, balance } = await investBucketBalance(supabase, familyId, order.child_wallet_id);

  // Re-validate at approval time, then move cash through the INVEST bucket.
  if (order.side === 'buy') {
    if (order.amount_cents > balance) return { ok: false, error: 'No longer enough in the Invest bucket.' };
  } else {
    const { data: holding } = await supabase
      .from('invest_holdings').select('shares').eq('family_id', familyId).eq('child_wallet_id', order.child_wallet_id).eq('asset_id', order.asset_id).maybeSingle();
    if (!holding || holding.shares < order.shares) return { ok: false, error: 'No longer enough shares to sell.' };
  }

  const { data: txn, error: txnErr } = await supabase.from('wallet_transactions').insert({
    family_id: familyId, child_wallet_id: order.child_wallet_id, bucket_id: bucketId,
    type: 'adjustment', status: 'completed',
    direction: order.side === 'buy' ? 'debit' : 'credit', amount_cents: order.amount_cents,
    description: order.side === 'buy' ? 'Invest: bought shares' : 'Invest: sold shares',
    related_type: 'invest_orders', related_id: order.id, created_by: ctx.user.id, approved_by: ctx.user.id,
    metadata: { side: order.side, shares: order.shares },
  }).select('id').single();
  if (txnErr) return { ok: false, error: txnErr.message };

  // Update holdings (recompute avg cost on buy; reduce on sell).
  const { data: existing } = await supabase
    .from('invest_holdings').select('id, shares, avg_cost_cents')
    .eq('family_id', familyId).eq('child_wallet_id', order.child_wallet_id).eq('asset_id', order.asset_id).maybeSingle();

  if (order.side === 'buy') {
    if (existing) {
      const newShares = Number(existing.shares) + Number(order.shares);
      const newCostBasis = existing.shares * existing.avg_cost_cents + order.shares * order.price_cents;
      const avg = newShares > 0 ? Math.round(newCostBasis / newShares) : 0;
      await supabase.from('invest_holdings').update({ shares: newShares, avg_cost_cents: avg }).eq('id', existing.id);
    } else {
      await supabase.from('invest_holdings').insert({
        family_id: familyId, child_wallet_id: order.child_wallet_id, asset_id: order.asset_id,
        shares: order.shares, avg_cost_cents: order.price_cents,
      });
    }
  } else if (existing) {
    const newShares = Math.max(0, Number(existing.shares) - Number(order.shares));
    await supabase.from('invest_holdings').update({ shares: newShares }).eq('id', existing.id);
  }

  await supabase.from('invest_orders').update({ status: 'filled', txn_id: txn.id, decided_by: ctx.user.id, decided_at: new Date().toISOString() }).eq('id', order.id).eq('family_id', familyId);
  await supabase.from('wallet_audit_logs').insert({
    family_id: familyId, actor_user_id: ctx.user.id, action: `invest_${order.side}`,
    entity_type: 'invest_orders', entity_id: order.id, detail: `${order.side} ${order.shares} shares`,
  });

  revalidatePath('/wallet/invest');
  return { ok: true };
}
