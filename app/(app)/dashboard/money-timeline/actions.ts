'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { loadMoneyTimeline } from '@/lib/finance/timeline-load';
import { insightDedupeKey, type TimelineInsight } from '@/lib/finance/timeline';
import { getLocaleContext } from '@/lib/i18n/server';

const PATH = '/dashboard/money-timeline';

/** Acknowledge or dismiss a copilot insight (upserts by stable dedupe key). */
export async function setMoneyInsightStatusAction(input: {
  insight: TimelineInsight;
  status: 'acknowledged' | 'dismissed' | 'active';
}): Promise<void> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const i = input.insight;
  await supabase.from('money_timeline_insights').upsert(
    {
      family_id: ctx.active.familyId,
      kind: i.kind,
      title: i.title,
      detail: i.detail,
      severity: i.severity,
      week_start: i.weekStart,
      amount: i.amount,
      status: input.status,
      dedupe_key: insightDedupeKey(i),
    },
    { onConflict: 'family_id,dedupe_key' },
  );
  revalidatePath(PATH);
}

/**
 * Recompute the timeline and refresh the persisted insights' content. Status is
 * intentionally omitted from the payload so any existing acknowledge/dismiss the
 * family set survives the refresh (only new insights insert as 'active').
 */
export async function syncMoneyInsightsAction(): Promise<void> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // The persisted title/detail are a record of what was surfaced, not what the
  // page renders — money-timeline/page.tsx reads back only dedupe_key and
  // status and re-derives the copy for its own reader. So this formats in the
  // language of whoever pressed Refresh, which is the right owner for a record
  // and deliberately not a per-member choice: one row serves the whole family.
  const { locale } = await getLocaleContext();
  const timeline = await loadMoneyTimeline(supabase, ctx.active.familyId, new Date(), { locale: locale.code });
  for (const i of timeline.insights) {
    await supabase.from('money_timeline_insights').upsert(
      {
        family_id: ctx.active.familyId,
        kind: i.kind,
        title: i.title,
        detail: i.detail,
        severity: i.severity,
        week_start: i.weekStart,
        amount: i.amount,
        dedupe_key: insightDedupeKey(i),
      },
      { onConflict: 'family_id,dedupe_key' },
    );
  }
  revalidatePath(PATH);
}
