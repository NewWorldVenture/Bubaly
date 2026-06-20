import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { InboxModule } from '@/components/modules/inbox-module';

export const metadata: Metadata = { title: 'Magic Import' };

export default async function InboxPage() {
  await requirePlanLevel(1);
  return <InboxModule />;
}
