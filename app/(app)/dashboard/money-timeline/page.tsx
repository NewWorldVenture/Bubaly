import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { loadMoneyTimeline } from '@/lib/finance/timeline-load';
import { insightDedupeKey, type CashflowTimeline } from '@/lib/finance/timeline';
import { MoneyTimelineModule } from '@/components/modules/money-timeline-module';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Financial Copilot' };
export const dynamic = 'force-dynamic';

/**
 * Financial Copilot — the schedule↔money timeline. Fuses bills, savings goals,
 * account balances and the calendar into one forward cash-flow view with ranked,
 * plain-language insights the family can acknowledge or dismiss.
 */
export default async function MoneyTimelinePage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  // The loader throws on a real money read failure (see timeline-load.ts):
  // a forecast missing its bills or a trip is a reassuring-but-wrong balance,
  // so it fails closed here rather than rendering "smooth water".
  let timeline: CashflowTimeline;
  try {
    timeline = await loadMoneyTimeline(supabase, familyId);
  } catch (err) {
    console.error('[dashboard/money-timeline] forecast read failed', err);
    const tr = await getTranslations();
    return <ErrorState message={tr('moneyTimeline.couldNotLoadYourMoney')} />;
  }

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
