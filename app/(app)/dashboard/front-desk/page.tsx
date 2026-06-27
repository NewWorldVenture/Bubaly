import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { FrontDeskModule } from '@/components/modules/front-desk-module';

export const metadata: Metadata = { title: 'AI Front Desk' };

export default async function FrontDeskPage() {
  await requireFeature('/dashboard/front-desk');
  return <FrontDeskModule />;
}
