import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { BriefingModule } from '@/components/modules/briefing-module';
import { ChangeRecap } from '@/components/operating-index/change-recap';
import { summarizeChange, type SnapshotView } from '@/lib/operating-index/summary';
import { ActivationBeacon } from '@/components/analytics/activation-beacon';

export const metadata: Metadata = { title: 'Daily Briefing | Bubaly' };

export default async function BriefingPage() {
  const ctx = await requireFeature('/dashboard/briefing');
  const supabase = await createServer();

  // The evening tab shows the Operating Index "since yesterday" recap (pillar
  // #5) — diff the two most recent daily snapshots. Silent on the first reading.
  const { data: foiSnaps } = await supabase.from('family_operating_index')
    .select('composite, dimensions, suggestions, as_of_date')
    .eq('family_id', ctx.active.familyId).order('as_of_date', { ascending: false }).limit(2);

  const toView = (row: { composite: number; dimensions: unknown; suggestions: unknown }): SnapshotView => ({
    composite: row.composite,
    dimensions: (row.dimensions ?? {}) as Record<string, number>,
    suggestions: (Array.isArray(row.suggestions) ? row.suggestions : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({ id: String(s.id ?? ''), title: String(s.title ?? '') })),
  });
  const change = foiSnaps && foiSnaps.length
    ? summarizeChange(toView(foiSnaps[0]), foiSnaps[1] ? toView(foiSnaps[1]) : null)
    : null;

  return (
    <>
      <ActivationBeacon milestone="first_brief_viewed" familyId={ctx.active.familyId} userId={ctx.user.id} signupAtIso={ctx.active.family.created_at} />
      <BriefingModule recap={change ? <ChangeRecap change={change} /> : null} />
    </>
  );
}
