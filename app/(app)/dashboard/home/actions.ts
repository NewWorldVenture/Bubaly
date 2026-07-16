'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import { DEFAULT_CADENCES } from '@/lib/home/maintenance';

async function ctx() {
  const c = await requireUserContext();
  return { familyId: c.active.familyId, userId: c.user.id, supabase: await createServer() };
}

function str(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}
function num(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Warranties ──────────────────────────────────────────────────────────────
export async function saveWarrantyAction(fd: FormData) {
  const { familyId, userId, supabase } = await ctx();
  const id = str(fd, 'id');
  const row = {
    name: str(fd, 'name') ?? 'Warranty',
    provider: str(fd, 'provider'),
    warranty_type: str(fd, 'warranty_type') ?? 'manufacturer',
    asset_id: str(fd, 'asset_id'),
    policy_number: str(fd, 'policy_number'),
    coverage: str(fd, 'coverage'),
    starts_on: str(fd, 'starts_on'),
    expires_on: str(fd, 'expires_on'),
    cost: num(fd, 'cost'),
    premium_period: str(fd, 'premium_period'),
    claim_phone: str(fd, 'claim_phone'),
    claim_url: str(fd, 'claim_url'),
    claim_email: str(fd, 'claim_email'),
    status: str(fd, 'status') ?? 'active',
    notes: str(fd, 'notes'),
    updated_by: userId,
  };
  const { error } = id
    ? await supabase.from('home_warranties').update(row).eq('id', id).eq('family_id', familyId)
    : await supabase.from('home_warranties').insert({ ...row, family_id: familyId, created_by: userId });
  if (error) throw new Error(describeActionError(error, 'Could not save that warranty.'));
  revalidatePath('/dashboard/home/warranties');
  revalidatePath('/dashboard/home');
}

export async function deleteWarrantyAction(id: string) {
  const { familyId, userId, supabase } = await ctx();
  const { error } = await supabase.from('home_warranties').update({ deleted_at: new Date().toISOString(), updated_by: userId }).eq('id', id).eq('family_id', familyId);
  if (error) throw new Error(describeActionError(error, 'Could not delete that warranty.'));
  revalidatePath('/dashboard/home/warranties');
}

// ── Contractors ─────────────────────────────────────────────────────────────
export async function saveContractorAction(fd: FormData) {
  const { familyId, userId, supabase } = await ctx();
  const id = str(fd, 'id');
  const row = {
    name: str(fd, 'name') ?? 'Contractor',
    trade: str(fd, 'trade'),
    company: str(fd, 'company'),
    phone: str(fd, 'phone'),
    email: str(fd, 'email'),
    website: str(fd, 'website'),
    rating: num(fd, 'rating'),
    is_preferred: fd.get('is_preferred') === 'on',
    notes: str(fd, 'notes'),
    updated_by: userId,
  };
  const { error } = id
    ? await supabase.from('home_contractors').update(row).eq('id', id).eq('family_id', familyId)
    : await supabase.from('home_contractors').insert({ ...row, family_id: familyId, created_by: userId });
  if (error) throw new Error(describeActionError(error, 'Could not save that contractor.'));
  revalidatePath('/dashboard/home/pros');
}

export async function deleteContractorAction(id: string) {
  const { familyId, userId, supabase } = await ctx();
  const { error } = await supabase.from('home_contractors').update({ deleted_at: new Date().toISOString(), updated_by: userId }).eq('id', id).eq('family_id', familyId);
  if (error) throw new Error(describeActionError(error, 'Could not delete that contractor.'));
  revalidatePath('/dashboard/home/pros');
}

// ── Service records ─────────────────────────────────────────────────────────
export async function saveServiceRecordAction(fd: FormData) {
  const { familyId, userId, supabase } = await ctx();
  const assetId = str(fd, 'asset_id');
  const serviceDate = str(fd, 'service_date');
  const { error } = await supabase.from('home_service_records').insert({
    family_id: familyId,
    asset_id: assetId,
    title: str(fd, 'title') ?? 'Service',
    service_date: serviceDate ?? new Date().toISOString().slice(0, 10),
    provider: str(fd, 'provider'),
    cost: num(fd, 'cost'),
    description: str(fd, 'description'),
    next_due_on: str(fd, 'next_due_on'),
    created_by: userId,
  });
  if (error) throw new Error(describeActionError(error, 'Could not save that service record.'));
  // Keep the asset's last-serviced date fresh for life/forecast math. Best-effort
  // (the record itself is already saved), but log a failure so a broken update is
  // observable instead of silently drifting the forecast math.
  if (assetId && serviceDate) {
    const { error: assetError } = await supabase.from('home_assets').update({ last_serviced_on: serviceDate }).eq('id', assetId).eq('family_id', familyId);
    if (assetError) console.error('[home] home_assets last_serviced_on update failed', { familyId, assetId, error: assetError });
  }
  revalidatePath('/dashboard/home/service');
  revalidatePath('/dashboard/home');
}

export async function deleteServiceRecordAction(id: string) {
  const { familyId, userId, supabase } = await ctx();
  const { error } = await supabase.from('home_service_records').update({ deleted_at: new Date().toISOString(), updated_by: userId }).eq('id', id).eq('family_id', familyId);
  if (error) throw new Error(describeActionError(error, 'Could not delete that service record.'));
  revalidatePath('/dashboard/home/service');
}

// ── Deterministic forecast → schedule recommended maintenance for an asset ────
export async function scheduleRecommendedTasksAction(assetId: string): Promise<{ ok: boolean; created: number; error?: string }> {
  const { familyId, userId, supabase } = await ctx();
  const { data: asset } = await supabase
    .from('home_assets')
    .select('id, name, category, last_serviced_on')
    .eq('id', assetId)
    .eq('family_id', familyId)
    .maybeSingle();
  if (!asset) return { ok: false, created: 0, error: 'Asset not found.' };

  const cadences = DEFAULT_CADENCES[asset.category ?? ''] ?? [];
  if (cadences.length === 0) return { ok: false, created: 0, error: 'No recommended schedule for this asset type yet.' };

  // Avoid duplicating tasks we already created for this asset.
  const { data: existing } = await supabase
    .from('maintenance_tasks')
    .select('title')
    .eq('family_id', familyId)
    .eq('asset_id', assetId);
  const have = new Set((existing ?? []).map((t) => t.title.toLowerCase()));

  const base = asset.last_serviced_on ? new Date(asset.last_serviced_on) : new Date();
  const rows = cadences
    .filter((c) => !have.has(c.task.toLowerCase()))
    .map((c) => ({
      family_id: familyId,
      asset_id: assetId,
      title: c.task,
      description: `Recommended every ${c.intervalDays} days for ${asset.name}.`,
      interval_days: c.intervalDays,
      due_at: new Date(base.getTime() + c.intervalDays * 86_400_000).toISOString(),
      created_by: userId,
    }));

  if (rows.length === 0) return { ok: true, created: 0 };
  const { error } = await supabase.from('maintenance_tasks').insert(rows);
  if (error) return { ok: false, created: 0, error: error.message };
  revalidatePath('/dashboard/home');
  return { ok: true, created: rows.length };
}
