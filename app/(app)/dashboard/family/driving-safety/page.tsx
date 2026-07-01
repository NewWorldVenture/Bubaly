import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { DrivingSafetyView } from '@/components/family/driving-safety-view';

export const metadata: Metadata = { title: 'Driving Safety' };

export default async function DrivingSafetyPage() {
  await requireUserContext();
  return <DrivingSafetyView />;
}
