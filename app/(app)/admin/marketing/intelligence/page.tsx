import type { Metadata } from 'next';
import { Users, MousePointerClick, Target, Radar } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import {
  attributeConversions, conversionCount, channelOf, ATTRIBUTION_MODEL_LABELS, type Touchpoint,
} from '@/lib/marketing/attribution';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Customer Intelligence', robots: { index: false } };
export const dynamic = 'force-dynamic';

function ReadFailure() {
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-black sm:text-2xl">Customer Intelligence</h1>
      <ErrorState message="Could not load customer intelligence from Supabase. Refresh and try again." />
      <a href="/admin/marketing/intelligence" className="text-sm font-medium text-brand-text underline">Refresh customer intelligence</a>
    </div>
  );
}

export default async function IntelligencePage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  let results;
  try {
    results = await Promise.all([
      supabase.from('mkt_visitors').select('*', { count: 'exact', head: true }),
      supabase.from('mkt_sessions').select('*', { count: 'exact', head: true }),
      supabase.from('mkt_sessions').select('source').limit(5000),
      supabase.from('mkt_touchpoints').select('visitor_id, source, kind, occurred_at').limit(10000),
    ]);
  } catch {
    return <ReadFailure />;
  }
  const [visitorsResult, sessionCountResult, sessionsResult, touchpointsResult] = results;
  if (results.some((result) => result.error)) return <ReadFailure />;

  const visitorCount = visitorsResult.count ?? 0;
  const sessionCount = sessionCountResult.count ?? 0;
  const sessions = sessionsResult.data ?? [];
  const touchpoints = touchpointsResult.data ?? [];

  const tps = touchpoints as Touchpoint[];
  const conversions = conversionCount(tps);

  // Top acquisition channels by session volume.
  const sourceCounts = new Map<string, number>();
  for (const s of sessions) {
    const ch = channelOf({ source: s.source });
    sourceCounts.set(ch, (sourceCounts.get(ch) ?? 0) + 1);
  }
  const topSources = [...sourceCounts.entries()].map(([channel, count]) => ({ channel, count })).sort((a, b) => b.count - a.count).slice(0, 8);

  // Multi-touch attribution across the four standard models.
  const models = (Object.keys(ATTRIBUTION_MODEL_LABELS) as Array<keyof typeof ATTRIBUTION_MODEL_LABELS>);
  const attribution = models.map((m) => ({ model: m, rows: attributeConversions(tps, m).slice(0, 6) }));

  const stats = [
    { label: 'Visitors', value: visitorCount, icon: Users, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Sessions', value: sessionCount, icon: MousePointerClick, tint: 'text-blue-400 bg-blue-500/15' },
    { label: 'Conversions', value: conversions, icon: Target, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Touchpoints', value: tps.length, icon: Radar, tint: 'text-amber-400 bg-amber-500/15' },
  ];

  const maxSource = Math.max(1, ...topSources.map((s) => s.count));

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        {t('adminMarketingIntelligence.customerIntelligenceVisitorTrackingACdp')}
        <code className="mx-1 rounded bg-elevated px-1 py-0.5 text-xs">{t('adminMarketingIntelligence.postApiMktTrack')}</code>.
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div><p className="text-xl font-bold leading-none">{s.value}</p><p className="mt-1 text-xs text-muted">{s.label}</p></div>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-4 text-base font-semibold">{t('adminMarketingIntelligence.topAcquisitionChannels')}</h2>
        {topSources.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t('adminMarketingIntelligence.noSessionsTrackedYetSendEvents')} <code>/api/mkt/track</code>.</p>
        ) : (
          <div className="space-y-2">
            {topSources.map((s) => (
              <div key={s.channel} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-sm capitalize">{s.channel}</span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-elevated">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${(s.count / maxSource) * 100}%` }} />
                </div>
                <span className="w-12 shrink-0 text-right text-sm text-muted">{s.count}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-base font-semibold">{t('adminMarketingIntelligence.attributionByModel')}</h2>
        <p className="mb-4 text-xs text-muted">{t('adminMarketingIntelligence.conversionCreditDistributedAcrossChannelsCompare')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {attribution.map(({ model, rows }) => (
            <div key={model} className="rounded-xl border border-border bg-surface/30 p-3">
              <p className="mb-2 text-sm font-semibold">{ATTRIBUTION_MODEL_LABELS[model]}</p>
              {rows.length === 0 ? (
                <p className="text-xs text-muted">No conversions yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {rows.map((r) => (
                    <li key={r.channel} className="flex items-center justify-between text-sm">
                      <span className="capitalize">{r.channel}</span>
                      <span className="text-muted">{r.credit.toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
