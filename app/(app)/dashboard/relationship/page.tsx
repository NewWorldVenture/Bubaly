import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { RelationshipModule } from '@/components/modules/relationship-module';

export const metadata: Metadata = { title: 'Relationship Helper' };

export default async function RelationshipPage() {
  await requireUserContext();
  return <RelationshipModule />;
}
