import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { InboxModule } from '@/components/modules/inbox-module';

export const metadata: Metadata = { title: 'Magic Import' };

export default async function InboxPage() {
  await requireFeature('/dashboard/inbox');
  return <InboxModule />;
}
