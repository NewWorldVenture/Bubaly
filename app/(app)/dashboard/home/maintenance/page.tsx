import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { getAssets } from '@/lib/home/queries';
import {
  assetAgeYears, lifeRemaining, currentSeason, SEASONAL_CHECKLIST,
  DEFAULT_CADENCES, TYPICAL_LIFESPAN_YEARS,
} from '@/lib/home/maintenance';
import { MaintenanceClient, type AssetView } from '@/components/home/maintenance-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('dashboardFamilyCoo.maintenance')} · ${t('navLabel.home')}` };
}
export const dynamic = 'force-dynamic';

export default async function MaintenancePage() {
  const ctx = await requirePlanLevel(1);
  const assets = await getAssets(ctx.active.familyId);
  const season = currentSeason();

  const views: AssetView[] = assets.map((a) => {
    const life = lifeRemaining(a);
    return {
      id: a.id,
      name: a.name,
      category: a.category,
      ageYears: assetAgeYears(a),
      expectedLife: a.expected_life_years ?? (a.category ? TYPICAL_LIFESPAN_YEARS[a.category] ?? null : null),
      lastServiced: a.last_serviced_on,
      hasCadence: Boolean(a.category && DEFAULT_CADENCES[a.category]?.length),
      life: life ? { percentUsed: life.percentUsed, tone: life.tone, label: life.label } : null,
    };
  });

  return <MaintenanceClient assets={views} season={season} seasonTasks={SEASONAL_CHECKLIST[season]} />;
}
