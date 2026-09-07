import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Plug, Newspaper, PenSquare, CalendarClock, BarChart3, Inbox as InboxIcon,
  CheckCircle2, AlertTriangle, FileEdit, Send,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getSocialOverview } from '@/lib/social/queries';
import { getSocialAccess } from '@/lib/social/access';
import { PLATFORMS, isProviderConfigured } from '@/lib/social/capabilities';
import { PlatformDot } from '@/components/social/platform';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Social Command Center' };
export const dynamic = 'force-dynamic';

export default async function SocialOverviewPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const [overview, access] = await Promise.all([
    getSocialOverview(familyId),
    getSocialAccess(familyId),
  ]);

  const stats = [
    { label: 'Connected accounts', value: overview.connectedCount, icon: CheckCircle2, tone: 'text-success bg-success/10' },
    { label: 'Feed items', value: overview.feedCount, icon: Newspaper, tone: 'text-brand-text bg-brand/10' },
    { label: 'Drafts', value: overview.drafts, icon: FileEdit, tone: 'text-accent bg-accent/10' },
    { label: 'Scheduled', value: overview.scheduled, icon: CalendarClock, tone: 'text-warning bg-warning/10' },
    { label: 'Published', value: overview.published, icon: Send, tone: 'text-success bg-success/10' },
    { label: 'Open inbox', value: overview.openInbox, icon: InboxIcon, tone: 'text-brand-text bg-brand/10' },
  ];

  const quickLinks = [
    { href: '/dashboard/social/accounts/connect', label: 'Connect an account', icon: Plug },
    { href: '/dashboard/social/content-studio/new', label: 'Create content', icon: PenSquare },
    { href: '/dashboard/social/feed', label: 'Open unified feed', icon: Newspaper },
    { href: '/dashboard/social/analytics', label: 'View analytics', icon: BarChart3 },
  ];

  const configured = PLATFORMS.filter((p) => isProviderConfigured(p));

  return (
    <div className="space-y-6">
      <div className="grid-stats">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tone}`}>
              <s.icon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xl font-bold leading-none">{s.value}</p>
              <p className="mt-1 text-xs text-muted">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">{t('dashboardSocial.quickActions')}</h2>
          <div className="grid grid-cols-2 gap-2">
            {quickLinks.map((q) => (
              <Link
                key={q.href}
                href={q.href}
                className="flex items-center gap-2 rounded-xl border border-border bg-elevated px-3 py-3 text-sm font-medium transition hover:border-brand/40"
              >
                <q.icon className="h-4 w-4 text-brand-text" /> {q.label}
              </Link>
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">{t('dashboardSocial.yourRoleAmpAccess')}</h2>
          {access ? (
            <div className="space-y-2 text-sm">
              <p>
                {t('dashboardSocial.youAreSignedInAs')} <Badge tone="brand">{access.role.replace(/_/g, ' ')}</Badge>
              </p>
              <p className="text-muted">
                {access.permissions.length} permission{access.permissions.length === 1 ? '' : 's'}:{' '}
                {access.permissions.map((p) => p.replace(/_/g, ' ')).join(', ')}
              </p>
              <Link href="/dashboard/social/settings" className="inline-block text-sm font-medium text-brand-text underline">
                {t('dashboardSocial.manageAccessAmpSettings')}
              </Link>
            </div>
          ) : (
            <p className="text-sm text-muted">{t('dashboardSocial.noSocialAccessResolvedForThis')}</p>
          )}
        </Card>
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('dashboardSocial.platformReadiness')}</h2>
          <Link href="/dashboard/social/accounts" className="text-sm font-medium text-brand-text underline">{t('dashboardSocial.manageAccounts')}</Link>
        </div>
        <p className="mb-3 text-xs text-muted">
          {t('dashboardSocial.aPlatformIs')} <strong>ready</strong>{' '}{t('social.onlyWhenItsAppCredentials')}</p>
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => (
            <span key={p} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2 py-1 text-xs">
              <PlatformDot platform={p} />
              {isProviderConfigured(p)
                ? <Badge tone="success">{t('social.ready')}</Badge>
                : <Badge tone="neutral">{t('social.requiresSetup')}</Badge>}
            </span>
          ))}
        </div>
        {configured.length === 0 && (
          <p className="mt-3 text-xs text-warning">{t('social.noPlatformCredentialsAreConfigured')}</p>
        )}
      </Card>

      {overview.connectedCount === 0 && (
        <EmptyState
          icon={Plug}
          title={t('dashboardSocial.noAccountsConnectedYet')}
          description={t('social.connectASocialAccountTo')}
          action={
            <Link href="/dashboard/social/accounts/connect" className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg">
              <Plug className="h-4 w-4" /> {t('dashboardSocial.connectAnAccount')}
            </Link>
          }
        />
      )}
    </div>
  );
}
