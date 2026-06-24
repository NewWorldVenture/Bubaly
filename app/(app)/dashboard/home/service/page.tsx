import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getServiceRecords, getAssets } from '@/lib/home/queries';
import { ServiceClient } from '@/components/home/service-client';

export const metadata: Metadata = { title: 'Service Log · Home' };
export const dynamic = 'force-dynamic';

export default async function ServicePage() {
  const ctx = await requirePlanLevel(1);
  const [records, assets] = await Promise.all([
    getServiceRecords(ctx.active.familyId),
    getAssets(ctx.active.familyId),
  ]);
  return <ServiceClient records={records} assets={assets} />;
}
