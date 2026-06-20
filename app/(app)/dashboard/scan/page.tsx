import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { ScanModule } from '@/components/modules/scan-module';

export const metadata: Metadata = { title: 'Scan Flyer' };

export default async function ScanPage() {
  await requirePlanLevel(1);
  return <ScanModule />;
}
