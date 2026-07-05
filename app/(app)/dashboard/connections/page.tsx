import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { ConnectionsModule } from '@/components/modules/connections-module';

export const metadata: Metadata = { title: 'Connections | Bubaly' };

export default async function ConnectionsPage() {
  await requireUserContext();
  return <ConnectionsModule />;
}
