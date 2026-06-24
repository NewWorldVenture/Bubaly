import type { Metadata } from 'next';
import { FlaskConical, Trophy } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { computeABResults, leadingVariant, type ABVariant, type VariantTotals } from '@/lib/marketing/ab';
import { NewExperimentForm, ExperimentControls } from './experiments-client';

export const metadata: Metadata = { title: 'A/B Testing', robots: { index: false } };
export const dynamic = 'force-dynamic';

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-elevated text-muted',
  running: 'bg-emerald-500/15 text-emerald-300',
  paused: 'bg-amber-500/15 text-amber-300',
  completed: 'bg-blue-500/15 text-blue-300',
};

export default async function ABTestingPage() {
  const supabase = createServiceClient();
  const { data: experiments } = await supabase
    .from('ab_experiments')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  const keys = (experiments ?? []).map((e) => e.key);
  const { data: events } = keys.length
    ? await supabase.from('ab_events').select('experiment_key, variant_key, kind').in('experiment_key', keys).limit(100000)
    : { data: [] as { experiment_key: string; variant_key: string; kind: string }[] };

  // Tally exposures/conversions per experiment+variant.
  const tally = new Map<string, { exposures: number; conversions: number }>();
  for (const ev of events ?? []) {
    const k = `${ev.experiment_key}::${ev.variant_key}`;
    const t = tally.get(k) ?? { exposures: 0, conversions: 0 };
    if (ev.kind === 'conversion') t.conversions++; else t.exposures++;
    tally.set(k, t);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">Run experiments with deterministic variant assignment and two-proportion significance testing.</p>
        <NewExperimentForm />
      </div>

      {(experiments ?? []).length === 0 ? (
        <Card><p className="py-8 text-center text-sm text-muted">No experiments yet — create your first test.</p></Card>
      ) : (
        <div className="space-y-4">
          {(experiments ?? []).map((exp) => {
            const variants = (exp.variants as unknown as ABVariant[]) ?? [];
            const totals: VariantTotals[] = variants.map((v) => {
              const t = tally.get(`${exp.key}::${v.key}`) ?? { exposures: 0, conversions: 0 };
              return { key: v.key, label: v.label, exposures: t.exposures, conversions: t.conversions };
            });
            const results = computeABResults(totals);
            const leader = leadingVariant(results);
            return (
              <Card key={exp.id}>
                <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <FlaskConical className="h-4 w-4 text-brand" />
                      <h2 className="font-semibold">{exp.name}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[exp.status] ?? 'bg-elevated text-muted'}`}>{exp.status}</span>
                      {exp.winner && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300"><Trophy className="h-3 w-3" />{variants.find((v) => v.key === exp.winner)?.label ?? exp.winner}</span>}
                    </div>
                    {exp.hypothesis && <p className="mt-1 text-xs text-muted">{exp.hypothesis}</p>}
                    <p className="mt-1 text-[11px] text-muted">key: <code>{exp.key}</code> · metric: {exp.metric}</p>
                  </div>
                  <ExperimentControls id={exp.id} status={exp.status} variants={variants} />
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted">
                      <tr><th className="pb-2">Variant</th><th className="pb-2 text-right">Exposures</th><th className="pb-2 text-right">Conversions</th><th className="pb-2 text-right">Rate</th><th className="pb-2 text-right">Lift</th><th className="pb-2 text-right">Significance</th></tr>
                    </thead>
                    <tbody>
                      {results.map((r) => (
                        <tr key={r.key} className="border-t border-border">
                          <td className="py-2">{r.label}{r.isControl && <span className="ml-1 text-xs text-muted">(control)</span>}{leader?.key === r.key && <Trophy className="ml-1 inline h-3.5 w-3.5 text-amber-300" />}</td>
                          <td className="py-2 text-right tabular-nums">{r.exposures.toLocaleString()}</td>
                          <td className="py-2 text-right tabular-nums">{r.conversions.toLocaleString()}</td>
                          <td className="py-2 text-right tabular-nums">{(r.rate * 100).toFixed(1)}%</td>
                          <td className="py-2 text-right tabular-nums">{r.lift == null ? '—' : `${r.lift > 0 ? '+' : ''}${(r.lift * 100).toFixed(0)}%`}</td>
                          <td className="py-2 text-right tabular-nums">{r.isControl ? '—' : r.pValue == null ? 'n/a' : r.significant ? <span className="text-emerald-300">✓ p={r.pValue.toFixed(3)}</span> : <span className="text-muted">p={r.pValue.toFixed(2)}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
