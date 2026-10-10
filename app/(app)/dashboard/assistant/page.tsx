import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { AssistantModule } from '@/components/modules/assistant-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.aiAssistant') };
}

// Free tier includes a metered AI assistant (10 requests/month). Access is open
// to any signed-in member; the monthly quota is enforced at the request layer.
export default async function AssistantPage() {
  await requireFeature('/dashboard/assistant');
  const t = await getTranslations();
  // The module's own heading is an h2 because it also renders inside the AI
  // orb on other pages; the route's h1 lives here, for screen readers. Its
  // data-scroll-below-topbar asks app/globals.css to stop scrolls below the
  // sticky top bar on this page (between lg and 2xl), and on no other.
  return (
    <>
      <h1 data-scroll-below-topbar className="sr-only">{t('navShared.aiAssistant')}</h1>
      <AssistantModule />
    </>
  );
}
