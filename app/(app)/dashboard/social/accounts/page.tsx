import type { Metadata } from 'next';
import Link from 'next/link';
import { Plug } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getAccounts } from '@/lib/social/queries';
import { PROVIDERS, PLATFORMS, type SocialPlatform } from '@/lib/social/capabilities';
import { AccountRow } from '@/components/social/account-row';
import { PlatformDot } from '@/components/social/platform';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Accounts · Social' };
export const dynamic = 'force-dynamic';

function cap(ok: boolean, limitation?: string) {
  return ok ? <Badge tone="success" title={limitation}>Yes</Badge> : <Badge tone="neutral" title={limitation}>No</Badge>;
}

export default async function AccountsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const accounts = await getAccounts(ctx.active.familyId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('dashboardSocialAccounts.connectedAccounts')}</h2>
        <Link href="/dashboard/social/accounts/connect" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg">
          <Plug className="h-4 w-4" /> {t('dashboardSocialAccounts.connect')}
        </Link>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          icon={Plug}
          title={t('dashboardSocialAccounts.noAccountsYet')}
          description="Connect a social account to begin."
          action={<Link href="/dashboard/social/accounts/connect" className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg"><Plug className="h-4 w-4" /> {t('dashboardSocialAccounts.connectAnAccount')}</Link>}
        />
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              id={a.id}
              platform={a.platform as SocialPlatform}
              name={a.display_name ?? a.handle ?? PROVIDERS[a.platform as SocialPlatform].label}
              status={a.status}
              lastError={a.last_error}
              lastSyncedAt={a.last_synced_at}
            />
          ))}
        </div>
      )}

      {/* Honest capability matrix */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold">{t('dashboardSocialAccounts.whatEachPlatformSupports')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-2 py-1.5 font-medium">{t('dashboardSocialAccounts.platform')}</th>
                <th className="px-2 py-1.5 font-medium">{t('dashboardSocialAccounts.feed')}</th>
                <th className="px-2 py-1.5 font-medium">{t('dashboardSocialAccounts.post')}</th>
                <th className="px-2 py-1.5 font-medium">{t('dashboardSocialAccounts.analytics')}</th>
                <th className="px-2 py-1.5 font-medium">{t('dashboardSocialAccounts.inbox')}</th>
                <th className="px-2 py-1.5 font-medium">{t('dashboardSocialAccounts.appReview')}</th>
              </tr>
            </thead>
            <tbody>
              {PLATFORMS.map((p) => {
                const d = PROVIDERS[p];
                return (
                  <tr key={p} className="border-t border-border">
                    <td className="px-2 py-1.5"><span className="inline-flex items-center gap-1.5"><PlatformDot platform={p} /> {d.label}</span></td>
                    <td className="px-2 py-1.5">{cap(d.feed.supported, d.feed.limitation)}</td>
                    <td className="px-2 py-1.5">{cap(d.posting.supported, d.posting.limitation)}</td>
                    <td className="px-2 py-1.5">{cap(d.analytics.supported, d.analytics.limitation)}</td>
                    <td className="px-2 py-1.5">{cap(d.inbox.supported, d.inbox.limitation)}</td>
                    <td className="px-2 py-1.5">{d.needsAppReview ? <Badge tone="warning">{t('accounts.required')}</Badge> : <Badge tone="neutral">No</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">{t('accounts.hoverACellForThe')}</p>
      </Card>
    </div>
  );
}
