import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { DeclutterModule } from '@/components/modules/declutter-module';

export const metadata: Metadata = { title: 'Declutter Missions' };

export default async function DeclutterPage() {
  await requireFeature('/dashboard/declutter');
  return <DeclutterModule />;
}
