import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { IntelligenceModule } from '@/components/modules/intelligence-module';

export const metadata: Metadata = { title: 'Intelligence Network | Bubaly' };

export default async function IntelligencePage() {
  await requireUserContext();
  return <IntelligenceModule />;
}
