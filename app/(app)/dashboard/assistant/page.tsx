import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { AssistantModule } from '@/components/modules/assistant-module';

export const metadata: Metadata = { title: 'AI Assistant' };

export default async function AssistantPage() {
  await requirePlanLevel(1);
  return <AssistantModule />;
}
