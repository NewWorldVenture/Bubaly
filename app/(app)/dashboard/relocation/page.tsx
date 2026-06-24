import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { RelocationModule } from '@/components/modules/relocation-module';

export const metadata: Metadata = { title: 'Relocation Guide' };

export default async function RelocationPage() {
  await requireUserContext();
  return <RelocationModule />;
}
