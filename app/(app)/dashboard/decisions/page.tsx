import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { DecisionsModule } from '@/components/modules/decisions-module';

export const metadata: Metadata = { title: 'Decision Engine | Bubaly' };

export default async function DecisionsPage() {
  await requireUserContext();
  return <DecisionsModule />;
}
