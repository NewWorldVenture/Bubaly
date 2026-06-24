import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { FocusModule } from '@/components/modules/focus-module';

export const metadata: Metadata = { title: 'Focus Mode' };

export default async function FocusPage() {
  await requireFeature('/dashboard/focus');
  return <FocusModule />;
}
