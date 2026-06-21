import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getAssets } from '@/lib/home/queries';
import { DiagnoseClient } from '@/components/home/diagnose-client';

export const metadata: Metadata = { title: 'Repair Help · Home' };
export const dynamic = 'force-dynamic';

export default async function DiagnosePage() {
  const ctx = await requirePlanLevel(1);
  const assets = await getAssets(ctx.active.familyId);
  return <DiagnoseClient assets={assets} />;
}
