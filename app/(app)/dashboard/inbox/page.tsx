import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { InboxModule } from '@/components/modules/inbox-module';

export const metadata: Metadata = { title: 'Communications Hub' };

export default async function InboxPage() {
  await requireFeature('/dashboard/inbox');
  return <InboxModule />;
}
