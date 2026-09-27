import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { RelatedOutcomes } from '@/components/outcomes/related-outcomes';
import { requireFeature } from '@/lib/supabase/auth';
import { TripsModule } from '@/components/modules/trips-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.tripPlanner') };
}

export default async function TripsPage() {
  await requireFeature('/dashboard/trips');
  return <><RelatedOutcomes href="/dashboard/trips" /><TripsModule /></>;
}
