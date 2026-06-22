import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { CelebrationsModule } from '@/components/modules/celebrations-module';

export const metadata: Metadata = { title: 'Celebrations' };

export default async function CelebrationsPage() {
  await requireUserContext();
  return <CelebrationsModule />;
}
