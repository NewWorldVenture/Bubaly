'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
import { awardPoints } from '@/lib/loyalty/server';
import { REWARD_KINDS } from '@/lib/marketing/loyalty';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}
function num(fd: FormData, k: string): number | null {
  const v = s(fd, k);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(fd: FormData, k: string): boolean {
  return fd.get(k) != null;
}

const PATH = '/admin/marketing/loyalty';

export async function saveLoyaltySettingsAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const row = {
    singleton: true,
    enabled: bool(formData, 'enabled'),
    program_name: s(formData, 'program_name') ?? 'Bubaly Rewards',
    points_label: s(formData, 'points_label') ?? 'points',
    earn_signup: num(formData, 'earn_signup') ?? 0,
    earn_referral: num(formData, 'earn_referral') ?? 0,
    earn_review: num(formData, 'earn_review') ?? 0,
    earn_per_dollar: num(formData, 'earn_per_dollar') ?? 0,
    tier_silver_at: num(formData, 'tier_silver_at') ?? 1000,
    tier_gold_at: num(formData, 'tier_gold_at') ?? 5000,
    updated_by: actorId,
  };
  await supabase.from('loyalty_settings').upsert(row, { onConflict: 'singleton' });
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'loyalty_settings' });
  revalidatePath(PATH);
}

export async function saveRewardAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  const name = s(formData, 'name');
  if (!name) return;
  const kindRaw = s(formData, 'kind') ?? 'credit';
  const kind = (REWARD_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : 'credit';
  const row = {
    name,
    description: s(formData, 'description'),
    cost_points: Math.max(0, num(formData, 'cost_points') ?? 0),
    kind,
    value_cents: num(formData, 'value_cents'),
    image_url: s(formData, 'image_url'),
    stock: num(formData, 'stock'),
    is_active: bool(formData, 'is_active'),
    sort: num(formData, 'sort') ?? 0,
  };
  if (id) {
    await supabase.from('loyalty_rewards').update(row).eq('id', id);
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'loyalty_reward', resourceId: id });
  } else {
    const { data } = await supabase.from('loyalty_rewards').insert({ ...row, created_by: actorId }).select('id').single();
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'loyalty_reward', resourceId: data?.id ?? null });
  }
  revalidatePath(PATH);
}

export async function deleteRewardAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('loyalty_rewards').update({ deleted_at: new Date().toISOString(), is_active: false }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'loyalty_reward', resourceId: id });
  revalidatePath(PATH);
}

export async function awardPointsAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const familyId = s(formData, 'family_id');
  const points = num(formData, 'points');
  if (!familyId || !points || points === 0) return;
  await awardPoints(supabase, familyId, points, {
    kind: 'adjust',
    source: 'manual',
    reason: s(formData, 'reason') ?? 'Manual adjustment',
    actorId,
  });
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'award', resource: 'loyalty_account', resourceId: familyId, metadata: { points } });
  revalidatePath(PATH);
}

export async function fulfillRedemptionAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  if (!id) return;
  await supabase.from('loyalty_redemptions').update({
    status: 'fulfilled',
    code: s(formData, 'code'),
    notes: s(formData, 'notes'),
    fulfilled_at: new Date().toISOString(),
    fulfilled_by: actorId,
  }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'fulfill', resource: 'loyalty_redemption', resourceId: id });
  revalidatePath(PATH);
}

export async function cancelRedemptionAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  // Look up the redemption to refund the points.
  const { data: red } = await supabase.from('loyalty_redemptions').select('family_id, cost_points, status').eq('id', id).maybeSingle();
  if (!red || red.status === 'cancelled') return;
  await supabase.from('loyalty_redemptions').update({ status: 'cancelled' }).eq('id', id);
  if (red.cost_points > 0) {
    await awardPoints(supabase, red.family_id, red.cost_points, {
      kind: 'adjust',
      source: 'redemption_refund',
      reason: 'Redemption cancelled — points refunded',
      actorId,
    });
  }
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'cancel', resource: 'loyalty_redemption', resourceId: id });
  revalidatePath(PATH);
}
