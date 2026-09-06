import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { BriefingModule } from '@/components/modules/briefing-module';
import { ChangeRecap } from '@/components/operating-index/change-recap';
import { loadOperatingIndex } from '@/lib/operating-index/server';
import { ActivationBeacon } from '@/components/analytics/activation-beacon';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { RelationshipInsights } from '@/components/reasoning/relationship-insights';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Daily Briefing | Bubaly' };

export default async function BriefingPage() {
  const ctx = await requireFeature('/dashboard/briefing');
  const supabase = await createServer();

  // Both reads run together. The page used to await the operating-index read and
  // THEN the reasoning context, so parallelising them pays for the extra queries
  // the snapshot build costs — `allSettled` rather than `all` because the two
  // failures mean different things to a family and each keeps its own message.
  const [indexResult, reasoningResult] = await Promise.allSettled([
    // The recap has to be TODAY's picture, not whichever two rows happen to be
    // newest. This page used to read `family_operating_index` itself, ordered by
    // `as_of_date` descending with `limit(2)`, and diff those — with no anchor to
    // today at all. But that table is written LAZILY, by this very function's
    // upsert, and its only other callers are the Command Center, the Operating
    // Index page and the reasoning engine. On a morning when nobody has opened
    // one of those there IS no row for today, so the card diffed YESTERDAY
    // against THE DAY BEFORE and still titled itself "Since yesterday": a day
    // stale, silently, on the one screen meant to start the family's day.
    //
    // `loadOperatingIndex` computes today live, anchors the prior read with
    // `.lt('as_of_date', today)` (pinned by
    // tests/operating-index-today-anchor.test.ts), and persists today's row — so
    // opening the brief is now what makes today's snapshot exist for every other
    // surface, instead of the brief being the one that reads a stale pair.
    loadOperatingIndex(supabase, ctx.active.familyId),
    // R2: the briefing reasons over Knowledge Graph relationships (hub / ripple /
    // coverage). A failed read must remain visible because the relationship
    // section is derived from source-of-truth data.
    loadFamilyContext(supabase, ctx.active.familyId),
  ]);

  if (indexResult.status === 'rejected') {
    console.error('[dashboard/briefing] operating index read failed', indexResult.reason);
    return <ErrorState message="Could not load your daily briefing from Supabase. Refresh and try again." />;
  }
  if (reasoningResult.status === 'rejected') {
    console.error('[dashboard/briefing] reasoning context read failed', reasoningResult.reason);
    return <ErrorState message="Could not load relationship guidance for your daily briefing from Supabase. Refresh and try again." />;
  }

  const { change } = indexResult.value;
  const insights = reasoningInsights(reasoningResult.value);

  return (
    <>
      <ActivationBeacon milestone="first_brief_viewed" familyId={ctx.active.familyId} userId={ctx.user.id} signupAtIso={ctx.active.family.created_at} />
      <BriefingModule
        recap={<ChangeRecap change={change} />}
        relationships={insights.length ? <RelationshipInsights insights={insights} /> : null}
      />
    </>
  );
}
