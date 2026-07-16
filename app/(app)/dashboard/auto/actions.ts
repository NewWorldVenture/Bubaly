'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type Client = SupabaseClient<Database>;

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
function revalidate(...paths: string[]) {
  for (const p of paths) revalidatePath(p);
}

// Insert/update a family-scoped row, throwing a human-readable error on failure.
// A PostgREST write returns { error } without throwing, so an unchecked write
// would let a form report success while the record was silently lost. The
// `as 'vehicles'` cast mirrors softDelete — the row shape is validated per caller.
async function saveRow(
  supabase: Client, table: string, id: string | null, row: Record<string, unknown>,
  familyId: string, userId: string, label: string,
) {
  const { error } = id
    ? await supabase.from(table as 'vehicles').update(row as never).eq('id', id).eq('family_id', familyId)
    : await supabase.from(table as 'vehicles').insert({ ...row, family_id: familyId, created_by: userId } as never);
  if (error) throw new Error(describeActionError(error, label));
}

async function softDelete(supabase: Client, table: string, id: string, familyId: string, userId: string, label = 'Could not delete that record.') {
  const { error } = await supabase.from(table as 'vehicles').update({ deleted_at: new Date().toISOString(), updated_by: userId }).eq('id', id).eq('family_id', familyId);
  if (error) throw new Error(describeActionError(error, label));
}

// ── Vehicles ────────────────────────────────────────────────────────────────
export async function saveVehicleAction(fd: FormData) {
  const { familyId, userId, supabase } = await ctx();
  const id = str(fd, 'id');
  const row = {
    nickname: str(fd, 'nickname'), make: str(fd, 'make'), model: str(fd, 'model'), year: num(fd, 'year'),
    trim: str(fd, 'trim'), color: str(fd, 'color'), vin: str(fd, 'vin'), license_plate: str(fd, 'license_plate'),
    plate_state: str(fd, 'plate_state'), body_type: str(fd, 'body_type'), fuel_type: str(fd, 'fuel_type'),
    mileage: num(fd, 'mileage'), purchase_date: str(fd, 'purchase_date'), primary_driver: str(fd, 'primary_driver'),
    status: str(fd, 'status') ?? 'active', notes: str(fd, 'notes'), updated_by: userId,
  };
  await saveRow(supabase, 'vehicles', id, row, familyId, userId, 'Could not save that vehicle.');
  revalidate('/dashboard/auto', '/dashboard/auto/vehicles');
}
export async function deleteVehicleAction(id: string) {
  const { familyId, userId, supabase } = await ctx();
  await softDelete(supabase, 'vehicles', id, familyId, userId);
  revalidate('/dashboard/auto', '/dashboard/auto/vehicles');
}

// ── Driver licenses ───────────────────────────────────────────────────────────
export async function saveLicenseAction(fd: FormData) {
  const { familyId, userId, supabase } = await ctx();
  const id = str(fd, 'id');
  const row = {
    member_id: str(fd, 'member_id'), holder_name: str(fd, 'holder_name') ?? 'Driver', license_number: str(fd, 'license_number'),
    state: str(fd, 'state'), license_class: str(fd, 'license_class'), endorsements: str(fd, 'endorsements'),
    restrictions: str(fd, 'restrictions'), issued_on: str(fd, 'issued_on'), expires_on: str(fd, 'expires_on'),
    status: str(fd, 'status') ?? 'active', notes: str(fd, 'notes'), updated_by: userId,
  };
  await saveRow(supabase, 'driver_licenses', id, row, familyId, userId, 'Could not save that license.');
  revalidate('/dashboard/auto', '/dashboard/auto/licenses');
}
export async function deleteLicenseAction(id: string) {
  const { familyId, userId, supabase } = await ctx();
  await softDelete(supabase, 'driver_licenses', id, familyId, userId);
  revalidate('/dashboard/auto', '/dashboard/auto/licenses');
}

// ── Registrations ─────────────────────────────────────────────────────────────
export async function saveRegistrationAction(fd: FormData) {
  const { familyId, userId, supabase } = await ctx();
  const id = str(fd, 'id');
  const row = {
    vehicle_id: str(fd, 'vehicle_id'), plate: str(fd, 'plate'), state: str(fd, 'state'),
    registered_on: str(fd, 'registered_on'), expires_on: str(fd, 'expires_on'), fee: num(fd, 'fee'),
    status: str(fd, 'status') ?? 'active', notes: str(fd, 'notes'), updated_by: userId,
  };
  await saveRow(supabase, 'vehicle_registrations', id, row, familyId, userId, 'Could not save that registration.');
  revalidate('/dashboard/auto', '/dashboard/auto/registration');
}
export async function deleteRegistrationAction(id: string) {
  const { familyId, userId, supabase } = await ctx();
  await softDelete(supabase, 'vehicle_registrations', id, familyId, userId);
  revalidate('/dashboard/auto', '/dashboard/auto/registration');
}

