import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import Link from 'next/link';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { FamilySignalsModule, type SignalView } from '@/components/modules/family-signals-module';
import { ErrorState } from '@/components/ui/states';
import { SignalPrecisionCard } from '@/components/metrics/signal-precision-card';
import { loadSignalPrecision } from '@/lib/metric/signal-precision-server';

export const metadata: Metadata = { title: 'Family Intelligence' };

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">{t('familySignals.familyIntelligence')}</h1>
      <ErrorState message={t('familySignals.couldNotLoadFamilyIntelligence')} />
      <Link href="/dashboard/family-signals" className="text-sm font-medium text-brand-text underline">{t('familySignals.refreshFamilyIntelligence')}</Link>
    </div>
  );
}

export default async function FamilySignalsPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data, error } = await supabase
    .from('family_signals')
    .select('id, kind, title, detail, score, evidence, status, last_seen_at')
    .eq('family_id', ctx.active.familyId)
    .order('score', { ascending: false })
    .limit(200);
  if (error) {
    console.error('[dashboard-family-signals] signal read failed', error);
    return <ReadFailure />;
  }

  const rows = (data ?? []) as {
    id: string; kind: string; title: string; detail: string | null;
    score: number; evidence: Record<string, unknown> | null; status: string; last_seen_at: string;
  }[];
  const toView = (r: (typeof rows)[number]): SignalView => ({
    id: r.id, kind: r.kind, title: r.title, detail: r.detail,
    score: r.score, evidence: r.evidence ?? {}, status: r.status, lastSeenAt: r.last_seen_at,
  });

  const active = rows.filter((r) => r.status === 'active').map(toView);
  const hidden = rows.filter((r) => r.status !== 'active').map(toView);
  const precision = await loadSignalPrecision(supabase, { familyId: ctx.active.familyId });

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <FamilySignalsModule active={active} hidden={hidden} />
      <SignalPrecisionCard result={precision} retryHref="/dashboard/family-signals" />
    </div>
  );
}
