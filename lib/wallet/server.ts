// lib/wallet/server.ts — server-side wallet money movement. The ONE place that
// writes credits into the immutable ledger: allocates an amount across a child's
// buckets per their split rule and inserts one `completed` credit per bucket.
// Reused by parent top-ups, allowance runs, and chore rewards so every credit
// path is identical and auditable.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json, WalletTxnType } from '@/lib/database.types';
import { allocate, normalizeSplit, type Split } from '@/lib/wallet/ledger';
import { describeActionError } from '@/lib/supabase/errors';
import { settleAll } from '@/lib/supabase/settle';

type DB = SupabaseClient<Database>;

function walletFailure(error: unknown, fallback: string): string {
  console.error('[wallet] operation failed:', error);
  return describeActionError(error, fallback);
}

type WalletRpcResult = { ok?: boolean; reason?: string; available?: number; transaction_id?: string; debit_transaction_id?: string; credit_transaction_id?: string };

function walletRpcResult(data: Json | null): WalletRpcResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data as WalletRpcResult;
}

function walletRpcReason(result: WalletRpcResult, fallback: string): string {
  switch (result.reason) {
    case 'forbidden': return 'You are not allowed to manage this family wallet.';
    case 'not_found':
    case 'wallet_not_found': return 'The wallet request was not found.';
    case 'already_processed': return 'This wallet request was already processed.';
    case 'insufficient_funds': return `Only ${((result.available ?? 0) / 100).toFixed(2)} is available.`;
    case 'spend_bucket_missing': return 'The wallet Spend bucket is unavailable.';
    case 'save_bucket_missing': return 'The wallet Save bucket is unavailable.';
    case 'goal_not_found': return 'The savings goal was not found.';
    case 'goal_wallet_required': return 'That goal needs a child wallet before it can be funded.';
    case 'wallet_buckets_missing': return 'The recipient wallet is not fully provisioned.';
    default: return fallback;
  }
}

export async function transferWallets(supabase: DB, params: {
  familyId: string; fromChildWalletId: string; toChildWalletId: string; amountCents: number; note?: string; actorId: string;
}): Promise<{ ok: boolean; error?: string; txnId?: string }> {
  const { data, error } = await supabase.rpc('wallet_transfer', {
    p_family_id: params.familyId,
    p_from_child_wallet_id: params.fromChildWalletId,
    p_to_child_wallet_id: params.toChildWalletId,
    p_amount: Math.trunc(params.amountCents),
    p_note: params.note ?? null,
    p_actor_id: params.actorId,
  });
  if (error) return { ok: false, error: walletFailure(error, 'Could not transfer money between those wallets.') };
  const result = walletRpcResult(data);
  if (!result.ok) return { ok: false, error: walletRpcReason(result, 'Could not transfer money between those wallets.') };
  return { ok: true, txnId: result.debit_transaction_id };
}

export async function approveGift(supabase: DB, familyId: string, giftPaymentId: string, actorId: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('wallet_approve_gift', {
    p_family_id: familyId, p_gift_payment_id: giftPaymentId, p_actor_id: actorId,
  });
  if (error) return { ok: false, error: walletFailure(error, 'Could not approve that gift.') };
  const result = walletRpcResult(data);
  if (!result.ok) return { ok: false, error: walletRpcReason(result, 'Could not approve that gift.') };
  return { ok: true };
}

