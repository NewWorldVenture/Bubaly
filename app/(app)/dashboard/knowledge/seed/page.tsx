import type { Metadata } from 'next';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { KnowledgeSeedScreen } from '@/components/knowledge/seed-screen';
import { AppNotFound } from '@/components/app/app-not-found';

export const metadata: Metadata = { title: 'Seed Knowledge Base' };

export default async function KnowledgeSeedPage() {
  await requireUserContext();
  if (!(await isSuperAdmin())) return <AppNotFound backHref="/dashboard" />;
  return <KnowledgeSeedScreen />;
}
