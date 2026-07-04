import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { KnowledgeSeedScreen } from '@/components/knowledge/seed-screen';

export const metadata: Metadata = { title: 'Seed Knowledge Base | Bubaly' };

export default async function KnowledgeSeedPage() {
  await requireUserContext();
  if (!(await isSuperAdmin())) notFound();
  return <KnowledgeSeedScreen />;
}
