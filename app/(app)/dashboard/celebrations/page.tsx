import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { CelebrationsModule } from '@/components/modules/celebrations-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.celebrations') };
}

export default async function CelebrationsPage() {
  // A catalog feature: the sidebar hides or padlocks it when an admin moves its
  // tier, so the page answers to the same gate rather than only a session.
  await requireFeature('/dashboard/celebrations');
  return <CelebrationsModule />;
}
