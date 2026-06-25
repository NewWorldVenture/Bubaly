import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { ConciergeModule } from '@/components/modules/concierge-module';

export const metadata: Metadata = { title: 'AI Concierge' };

export default async function ConciergePage() {
  await requireUserContext();
  return <ConciergeModule />;
}
