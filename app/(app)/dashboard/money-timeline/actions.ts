'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { loadMoneyTimeline } from '@/lib/finance/timeline-load';
import { insightDedupeKey, type TimelineInsight } from '@/lib/finance/timeline';

const PATH = '/dashboard/money-timeline';

/**
 * Both actions here returned nothing and discarded their writes' results
 * outright, and the module called them as `void action()`. A dismissal that
 * was refused vanished from the screen anyway and came back on the next visit;
 * a refresh that failed looked like one with nothing new. They now say whether
 * the write landed, and the module undoes what it showed. Audit C1-S9-73.
 */
export type MoneyInsightWriteResult = { ok: boolean };

/** Acknowledge or dismiss a copilot insight (upserts by stable dedupe key). */
export async function setMoneyInsightStatusAction(input: {
  insight: TimelineInsight;
  status: 'acknowledged' | 'dismissed' | 'active';
}): Promise<MoneyInsightWriteResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const i = input.insight;
  const { error } = await supabase.from('money_timeline_insights').upsert(
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
  if (error) {
    console.error('[money-timeline] insight status save failed', { familyId: ctx.active.familyId, status: input.status, error });
    return { ok: false };
  }
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Recompute the timeline and refresh the persisted insights' content. Status is
 * intentionally omitted from the payload so any existing acknowledge/dismiss the
 * family set survives the refresh (only new insights insert as 'active').
 */
export async function syncMoneyInsightsAction(): Promise<MoneyInsightWriteResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const timeline = await loadMoneyTimeline(supabase, ctx.active.familyId);
  let failed = 0;
  for (const i of timeline.insights) {
    const { error } = await supabase.from('money_timeline_insights').upsert(
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
    if (error) {
      failed += 1;
      console.error('[money-timeline] insight refresh write failed', { familyId: ctx.active.familyId, error });
    }
  }
  revalidatePath(PATH);
  return { ok: failed === 0 };
}
