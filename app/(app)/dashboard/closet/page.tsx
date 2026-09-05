import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { ClosetModule } from '@/components/modules/closet-module';

export const metadata: Metadata = { title: 'Closet & Outfits' };

export default async function ClosetPage() {
  await requireFeature('/dashboard/closet');
  return <ClosetModule />;
}
