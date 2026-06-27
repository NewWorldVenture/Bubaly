import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { FamilyTreeModule } from '@/components/modules/family-tree-module';

export const metadata: Metadata = { title: 'Family Tree' };

export default async function FamilyTreePage() {
  await requireUserContext();
  return <FamilyTreeModule />;
}
