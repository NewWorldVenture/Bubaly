import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { YearbookModule } from '@/components/modules/yearbook-module';

export const metadata: Metadata = { title: 'Family Yearbook' };

export default async function YearbookPage() {
  await requireUserContext();
  return <YearbookModule />;
}
