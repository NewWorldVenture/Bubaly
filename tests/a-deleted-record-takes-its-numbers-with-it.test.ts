// A deleted Auto or Home record takes its identifying numbers with it.
//
// The Auto hub's Delete (licences, policies, registrations, inspections,
// rentals, vehicles, service records) and the Home hub's (warranties,
// contractors, service records) stamp `deleted_at`. No code path and no cron
// ever purges a stamped row, every application reader filters it out, and the
// 0036/0037 select policies carry no `deleted_at is null` clause — so a
// "deleted" licence kept its licence number, a policy its policy number, a
// registration its plate, a contractor their phone and email, served by
// `GET /rest/v1/<table>` to any member's session for good, under a button that
// says plain "Delete". The soft delete now blanks the identifying columns in
// the same UPDATE as the stamp. (The scheduled purge and the policy clause are
// the owner's SQL.) Driven through the real actions against the in-memory
// database; the other family's row and the non-identifying columns are the
// controls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'auth-parent' }, active: { familyId: 'fam-1', family: { timezone: 'UTC' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const auto = await import('@/app/(app)/dashboard/auto/actions');
const home = await import('@/app/(app)/dashboard/home/actions');

type DB = SupabaseClient<Database>;
let db: InMemorySupabase;

/** One of ours and one of another family's, identical but for the family. */
function pair(table: string, row: Record<string, unknown>) {
  db.seed(table, [{ ...row, id: `${table}-ours`, family_id: 'fam-1', deleted_at: null }, { ...row, id: `${table}-theirs`, family_id: 'fam-2', deleted_at: null }]);
}
const ours = (table: string) => db.table(table).find((r) => r.id === `${table}-ours`)!;
const theirs = (table: string) => db.table(table).find((r) => r.id === `${table}-theirs`)!;

beforeEach(() => {
  db = createInMemorySupabase<DB>();
  h.db = db;
  pair('driver_licenses', { holder_name: 'Alex', license_number: 'D1234567', state: 'CA', expires_on: '2028-01-01', notes: 'renew early' });
  pair('auto_insurance_policies', { provider: 'State Farm', policy_number: 'POL-998877', agent_name: 'Pat Agent', agent_phone: '555-0100', claims_phone: '800-555-0199', notes: 'bundled' });
  pair('vehicle_registrations', { plate: '8ABC123', state: 'CA', expires_on: '2027-03-01', notes: 'sticker on dash' });
  pair('vehicle_inspections', { inspection_type: 'safety', station: 'Main St Smog', result: 'pass', notes: 'passed clean' });
  pair('rental_cars', { company: 'Hertz', confirmation_number: 'H7Y2K9', pickup_location: 'SFO', notes: 'ask for a car seat' });
  pair('vehicles', { nickname: 'Van', make: 'Honda', model: 'Odyssey', vin: '1HGCM82633A004352', license_plate: '8ABC123', notes: 'squeaky brake' });
  pair('auto_service_records', { title: 'Oil change', service_date: '2026-09-01', provider: 'Quick Lube', description: 'synthetic 5W-30', cost: 80 });
  pair('home_warranties', { name: 'Dishwasher', provider: 'Bosch', policy_number: 'W-556677', claim_phone: '800-555-0123', notes: 'extended' });
  pair('home_contractors', { name: 'Ace Plumbing', trade: 'plumbing', phone: '555-0101', email: 'ace@example.test', website: 'https://ace.example', notes: 'knows the boiler' });
  pair('home_service_records', { title: 'Boiler service', service_date: '2026-09-01', provider: 'Ace Plumbing', description: 'annual check', cost: 150, asset_id: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const CASES: [string, (id: string) => Promise<void>, Record<string, null>, Record<string, unknown>][] = [
  ['driver_licenses', auto.deleteLicenseAction, { license_number: null, notes: null }, { holder_name: 'Alex', state: 'CA', expires_on: '2028-01-01' }],
  ['auto_insurance_policies', auto.deletePolicyAction, { policy_number: null, agent_name: null, agent_phone: null, notes: null }, { provider: 'State Farm', claims_phone: '800-555-0199' }],
  ['vehicle_registrations', auto.deleteRegistrationAction, { plate: null, notes: null }, { state: 'CA', expires_on: '2027-03-01' }],
  ['vehicle_inspections', auto.deleteInspectionAction, { station: null, notes: null }, { inspection_type: 'safety', result: 'pass' }],
  ['rental_cars', auto.deleteRentalAction, { confirmation_number: null, notes: null }, { company: 'Hertz', pickup_location: 'SFO' }],
  ['vehicles', auto.deleteVehicleAction, { vin: null, license_plate: null, notes: null }, { nickname: 'Van', make: 'Honda', model: 'Odyssey' }],
  ['auto_service_records', auto.deleteAutoServiceAction, { provider: null, description: null }, { title: 'Oil change', service_date: '2026-09-01', cost: 80 }],
  ['home_warranties', home.deleteWarrantyAction, { policy_number: null, notes: null }, { name: 'Dishwasher', provider: 'Bosch', claim_phone: '800-555-0123' }],
  ['home_contractors', home.deleteContractorAction, { phone: null, email: null, notes: null }, { name: 'Ace Plumbing', trade: 'plumbing', website: 'https://ace.example' }],
  ['home_service_records', home.deleteServiceRecordAction, { provider: null, description: null }, { title: 'Boiler service', service_date: '2026-09-01', cost: 150 }],
];

describe.each(CASES)('deleting a %s row', (table, remove, blanked, kept) => {
  it('stamps it deleted and blanks what identified it, keeping the rest and the other family\'s row', async () => {
    const before = { ...theirs(table) };
    await expect(remove(`${table}-ours`)).resolves.toBeUndefined();
    const row = ours(table);
    expect(row.deleted_at).toBeTruthy();
    expect(row.updated_by).toBe('auth-parent');
    for (const [column, value] of Object.entries(blanked)) expect(row[column], column).toBe(value);
    for (const [column, value] of Object.entries(kept)) expect(row[column], column).toBe(value);
    expect(theirs(table)).toEqual(before);
  });

  it('refuses to delete the other family\'s row, and changes nothing on it', async () => {
    const before = { ...theirs(table) };
    await expect(remove(`${table}-theirs`)).rejects.toThrow();
    expect(theirs(table)).toEqual(before);
  });
});
