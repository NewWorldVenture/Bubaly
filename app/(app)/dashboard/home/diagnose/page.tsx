import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getAssets } from '@/lib/home/queries';
import { DiagnoseClient } from '@/components/home/diagnose-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('diagnoseClient.repairHelp')} · ${t('navLabel.home')}` };
}
export const dynamic = 'force-dynamic';

export default async function DiagnosePage() {
  const ctx = await requirePlanLevel(1);
  const assets = await getAssets(ctx.active.familyId);
  return <DiagnoseClient assets={assets} />;
}
