'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { allocate, normalizeSplit, isValidSplit, type Split } from '@/lib/wallet/ledger';
import { creditChildWallet } from '@/lib/wallet/server';
import { nextRunDate, type Cadence } from '@/lib/wallet/allowance';
import { walletTierForPlanLevel, walletFeatureEnabled } from '@/lib/wallet/tiers';
import { planLevel } from '@/lib/constants/plans';

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

/** Resolve the family's wallet tier from its active subscription plan. */
async function familyWalletTier(supabase: Awaited<ReturnType<typeof createServer>>, familyId: string) {
  const { data: sub } = await supabase
    .from('subscriptions').select('plan, status').eq('family_id', familyId)
    .in('status', ['active', 'trialing']).maybeSingle();
  return walletTierForPlanLevel(planLevel(sub?.plan ?? null));
}

/**
 * Pay a child for an approved chore — credits their wallet from the chore's cash
 * reward, allocated across buckets (immutable ledger). Idempotent per assignment
 * via a marker on the assignment row.
 */
export async function payChoreRewardAction(input: { choreAssignmentId: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can pay chore rewards.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: assignment } = await supabase
    .from('chore_assignments')
    .select('id, member_id, family_id, cash_awarded_cents, chores(title, cash_cents)')
    .eq('id', input.choreAssignmentId).eq('family_id', familyId).maybeSingle();
  if (!assignment) return { ok: false, error: 'Chore not found.' };

  const chore = (assignment as unknown as { chores: { title: string; cash_cents: number | null } | null }).chores;
  const amount = assignment.cash_awarded_cents ?? chore?.cash_cents ?? 0;
  if (amount <= 0) return { ok: false, error: 'This chore has no cash reward.' };

  // Already paid? (one wallet credit per assignment)
  const { data: existing } = await supabase
    .from('wallet_transactions').select('id')
    .eq('family_id', familyId).eq('related_type', 'chore_assignments').eq('related_id', assignment.id).limit(1);
  if ((existing ?? []).length > 0) return { ok: false, error: 'This chore was already paid.' };

  const { data: cw } = await supabase
    .from('child_wallets').select('id').eq('family_id', familyId).eq('member_id', assignment.member_id).maybeSingle();
  if (!cw) return { ok: false, error: 'This child has no wallet. Activate the Family Wallet first.' };

  const res = await creditChildWallet(supabase, {
    familyId, childWalletId: cw.id, amountCents: amount, type: 'chore_reward',
    description: `Chore: ${chore?.title ?? 'completed'}`, createdBy: ctx.user.id,
    relatedType: 'chore_assignments', relatedId: assignment.id,
  });
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath('/wallet');
  return { ok: true };
}

