import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { DocumentsModule } from '@/components/modules/documents-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.documents') };
}

export default async function DocumentsPage() {
  // The Documents feature's own page, gated as /dashboard/files/* are: Off,
  // a tier above the plan, or a locked family is refused here too.
  const ctx = await requireFeature('/dashboard/documents');
  await requireAal2(ctx, 'documents', '/dashboard/documents');
  return <DocumentsModule />;
}
