import 'server-only';
import { createServer } from '@/lib/supabase/server';
import type { Tables } from '@/lib/database.types';

export type Warranty = Tables<'home_warranties'>;
export type Contractor = Tables<'home_contractors'>;
export type ServiceRecord = Tables<'home_service_records'>;
export type Asset = Tables<'home_assets'>;

export async function getAssets(familyId: string): Promise<Asset[]> {
  const supabase = await createServer();
  const { data } = await supabase
    .from('home_assets')
    .select('*')
    .eq('family_id', familyId)
    .order('name', { ascending: true });
  return data ?? [];
}

export async function getWarranties(familyId: string): Promise<Warranty[]> {
  const supabase = await createServer();
  const { data } = await supabase
    .from('home_warranties')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('expires_on', { ascending: true, nullsFirst: false });
  return data ?? [];
}

export async function getContractors(familyId: string): Promise<Contractor[]> {
  const supabase = await createServer();
  const { data } = await supabase
    .from('home_contractors')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('is_preferred', { ascending: false })
    .order('name', { ascending: true });
  return data ?? [];
}

export async function getServiceRecords(familyId: string): Promise<ServiceRecord[]> {
  const supabase = await createServer();
  const { data } = await supabase
    .from('home_service_records')
    .select('*')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .order('service_date', { ascending: false })
    .limit(200);
  return data ?? [];
}

export async function getHomeOverview(familyId: string) {
  const supabase = await createServer();
  const [assets, warranties, openTasks] = await Promise.all([
    getAssets(familyId),
    getWarranties(familyId),
    supabase.from('maintenance_tasks').select('id, title, due_at, status, asset_id')
      .eq('family_id', familyId).neq('status', 'done').not('due_at', 'is', null)
      .order('due_at', { ascending: true }).limit(50),
  ]);
  return { assets, warranties, tasks: openTasks.data ?? [] };
}
