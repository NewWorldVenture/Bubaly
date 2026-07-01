import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { PlayDatesView } from '@/components/family/play-dates-view';

export const metadata: Metadata = { title: 'Play Dates' };

export default async function PlayDatesPage() {
  await requireUserContext();
  return <PlayDatesView />;
}
