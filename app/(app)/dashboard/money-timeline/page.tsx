import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { createServer } from '@/lib/supabase/server';
import { loadMoneyTimeline } from '@/lib/finance/timeline-load';
import { insightDedupeKey } from '@/lib/finance/timeline';
import { MoneyTimelineModule } from '@/components/modules/money-timeline-module';

export const metadata: Metadata = { title: 'Financial Copilot' };
export const dynamic = 'force-dynamic';

/**
 * Financial Copilot — the schedule↔money timeline. Fuses bills, savings goals,
 * account balances and the calendar into one forward cash-flow view with ranked,
 * plain-language insights the family can acknowledge or dismiss.
 */
export default async function MoneyTimelinePage() {
  const ctx = await requireUserContext();
  await requireAal2(ctx, 'money', '/dashboard/money-timeline');
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const timeline = await loadMoneyTimeline(supabase, familyId);

  // Persisted acknowledge/dismiss state, keyed by the insight's stable dedupe key.
  // Degrades safely before migration 0168 (treat as "no persisted state").
  const statusByKey: Record<string, string> = {};
  try {
    const { data } = await supabase
      .from('money_timeline_insights')
      .select('dedupe_key, status')
      .eq('family_id', familyId);
    for (const row of data ?? []) statusByKey[row.dedupe_key] = row.status;
  } catch { /* table not applied yet */ }

  // Attach the dedupe key so the client can match persisted state without
  // re-deriving it (keeps the key logic in one place).
  const insights = timeline.insights.map((i) => ({ ...i, key: insightDedupeKey(i) }));

  return (
    <MoneyTimelineModule
      timeline={timeline}
      insights={insights}
      statusByKey={statusByKey}
    />
  );
}
