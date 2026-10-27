import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireSocialPage } from '@/lib/social/access';
import { SOCIAL_SURFACES } from '@/lib/social/roles';
import { PLATFORMS, isProviderConfigured, type SocialPlatform } from '@/lib/social/capabilities';
import { ConnectGrid } from '@/components/social/connect-grid';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('pageTitle.connectAccounts')} · ${t('pageTitle.social')}` };
}
export const dynamic = 'force-dynamic';

export default async function ConnectPage() {
  const t = await getTranslations();
  // Every control on this page connects an account, which is connect_accounts'.
  await requireSocialPage(SOCIAL_SURFACES.connect);
  // Compute readiness server-side; never ship which env vars exist to the client.
  const readiness = Object.fromEntries(
    PLATFORMS.map((p) => [p, isProviderConfigured(p)]),
  ) as Record<SocialPlatform, boolean>;

  return (
    <div className="space-y-4">
      <Link href="/dashboard/social/accounts" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> {t('dashboardSocialAccountsConnect.backToAccounts')}
      </Link>
      <p className="text-sm text-muted">
        {t('dashboardSocialAccountsConnect.connectAPlatformToPullIts')} <strong>{t('dashboardSocialAccountsConnect.requiresSetup')}</strong>{' '}{t('connect.needsItsDeveloperAppCredentials')}</p>
      <ConnectGrid readiness={readiness} />
    </div>
  );
}
