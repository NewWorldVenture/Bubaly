import type { Metadata } from 'next';
import { BarChart3, Eye, Users, Heart, MessageCircle, Share2, MousePointerClick, PlaySquare } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getAnalytics, getAccounts } from '@/lib/social/queries';
import { PROVIDERS, type SocialPlatform } from '@/lib/social/capabilities';
import { PlatformDot } from '@/components/social/platform';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Analytics · Social' };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const [{ totals, byPlatform }, accounts] = await Promise.all([
    getAnalytics(familyId),
    getAccounts(familyId),
  ]);

  const connectedPlatforms = new Set(accounts.filter((a) => a.status === 'connected').map((a) => a.platform));
  const hasData = totals.snapshots > 0;

  const cards = [
    { label: 'Posts published', value: totals.postsPublished, icon: BarChart3 },
    { label: 'Impressions', value: totals.impressions, icon: Eye },
    { label: 'Reach', value: totals.reach, icon: Users },
    { label: 'Likes', value: totals.likes, icon: Heart },
    { label: 'Comments', value: totals.comments, icon: MessageCircle },
    { label: 'Shares', value: totals.shares, icon: Share2 },
    { label: 'Clicks', value: totals.clicks, icon: MousePointerClick },
    { label: 'Views', value: totals.views, icon: PlaySquare },
  ];

  return (
    <div className="space-y-4">
      <div className="grid-stats">
        {cards.map((c) => (
          <div key={c.label} className="stat-card">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand-text"><c.icon className="h-5 w-5" /></div>
            <div>
              <p className="text-xl font-bold leading-none">{c.value.toLocaleString()}</p>
              <p className="mt-1 text-xs text-muted">{c.label}</p>
            </div>
          </div>
        ))}
      </div>

      {!hasData && (
        <Card>
          <p className="text-sm text-muted">
            No analytics snapshots yet. Metrics are written from each platform’s analytics API once accounts are connected and
            credentialed — nothing here is invented. The totals above reflect real stored snapshots (currently zero).
          </p>
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-sm font-semibold">{t('dashboardSocialAnalytics.byPlatform')}</h2>
        <div className="space-y-2">
          {(['x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit'] as SocialPlatform[]).map((p) => {
            const def = PROVIDERS[p];
            const impressions = byPlatform[p] ?? 0;
            return (
              <div key={p} className="flex items-center gap-3 text-sm">
                <PlatformDot platform={p} />
                <span className="w-32 shrink-0">{def.label}</span>
                {def.analytics.supported ? (
                  <>
                    <span className="text-muted">{impressions.toLocaleString()} impressions</span>
                    {!connectedPlatforms.has(p) && <Badge tone="neutral" className="ml-auto">not connected</Badge>}
                  </>
                ) : (
                  <Badge tone="neutral" className="ml-auto" title={def.analytics.limitation}>Analytics unavailable</Badge>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
