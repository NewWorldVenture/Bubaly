import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { AutopilotModule } from '@/components/modules/autopilot-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.familyAutopilot') };
}

export default async function AutopilotPage() {
  await requireFeature('/dashboard/autopilot');
  return <AutopilotModule />;
}
