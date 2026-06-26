'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { allocate, normalizeSplit, type Split } from '@/lib/wallet/ledger';
import { creditChildWallet, debitSpendBucket, bucketBalanceCents } from '@/lib/wallet/server';
import { nextRunDate, type Cadence } from '@/lib/wallet/allowance';
import { walletTierForPlanLevel, walletFeatureEnabled } from '@/lib/wallet/tiers';
import { planLevel } from '@/lib/constants/plans';
import { normalizeHandle, handleError } from '@/lib/wallet/pay-handle';
import { evaluateTrust, roleOf } from '@/lib/trust/server';

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

// ─── Babysitters ────────────────────────────────────────────────────────────

/** Create or update a babysitter profile (parent-only). */
export async function saveBabysitterAction(input: {
  id?: string; name: string; phone?: string; email?: string; rateCents?: number; notes?: string;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can manage babysitters.' };
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Enter a name.' };
  if (name.length > 120) return { ok: false, error: 'Name is too long.' };
  if (input.rateCents != null && (!Number.isFinite(input.rateCents) || input.rateCents < 0)) {
    return { ok: false, error: 'Rate must be a positive amount.' };
  }
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  if (input.id) {
    const { error } = await supabase.from('babysitter_profiles').update({
      name, phone: input.phone?.trim() || null, email: input.email?.trim() || null,
      rate_cents: input.rateCents ?? null, notes: input.notes?.trim() || null,
    }).eq('id', input.id).eq('family_id', familyId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase.from('babysitter_profiles').insert({
      family_id: familyId, name, phone: input.phone?.trim() || null, email: input.email?.trim() || null,
      rate_cents: input.rateCents ?? null, notes: input.notes?.trim() || null, created_by: ctx.user.id,
    });
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath('/wallet/babysitters');
  return { ok: true };
}

/** Archive (soft-delete) a babysitter profile. */
export async function archiveBabysitterAction(input: { id: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can manage babysitters.' };
  const supabase = await createServer();
  const { error } = await supabase.from('babysitter_profiles')
    .update({ is_active: false }).eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/wallet/babysitters');
  return { ok: true };
}

/** Record a babysitter payment (tracking + receipt). Hours × rate + tip = amount.
 *  Marked completed immediately in ledger mode (no real payout rail yet). */
export async function recordBabysitterPaymentAction(input: {
  babysitterId: string; hours?: number; rateCents?: number; tipCents?: number; amountCents: number; eventId?: string;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can record payments.' };
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) return { ok: false, error: 'Enter a payment amount.' };
  const supabase = await createServer();
  const { error } = await supabase.from('babysitter_payments').insert({
    family_id: ctx.active.familyId,
    babysitter_id: input.babysitterId,
    event_id: input.eventId ?? null,
    hours: input.hours ?? null,
    rate_cents: input.rateCents ?? null,
    tip_cents: input.tipCents ?? 0,
    amount_cents: input.amountCents,
    status: 'completed',
    created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };

  await supabase.from('wallet_audit_logs').insert({
    family_id: ctx.active.familyId, actor_user_id: ctx.user.id, action: 'babysitter_paid',
    entity_type: 'babysitter_payments', detail: `Recorded babysitter payment of $${(input.amountCents / 100).toFixed(2)}`,
  });
  revalidatePath('/wallet/babysitters');
  return { ok: true };
}

// ─── Wallet Settings (split rules per child) ─────────────────────────────────

/** Update a child's allocation rule: bucket split (must sum to 100), gift
 *  auto-accept, and the approval threshold. Family-default when childWalletId is null. */
export async function saveWalletRuleAction(input: {
  childWalletId: string;
  split: { spend: number; save: number; give: number; invest: number };
  autoAcceptGifts: boolean;
  requireApprovalOverCents: number;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can change wallet settings.' };
  const familyId = ctx.active.familyId;

  const sum = input.split.spend + input.split.save + input.split.give + input.split.invest;
  if (sum !== 100) return { ok: false, error: 'Split percentages must add up to 100%.' };
  if (Object.values(input.split).some((v) => v < 0 || v > 100)) return { ok: false, error: 'Each bucket must be 0–100%.' };
  if (!Number.isFinite(input.requireApprovalOverCents) || input.requireApprovalOverCents < 0) {
    return { ok: false, error: 'Approval threshold must be a positive amount.' };
  }

  const supabase = await createServer();
  // Verify the child wallet belongs to this family before writing.
  const { data: cw } = await supabase.from('child_wallets')
    .select('id').eq('id', input.childWalletId).eq('family_id', familyId).maybeSingle();
  if (!cw) return { ok: false, error: 'Child wallet not found.' };

  const { error } = await supabase.from('wallet_rules').upsert({
    family_id: familyId,
    child_wallet_id: input.childWalletId,
    split: normalizeSplit(input.split) as unknown as Split,
    auto_accept_gifts: input.autoAcceptGifts,
    require_approval_over_cents: input.requireApprovalOverCents,
    created_by: ctx.user.id,
  }, { onConflict: 'family_id,child_wallet_id' });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/wallet/settings');
  return { ok: true };
}

// ─── Pay-ID handles ──────────────────────────────────────────────────────────

/** Claim (or rename) a memorable Pay-ID handle for a child or the whole family. */
export async function claimPayHandleAction(input: { id?: string; childWalletId: string | null; handle: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can set a Pay-ID.' };
  const familyId = ctx.active.familyId;

  const err = handleError(input.handle);
  if (err) return { ok: false, error: err };
  const handle = normalizeHandle(input.handle);

  const supabase = await createServer();

  // If targeting a child, make sure the wallet belongs to this family.
  if (input.childWalletId) {
    const { data: cw } = await supabase
      .from('child_wallets').select('id').eq('family_id', familyId).eq('id', input.childWalletId).maybeSingle();
    if (!cw) return { ok: false, error: 'Child wallet not found.' };
  }

  // Globally unique: surface a friendly message if someone else holds it.
  const { data: taken } = await supabase
    .from('pay_handles').select('id, family_id').eq('handle', handle).maybeSingle();
  if (taken && taken.family_id !== familyId) return { ok: false, error: 'That Pay-ID is already taken — try another.' };
  if (taken && input.id && taken.id !== input.id) return { ok: false, error: 'That Pay-ID is already taken — try another.' };

  const row = {
    family_id: familyId, child_wallet_id: input.childWalletId, handle, is_active: true, created_by: ctx.user.id,
  };
  const { error } = input.id
    ? await supabase.from('pay_handles').update({ handle, child_wallet_id: input.childWalletId, is_active: true }).eq('id', input.id).eq('family_id', familyId)
    : await supabase.from('pay_handles').insert(row);
  if (error) {
    // Unique-violation fallback (race with the check above).
    if (error.code === '23505') return { ok: false, error: 'That Pay-ID is already taken — try another.' };
    return { ok: false, error: error.message };
  }

  await supabase.from('wallet_audit_logs').insert({
    family_id: familyId, actor_user_id: ctx.user.id, action: 'pay_handle_claimed',
    entity_type: 'pay_handles', detail: handle, metadata: { handle, childWalletId: input.childWalletId },
  });
  revalidatePath('/wallet/gift');
  return { ok: true };
}

/** Release a Pay-ID handle (frees it for anyone to claim). */
export async function releasePayHandleAction(input: { id: string }): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can do this.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const { error } = await supabase.from('pay_handles').delete().eq('id', input.id).eq('family_id', familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/wallet/gift');
  return { ok: true };
}

// ─── Spend requests + approvals (the "Pending Approvals" flow) ────────────────

/**
 * Request to spend from a child's Spend bucket. Money movement is governed by
 * the Trust Engine and the wallet's per-child approval threshold:
 *   • Under threshold AND requester is a parent → posts a completed debit.
 *   • Otherwise → posts a held (requires_parent_approval) debit + a
 *     parent_approvals row that shows up in the family's Pending Approvals.
 * Never overdraws: the requested amount must fit the current Spend balance.
 */
export async function requestSpendAction(input: {
  childWalletId: string; amountCents: number; description: string;
}): Promise<Result & { pendingApproval?: boolean }> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const amount = Math.trunc(input.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Enter an amount greater than $0.' };
  const description = input.description.trim() || 'Purchase';
  const supabase = await createServer();

  // The child wallet must belong to this family; load its approval threshold.
  const [{ data: cw }, { data: rule }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id').eq('id', input.childWalletId).eq('family_id', familyId).maybeSingle(),
    supabase.from('wallet_rules').select('require_approval_over_cents').eq('family_id', familyId).eq('child_wallet_id', input.childWalletId).maybeSingle(),
  ]);
  if (!cw) return { ok: false, error: 'That wallet was not found.' };

  // Can't request more than is available in Spend.
  const { available } = await bucketBalanceCents(supabase, { familyId, childWalletId: cw.id, kind: 'spend' });
  if (amount > available) return { ok: false, error: `Only ${(available / 100).toFixed(2)} available in Spend.` };

  const threshold = rule?.require_approval_over_cents ?? 5000;
  const manager = isManager(ctx.active.role);

  // Trust Engine governs the money movement (domain finances / capability automate).
  const { decision } = await evaluateTrust(supabase, familyId, {
    actor: { kind: 'member', id: ctx.active.member.id, role: roleOf(ctx.active.role) },
    domain: 'finances', capability: 'automate',
    title: `Spend ${(amount / 100).toFixed(2)} — ${description}`,
    context: { amountCents: amount },
    openApproval: false, // the wallet owns its own approval row below
  });
  // Only an EXPLICIT denial (a deny grant or a household policy) hard-blocks a
  // request. A role-default "no" just means the child needs a parent's OK — they
  // can always *ask*, which is the whole point of a spend request.
  const explicitlyDenied = decision.effect === 'deny' && (decision.basis === 'deny_grant' || decision.basis === 'policy');
  if (explicitlyDenied) return { ok: false, error: `Blocked by household policy: ${decision.reason}` };

  // A parent under threshold (and not forced to review by a policy) spends directly.
  const needsApproval = !manager || amount > threshold || decision.effect !== 'allow';

  const debit = await debitSpendBucket(supabase, {
    familyId, childWalletId: cw.id, amountCents: amount, type: 'card_spend',
    description, createdBy: ctx.user.id, requiresApproval: needsApproval,
    relatedType: 'spend_request', metadata: { requested_by_member: ctx.active.member.id },
  });
  if (!debit.ok) return { ok: false, error: debit.error };

  if (needsApproval) {
    await supabase.from('parent_approvals').insert({
      family_id: familyId, kind: 'card_spend', ref_type: 'wallet_transactions', ref_id: debit.txnId ?? null,
      amount_cents: amount, status: 'pending', requested_by: ctx.user.id, note: description,
    });
    revalidatePath('/wallet');
    return { ok: true, pendingApproval: true };
  }

  revalidatePath('/wallet');
  return { ok: true };
}

/**
 * Approve or reject a pending spend request. On approve the held debit posts
 * (re-checking the balance so it can never overdraw); on reject it's cancelled.
 */
export async function decideSpendRequestAction(input: {
  approvalId: string; decision: 'approved' | 'rejected'; note?: string;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can decide spend requests.' };
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const { data: appr } = await supabase.from('parent_approvals')
    .select('id, status, ref_type, ref_id, amount_cents').eq('id', input.approvalId).eq('family_id', familyId).maybeSingle();
  if (!appr) return { ok: false, error: 'Request not found.' };
  if (appr.status !== 'pending') return { ok: false, error: 'This request was already decided.' };
  if (appr.ref_type !== 'wallet_transactions' || !appr.ref_id) return { ok: false, error: 'Request is missing its transaction.' };

  const { data: txn } = await supabase.from('wallet_transactions')
    .select('id, child_wallet_id, amount_cents, status').eq('id', appr.ref_id).eq('family_id', familyId).maybeSingle();
  if (!txn) return { ok: false, error: 'Transaction not found.' };

  if (input.decision === 'approved') {
    // Re-validate against the live Spend balance so a stale request can't overdraw.
    if (txn.child_wallet_id) {
      const { available } = await bucketBalanceCents(supabase, { familyId, childWalletId: txn.child_wallet_id, kind: 'spend' });
      if (txn.amount_cents > available) return { ok: false, error: `Not enough left in Spend (${(available / 100).toFixed(2)}).` };
    }
    const { error: e } = await supabase.from('wallet_transactions')
      .update({ status: 'completed', approved_by: ctx.user.id }).eq('id', txn.id);
    if (e) return { ok: false, error: e.message };
  } else {
    const { error: e } = await supabase.from('wallet_transactions')
      .update({ status: 'cancelled' }).eq('id', txn.id);
    if (e) return { ok: false, error: e.message };
  }

  await supabase.from('parent_approvals').update({
    status: input.decision, decided_by: ctx.user.id, decided_at: new Date().toISOString(),
    note: input.note?.trim() || null,
  }).eq('id', appr.id);

  await supabase.from('wallet_audit_logs').insert({
    family_id: familyId, actor_user_id: ctx.user.id, action: `spend_${input.decision}`,
    entity_type: 'wallet_transactions', entity_id: txn.id,
    detail: `Spend request ${input.decision}`,
  });

  revalidatePath('/wallet');
  return { ok: true };
}

/**
 * Send money between child wallets (parent-initiated). Money-conserving: debits
 * the sender's Spend bucket and credits the recipient (allocated by their split).
 * Goes through the Trust Engine and never overdraws the sender.
 */
export async function sendMoneyAction(input: {
  fromChildWalletId: string; toChildWalletId: string; amountCents: number; note?: string;
}): Promise<Result> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: 'Only a parent/guardian can move money between wallets.' };
  const familyId = ctx.active.familyId;
  const amount = Math.trunc(input.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Enter an amount greater than $0.' };
  if (input.fromChildWalletId === input.toChildWalletId) return { ok: false, error: 'Pick two different wallets.' };
  const supabase = await createServer();

  const { data: wallets } = await supabase.from('child_wallets')
    .select('id, member_id').eq('family_id', familyId).in('id', [input.fromChildWalletId, input.toChildWalletId]);
  if ((wallets ?? []).length !== 2) return { ok: false, error: 'One of those wallets was not found.' };

  const { decision } = await evaluateTrust(supabase, familyId, {
    actor: { kind: 'member', id: ctx.active.member.id, role: roleOf(ctx.active.role) },
    domain: 'finances', capability: 'automate',
    title: `Transfer ${(amount / 100).toFixed(2)} between wallets`,
    context: { amountCents: amount }, openApproval: false,
  });
  if (decision.effect === 'deny') return { ok: false, error: `Blocked by household policy: ${decision.reason}` };

  const note = input.note?.trim() || 'Transfer';
  // Debit the sender's Spend bucket (validates available balance).
  const debit = await debitSpendBucket(supabase, {
    familyId, childWalletId: input.fromChildWalletId, amountCents: amount, type: 'transfer',
    description: `Sent: ${note}`, createdBy: ctx.user.id,
    relatedType: 'child_wallets', relatedId: input.toChildWalletId,
  });
  if (!debit.ok) return { ok: false, error: debit.error };

  // Credit the recipient (allocated across their buckets).
  const credit = await creditChildWallet(supabase, {
    familyId, childWalletId: input.toChildWalletId, amountCents: amount, type: 'transfer',
    description: `Received: ${note}`, createdBy: ctx.user.id,
    relatedType: 'child_wallets', relatedId: input.fromChildWalletId,
  });
  if (!credit.ok) {
    // Roll back the debit with a reversal so money is conserved on failure.
    if (debit.txnId) {
      await supabase.from('wallet_transactions').insert({
        family_id: familyId, child_wallet_id: input.fromChildWalletId, type: 'reversal',
        status: 'completed', direction: 'credit', amount_cents: amount,
        description: 'Reversed failed transfer', reverses_id: debit.txnId, created_by: ctx.user.id, approved_by: ctx.user.id,
      });
    }
    return { ok: false, error: credit.error };
  }

  revalidatePath('/wallet');
  return { ok: true };
}
