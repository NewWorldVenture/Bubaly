import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { AssistantModule } from '@/components/modules/assistant-module';

export const metadata: Metadata = { title: 'AI Assistant' };

// Free tier includes a metered AI assistant (10 requests/month). Access is open
// to any signed-in member; the monthly quota is enforced at the request layer.
export default async function AssistantPage() {
  await requireFeature('/dashboard/assistant');
  return <AssistantModule />;
}
