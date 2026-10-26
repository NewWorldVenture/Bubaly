'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { todayKeyFor } from '@/lib/services/scope';
import { createServer } from '@/lib/supabase/server';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { refusalError, refusalForError } from '@/lib/actions/refusal';
import { DEFAULT_CADENCES } from '@/lib/home/maintenance';
import { isManager } from '@/lib/constants/roles';
import { alreadyOnOrAfter, isDayKey, onlyForward } from '@/lib/home/service-dates';

async function ctx() {
  const c = await requireUserContext();
  return {
    familyId: c.active.familyId,
    userId: c.user.id,
    role: c.active.role,
    supabase: await createServer(),
    // The family's day, for defaulting a date column. `new Date()` formatted as
    // a day key is the HOST's day, so a record logged at 6pm in California was
    // dated tomorrow.
    todayKey: todayKeyFor(c),
  };
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

/** The per-asset detail view (/dashboard/home/assets/[id]) composes warranties,
 *  service history and open maintenance, so anything that writes one of those
 *  for a known asset has to drop that page's cache too — otherwise the family
 *  saves a service record and the asset page still shows the old history. */
function revalidateAsset(assetId: string | null) {
  if (!assetId) return;
  revalidatePath(`/dashboard/home/assets/${assetId}`);
}

/** A form's asset selection must still be readable in the active family. */
async function requireLinkedAsset(
  supabase: Awaited<ReturnType<typeof createServer>>,
  familyId: string,
  assetId: string,
  readFailure: string,
  notFound: string,
) {
  let asset: { id: string } | null;
  try {
    const { data, error } = await supabase.from('home_assets').select('id')
      .eq('id', assetId).eq('family_id', familyId).maybeSingle();
    if (error) throw error;
    asset = data;
  } catch (error) {
    throw refusalError(describeActionError(error, readFailure), refusalForError(error));
  }
  if (!asset) throw refusalError(notFound, 'invalid');
}

// ── Warranties ──────────────────────────────────────────────────────────────
export async function saveWarrantyAction(fd: FormData) {
  const tr = await getTranslations();
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
  if (row.asset_id) await requireLinkedAsset(supabase, familyId, row.asset_id, tr('actions.couldNotSaveThatWarranty'), tr('actions.assetNotFound'));
  // Only the UPDATE branch needs confirming: an insert either inserts or
  // errors, so it cannot match zero rows. Same split as `saveRow` in
  // `dashboard/auto/actions.ts`. Audit C1-S9-47. A deleted row (`deleted_at`)
  // matches nothing, so an edit to it is refused rather than saved out of sight.
  const { data: saved, error } = id
    ? await supabase.from('home_warranties').update(row).eq('id', id).eq('family_id', familyId).is('deleted_at', null).select('id')
    : await supabase.from('home_warranties').insert({ ...row, family_id: familyId, created_by: userId });
  if (error) throw refusalError(describeActionError(error, tr('actions.couldNotSaveThatWarranty')), refusalForError(error));
  if (id && wroteNoRows(saved)) throw new Error(tr('actions.couldNotSaveThatWarranty'));
  revalidatePath('/dashboard/home/warranties');
  revalidatePath('/dashboard/home');
  revalidateAsset(row.asset_id);
}

export async function deleteWarrantyAction(id: string) {
  const tr = await getTranslations();
  const { familyId, userId, supabase } = await ctx();
  // A soft delete is an update, so it carries the zero-rows hazard — and the
  // caller has already told the family the record is gone. Audit C1-S9-47.
  // The policy number leaves with the delete: nothing purges a `deleted_at`
  // row and the select policy serves it, so a "deleted" warranty kept its
  // number for good (the same rule as dashboard/auto's SCRUBBED_ON_DELETE).
  const { data: removed, error } = await supabase.from('home_warranties').update({ policy_number: null, notes: null, deleted_at: new Date().toISOString(), updated_by: userId }).eq('id', id).eq('family_id', familyId).select('id');
  if (error) throw refusalError(describeActionError(error, tr('actions.couldNotDeleteThatWarranty')), refusalForError(error));
  if (wroteNoRows(removed)) throw new Error(tr('actions.couldNotDeleteThatWarranty'));
  revalidatePath('/dashboard/home/warranties');
}

// ── Contractors ─────────────────────────────────────────────────────────────
export async function saveContractorAction(fd: FormData) {
  const tr = await getTranslations();
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
  // Only the UPDATE branch needs confirming: an insert either inserts or
  // errors, so it cannot match zero rows. Same split as `saveRow` in
  // `dashboard/auto/actions.ts`. Audit C1-S9-47.
  const { data: saved, error } = id
    ? await supabase.from('home_contractors').update(row).eq('id', id).eq('family_id', familyId).is('deleted_at', null).select('id')
    : await supabase.from('home_contractors').insert({ ...row, family_id: familyId, created_by: userId });
  if (error) throw refusalError(describeActionError(error, tr('actions.couldNotSaveThatContractor')), refusalForError(error));
  if (id && wroteNoRows(saved)) throw new Error(tr('actions.couldNotSaveThatContractor'));
  revalidatePath('/dashboard/home/pros');
}

export async function deleteContractorAction(id: string) {
  const tr = await getTranslations();
  const { familyId, userId, supabase } = await ctx();
  // A soft delete is an update, so it carries the zero-rows hazard — and the
  // caller has already told the family the record is gone. Audit C1-S9-47.
  // A contractor is a third party: their phone and email leave with the
  // delete rather than staying readable by direct REST on a row every screen
  // hides (the same rule as dashboard/auto's SCRUBBED_ON_DELETE).
  const { data: removed, error } = await supabase.from('home_contractors').update({ phone: null, email: null, notes: null, deleted_at: new Date().toISOString(), updated_by: userId }).eq('id', id).eq('family_id', familyId).select('id');
  if (error) throw refusalError(describeActionError(error, tr('actions.couldNotDeleteThatContractor')), refusalForError(error));
  if (wroteNoRows(removed)) throw new Error(tr('actions.couldNotDeleteThatContractor'));
  revalidatePath('/dashboard/home/pros');
}

// ── Service records ─────────────────────────────────────────────────────────
export async function saveServiceRecordAction(fd: FormData) {
  const tr = await getTranslations();
  const { familyId, userId, supabase, todayKey } = await ctx();
  const assetId = str(fd, 'asset_id');
  const typedDate = str(fd, 'service_date');
  if (assetId) await requireLinkedAsset(supabase, familyId, assetId, tr('actions.couldNotSaveThatService'), tr('actions.assetNotFound'));
  const { data: saved, error } = await supabase.from('home_service_records').insert({
    family_id: familyId,
    asset_id: assetId,
    title: str(fd, 'title') ?? 'Service',
    service_date: typedDate ?? todayKey,
    provider: str(fd, 'provider'),
    cost: num(fd, 'cost'),
    description: str(fd, 'description'),
    next_due_on: str(fd, 'next_due_on'),
    created_by: userId,
  }).select('service_date').single();
  if (error) throw refusalError(describeActionError(error, tr('actions.couldNotSaveThatService')), refusalForError(error));
  // The date as the database stored it (YYYY-MM-DD, whatever form it was
  // typed in), when one was typed: an empty field dates the record today and
  // leaves the asset alone, as it always has.
  const serviceDate = typedDate && isDayKey(saved?.service_date) ? saved.service_date : null;
  // Keep the asset's last-serviced date fresh for life/forecast math. Best-effort
  // (the record itself is already saved), but log a failure so a broken update is
  // observable instead of silently drifting the forecast math.
  if (assetId && serviceDate) {
    // Confirmed for the LOG, not for a bail — the same treatment as the vehicle
    // odometer. An asset id matching no row in this family is the commonest way
    // this quietly does nothing, and only an ERROR was reaching the log that
    // exists to keep the forecast math from drifting unobserved. Audit C1-S9-60.
    // FORWARD only (lib/home/service-dates): a visit logged after the fact is
    // history, and moving the asset's date back to it made every recommended
    // task built from it overdue. Zero rows is then ordinary — the asset was
    // serviced later — so only a missing asset or an older date is logged.
    const { data: assetTouched, error: assetError } = await supabase.from('home_assets')
      .update({ last_serviced_on: serviceDate }).eq('id', assetId).eq('family_id', familyId)
      .or(onlyForward('last_serviced_on', serviceDate)).select('id');
    if (assetError || wroteNoRows(assetTouched)) {
      if (assetError || !(await alreadyOnOrAfter(supabase, 'home_assets', 'last_serviced_on', familyId, assetId, serviceDate))) console.error('[home] home_assets last_serviced_on update failed', {
        familyId, assetId, error: assetError?.message ?? 'no rows updated',
      });
    }
  }
  revalidatePath('/dashboard/home/service');
  revalidatePath('/dashboard/home');
  revalidateAsset(assetId);
}

export async function deleteServiceRecordAction(id: string) {
  const tr = await getTranslations();
  const { familyId, userId, supabase } = await ctx();
  // A soft delete is an update, so it carries the zero-rows hazard — and the
  // caller has already told the family the record is gone. Audit C1-S9-47.
  const { data: removed, error } = await supabase.from('home_service_records').update({ provider: null, description: null, deleted_at: new Date().toISOString(), updated_by: userId }).eq('id', id).eq('family_id', familyId).select('id, asset_id, service_date');
  if (error) throw refusalError(describeActionError(error, tr('actions.couldNotDeleteThatService')), refusalForError(error));
  if (wroteNoRows(removed)) throw new Error(tr('actions.couldNotDeleteThatService'));
  const gone = removed?.[0];
  if (gone?.asset_id && isDayKey(gone.service_date)) await restoreLastServiced(supabase, familyId, gone.asset_id, gone.service_date);
  revalidatePath('/dashboard/home/service');
  revalidateAsset(gone?.asset_id ?? null);
}

/**
 * A deleted visit takes its date off the asset: when the asset's
 * `last_serviced_on` is that visit's date, it falls back to the latest visit
 * still on file, or to none. A date set by a later visit or by hand is not this
 * visit's and is left alone (the `.eq` on the old date). Best-effort: the
 * record is already deleted, so a failure is logged, not raised.
 */
async function restoreLastServiced(supabase: Awaited<ReturnType<typeof createServer>>, familyId: string, assetId: string, deletedDate: string) {
  const { data: latest, error: latestError } = await supabase.from('home_service_records').select('service_date')
    .eq('family_id', familyId).eq('asset_id', assetId).is('deleted_at', null)
    .order('service_date', { ascending: false }).order('id').limit(1);
  if (latestError) {
    console.error('[home] last-serviced fallback read failed', { familyId, assetId, error: latestError.message });
    return;
  }
  const fallback = latest?.[0]?.service_date ?? null;
  if (fallback === deletedDate) return;
  const { error: restoreError } = await supabase.from('home_assets').update({ last_serviced_on: fallback })
    .eq('id', assetId).eq('family_id', familyId).eq('last_serviced_on', deletedDate).select('id');
  if (restoreError) console.error('[home] last-serviced fallback write failed', { familyId, assetId, error: restoreError.message });
}

// ── Deterministic forecast → schedule recommended maintenance for an asset ────
export async function scheduleRecommendedTasksAction(assetId: string): Promise<{ ok: boolean; created: number; error?: string }> {
  const tr = await getTranslations();
  const { familyId, userId, role, supabase } = await ctx();
  // The Home page offers "Add task" to a parent or adult only, and this writes a
  // year of recurring tasks: a child, caregiver or guest is refused before
  // anything is read (maintenance_tasks itself takes any member's insert).
  if (!isManager(role)) return { ok: false, created: 0, error: tr('actions.onlyAParentOrAdultCanScheduleMaintenance') };
  const { data: asset, error: assetReadError } = await supabase
    .from('home_assets')
    .select('id, name, category, last_serviced_on')
    .eq('id', assetId)
    .eq('family_id', familyId)
    .maybeSingle();
  // A refused read is not an absence: it used to return the "not found" answer below. Audit C1-S9-75.
  if (assetReadError) return { ok: false, created: 0, error: describeActionError(assetReadError, tr('actions.couldNotCheckThatRefresh')) };
  if (!asset) return { ok: false, created: 0, error: tr('actions.assetNotFound') };

  const cadences = DEFAULT_CADENCES[asset.category ?? ''] ?? [];
  if (cadences.length === 0) return { ok: false, created: 0, error: tr('actions.noRecommendedScheduleForThis') };

  // Avoid duplicating tasks we already created for this asset.
  //
  // This read IS the de-dupe set, so `?? []` on a failed read means "nothing is
  // scheduled yet" and the whole recommended cadence is written a second time —
  // the family gets every task twice, and a third press gives them three. The
  // same hazard app/(app)/dashboard/migrate/actions.ts names on its own de-dupe
  // reads: a short or failed read is duplication, not emptiness.
  const { data: existing, error: existingError } = await supabase
    .from('maintenance_tasks')
    .select('title')
    .eq('family_id', familyId)
    .eq('asset_id', assetId);
  if (existingError) {
    console.error('[home] maintenance de-dupe read failed', { familyId, assetId, error: existingError });
    return { ok: false, created: 0, error: describeActionError(existingError, tr('actions.couldNotAddThatTask')) };
  }
  const have = new Set((existing ?? []).map((t) => t.title.toLowerCase()));

  // Noon UTC on the day last serviced, as the assistant's `scheduleRecommendedTasks`
  // does, so both write the same rows. `new Date(<DATE>)` is UTC midnight: the
  // evening before west of Greenwich, so every task there fell due a day early.
  const base = asset.last_serviced_on ? Date.parse(`${asset.last_serviced_on}T12:00:00Z`) : Date.now();
  const rows = cadences
    .filter((c) => !have.has(c.task.toLowerCase()))
    .map((c) => ({
      family_id: familyId,
      asset_id: assetId,
      title: c.task,
      description: `Recommended every ${c.intervalDays} days for ${asset.name}.`,
      interval_days: c.intervalDays,
      due_at: new Date(base + c.intervalDays * 86_400_000).toISOString(),
      created_by: userId,
    }));

  if (rows.length === 0) return { ok: true, created: 0 };
  const { error } = await supabase.from('maintenance_tasks').insert(rows);
  if (error) return { ok: false, created: 0, error: describeActionError(error) };
  revalidatePath('/dashboard/home');
  revalidateAsset(assetId);
  return { ok: true, created: rows.length };
}
