import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { DocumentsModule } from '@/components/modules/documents-module';

export const metadata: Metadata = { title: 'Documents' };

export default async function DocumentsPage() {
  const ctx = await requireUserContext();
  await requireAal2(ctx, 'documents', '/dashboard/documents');
  return <DocumentsModule />;
}
