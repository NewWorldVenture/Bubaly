import type { Metadata } from 'next';
import { RelatedOutcomes } from '@/components/outcomes/related-outcomes';
import { requireFeature } from '@/lib/supabase/auth';
import { HealthModule } from '@/components/modules/health-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('health.health') };
}

export default async function HealthPage() {
  await requireFeature('/dashboard/health');
  return <><RelatedOutcomes href="/dashboard/health" /><HealthModule /></>;
}
