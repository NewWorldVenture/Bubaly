'use server';
// The write path for reward redemptions.
//
// Both of these were direct browser writes, and each chose `status`,
// `decided_by` and `cost_points` client-side — `redeem()` in chores-module,
// `requestReward()` and `decide()` in rewards-module. The client decided
// whether it was a manager and wrote 'approved' if it thought so, so anyone
// who could edit the request could grant themselves a reward.
//
// Migration 0295 is the durable fix, because the table is reachable from
// PostgREST whatever this file does. It is written, probed against PG16, and
// unapplied — see F5. These actions close the half that ships without it: the
// deployed app no longer takes the client's word for any of the three fields,
// so the forgery needs a hand-crafted API call rather than the browser console.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { describeActionError } from '@/lib/supabase/errors';

const PATHS = ['/dashboard/rewards', '/dashboard/chores'];

export type RedemptionResult = { ok: true; id: string } | { ok: false; error: string };

/** The three a parent decides — the same set migration 0295 guards. */
export type RedemptionDecision = 'approved' | 'rejected' | 'fulfilled';

function revalidate() {
  for (const path of PATHS) revalidatePath(path);
}

/**
 * Ask for a reward, or — if you manage the family and are redeeming for
 * yourself — take it.
 *
 * `reward_title` and `cost_points` are read from the reward here rather than
 * accepted from the caller. They are a deliberate snapshot (0028: history has
 * to survive the reward being edited or deleted), and a snapshot the spender
 * supplies is not a snapshot. A child sending `cost_points: 0` was the quieter
 * half of this finding.
 */
export async function requestRedemptionAction(input: {
  rewardId: string;
  forMemberId: string;
}): Promise<RedemptionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();

  if (!input?.rewardId || !input?.forMemberId) {
    return { ok: false, error: t('actions.thatRewardIsNotAvailable') };
  }
  // Points are spent from forMemberId's balance, so only a manager may request
  // on someone else's behalf (the module already offers nothing else; 0347
  // holds the database to the same).
  if (!isManager(ctx.active.role) && input.forMemberId !== ctx.active.member.id) {
    return { ok: false, error: t('actions.thatRewardIsNotAvailable') };
  }

  try {
    const supabase = await createServer();
    const { data: reward, error: rewardError } = await supabase
      .from('rewards')
      .select('id, title, cost_points')
      .eq('id', input.rewardId)
      .eq('family_id', ctx.active.familyId)
      .maybeSingle();
    if (rewardError) return { ok: false, error: describeActionError(rewardError, t('actions.thatRewardIsNotAvailable')) };
    if (!reward) return { ok: false, error: t('actions.thatRewardIsNotAvailable') };

    // A manager redeeming for THEMSELVES takes it; everything else queues. The
    // role is resolved here, from the session, and no longer asserted by the
    // caller.
    const instant = isManager(ctx.active.role) && input.forMemberId === ctx.active.member.id;
    const decidedAt = instant ? new Date().toISOString() : null;

    const { data, error } = await supabase
      .from('reward_redemptions')
      .insert({
        family_id: ctx.active.familyId,
        reward_id: reward.id,
        member_id: input.forMemberId,
        reward_title: reward.title,
        cost_points: reward.cost_points,
        status: instant ? 'approved' : 'requested',
        decided_by: instant ? ctx.active.member.id : null,
        decided_at: decidedAt,
      })
      .select('id')
      .single();
    if (error) return { ok: false, error: describeActionError(error, t('actions.thatRewardIsNotAvailable')) };

    revalidate();
    return { ok: true, id: data.id };
  } catch (error) {
    console.error('[rewards] redemption request failed', error);
    return { ok: false, error: describeActionError(error, t('actions.thatRewardIsNotAvailable')) };
  }
}

/** Approve, reject or fulfil a queued redemption. Managers only. */
export async function decideRedemptionAction(input: {
  id: string;
  decision: RedemptionDecision;
}): Promise<RedemptionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();

  if (!isManager(ctx.active.role)) {
    return { ok: false, error: t('actions.onlyAParentGuardianCan16') };
  }
  if (!input?.id || !['approved', 'rejected', 'fulfilled'].includes(input.decision)) {
    return { ok: false, error: t('actions.thatRewardIsNotAvailable') };
  }

  try {
    const supabase = await createServer();
    const { data, error } = await supabase
      .from('reward_redemptions')
      .update({
        status: input.decision,
        decided_by: ctx.active.member.id,
        decided_at: new Date().toISOString(),
      })
      .eq('id', input.id)
      .eq('family_id', ctx.active.familyId)
      .select('id')
      .maybeSingle();
    if (error) return { ok: false, error: describeActionError(error, t('actions.thatRewardIsNotAvailable')) };
    if (!data) return { ok: false, error: t('actions.thatRewardIsNotAvailable') };

    revalidate();
    return { ok: true, id: data.id };
  } catch (error) {
    console.error('[rewards] redemption decision failed', error);
    return { ok: false, error: describeActionError(error, t('actions.thatRewardIsNotAvailable')) };
  }
}
