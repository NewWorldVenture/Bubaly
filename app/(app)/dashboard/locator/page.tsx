import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { LocatorModule } from '@/components/modules/locator-module';

export const metadata: Metadata = { title: 'Family Map | Bubaly' };

export default async function LocatorPage() {
  await requirePlanLevel(1);
  return <LocatorModule />;
}
