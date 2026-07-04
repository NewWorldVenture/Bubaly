import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Activity, CheckCircle2, Timer } from 'lucide-react';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty, StatTile } from '@/components/family/shell';
import {
  summarizeJourneys, formatDuration, formatRate,
  type JourneyEventLike,
} from '@/lib/analytics/journey';

export const metadata: Metadata = { title: 'Journey Analytics' };
export const dynamic = 'force-dynamic';

export default async function JourneysPage() {
  const ctx = await requireUserContext();
  // Raw product telemetry is an admin-only view.
  if (!(await isSuperAdmin())) notFound();

  const supabase = await createServer();
  const { data } = await supabase
    .from('journey_events')
    .select('journey, phase, step, duration_ms, session_id, created_at')
    .eq('family_id', ctx.active.familyId)
    .order('created_at', { ascending: false })
    .limit(5000);

  const events = (data ?? []) as JourneyEventLike[];
  const rows = summarizeJourneys(events);
  const totalStarts = rows.reduce((a, r) => a + r.starts, 0);
  const totalCompletions = rows.reduce((a, r) => a + r.completions, 0);
  const overallRate = totalStarts > 0 ? totalCompletions / totalStarts : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Journey Analytics"
        description="Real completion rates and times per user journey — the live source for the Experience Scorecard (this family)."
      />

      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Journeys started" value={totalStarts} icon={Activity} accent="bg-blue-600" />
        <StatTile label="Completed" value={totalCompletions} icon={CheckCircle2} accent="bg-emerald-600" />
        <StatTile label="Completion" value={formatRate(overallRate)} icon={Timer} accent="bg-violet-600" />
      </div>

      <SectionCard title="Per-journey medians" description="Measured from journey_events (0124) — no estimates.">
        {rows.length === 0 ? (
          <MiniEmpty icon={Activity} text="No journey events yet. Use the app (e.g. Quick Capture) to generate telemetry, then refresh." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3 font-medium">Journey</th>
                  <th className="py-2 px-3 font-medium">Starts</th>
                  <th className="py-2 px-3 font-medium">Completed</th>
                  <th className="py-2 px-3 font-medium">Rate</th>
                  <th className="py-2 px-3 font-medium">Median time</th>
                  <th className="py-2 pl-3 font-medium">Median steps</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.journey} className="border-b border-border/50">
                    <td className="py-2.5 pr-3 font-medium text-fg">{r.label}</td>
                    <td className="py-2.5 px-3 tabular-nums text-muted">{r.starts}</td>
                    <td className="py-2.5 px-3 tabular-nums text-muted">{r.completions}</td>
                    <td className="py-2.5 px-3 tabular-nums">
                      <span className={r.completionRate >= 0.8 ? 'text-emerald-300' : r.completionRate >= 0.5 ? 'text-amber-300' : 'text-rose-300'}>
                        {formatRate(r.completionRate)}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 tabular-nums text-muted">{formatDuration(r.medianDurationMs)}</td>
                    <td className="py-2.5 pl-3 tabular-nums text-muted">{r.medianSteps ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <p className="text-xs text-muted">
        Scope: this family only (RLS). Cross-family aggregate medians for the Scorecard would use a
        service-role read. Instrument more flows by calling <code className="rounded bg-elevated px-1">useJourney(&apos;key&apos;)</code>.
      </p>
    </div>
  );
}
