import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { DevicesModule } from '@/components/modules/devices-module';

export const metadata: Metadata = { title: 'Smart Home' };

export default async function DevicesPage() {
  await requireFeature('/dashboard/devices');
  return <DevicesModule />;
}
