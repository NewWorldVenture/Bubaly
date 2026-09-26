import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { createServer } from '@/lib/supabase/server';
import { loadMoneyTimeline } from '@/lib/finance/timeline-load';
import { insightDedupeKey, type CashflowTimeline } from '@/lib/finance/timeline';
import { MoneyTimelineModule } from '@/components/modules/money-timeline-module';
import { ErrorState } from '@/components/ui/states';
import { isManager } from '@/lib/constants/roles';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';

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
  // The forecast's "today" and its week buckets are the family's, not the
  // server's — every day key below is resolved in this zone.
  const tz = ctx.active.family.timezone || 'UTC';
  const { locale } = await getLocaleContext();

  // The loader throws on a real money read failure (see timeline-load.ts):
  // a forecast missing its bills or a trip is a reassuring-but-wrong balance,
  // so it fails closed here rather than rendering "smooth water".
  let timeline: CashflowTimeline;
  try {
    // The insight copy carries amounts and week labels, so the forecast is
    // built for whoever is reading this page.
    timeline = await loadMoneyTimeline(supabase, familyId, tz, new Date(), { locale: locale.code });
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

  // The forecast is every member's to READ (0267's documented decision, kept by
  // 0352). Clearing an advisory is not: one row serves the whole family, so a
  // dismissal speaks for the parents too. RLS is the boundary; this only decides
  // whether a reader is shown a button that would be refused.
  return (
    <MoneyTimelineModule
      timeline={timeline}
      insights={insights}
      statusByKey={statusByKey}
      canManage={isManager(ctx.active.role)}
    />
  );
}
