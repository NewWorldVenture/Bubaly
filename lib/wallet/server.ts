// lib/wallet/server.ts — server-side wallet money movement. The ONE place that
// writes credits into the immutable ledger: allocates an amount across a child's
// buckets per their split rule and inserts one `completed` credit per bucket.
// Reused by parent top-ups, allowance runs, and chore rewards so every credit
// path is identical and auditable.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, WalletTxnType } from '@/lib/database.types';
import { allocate, normalizeSplit, type Split } from '@/lib/wallet/ledger';

type DB = SupabaseClient<Database>;

export type CreditResult = { ok: boolean; error?: string; credited: number };

/**
 * Spendable balance for a child = the live balance of their SPEND bucket, derived
 * from the immutable ledger (credits − debits). This is what a card authorization
 * is checked against in real time. Returns 0 when the bucket/wallet is unknown.
 */
export async function childSpendableCents(supabase: DB, familyId: string, childWalletId: string): Promise<number> {
  const { data: bucket } = await supabase
    .from('wallet_buckets').select('id')
    .eq('family_id', familyId).eq('child_wallet_id', childWalletId).eq('kind', 'spend').maybeSingle();
  if (!bucket) return 0;

  const { data: txns } = await supabase
    .from('wallet_transactions')
    .select('direction, amount_cents, status')
    .eq('family_id', familyId).eq('bucket_id', bucket.id)
    .in('status', ['completed', 'processing']);

  return (txns ?? []).reduce((sum, t) => {
    if (t.status !== 'completed' && t.status !== 'processing') return sum;
    return sum + (t.direction === 'credit' ? t.amount_cents : -t.amount_cents);
  }, 0);
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
  const { data: dupe } = await supabase
    .from('wallet_transactions').select('id').eq('stripe_ref', params.stripeRef).eq('type', 'card_spend').maybeSingle();
  if (dupe) return { ok: true, txnId: dupe.id };

  const { data: bucket } = await supabase
    .from('wallet_buckets').select('id')
    .eq('family_id', params.familyId).eq('child_wallet_id', params.childWalletId).eq('kind', 'spend').maybeSingle();

  const { data: row, error } = await supabase
    .from('wallet_transactions')
    .insert({
      family_id: params.familyId, child_wallet_id: params.childWalletId, bucket_id: bucket?.id ?? null,
      type: 'card_spend', status: 'completed', direction: 'debit', amount_cents: amount,
      description: params.description, stripe_ref: params.stripeRef, metadata: { source: 'issuing' },
    })
    .select('id')
    .single();
  if (error) return { ok: false, error: error.message };

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

  const [{ data: rule }, { data: buckets }] = await Promise.all([
    supabase.from('wallet_rules').select('split').eq('family_id', params.familyId).eq('child_wallet_id', params.childWalletId).maybeSingle(),
    supabase.from('wallet_buckets').select('id, kind').eq('family_id', params.familyId).eq('child_wallet_id', params.childWalletId),
  ]);

  const split = normalizeSplit(params.splitOverride ?? (rule?.split as Partial<Split> | null));
  const parts = allocate(amount, split);
  const bucketByKind = new Map((buckets ?? []).map((b) => [b.kind, b.id]));

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
  if (error) return { ok: false, error: error.message, credited: 0 };

  await supabase.from('wallet_audit_logs').insert({
    family_id: params.familyId, actor_user_id: params.createdBy, action: `credit_${params.type}`,
    entity_type: 'child_wallets', entity_id: params.childWalletId,
    detail: `${params.description} (${amount}c)`, metadata: { split, parts, type: params.type },
  });

  return { ok: true, credited: amount };
}
