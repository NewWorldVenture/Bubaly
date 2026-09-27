import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { AssistantModule } from '@/components/modules/assistant-module';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'AI Assistant' };

// Free tier includes a metered AI assistant (10 requests/month). Access is open
// to any signed-in member; the monthly quota is enforced at the request layer.
export default async function AssistantPage() {
  await requireFeature('/dashboard/assistant');
  const t = await getTranslations();
  // The module's own heading is an h2 because it also renders inside the AI
  // orb on other pages; the route's h1 lives here, for screen readers.
  return (
    <>
      <h1 className="sr-only">{t('navShared.aiAssistant')}</h1>
      <AssistantModule />
    </>
  );
}
