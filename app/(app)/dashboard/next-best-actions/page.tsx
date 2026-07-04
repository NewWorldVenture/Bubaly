import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { NextActionsModule } from '@/components/modules/next-actions-module';

export const metadata: Metadata = { title: 'Next Best Actions | Bubaly' };

export default async function NextBestActionsPage() {
  await requireUserContext();
  return <NextActionsModule />;
}
