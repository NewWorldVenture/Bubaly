import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getWarranties, getAssets } from '@/lib/home/queries';
import { WarrantiesClient } from '@/components/home/warranties-client';

export const metadata: Metadata = { title: 'Warranties · Home' };
export const dynamic = 'force-dynamic';

export default async function WarrantiesPage() {
  const ctx = await requirePlanLevel(1);
  const [warranties, assets] = await Promise.all([
    getWarranties(ctx.active.familyId),
    getAssets(ctx.active.familyId),
  ]);
  return <WarrantiesClient warranties={warranties} assets={assets} />;
}
