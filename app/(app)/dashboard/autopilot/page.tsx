import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isFeaturePreviewOnly } from '@/lib/server/feature-entitlement';
import { AutopilotModule } from '@/components/modules/autopilot-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.familyAutopilot') };
}

export default async function AutopilotPage() {
  const ctx = await requireFeature('/dashboard/autopilot');
  const preview = await isFeaturePreviewOnly(await createServer(), ctx.active.familyId, '/dashboard/autopilot');
  return <AutopilotModule preview={preview} />;
}
