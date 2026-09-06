import type { Metadata } from 'next';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/server';
import { PROVIDERS, PLATFORMS, isProviderConfigured, type SocialPlatform } from '@/lib/social/capabilities';
import { AdminSocialSubnav } from '@/components/social/admin-subnav';
import { PlatformDot } from '@/components/social/platform';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Social Providers', robots: { index: false } };
export const dynamic = 'force-dynamic';

function ReadFailure() {
  return (
    <div className="module-page">
      <h1 className="text-2xl font-bold tracking-tight">Providers</h1>
      <AdminSocialSubnav active="/admin/social/providers" />
      <ErrorState message="Could not load social providers from Supabase. Refresh and try again." />
      <Link href="/admin/social/providers" className="text-sm font-medium text-brand-text underline">Refresh social providers</Link>
    </div>
  );
}

export default async function AdminProvidersPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const { data: rows, error } = await supabase.from('social_providers').select('platform, label, is_enabled, needs_app_review, char_limit');
  if (error) {
    console.error('[admin-social-providers] provider catalog read failed', error);
    return <ReadFailure />;
  }
  const enabled = new Map((rows ?? []).map((r) => [r.platform, r.is_enabled]));

  return (
    <div className="module-page">
      <h1 className="text-2xl font-bold tracking-tight">{t('adminSocialProviders.providers')}</h1>
      <AdminSocialSubnav active="/admin/social/providers" />
      <p className="text-sm text-muted">
        {t('adminSocialProviders.theProviderCatalogAndCapabilityMatrix')} <code>lib/social/capabilities.ts</code>{t('adminSocialProviders.mirroredInto')}{' '}
        <code>social_providers</code>{t('adminSocialProviders.credentialReadinessIsReadFromThe')}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {PLATFORMS.map((p) => {
          const d = PROVIDERS[p];
          const configured = isProviderConfigured(p);
          return (
            <Card key={p}>
              <div className="mb-2 flex items-center gap-2">
                <PlatformDot platform={p} />
                <span className="text-sm font-semibold">{d.label}</span>
                {configured ? <Badge tone="success" className="ml-auto">Configured</Badge> : <Badge tone="neutral" className="ml-auto">Missing creds</Badge>}
              </div>
              <div className="grid grid-cols-2 gap-1 text-xs text-muted">
                <span>Auth: {d.auth}</span>
                <span>Char limit: {d.charLimit.toLocaleString()}</span>
                <span>Feed: {d.feed.supported ? 'yes' : 'no'}</span>
                <span>Post: {d.posting.supported ? 'yes' : 'no'}</span>
                <span>Analytics: {d.analytics.supported ? 'yes' : 'no'}</span>
                <span>Inbox: {d.inbox.supported ? 'yes' : 'no'}</span>
                <span>App review: {d.needsAppReview ? 'required' : 'no'}</span>
                <span>DB enabled: {enabled.get(p) === false ? 'no' : 'yes'}</span>
              </div>
              <p className="mt-2 text-[11px] text-muted">Scopes: {d.requiredScopes.join(', ')}</p>
              <p className="text-[11px] text-muted">Env: {d.credentialEnv.join(', ')}</p>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
