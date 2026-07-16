import 'server-only';
import { createServer } from '@/lib/supabase/server';
import type { Tables } from '@/lib/database.types';
import { buildRenewals, vehicleLabel, type RenewalItem } from './renewals';

export type Vehicle = Tables<'vehicles'>;
export type License = Tables<'driver_licenses'>;
export type Registration = Tables<'vehicle_registrations'>;
export type Inspection = Tables<'vehicle_inspections'>;
export type Policy = Tables<'auto_insurance_policies'>;
export type Rental = Tables<'rental_cars'>;
export type AutoService = Tables<'auto_service_records'>;

async function fam<T>(table: string, familyId: string, order?: { col: string; asc?: boolean }): Promise<T[]> {
  const supabase = await createServer();
  let q = supabase.from(table as 'vehicles').select('*').eq('family_id', familyId).is('deleted_at', null);
  if (order) q = q.order(order.col, { ascending: order.asc ?? true, nullsFirst: false });
  const { data, error } = await q;
  // Fail closed: these are source-of-truth records. A swallowed read error would
  // render an empty list — "you have no vehicles" — when the data is really just
  // unreadable, so the caller (a dedicated Auto page with no try/catch) must show
  // a visible error instead of a misleading empty state.
  if (error) {
    console.error('[auto/queries] read failed', { table, familyId, error });
    throw new Error('Could not load your vehicle records from Supabase. Refresh and try again.');
  }
  return (data ?? []) as unknown as T[];
}

export const getVehicles = (f: string) => fam<Vehicle>('vehicles', f, { col: 'created_at', asc: false });
export const getLicenses = (f: string) => fam<License>('driver_licenses', f, { col: 'expires_on' });
export const getRegistrations = (f: string) => fam<Registration>('vehicle_registrations', f, { col: 'expires_on' });
export const getInspections = (f: string) => fam<Inspection>('vehicle_inspections', f, { col: 'expires_on' });
export const getPolicies = (f: string) => fam<Policy>('auto_insurance_policies', f, { col: 'expires_on' });
export const getRentals = (f: string) => fam<Rental>('rental_cars', f, { col: 'pickup_at', asc: false });
export const getServiceRecords = (f: string) => fam<AutoService>('auto_service_records', f, { col: 'service_date', asc: false });

export async function getAutoOverview(familyId: string): Promise<{
  vehicles: Vehicle[]; policies: Policy[]; rentals: Rental[]; renewals: RenewalItem[];
}> {
  const [vehicles, licenses, registrations, inspections, policies, rentals] = await Promise.all([
    getVehicles(familyId), getLicenses(familyId), getRegistrations(familyId),
    getInspections(familyId), getPolicies(familyId), getRentals(familyId),
  ]);
  const nameById = new Map(vehicles.map((v) => [v.id, vehicleLabel(v)]));
  const renewals = buildRenewals({
    licenses, registrations, inspections, policies,
    vehicleName: (id) => (id ? nameById.get(id) ?? null : null),
  });
  return { vehicles, policies, rentals, renewals };
}
