import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { FamilySignalsModule, type SignalView } from '@/components/modules/family-signals-module';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Family Intelligence' };

function ReadFailure() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">Family Intelligence</h1>
      <ErrorState message="Could not load family intelligence from Supabase. Refresh and try again." />
      <Link href="/dashboard/family-signals" className="text-sm font-medium text-brand-text underline">Refresh family intelligence</Link>
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

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <FamilySignalsModule active={active} hidden={hidden} />
    </div>
  );
}
