import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { MovingModule } from '@/components/modules/moving-module';

export const metadata: Metadata = { title: 'Move Planner' };

export default async function MovingPage() {
  await requireFeature('/dashboard/moving');
  return <MovingModule />;
}
