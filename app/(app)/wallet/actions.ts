'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { allocate, normalizeSplit, type Split } from '@/lib/wallet/ledger';

const WALLET_TERMS_VERSION = '2026-06-25';

type Result = { ok: boolean; error?: string };

/** Default bucket set every child wallet is provisioned with. */
const BUCKETS: { kind: 'spend' | 'save' | 'give' | 'invest'; label: string }[] = [
  { kind: 'spend', label: 'Spend' },
  { kind: 'save', label: 'Save' },
  { kind: 'give', label: 'Give' },
  { kind: 'invest', label: 'Invest' },
];

/**
 * Activate the parent-controlled Family Wallet (virtual-ledger MVP). Provisions
 * the family wallet, a child wallet + 4 buckets for every child member, a
 * default allocation rule, and records the parent's disclosure acceptance.
 * Idempotent: safe to call again (skips rows that already exist).
 */
export async function activateFamilyWalletAction(): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can activate the Family Wallet.' };
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;
  const supabase = await createServer();

  // 1) the family wallet (unique per family)
  const { data: wallet, error: wErr } = await supabase
    .from('family_wallets')
    .upsert(
      { family_id: familyId, mode: 'ledger', is_active: true, disclosures_accepted_at: new Date().toISOString(), disclosures_accepted_by: userId, created_by: userId },
      { onConflict: 'family_id' },
    )
    .select('id')
    .single();
  if (wErr) return { ok: false, error: wErr.message };

  // 2) record the disclosure acceptance (immutable audit)
  await supabase.from('compliance_disclosures').insert({
    family_id: familyId, kind: 'wallet_terms', version: WALLET_TERMS_VERSION, accepted_by: userId,
  });

  // 3) a child wallet + buckets + default rule for each child member
  const { data: children } = await supabase
    .from('family_members')
    .select('id, role')
    .eq('family_id', familyId).eq('is_active', true);

  for (const child of (children ?? []).filter((m) => !isManager(m.role))) {
    const { data: cw } = await supabase
      .from('child_wallets')
      .upsert({ family_id: familyId, member_id: child.id, is_active: true, created_by: userId }, { onConflict: 'family_id,member_id' })
      .select('id')
      .single();
    if (!cw) continue;

    await supabase.from('wallet_buckets').upsert(
      BUCKETS.map((b, i) => ({ family_id: familyId, child_wallet_id: cw.id, kind: b.kind, label: b.label, sort_order: i })),
      { onConflict: 'child_wallet_id,kind' },
    );
    await supabase.from('wallet_rules').upsert(
      { family_id: familyId, child_wallet_id: cw.id, created_by: userId },
      { onConflict: 'family_id,child_wallet_id' },
    );
  }

  await supabase.from('wallet_audit_logs').insert({
    family_id: familyId, actor_user_id: userId, action: 'wallet_activated', entity_type: 'family_wallets', entity_id: wallet.id,
    detail: 'Family Wallet activated (virtual-ledger mode)',
  });

  revalidatePath('/wallet');
  return { ok: true };
}

/**
 * Add funds to a child's wallet (parent top-up), allocated across buckets per
 * the child's split rule. Writes one immutable `completed` credit per bucket —
 * the ledger is the source of truth, never edited.
 */
export async function addFundsAction(input: { childWalletId: string; amountCents: number; description?: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can add funds.' };
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;
  const amount = Math.trunc(input.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Enter an amount greater than $0.' };

  const supabase = await createServer();

  // confirm the child wallet belongs to this family + load its split rule + buckets
  const [{ data: cw }, { data: rule }, { data: buckets }] = await Promise.all([
    supabase.from('child_wallets').select('id').eq('id', input.childWalletId).eq('family_id', familyId).maybeSingle(),
    supabase.from('wallet_rules').select('split').eq('family_id', familyId).eq('child_wallet_id', input.childWalletId).maybeSingle(),
    supabase.from('wallet_buckets').select('id, kind').eq('family_id', familyId).eq('child_wallet_id', input.childWalletId),
  ]);
  if (!cw) return { ok: false, error: 'That wallet was not found.' };

  const split = normalizeSplit(rule?.split as Partial<Split> | null);
  const parts = allocate(amount, split);
  const bucketByKind = new Map((buckets ?? []).map((b) => [b.kind, b.id]));

  const rows = (['spend', 'save', 'give', 'invest'] as const)
    .filter((k) => parts[k] > 0)
    .map((k) => ({
      family_id: familyId,
      child_wallet_id: cw.id,
      bucket_id: bucketByKind.get(k) ?? null,
      type: 'parent_top_up' as const,
      status: 'completed' as const,
      direction: 'credit' as const,
      amount_cents: parts[k],
      description: input.description || 'Parent top-up',
      created_by: userId,
      approved_by: userId,
      metadata: { split },
    }));
  if (rows.length === 0) return { ok: false, error: 'Nothing to allocate.' };

  const { error: txErr } = await supabase.from('wallet_transactions').insert(rows);
  if (txErr) return { ok: false, error: txErr.message };

  await supabase.from('wallet_audit_logs').insert({
    family_id: familyId, actor_user_id: userId, action: 'funds_added', entity_type: 'child_wallets', entity_id: cw.id,
    detail: `Added ${amount} cents`, metadata: { split, parts },
  });

  revalidatePath('/wallet');
  return { ok: true };
}