export async function decideSpend(supabase: DB, params: {
  familyId: string; approvalId: string; decision: 'approved' | 'rejected'; note?: string; actorId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('wallet_decide_spend', {
    p_family_id: params.familyId, p_approval_id: params.approvalId, p_decision: params.decision,
    p_note: params.note ?? null, p_actor_id: params.actorId,
  });
  if (error) return { ok: false, error: walletFailure(error, 'Could not decide that spend request.') };
  const result = walletRpcResult(data);
  if (!result.ok) return { ok: false, error: walletRpcReason(result, 'Could not decide that spend request.') };
  return { ok: true };
}

export async function decideAllowance(supabase: DB, params: {
  familyId: string; approvalId: string; decision: 'approved' | 'rejected'; note?: string; actorId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('wallet_decide_allowance', {
    p_family_id: params.familyId, p_approval_id: params.approvalId, p_decision: params.decision,
    p_note: params.note ?? null, p_actor_id: params.actorId,
  });
  if (error) return { ok: false, error: walletFailure(error, 'Could not decide that allowance request.') };
  const result = walletRpcResult(data);
  if (!result.ok) return { ok: false, error: walletRpcReason(result, 'Could not decide that allowance request.') };
  return { ok: true };
}

export async function fundGoal(supabase: DB, params: {
  familyId: string; goalId: string; amountCents: number; actorId: string;
}): Promise<{ ok: boolean; error?: string; txnId?: string }> {
  const { data, error } = await supabase.rpc('wallet_fund_goal', {
    p_family_id: params.familyId,
    p_goal_id: params.goalId,
    p_amount: Math.trunc(params.amountCents),
    p_actor_id: params.actorId,
  });
  if (error) return { ok: false, error: walletFailure(error, 'Could not fund that goal.') };
  const result = walletRpcResult(data);
  if (!result.ok) return { ok: false, error: walletRpcReason(result, 'Could not fund that goal.') };
  return { ok: true, txnId: result.transaction_id };
}

export type CreditResult = { ok: boolean; error?: string; credited: number };

/**
 * Spendable balance for a child = the live balance of their SPEND bucket, derived
 * from the immutable ledger (credits − debits). This is what a card authorization
 * is checked against in real time. Returns 0 when the bucket/wallet is unknown.
 */
export async function childSpendableCents(supabase: DB, familyId: string, childWalletId: string): Promise<number> {
  const { data: bucket, error: bucketError } = await supabase
    .from('wallet_buckets').select('id')
    .eq('family_id', familyId).eq('child_wallet_id', childWalletId).eq('kind', 'spend').maybeSingle();
  if (bucketError) throw new Error(walletFailure(bucketError, 'Could not load the wallet Spend bucket.'));
  if (!bucket) return 0;

  const { data: txns, error: transactionError } = await supabase
    .from('wallet_transactions')
    .select('direction, amount_cents, status')
    .eq('family_id', familyId).eq('bucket_id', bucket.id)
    .in('status', ['completed', 'processing']);
  if (transactionError) throw new Error(walletFailure(transactionError, 'Could not load the wallet balance.'));

  return (txns ?? []).reduce((sum, t) => {
    if (t.status !== 'completed' && t.status !== 'processing') return sum;
    return sum + (t.direction === 'credit' ? t.amount_cents : -t.amount_cents);
  }, 0);
}

/**
 * Atomically reserve a hold for a card authorization. Under a per-child lock the
 * DB re-checks the spendable balance and, if sufficient, writes a `processing`
 * debit keyed by the authorization id — so concurrent authorizations can't each
 * approve against the same balance (audit PAY-1). Returns whether the hold was
 * placed (i.e. whether to approve). Idempotent on the authorization id.
 */
export async function reserveCardAuth(supabase: DB, params: {
  familyId: string; childWalletId: string; amountCents: number; authId: string; description: string;
}): Promise<boolean> {
  const { data, error } = await supabase.rpc('wallet_reserve_card_auth', {
    p_family: params.familyId,
    p_child_wallet: params.childWalletId,
    p_amount: Math.max(0, Math.trunc(params.amountCents)),
    p_auth_id: params.authId,
    p_description: params.description,
  });
  if (error) {
    console.error('[wallet] reserveCardAuth failed', error.message);
    return false; // fail closed — decline rather than risk an unfunded approval
  }
  return data === true;
}

/**
 * Release a card authorization hold (status → 'cancelled') so it stops reducing
 * the spendable balance. Called on capture (the real debit replaces it) and on
 * authorization reversal/expiry. Idempotent: only `processing` holds are touched.
 */
export async function releaseCardHold(supabase: DB, authId: string): Promise<void> {
  const { error } = await supabase
    .from('wallet_transactions')
    .update({ status: 'cancelled' })
    .eq('stripe_ref', authId)
    .eq('type', 'card_spend')
    .eq('status', 'processing');
  if (error) throw new Error(walletFailure(error, 'Could not release the card authorization hold.'));
}

/**
 * Post a card spend as a DEBIT against the child's SPEND bucket. Used by the
 * Issuing webhook when an authorization is captured. Immutable: a refund is a new
 * credit, never an edit. Idempotent on the Stripe ref.
 */
export async function debitCardSpend(supabase: DB, params: {
  familyId: string; childWalletId: string; amountCents: number; description: string; stripeRef: string;
}): Promise<{ ok: boolean; txnId?: string; error?: string }> {
  const amount = Math.trunc(params.amountCents);
  if (amount <= 0) return { ok: false, error: 'Amount must be greater than 0' };

  // Idempotency: skip if this Stripe authorization already produced a debit.
  const { data: dupe, error: dupeError } = await supabase
    .from('wallet_transactions').select('id').eq('stripe_ref', params.stripeRef).eq('type', 'card_spend').maybeSingle();
  if (dupeError) return { ok: false, error: walletFailure(dupeError, 'Could not verify that card spend.') };
  if (dupe) return { ok: true, txnId: dupe.id };

  const { data: bucket, error: bucketError } = await supabase
    .from('wallet_buckets').select('id')
    .eq('family_id', params.familyId).eq('child_wallet_id', params.childWalletId).eq('kind', 'spend').maybeSingle();
  if (bucketError) return { ok: false, error: walletFailure(bucketError, 'Could not load the wallet Spend bucket.') };
  if (!bucket?.id) return { ok: false, error: 'The wallet Spend bucket is unavailable.' };

  const { data: row, error } = await supabase
    .from('wallet_transactions')
    .insert({
      family_id: params.familyId, child_wallet_id: params.childWalletId, bucket_id: bucket.id,
      type: 'card_spend', status: 'completed', direction: 'debit', amount_cents: amount,
      description: params.description, stripe_ref: params.stripeRef, metadata: { source: 'issuing' },
    })
    .select('id')
    .single();
  if (error) return { ok: false, error: walletFailure(error, 'Could not post that card spend.') };

  await supabase.from('wallet_audit_logs').insert({
    family_id: params.familyId, actor_user_id: null, action: 'card_spend',
    entity_type: 'child_wallets', entity_id: params.childWalletId,
    detail: `${params.description} (${amount}c)`, metadata: { stripeRef: params.stripeRef },
  });
  return { ok: true, txnId: row.id };
}

export async function creditChildWallet(supabase: DB, params: {
  familyId: string;
  childWalletId: string;
  amountCents: number;
  type: WalletTxnType;
  description: string;
  createdBy: string | null;
  approvedBy?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  splitOverride?: Partial<Split> | null;
}): Promise<CreditResult> {
  const amount = Math.trunc(params.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Amount must be greater than 0', credited: 0 };

  const [{ data: rule, error: ruleError }, { data: buckets, error: bucketsError }] = await settleAll([
    supabase.from('wallet_rules').select('split').eq('family_id', params.familyId).eq('child_wallet_id', params.childWalletId).maybeSingle(),
    supabase.from('wallet_buckets').select('id, kind').eq('family_id', params.familyId).eq('child_wallet_id', params.childWalletId),
  ]);
  if (ruleError) return { ok: false, error: walletFailure(ruleError, 'Could not load the wallet allocation rule.'), credited: 0 };
  if (bucketsError) return { ok: false, error: walletFailure(bucketsError, 'Could not load the wallet buckets.'), credited: 0 };

  const split = normalizeSplit(params.splitOverride ?? (rule?.split as Partial<Split> | null));
  const parts = allocate(amount, split);
  const bucketByKind = new Map((buckets ?? []).map((b) => [b.kind, b.id]));
  const missingBucket = (['spend', 'save', 'give', 'invest'] as const)
    .some((kind) => parts[kind] > 0 && !bucketByKind.get(kind));
  if (missingBucket) return { ok: false, error: 'The wallet is not fully provisioned.', credited: 0 };

  const rows = (['spend', 'save', 'give', 'invest'] as const)
    .filter((k) => parts[k] > 0)
    .map((k) => ({
      family_id: params.familyId,
      child_wallet_id: params.childWalletId,
      bucket_id: bucketByKind.get(k) ?? null,
      type: params.type,
      status: 'completed' as const,
      direction: 'credit' as const,
      amount_cents: parts[k],
      description: params.description,
      related_type: params.relatedType ?? null,
      related_id: params.relatedId ?? null,
      created_by: params.createdBy,
      approved_by: params.approvedBy ?? params.createdBy,
      metadata: { split },
    }));
  if (rows.length === 0) return { ok: false, error: 'Nothing to allocate', credited: 0 };

  const { error } = await supabase.from('wallet_transactions').insert(rows);
  if (error) return { ok: false, error: walletFailure(error, 'Could not credit that wallet.'), credited: 0 };

  await supabase.from('wallet_audit_logs').insert({
    family_id: params.familyId, actor_user_id: params.createdBy, action: `credit_${params.type}`,
    entity_type: 'child_wallets', entity_id: params.childWalletId,
    detail: `${params.description} (${amount}c)`, metadata: { split, parts, type: params.type },
  });

  return { ok: true, credited: amount };
}

/**
 * Available (completed) balance in a single bucket for a child wallet, derived
 * straight from the ledger. Pending / requires_parent_approval rows do NOT count
 * — only `completed` moves a balance. Used to validate spend + transfers so a
 * wallet can never overdraw.
 */
export async function bucketBalanceCents(supabase: DB, params: {
  familyId: string; childWalletId: string; kind: 'spend' | 'save' | 'give' | 'invest';
}): Promise<{ bucketId: string | null; available: number; error?: string }> {
  const { data: bucket, error: bucketError } = await supabase.from('wallet_buckets')
    .select('id').eq('family_id', params.familyId).eq('child_wallet_id', params.childWalletId).eq('kind', params.kind).maybeSingle();
  if (bucketError) return { bucketId: null, available: 0, error: walletFailure(bucketError, 'Could not load the wallet bucket.') };
  if (!bucket?.id) return { bucketId: null, available: 0, error: 'The wallet bucket is unavailable.' };
  const { data: txns, error: transactionError } = await supabase.from('wallet_transactions')
    .select('direction, amount_cents, status').eq('family_id', params.familyId).eq('bucket_id', bucket.id);
  if (transactionError) return { bucketId: bucket.id, available: 0, error: walletFailure(transactionError, 'Could not load the wallet balance.') };
  const available = (txns ?? []).reduce(
    (s, t) => s + (t.status === 'completed' ? (t.direction === 'credit' ? t.amount_cents : -t.amount_cents) : 0), 0,
  );
  return { bucketId: bucket.id, available };
}

export type DebitResult = { ok: boolean; error?: string; txnId?: string };

/**
 * Debit a child's Spend bucket. When `requiresApproval` is true the row is
 * written as `requires_parent_approval` (held — does not yet reduce the balance)
 * and returned so a parent_approvals row can point at it; otherwise it posts
 * `completed` immediately. The single place spend leaves a wallet.
 */
export async function debitSpendBucket(supabase: DB, params: {
  familyId: string; childWalletId: string; amountCents: number; type: WalletTxnType;
  description: string; createdBy: string | null; approvedBy?: string | null;
  requiresApproval?: boolean; relatedType?: string | null; relatedId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<DebitResult> {
  const amount = Math.trunc(params.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Amount must be greater than 0' };

  const { bucketId, available, error: balanceError } = await bucketBalanceCents(supabase, { familyId: params.familyId, childWalletId: params.childWalletId, kind: 'spend' });
  if (balanceError) return { ok: false, error: balanceError };
  if (!params.requiresApproval && amount > available) {
    return { ok: false, error: `Only ${(available / 100).toFixed(2)} available in Spend.` };
  }

  const { data, error } = await supabase.from('wallet_transactions').insert({
    family_id: params.familyId, child_wallet_id: params.childWalletId, bucket_id: bucketId,
    type: params.type, status: params.requiresApproval ? 'requires_parent_approval' : 'completed',
    direction: 'debit', amount_cents: amount, description: params.description,
    related_type: params.relatedType ?? null, related_id: params.relatedId ?? null,
    created_by: params.createdBy, approved_by: params.requiresApproval ? null : (params.approvedBy ?? params.createdBy),
    metadata: (params.metadata ?? {}) as Database['public']['Tables']['wallet_transactions']['Insert']['metadata'],
  }).select('id').single();
  if (error) return { ok: false, error: walletFailure(error, 'Could not post that wallet debit.') };

  await supabase.from('wallet_audit_logs').insert({
    family_id: params.familyId, actor_user_id: params.createdBy, action: `debit_${params.type}`,
    entity_type: 'child_wallets', entity_id: params.childWalletId,
    detail: `${params.description} (${amount}c)${params.requiresApproval ? ' — pending approval' : ''}`,
  });
  return { ok: true, txnId: data.id };
}
