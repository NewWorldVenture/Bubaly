import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { DocumentsModule } from '@/components/modules/documents-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.documents') };
}

export default async function DocumentsPage() {
  const ctx = await requireUserContext();
  await requireAal2(ctx, 'documents', '/dashboard/documents');
  return <DocumentsModule />;
}
