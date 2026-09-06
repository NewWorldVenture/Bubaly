import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getAccounts } from '@/lib/social/queries';
import { StudioForm } from '@/components/social/studio-form';
import type { SocialPlatform } from '@/lib/social/capabilities';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'New post · Studio' };
export const dynamic = 'force-dynamic';

export default async function NewContentPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const accounts = await getAccounts(ctx.active.familyId);
  const lite = accounts.map((a) => ({
    id: a.id,
    platform: a.platform as SocialPlatform,
    display_name: a.display_name,
    handle: a.handle,
    status: a.status,
  }));
  return (
    <div className="space-y-4">
      <Link href="/dashboard/social/content-studio" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> {t('dashboardSocialContentStudioNew.backToStudio')}
      </Link>
      <StudioForm accounts={lite} />
    </div>
  );
}
