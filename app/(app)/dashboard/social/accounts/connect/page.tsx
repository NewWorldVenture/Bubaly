import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { PLATFORMS, isProviderConfigured, type SocialPlatform } from '@/lib/social/capabilities';
import { ConnectGrid } from '@/components/social/connect-grid';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Connect accounts · Social' };
export const dynamic = 'force-dynamic';

export default async function ConnectPage() {
  const t = await getTranslations();
  await requireUserContext();
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
        {t('dashboardSocialAccountsConnect.connectAPlatformToPullIts')} <strong>{t('dashboardSocialAccountsConnect.requiresSetup')}</strong> needs its
        developer-app credentials configured in this environment before it can authorize — we never mark an account
        connected without a real authorization.
      </p>
      <ConnectGrid readiness={readiness} />
    </div>
  );
}