/** Create or update an allowance rule (Basic+ feature). */
export async function saveAllowanceRuleAction(input: {
  id?: string; childWalletId: string; amountCents: number; cadence: Cadence;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can set allowances.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const tier = await familyWalletTier(supabase, familyId);
  if (!walletFeatureEnabled(tier, 'allowances')) {
    return { ok: false, error: 'Automated allowances are a Basic plan feature. Upgrade to enable them.' };
  }
  const amount = Math.trunc(input.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Enter an allowance greater than $0.' };

  const next = nextRunDate(new Date().toISOString().slice(0, 10), input.cadence);
  const { error } = input.id
    ? await supabase.from('allowance_rules')
        .update({ amount_cents: amount, cadence: input.cadence, is_active: true, next_run_on: next })
        .eq('id', input.id).eq('family_id', familyId)
    : await supabase.from('allowance_rules')
        .insert({ family_id: familyId, child_wallet_id: input.childWalletId, amount_cents: amount, cadence: input.cadence, is_active: true, next_run_on: next, created_by: ctx.user.id });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/wallet');
  return { ok: true };
}

/** Toggle an allowance rule on/off (pause/resume). */
export async function toggleAllowanceRuleAction(input: { id: string; isActive: boolean }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can change allowances.' };
  const supabase = await createServer();
  const { error } = await supabase.from('allowance_rules')
    .update({ is_active: input.isActive }).eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/wallet/allowance');
  return { ok: true };
}

/** Create a savings goal (child-specific when childWalletId is given, else family-wide). */
export async function createGoalAction(input: {
  title: string; kind?: string; targetCents: number; childWalletId?: string | null; targetDate?: string | null;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can create goals.' };
  const title = input.title.trim();
  const target = Math.trunc(input.targetCents);
  if (!title) return { ok: false, error: 'Give the goal a name.' };
  if (!Number.isFinite(target) || target <= 0) return { ok: false, error: 'Set a target greater than $0.' };

  const supabase = await createServer();
  const { error } = await supabase.from('wallet_goals').insert({
    family_id: ctx.active.familyId, child_wallet_id: input.childWalletId ?? null,
    title, kind: input.kind ?? 'custom', target_cents: target, target_date: input.targetDate ?? null, created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/wallet/goals');
  return { ok: true };
}

/**
 * Move money into a goal from a child's Save bucket. Writes an immutable
 * goal_transfer debit against the save bucket and increments the goal's saved
 * total (marking it reached when the target is met). Refuses to overdraw.
 */
export async function fundGoalAction(input: { goalId: string; amountCents: number }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can fund goals.' };
  const familyId = ctx.active.familyId;
  const amount = Math.trunc(input.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Enter an amount greater than $0.' };
  const supabase = await createServer();

  const { data: goal } = await supabase
    .from('wallet_goals').select('id, child_wallet_id, title, target_cents, saved_cents, status')
    .eq('id', input.goalId).eq('family_id', familyId).maybeSingle();
  if (!goal) return { ok: false, error: 'Goal not found.' };
  if (!goal.child_wallet_id) return { ok: false, error: 'Family goals are funded by contributions, not a single wallet.' };

  // available Save-bucket balance for this child (derived from the ledger)
  const { data: saveBucket } = await supabase
    .from('wallet_buckets').select('id').eq('family_id', familyId).eq('child_wallet_id', goal.child_wallet_id).eq('kind', 'save').maybeSingle();
  const { data: saveTxns } = await supabase
    .from('wallet_transactions').select('direction, amount_cents, status')
    .eq('family_id', familyId).eq('bucket_id', saveBucket?.id ?? '00000000-0000-0000-0000-000000000000');
  const available = (saveTxns ?? []).reduce((s, t) => s + (t.status === 'completed' ? (t.direction === 'credit' ? t.amount_cents : -t.amount_cents) : 0), 0);
  if (amount > available) return { ok: false, error: `Only ${(available / 100).toFixed(2)} available in Save.` };

  const { error: txErr } = await supabase.from('wallet_transactions').insert({
    family_id: familyId, child_wallet_id: goal.child_wallet_id, bucket_id: saveBucket?.id ?? null,
    type: 'goal_transfer', status: 'completed', direction: 'debit', amount_cents: amount,
    description: `Into goal: ${goal.title}`, related_type: 'wallet_goals', related_id: goal.id, created_by: ctx.user.id, approved_by: ctx.user.id,
  });
  if (txErr) return { ok: false, error: txErr.message };

  const newSaved = goal.saved_cents + amount;
  await supabase.from('wallet_goals').update({
    saved_cents: newSaved, status: newSaved >= goal.target_cents ? 'reached' : goal.status,
  }).eq('id', goal.id);
  await supabase.from('wallet_audit_logs').insert({
    family_id: familyId, actor_user_id: ctx.user.id, action: 'goal_funded', entity_type: 'wallet_goals', entity_id: goal.id,
    detail: `Funded ${amount}c into ${goal.title}`,
  });

  revalidatePath('/wallet/goals');
  return { ok: true };
}

/** Create a public gift link for a child (relatives gift via the token). */
export async function createGiftLinkAction(input: {
  childWalletId: string; occasion?: string | null; message?: string | null; suggestedCents?: number[];
}): Promise<Result & { token?: string }> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can create gift links.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: cw } = await supabase.from('child_wallets').select('id').eq('id', input.childWalletId).eq('family_id', familyId).maybeSingle();
  if (!cw) return { ok: false, error: 'That wallet was not found.' };

  const token = `gift_${crypto.randomUUID().replace(/-/g, '')}`;
  const { error } = await supabase.from('gift_links').insert({
    family_id: familyId, child_wallet_id: input.childWalletId, token,
    occasion: input.occasion ?? null, message: input.message ?? null,
    suggested_cents: input.suggestedCents && input.suggestedCents.length > 0 ? input.suggestedCents : undefined,
    created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/wallet/gift');
  return { ok: true, token };
}

/** Approve a pending gift → credit the child's wallet (allocated by split). */
export async function approveGiftAction(input: { giftPaymentId: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can approve gifts.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: gift } = await supabase
    .from('gift_payments').select('id, child_wallet_id, amount_cents, status, giver_name, applied_txn_id')
    .eq('id', input.giftPaymentId).eq('family_id', familyId).maybeSingle();
  if (!gift) return { ok: false, error: 'Gift not found.' };
  if (gift.status === 'completed' || gift.applied_txn_id) return { ok: false, error: 'This gift was already applied.' };
  if (!gift.child_wallet_id) return { ok: false, error: 'This gift has no child wallet.' };

  const res = await creditChildWallet(supabase, {
    familyId, childWalletId: gift.child_wallet_id, amountCents: gift.amount_cents, type: 'gift_received',
    description: gift.giver_name ? `Gift from ${gift.giver_name}` : 'Gift received', createdBy: ctx.user.id,
    relatedType: 'gift_payments', relatedId: gift.id,
  });
  if (!res.ok) return { ok: false, error: res.error };

  await supabase.from('gift_payments').update({ status: 'completed' }).eq('id', gift.id);
  revalidatePath('/wallet/gift');
  return { ok: true };
}

/** Decline a pending gift (does not credit the wallet). */
export async function dismissGiftAction(input: { giftPaymentId: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can manage gifts.' };
  const supabase = await createServer();
  const { error } = await supabase.from('gift_payments')
    .update({ status: 'cancelled' }).eq('id', input.giftPaymentId).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/wallet/gift');
  return { ok: true };
}

/**
 * Set how a child's incoming money is auto-split across Spend/Save/Give/Invest.
 * Persists the percentages on `wallet_rules.split` (must total 100). New credits
 * via `creditChildWallet` immediately allocate by this rule — no back-fill of the
 * immutable ledger. Parent/guardian only.
 */
export async function saveWalletSplitAction(input: { childWalletId: string; split: Split }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can change allocation.' };
  if (!isValidSplit(input.split)) return { ok: false, error: 'Percentages must be whole numbers that total 100%.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  // Confirm the child wallet belongs to this family.
  const { data: cw } = await supabase
    .from('child_wallets').select('id').eq('id', input.childWalletId).eq('family_id', familyId).maybeSingle();
  if (!cw) return { ok: false, error: 'That wallet was not found.' };

  const { error } = await supabase.from('wallet_rules').upsert(
    { family_id: familyId, child_wallet_id: input.childWalletId, split: input.split as unknown as Record<string, number> },
    { onConflict: 'family_id,child_wallet_id' },
  );
  if (error) return { ok: false, error: error.message };

  await supabase.from('wallet_audit_logs').insert({
    family_id: familyId, actor_user_id: ctx.user.id, action: 'split_updated',
    entity_type: 'wallet_rules', entity_id: input.childWalletId, detail: 'Updated allocation split', metadata: { split: input.split },
  });

  revalidatePath('/wallet/settings');
  revalidatePath('/wallet');
  return { ok: true };
}
