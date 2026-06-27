import type { Metadata } from 'next';
import { Users, MousePointerClick, Target, Radar } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import {
  attributeConversions, conversionCount, channelOf, ATTRIBUTION_MODEL_LABELS, type Touchpoint,
} from '@/lib/marketing/attribution';

export const metadata: Metadata = { title: 'Customer Intelligence', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function IntelligencePage() {
  const supabase = createServiceClient();
  const [{ count: visitorCount }, { count: sessionCount }, { data: sessions }, { data: touchpoints }] = await Promise.all([
    supabase.from('mkt_visitors').select('*', { count: 'exact', head: true }),
    supabase.from('mkt_sessions').select('*', { count: 'exact', head: true }),
    supabase.from('mkt_sessions').select('source').limit(5000),
    supabase.from('mkt_touchpoints').select('visitor_id, source, kind, occurred_at').limit(10000),
  ]);

  const tps = (touchpoints ?? []) as Touchpoint[];
  const conversions = conversionCount(tps);

  // Top acquisition channels by session volume.
  const sourceCounts = new Map<string, number>();
  for (const s of sessions ?? []) {
    const ch = channelOf({ source: s.source });
    sourceCounts.set(ch, (sourceCounts.get(ch) ?? 0) + 1);
  }
  const topSources = [...sourceCounts.entries()].map(([channel, count]) => ({ channel, count })).sort((a, b) => b.count - a.count).slice(0, 8);

  // Multi-touch attribution across the four standard models.
  const models = (Object.keys(ATTRIBUTION_MODEL_LABELS) as Array<keyof typeof ATTRIBUTION_MODEL_LABELS>);
  const attribution = models.map((m) => ({ model: m, rows: attributeConversions(tps, m).slice(0, 6) }));

  const stats = [
    { label: 'Visitors', value: visitorCount ?? 0, icon: Users, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Sessions', value: sessionCount ?? 0, icon: MousePointerClick, tint: 'text-blue-400 bg-blue-500/15' },
    { label: 'Conversions', value: conversions, icon: Target, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Touchpoints', value: tps.length, icon: Radar, tint: 'text-amber-400 bg-amber-500/15' },
  ];

  const maxSource = Math.max(1, ...topSources.map((s) => s.count));

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Customer Intelligence — visitor tracking, a CDP profile spine, and multi-touch attribution. Feed it from any surface via
        <code className="mx-1 rounded bg-elevated px-1 py-0.5 text-xs">POST /api/mkt/track</code>.
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
        <h2 className="mb-4 text-base font-semibold">Top acquisition channels</h2>
        {topSources.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No sessions tracked yet. Send events to <code>/api/mkt/track</code>.</p>
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
        <h2 className="mb-1 text-base font-semibold">Attribution by model</h2>
        <p className="mb-4 text-xs text-muted">Conversion credit distributed across channels — compare how each model values your touches.</p>
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