// ── Inspections ───────────────────────────────────────────────────────────────
export async function saveInspectionAction(fd: FormData) {
  const { familyId, userId, supabase } = await ctx();
  const id = str(fd, 'id');
  const row = {
    vehicle_id: str(fd, 'vehicle_id'), inspection_type: str(fd, 'inspection_type') ?? 'safety', station: str(fd, 'station'),
    inspected_on: str(fd, 'inspected_on'), expires_on: str(fd, 'expires_on'), result: str(fd, 'result'),
    notes: str(fd, 'notes'), updated_by: userId,
  };
  await saveRow(supabase, 'vehicle_inspections', id, row, familyId, userId, 'Could not save that inspection.');
  revalidate('/dashboard/auto', '/dashboard/auto/registration');
}
export async function deleteInspectionAction(id: string) {
  const { familyId, userId, supabase } = await ctx();
  await softDelete(supabase, 'vehicle_inspections', id, familyId, userId);
  revalidate('/dashboard/auto', '/dashboard/auto/registration');
}

// ── Insurance ─────────────────────────────────────────────────────────────────
export async function savePolicyAction(fd: FormData) {
  const { familyId, userId, supabase } = await ctx();
  const id = str(fd, 'id');
  const row = {
    vehicle_id: str(fd, 'vehicle_id'), provider: str(fd, 'provider'), policy_number: str(fd, 'policy_number'),
    naic: str(fd, 'naic'), coverage_summary: str(fd, 'coverage_summary'), liability_limits: str(fd, 'liability_limits'),
    deductible_collision: num(fd, 'deductible_collision'), deductible_comprehensive: num(fd, 'deductible_comprehensive'),
    agent_name: str(fd, 'agent_name'), agent_phone: str(fd, 'agent_phone'), claims_phone: str(fd, 'claims_phone'),
    roadside_phone: str(fd, 'roadside_phone'), effective_on: str(fd, 'effective_on'), expires_on: str(fd, 'expires_on'),
    premium: num(fd, 'premium'), premium_period: str(fd, 'premium_period'), is_active: fd.get('is_active') === 'on',
    status: str(fd, 'status') ?? 'active', notes: str(fd, 'notes'), updated_by: userId,
  };
  await saveRow(supabase, 'auto_insurance_policies', id, row, familyId, userId, 'Could not save that policy.');
  revalidate('/dashboard/auto', '/dashboard/auto/insurance');
}
export async function deletePolicyAction(id: string) {
  const { familyId, userId, supabase } = await ctx();
  await softDelete(supabase, 'auto_insurance_policies', id, familyId, userId);
  revalidate('/dashboard/auto', '/dashboard/auto/insurance');
}

// ── Rentals ───────────────────────────────────────────────────────────────────
export async function saveRentalAction(fd: FormData) {
  const { familyId, userId, supabase } = await ctx();
  const id = str(fd, 'id');
  const row = {
    company: str(fd, 'company'), confirmation_number: str(fd, 'confirmation_number'), pickup_location: str(fd, 'pickup_location'),
    dropoff_location: str(fd, 'dropoff_location'), pickup_at: str(fd, 'pickup_at'), return_at: str(fd, 'return_at'),
    vehicle_desc: str(fd, 'vehicle_desc'), daily_rate: num(fd, 'daily_rate'), total_cost: num(fd, 'total_cost'),
    coverage: str(fd, 'coverage'), status: str(fd, 'status') ?? 'upcoming', notes: str(fd, 'notes'), updated_by: userId,
  };
  await saveRow(supabase, 'rental_cars', id, row, familyId, userId, 'Could not save that rental.');
  revalidate('/dashboard/auto', '/dashboard/auto/rentals');
}
export async function deleteRentalAction(id: string) {
  const { familyId, userId, supabase } = await ctx();
  await softDelete(supabase, 'rental_cars', id, familyId, userId);
  revalidate('/dashboard/auto', '/dashboard/auto/rentals');
}

// ── Service log ───────────────────────────────────────────────────────────────
export async function saveAutoServiceAction(fd: FormData) {
  const { familyId, userId, supabase } = await ctx();
  const vehicleId = str(fd, 'vehicle_id');
  const mileage = num(fd, 'mileage');
  const { error } = await supabase.from('auto_service_records').insert({
    family_id: familyId, vehicle_id: vehicleId, title: str(fd, 'title') ?? 'Service',
    service_date: str(fd, 'service_date') ?? new Date().toISOString().slice(0, 10),
    provider: str(fd, 'provider'), cost: num(fd, 'cost'), mileage, description: str(fd, 'description'),
    next_due_on: str(fd, 'next_due_on'), next_due_mileage: num(fd, 'next_due_mileage'), created_by: userId,
  });
  if (error) throw new Error(describeActionError(error, 'Could not save that service record.'));
  // Keep the vehicle odometer fresh — best-effort (the record is already saved),
  // but log a failure so a broken update is observable, not silently ignored.
  if (vehicleId && mileage != null) {
    const { error: odoError } = await supabase.from('vehicles').update({ mileage }).eq('id', vehicleId).eq('family_id', familyId);
    if (odoError) console.error('[auto] vehicle odometer update failed', { familyId, vehicleId, error: odoError });
  }
  revalidate('/dashboard/auto', '/dashboard/auto/service');
}
export async function deleteAutoServiceAction(id: string) {
  const { familyId, userId, supabase } = await ctx();
  await softDelete(supabase, 'auto_service_records', id, familyId, userId);
  revalidate('/dashboard/auto', '/dashboard/auto/service');
}
