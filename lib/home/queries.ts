import 'server-only';
import { createServer } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import type { Tables } from '@/lib/database.types';

export type Warranty = Tables<'home_warranties'>;
export type Contractor = Tables<'home_contractors'>;
export type ServiceRecord = Tables<'home_service_records'>;
export type Asset = Tables<'home_assets'>;

// Fail closed: these are source-of-truth household records. A swallowed read
// error would render an empty list — "you have no warranties" — when the data is
// really just unreadable, so the caller (a dedicated Home page with no try/catch)
// must show a visible error instead of a misleading empty state.
function orThrow<T>(result: { data: T[] | null; error: unknown }, table: string, familyId: string): T[] {
  if (result.error) {
    console.error('[home/queries] read failed', { table, familyId, error: result.error });
    throw new Error('Could not load your home records from Supabase. Refresh and try again.');
  }
  return result.data ?? [];
}

export async function getAssets(familyId: string): Promise<Asset[]> {
  const supabase = await createServer();
  const res = await supabase
    .from('home_assets')
    .select('*')
    .eq('family_id', familyId)
    .order('name', { ascending: true });
  return orThrow(res, 'home_assets', familyId);
}

export async function getWarranties(familyId: string): Promise<Warranty[]> {
  const supabase = await createServer();
  const res = await supabase
    .from('home_warranties')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('expires_on', { ascending: true, nullsFirst: false });
  return orThrow(res, 'home_warranties', familyId);
}

export async function getContractors(familyId: string): Promise<Contractor[]> {
  const supabase = await createServer();
  const res = await supabase
    .from('home_contractors')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('is_preferred', { ascending: false })
    .order('name', { ascending: true });
  return orThrow(res, 'home_contractors', familyId);
}

export async function getServiceRecords(familyId: string): Promise<ServiceRecord[]> {
  const supabase = await createServer();
  const res = await supabase
    .from('home_service_records')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('service_date', { ascending: false })
    .limit(200);
  return orThrow(res, 'home_service_records', familyId);
}

export async function getHomeOverview(familyId: string) {
  const supabase = await createServer();
  const [assets, warranties, openTasks] = await Promise.all([
    getAssets(familyId),
    getWarranties(familyId),
    settle(supabase.from('maintenance_tasks').select('id, title, due_at, status, asset_id')
      .eq('family_id', familyId).neq('status', 'done').not('due_at', 'is', null)
      .order('due_at', { ascending: true }).limit(50)),
  ]);
  return { assets, warranties, tasks: orThrow(openTasks, 'maintenance_tasks', familyId) };
}
