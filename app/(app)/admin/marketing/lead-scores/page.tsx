import type { Metadata } from 'next';
import { Flame, Target, Users, Sparkles } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { CONTACT_BAND_META, type ContactBand, type ContactScoreFactor } from '@/lib/marketing/contact-score';
import { RecomputeButton, LeadRow } from './lead-scores-client';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Lead Scores', robots: { index: false } };
export const dynamic = 'force-dynamic';

type ScoredContact = {
  contact_id: string;
  score: number;
  band: string;
  factors: ContactScoreFactor[];
  name: string;
  email: string | null;
  lifecycle: string;
};

function ReadFailure() {
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <h1 className="text-xl font-black sm:text-2xl">Lead Scores</h1>
      <ErrorState message="Could not load lead scores from Supabase. Refresh and try again." />
      <a href="/admin/marketing/lead-scores" className="text-sm font-medium text-brand-text underline">Refresh lead scores</a>
    </div>
  );
}

export default async function LeadScoresPage() {
  const supabase = createServiceClient();

  // Ranked scores joined to their contact. Degrades to an empty state before 0172.
  let scoresResult;
  try {
    scoresResult = await supabase
      .from('crm_lead_scores')
      .select('contact_id, score, band, factors', { count: 'exact' })
      .order('score', { ascending: false })
      .limit(100);
  } catch {
    return <ReadFailure />;
  }
  if (scoresResult.error) return <ReadFailure />;

  const scores = scoresResult.data ?? [];
  const totalScored = scoresResult.count ?? 0;

  const ids = scores.map((s) => s.contact_id);
  const byId = new Map<string, { first_name: string | null; last_name: string | null; email: string | null; lifecycle_stage: string }>();
  if (ids.length) {
    let contactsResult;
    try {
      contactsResult = await supabase
        .from('crm_contacts').select('id, first_name, last_name, email, lifecycle_stage').in('id', ids);
    } catch {
      return <ReadFailure />;
    }
    if (contactsResult.error) return <ReadFailure />;
    for (const c of contactsResult.data ?? []) byId.set(c.id, c);
  }
  const rows: ScoredContact[] = scores.map((s) => {
      const c = byId.get(s.contact_id);
      const name = [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.email || 'Unknown contact';
      return {
        contact_id: s.contact_id, score: s.score, band: s.band,
        factors: Array.isArray(s.factors) ? (s.factors as unknown as ContactScoreFactor[]) : [],
        name, email: c?.email ?? null, lifecycle: c?.lifecycle_stage ?? '—',
      };
  });

  const bandCount = (b: ContactBand) => rows.filter((r) => r.band === b).length;
  const stats = [
    { label: 'Scored contacts', value: totalScored, icon: Users, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'Qualified', value: bandCount('qualified'), icon: Target, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Hot', value: bandCount('hot'), icon: Flame, tint: 'text-orange-400 bg-orange-500/15' },
    { label: 'Warm', value: bandCount('warm'), icon: Sparkles, tint: 'text-amber-400 bg-amber-500/15' },
  ];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-black sm:text-2xl">Lead Scores</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Every contact scored 0–100 from the signals we collect — site engagement, recency,
            conversions, demo, consent, and profile depth. Each score is fully itemized: expand a
            row to see exactly why.
          </p>
        </div>
        <RecomputeButton />
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="p-4">
            <div className="flex items-center gap-3">
              <span className={`grid h-10 w-10 place-items-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></span>
              <div>
                <p className="text-2xl font-black tabular-nums">{s.value}</p>
                <p className="text-xs text-muted">{s.label}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden p-0">
        {rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted">
            No scores yet. Click <span className="font-semibold text-fg">Recompute</span> to score contacts
            from the current signals{totalScored === 0 ? ' (or apply migration 0172 first)' : ''}.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <LeadRow
                key={r.contact_id}
                name={r.name}
                email={r.email}
                lifecycle={r.lifecycle}
                score={r.score}
                band={r.band as ContactBand}
                bandLabel={CONTACT_BAND_META[r.band as ContactBand]?.label ?? r.band}
                bandTint={CONTACT_BAND_META[r.band as ContactBand]?.tint ?? ''}
                factors={r.factors}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
